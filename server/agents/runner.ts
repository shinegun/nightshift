import { companyById, get, now, run, type Task } from '../db.ts';
import { num } from '../settings.ts';
import { activity, emit } from '../events.ts';
import { chat, LLMError, type Msg } from '../llm.ts';
import { snapshot } from '../sites.ts';
import { errMsg, stripToolMarkup, truncate } from '../util.ts';
import { agentSystemPrompt } from './prompts.ts';
import { botById, botForType } from '../bots.ts';
import { humanize } from '../humanizer.ts';
import { runTool, toolsForTask, type ToolCtx } from './tools.ts';

export const runningTasks = new Set<number>();

function log(taskId: number, companyId: number, kind: string, content: string) {
  run('INSERT INTO task_logs (task_id, ts, kind, content) VALUES (?, ?, ?, ?)', taskId, now(), kind, content);
  emit('task_log', companyId, { taskId });
}

const statusOf = (id: number) => get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', id)?.status;

/**
 * A conversation is only safe to resume if every tool call the model made has its result. A task
 * that died inside the tool loop has an assistant turn with calls still unanswered, and sending
 * that back is a protocol error, so drop back to the last complete turn.
 */
export function resumable(messages: Msg[]): Msg[] {
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Msg & { tool_calls?: { id: string }[] };
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const answered = new Set(
      messages.slice(i + 1).filter((x) => x.role === 'tool').map((x) => (x as { tool_call_id?: string }).tool_call_id),
    );
    cut = m.tool_calls.every((call) => answered.has(call.id)) ? cut : i;
    break;
  }
  return messages.slice(0, cut);
}

/** Reads back a saved conversation, ignoring anything that no longer parses. */
function savedMessages(task: Task): Msg[] {
  if (!task.messages) return [];
  try {
    const parsed = JSON.parse(task.messages);
    return Array.isArray(parsed) && parsed.length >= 2 ? resumable(parsed as Msg[]) : [];
  } catch {
    return [];
  }
}

