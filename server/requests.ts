/**
 * Closing a request the owner was asked to handle. The dashboard and Slack both do this, so it
 * lives in one place: whichever one is pressed, the paused task goes back in the queue the same way.
 */
import { get, now, run, type Request, type Task } from './db.ts';
import { activity, emit } from './events.ts';

export class RequestClosed extends Error {}

export function requestById(id: number) {
  return get<Request>('SELECT * FROM requests WHERE id = ?', id);
}

/** Owner did it: close the request and put the paused task back in the queue with their note. */
export function markRequestDone(r: Request, answer = '') {
  if (r.status !== 'open') throw new RequestClosed(`This request is already ${r.status}.`);
  const note = answer.trim().slice(0, 2000);
  run(`UPDATE requests SET status = 'done', answer = ?, done_at = ? WHERE id = ?`, note, now(), r.id);
  activity(r.company_id, `> You handled: ${r.title}`);
  const task = r.blocked_task_id ? get<Task>(`SELECT * FROM tasks WHERE id = ? AND status = 'blocked'`, r.blocked_task_id) : undefined;
  if (task) {
    const line = `\n\nOwner note (${new Date().toISOString().slice(0, 10)}) on "${r.title}": ${note || 'done'}`;
    run(`UPDATE tasks SET status = 'todo', description = ?, error = NULL, finished_at = NULL WHERE id = ?`, task.description + line, task.id);
    activity(r.company_id, `> Back in the queue: ${task.title}`);
  }
  emit('requests', r.company_id);
  emit('tasks', r.company_id);
  return task?.id ?? null;
}

/** Owner won't do it: close it and let the task run again so the agent can find another way or explain. */
export function dismissRequest(r: Request) {
  if (r.status !== 'open') throw new RequestClosed(`This request is already ${r.status}.`);
  run(`UPDATE requests SET status = 'dismissed', done_at = ? WHERE id = ?`, now(), r.id);
  const task = r.blocked_task_id ? get<Task>(`SELECT * FROM tasks WHERE id = ? AND status = 'blocked'`, r.blocked_task_id) : undefined;
  if (task) {
    const line = `\n\nOwner note: they will not do "${r.title}". Find another way or explain in your summary why this task can't be finished without it.`;
    run(`UPDATE tasks SET status = 'todo', description = ?, finished_at = NULL WHERE id = ?`, task.description + line, task.id);
  }
  emit('requests', r.company_id);
  emit('tasks', r.company_id);
}
