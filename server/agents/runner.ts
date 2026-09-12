import { companyById, get, now, run, type Task } from '../db.ts';
import { num } from '../settings.ts';
import { activity, emit } from '../events.ts';
import { chat, LLMError, type Msg } from '../llm.ts';
import { snapshot } from '../sites.ts';
import { errMsg, truncate } from '../util.ts';
import { agentSystemPrompt } from './prompts.ts';
import { humanize } from '../humanizer.ts';
import { runTool, toolsForTask, type ToolCtx } from './tools.ts';

export const runningTasks = new Set<number>();

function log(taskId: number, companyId: number, kind: string, content: string) {
  run('INSERT INTO task_logs (task_id, ts, kind, content) VALUES (?, ?, ?, ?)', taskId, now(), kind, content);
  emit('task_log', companyId, { taskId });
}

const statusOf = (id: number) => get<{ status: string }>('SELECT status FROM tasks WHERE id = ?', id)?.status;

/** Run one task to completion with the tool-using agent loop. */
export async function runTask(taskId: number): Promise<Task | undefined> {
  if (runningTasks.has(taskId)) return;
  const task = get<Task>('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task || !['todo', 'failed'].includes(task.status)) return task;
  const company = companyById(task.company_id);
  if (!company) return;

  runningTasks.add(taskId);
  run(`UPDATE tasks SET status = 'running', started_at = ?, finished_at = NULL, error = NULL, result = NULL, steps = 0 WHERE id = ?`, now(), taskId);
  run(`UPDATE companies SET mood = 'working' WHERE id = ?`, company.id);
  activity(company.id, `> Working on: ${task.title}`);
  emit('tasks', company.id);

  const ctx: ToolCtx = { company, taskId, counters: {}, siteChanged: false };
  const tools = toolsForTask(task.type, company);
  const messages: Msg[] = [
    { role: 'system', content: agentSystemPrompt(company, task.type) },
    { role: 'user', content: `Task #${task.id} (${task.type}, priority ${task.priority}): ${task.title}\n\n${task.description || '(no further description)'}` },
  ];
  const maxSteps = Math.max(3, num('agent_max_steps'));

  try {
    let summary = '';
    for (let step = 1; step <= maxSteps; step++) {
      if (statusOf(taskId) === 'cancelled') throw new Error('Cancelled by owner');
      if (step === maxSteps) {
        messages.push({ role: 'user', content: 'You are out of steps. Stop calling tools and reply now with your summary of what was done and what remains.' });
      }
      const reply = await chat({ messages, tools: step === maxSteps ? undefined : tools, companyId: company.id, taskId });
      messages.push(reply);
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
      run('UPDATE tasks SET steps = ? WHERE id = ?', step, taskId);
    }

    if (ctx.siteChanged) snapshot(company.slug, `Task #${task.id}: ${task.title}`);
    summary = await humanize(summary, 'a task summary for the company owner', company);
    if (ctx.blockedBy) {
      // Waiting on the owner: pause rather than fail, and requeue when they mark the request done.
      run(`UPDATE tasks SET status = 'blocked', result = ?, finished_at = ? WHERE id = ?`, summary || 'Waiting on the owner.', now(), taskId);
      activity(company.id, `> Paused until you help: ${task.title}`);
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
