import { all, get, now, run, type Company, type Thread } from '../db.ts';
import { emit } from '../events.ts';
import { chat, type ContentPart, type Msg } from '../llm.ts';
import { localNow, stripToolMarkup, truncate } from '../util.ts';
import { oneLine } from '../decisions.ts';
import { companyBrief } from './prompts.ts';
import { runTool, toolsFor, type ToolCtx } from './tools.ts';
import { humanize, writingGuide } from '../humanizer.ts';
import { imageDataUrl } from '../uploads.ts';

const CHAT_TOOLS = ['create_task', 'list_tasks', 'get_metrics', 'read_document', 'write_document', 'web_search', 'fetch_url'];

/** Tool rounds before the co-founder has to answer with what it has. */
const MAX_STEPS = 6;

/**
 * Starts a conversation, titled from its opening message. Free, and predictable enough to find
 * again — asking the model for a title would cost a call per thread and vary every time. Rename
 * it from the thread list if it turns out to be about something else.
 */
export function createThread(c: Company, firstMessage: string): Thread {
  const title = oneLine(firstMessage, 60) || 'New conversation';
  const r = run('INSERT INTO threads (company_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', c.id, title, now(), now());
  emit('messages', c.id);
  return get<Thread>('SELECT * FROM threads WHERE id = ?', r.id)!;
}

export interface ChatTurn {
  threadId?: number;
  signal?: AbortSignal;
  /** Reasoning mode for this one message. Costs more, so it is asked for per turn, not left on. */
  think?: boolean;
  /** Filename of an already-saved upload, from uploads.saveImage(). */
  image?: string;
}

/** The turn as the model sees it: the thread so far, this message, and the picture if there is one. */
function userTurn(c: Company, transcript: string, text: string, image?: string): string | ContentPart[] {
  const body = transcript ? `Conversation so far:\n\n${transcript}\n\n---\nOwner: ${text}` : text;
  if (!image) return body;
  const url = imageDataUrl(c.id, image);
  if (!url) return `${body}\n\n(The owner attached an image, but it could not be read off disk.)`;
  return [{ type: 'text', text: body }, { type: 'image_url', image_url: { url } }];
}

/** The owner's conversation with the company's AI co-founder, within one thread. */
export async function chatWithCofounder(c: Company, text: string, opts: ChatTurn = {}) {
  const { signal, think, image } = opts;
  const thread = opts.threadId
    ? get<Thread>('SELECT * FROM threads WHERE id = ? AND company_id = ?', opts.threadId, c.id) ?? createThread(c, text)
    : createThread(c, text);

  run('INSERT INTO messages (company_id, thread_id, role, content, image, created_at) VALUES (?, ?, ?, ?, ?, ?)', c.id, thread.id, 'user', text, image ?? null, now());
  emit('messages', c.id);

  // Earlier turns go in as a transcript rather than assistant messages: DeepSeek's
  // thinking mode rejects tool requests whose history lacks reasoning_content. Scoped to this
  // thread, so a question about pricing does not replay last week's argument about the roadmap.
  const history = all<{ role: string; content: string; image: string | null }>(
    'SELECT role, content, image FROM (SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 21) ORDER BY id', thread.id,
  ).slice(0, -1);
  // Earlier images are named, not re-sent. Replaying every picture in the thread into every later
  // prompt is how one attachment turns into twenty billed ones.
  const transcript = history
    .map((m) => `${m.role === 'user' ? 'Owner' : 'You'}: ${m.image ? '[sent an image] ' : ''}${truncate(m.content, 1500)}`)
    .join('\n\n');

  const messages: Msg[] = [
    {
      role: 'system',
      content: `You are the AI co-founder and CEO of ${c.name}. You lead a team of AI agents (engineering, research, marketing, outreach, support, ops) that do the work as tasks. Today is ${localNow().day}.

${companyBrief(c)}

How to talk to the owner:
- Be a real co-founder: direct, concise, opinionated. Push back on weak ideas and say why.
- When the owner wants something done, turn it into one or more well-scoped tasks with create_task — don't pretend you did the work yourself. Tasks run in Auto Mode, overnight with Night Task, or when the owner presses Run.
- Use get_metrics and list_tasks for facts; never make numbers up.
- Plain text, short paragraphs, no headings.

${writingGuide(c)}`,
    },
    { role: 'user', content: userTurn(c, transcript, text, image) },
  ];

  const ctx: ToolCtx = { company: c, counters: {}, siteChanged: false, limits: { create_task: 6 } };
  const tools = toolsFor(CHAT_TOOLS, c);
  let reply = '';
  for (let step = 1; step <= MAX_STEPS; step++) {
    // Say it out loud before taking the tools away. A model mid-investigation that silently loses
    // its tools writes the call markup into the reply instead, and the owner reads that.
    if (step === MAX_STEPS) {
      messages.push({ role: 'user', content: 'You are out of tool calls. Stop calling tools and reply now in plain text: what you found, what you could not check, and what you want to do about it.' });
    }
    const m = await chat({ messages, tools: step === MAX_STEPS ? undefined : tools, companyId: c.id, signal, thinking: think ? 'enabled' : undefined });
    messages.push(m);
    if (!m.tool_calls?.length) { reply = m.content?.trim() ?? ''; break; }
    if (signal?.aborted) throw new Error('Stopped.');
    for (const call of m.tool_calls) {
      let args: unknown = null;
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* reported below */ }
      const result = args === null ? 'Error: invalid JSON arguments.' : await runTool(call.function.name, args, ctx);
      messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(result, 15_000) });
    }
  }
  // Net under the instruction above: a leaked call block must never reach the owner.
  reply = stripToolMarkup(reply);
  reply ||= "I've queued that up.";
  reply = await humanize(reply, 'a chat reply to the company owner', c);
  run('INSERT INTO messages (company_id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', c.id, thread.id, 'assistant', reply, now());
  run('UPDATE threads SET updated_at = ? WHERE id = ?', now(), thread.id);
  emit('messages', c.id);
  return { reply, threadId: thread.id };
}