/** Run one task to completion with the tool-using agent loop. */
export async function runTask(taskId: number): Promise<Task | undefined> {
  if (runningTasks.has(taskId)) return;
  const task = get<Task>('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task || !['todo', 'failed'].includes(task.status)) return task;
  const company = companyById(task.company_id);
  if (!company) return;

  // A task paused for budget keeps its conversation, so it picks up where it stopped instead of
  // paying a second time for the steps it already took.
  const resumed = savedMessages(task);
  const doneSteps = resumed.length ? Math.max(0, task.steps) : 0;

  runningTasks.add(taskId);
  run(
    `UPDATE tasks SET status = 'running', started_at = ?, finished_at = NULL, error = NULL, result = NULL, steps = ?, messages = NULL WHERE id = ?`,
    now(), doneSteps, taskId,
  );
  run(`UPDATE companies SET mood = 'working' WHERE id = ?`, company.id);
  activity(company.id, resumed.length ? `> Resuming at step ${doneSteps + 1}: ${task.title}` : `> Working on: ${task.title}`);
  emit('tasks', company.id);

  // The task's own bot, or whichever bot now takes its type (the one it had may have been let go).
  // With none, it still runs from the built-in role, just without a notebook.
  const bot = (task.bot_id ? botById(task.bot_id) : undefined) ?? botForType(company.id, task.type);
  if (bot && bot.id !== task.bot_id) run('UPDATE tasks SET bot_id = ? WHERE id = ?', bot.id, taskId);
  const ctx: ToolCtx = { company, taskId, counters: {}, siteChanged: false, botId: bot?.id };
  const tools = toolsForTask(task.type, company, Boolean(bot));
  const messages: Msg[] = resumed.length ? resumed : [
    { role: 'system', content: agentSystemPrompt(company, task.type, bot) },
    { role: 'user', content: `Task #${task.id} (${task.type}, priority ${task.priority}): ${task.title}\n\n${task.description || '(no further description)'}` },
  ];
  const maxSteps = Math.max(3, num('agent_max_steps'));

  try {
    let summary = '';
    // Set the moment the agent is forced onto its last step. A summary written under that
    // instruction describes work that was cut short, so it must not be filed as a finished task.
    let outOfSteps = false;
    for (let step = doneSteps + 1; step <= maxSteps; step++) {
      if (statusOf(taskId) === 'cancelled') throw new Error('Cancelled by owner');
      if (step === maxSteps) {
        outOfSteps = true;
        messages.push({ role: 'user', content: 'You are out of steps. Stop calling tools and reply now with your summary of what was done and what remains.' });
      }
      const reply = await chat({ messages, tools: step === maxSteps ? undefined : tools, companyId: company.id, taskId });
      messages.push(reply);
      // Count the step here, not after the tool loop: the final step withholds tools, so the reply
      // has no tool calls and the loop breaks below before ever recording it.
      run('UPDATE tasks SET steps = ? WHERE id = ?', step, taskId);
      if (reply.reasoning_content) log(taskId, company.id, 'thinking', truncate(reply.reasoning_content, 4000));
      if (reply.content?.trim() && reply.tool_calls?.length) log(taskId, company.id, 'message', reply.content.trim());

      if (!reply.tool_calls?.length) { summary = reply.content?.trim() ?? ''; break; }

      for (const call of reply.tool_calls) {
        let args: unknown;
        let result: string;
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = null; }
        if (args === null) {
          result = 'Error: the arguments were not valid JSON. Try again.';
        } else {
          log(taskId, company.id, 'tool_call', `${call.function.name} ${truncate(JSON.stringify(args), 1200)}`);
          result = await runTool(call.function.name, args, ctx);
        }
        log(taskId, company.id, 'tool_result', truncate(result, 2500));
        messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(result, 20_000) });
      }
    }

    if (ctx.siteChanged) snapshot(company.slug, `Task #${task.id}: ${task.title}`);
    // The final step withholds tools; an agent that still wanted one can write the call markup
    // into its summary, and that summary is what the owner reads on the task and in the report.
    summary = stripToolMarkup(summary);
    summary = await humanize(summary, 'a task summary for the company owner', company);
    if (ctx.blockedBy) {
      // Waiting on the owner: pause rather than fail, and requeue when they mark the request done.
      run(`UPDATE tasks SET status = 'blocked', result = ?, finished_at = ? WHERE id = ?`, summary || 'Waiting on the owner.', now(), taskId);
      activity(company.id, `> Paused until you help: ${task.title}`);
    } else if (outOfSteps) {
      // It hit the ceiling, so whatever it did was cut off mid-way. Filing that as done is how a
      // half-finished job disappears from the queue and turns up later as someone else's bug.
      // The summary is kept: it says what was done and what is left.
      run(
        `UPDATE tasks SET status = 'failed', result = ?, error = ?, finished_at = ? WHERE id = ?`,
        summary || 'No summary.', `Ran out of steps after ${maxSteps}. The work is unfinished.`, now(), taskId,
      );
      activity(company.id, `> Ran out of steps, not finished: ${task.title}`);
    } else {
      run(`UPDATE tasks SET status = 'done', result = ?, finished_at = ? WHERE id = ?`, summary || 'Done.', now(), taskId);
      activity(company.id, `> Finished: ${task.title}`);
    }
  } catch (e) {
    if (ctx.siteChanged) snapshot(company.slug, `Task #${task.id} (partial): ${task.title}`);
    const msg = errMsg(e);
    // Budget / key problems aren't the task's fault: put it back in the queue.
    const requeue = e instanceof LLMError && (e.code === 'budget' || e.code === 'config');
    const status = statusOf(taskId) === 'cancelled' ? 'cancelled' : requeue ? 'todo' : 'failed';
    // Keep the conversation only for a requeue, so the retry resumes instead of paying twice.
    // Anything else is finished with it, and a stale transcript would be resumed by mistake.
    const keep = requeue && status === 'todo' ? resumable(messages) : [];
    run('UPDATE tasks SET messages = ? WHERE id = ?', keep.length >= 2 ? JSON.stringify(keep) : null, taskId);
    run('UPDATE tasks SET status = ?, error = ?, finished_at = ? WHERE id = ?', status, msg, now(), taskId);
    log(taskId, company.id, 'error', msg);
    activity(company.id, requeue ? `> Paused: ${msg}` : `> ${status === 'cancelled' ? 'Cancelled' : 'Failed'}: ${task.title} — ${truncate(msg, 160)}`);
  } finally {
    runningTasks.delete(taskId);
    run(`UPDATE companies SET mood = CASE WHEN status = 'live' THEN 'idle' ELSE mood END WHERE id = ?`, company.id);
    emit('tasks', company.id);
  }
  return get<Task>('SELECT * FROM tasks WHERE id = ?', taskId);
}

/** After a crash/restart nothing is actually running. */
export function recoverStaleTasks() {
  run(`UPDATE tasks SET status = 'todo', error = 'Interrupted by a server restart' WHERE status = 'running'`);
}
