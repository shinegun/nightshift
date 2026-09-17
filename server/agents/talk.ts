/**
 * A teammate talking to one bot, from Slack.
 *
 * The bot answers as itself: its own role, skills and notes for this company, the same briefing a
 * task gets. It can look things up and queue work, but a conversation is not a task — anything
 * that takes real work becomes one, so it runs under the budget and the modes like everything else.
 */
import type { Bot, Company } from '../db.ts';
import { chat, type Msg } from '../llm.ts';
import { stripToolMarkup, truncate } from '../util.ts';
import { humanize } from '../humanizer.ts';
import { templateById, templateTypes } from '../bots.ts';
import { agentSystemPrompt } from './prompts.ts';
import { runTool, toolsFor, type ToolCtx } from './tools.ts';

const TALK_TOOLS = ['list_tasks', 'create_task', 'get_metrics', 'read_document', 'remember'];
const MAX_STEPS = 4;

export async function talkToBot(c: Company, bot: Bot, text: string, opts: { speaker: string; transcript?: string }) {
  const t = templateById(bot.template_id);
  const type = (t && templateTypes(t)[0]) || 'ops';
  const messages: Msg[] = [
    { role: 'system', content: agentSystemPrompt(c, type, bot) },
    {
      role: 'user',
      content: `${opts.speaker}, a teammate, is talking to you in the company's Slack. This is a conversation, not a task: reply to them directly in a few sentences of plain text (Slack formatting: *bold*, no headings), not with a task summary.
If they ask for work that takes more than a quick look, queue it with create_task and say so. Use remember only for a durable fact they tell you about the company.
${opts.transcript ? `\nThe thread so far:\n${opts.transcript}\n` : ''}
${opts.speaker}: ${text}`,
    },
  ];
  const ctx: ToolCtx = { company: c, counters: {}, siteChanged: false, botId: bot.id, limits: { create_task: 2, remember: 1 } };
  const tools = toolsFor(TALK_TOOLS, c);
  let reply = '';
  for (let step = 1; step <= MAX_STEPS; step++) {
    if (step === MAX_STEPS) messages.push({ role: 'user', content: 'Stop calling tools and reply now.' });
    const m = await chat({ messages, tools: step === MAX_STEPS ? undefined : tools, companyId: c.id });
    messages.push(m);
    if (!m.tool_calls?.length) { reply = m.content?.trim() ?? ''; break; }
    for (const call of m.tool_calls) {
      let args: unknown = null;
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* reported below */ }
      const result = args === null ? 'Error: invalid JSON arguments.' : await runTool(call.function.name, args, ctx);
      messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(result, 10_000) });
    }
  }
  reply = stripToolMarkup(reply) || 'Done.';
  return humanize(reply, 'a short Slack reply to a teammate', c);
}
