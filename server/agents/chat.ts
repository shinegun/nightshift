import { all, now, run, type Company } from '../db.ts';
import { emit } from '../events.ts';
import { chat, type Msg } from '../llm.ts';
import { localNow, truncate } from '../util.ts';
import { companyBrief } from './prompts.ts';
import { runTool, toolsFor, type ToolCtx } from './tools.ts';
import { humanize, writingGuide } from '../humanizer.ts';

const CHAT_TOOLS = ['create_task', 'list_tasks', 'get_metrics', 'read_document', 'write_document', 'web_search', 'fetch_url'];

/** The owner's conversation with the company's AI co-founder. */
export async function chatWithCofounder(c: Company, text: string) {
  run('INSERT INTO messages (company_id, role, content, created_at) VALUES (?, ?, ?, ?)', c.id, 'user', text, now());
  emit('messages', c.id);

  // Earlier turns go in as a transcript rather than assistant messages: DeepSeek's
  // thinking mode rejects tool requests whose history lacks reasoning_content.
  const history = all<{ role: string; content: string }>(
    'SELECT role, content FROM (SELECT * FROM messages WHERE company_id = ? ORDER BY id DESC LIMIT 21) ORDER BY id', c.id,
  ).slice(0, -1);
  const transcript = history.map((m) => `${m.role === 'user' ? 'Owner' : 'You'}: ${truncate(m.content, 1500)}`).join('\n\n');

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
    { role: 'user', content: transcript ? `Conversation so far:\n\n${transcript}\n\n---\nOwner: ${text}` : text },
  ];

  const ctx: ToolCtx = { company: c, counters: {}, siteChanged: false, limits: { create_task: 6 } };
  const tools = toolsFor(CHAT_TOOLS, c);
  let reply = '';
  for (let step = 0; step < 6; step++) {
    const m = await chat({ messages, tools: step === 5 ? undefined : tools, companyId: c.id });
    messages.push(m);
    if (!m.tool_calls?.length) { reply = m.content?.trim() ?? ''; break; }
    for (const call of m.tool_calls) {
      let args: unknown = null;
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* reported below */ }
      const result = args === null ? 'Error: invalid JSON arguments.' : await runTool(call.function.name, args, ctx);
      messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(result, 15_000) });
    }
  }
  reply ||= "I've queued that up.";
  reply = await humanize(reply, 'a chat reply to the company owner', c);
  run('INSERT INTO messages (company_id, role, content, created_at) VALUES (?, ?, ?, ?)', c.id, 'assistant', reply, now());
  emit('messages', c.id);
  return reply;
}
