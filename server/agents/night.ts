import { all, get, now, run, type Company, type Task } from '../db.ts';
import { num, setting } from '../settings.ts';
import { activity, emit } from '../events.ts';
import { chat, chatJSON } from '../llm.ts';
import { emailConfigured } from '../integrations/email.ts';
import { queueEmail } from '../actions.ts';
import { errMsg, localNow } from '../util.ts';
import { companyBrief } from './prompts.ts';
import { briefText, decisions, lastNight } from '../decisions.ts';
import { companyMetrics, insertTask } from './tools.ts';
import { writingGuide } from '../humanizer.ts';

/** The CEO agent looks at the company and queues the most valuable next work. */
export async function planNight(c: Company) {
  const open = all<Task>(`SELECT * FROM tasks WHERE company_id = ? AND status = 'todo'`, c.id);
  const room = Math.min(num('night_max_new_tasks'), 25 - open.length);
  if (room <= 0 || open.length >= 4) return 0;
  const recent = all<Task>(`SELECT * FROM tasks WHERE company_id = ? AND status IN ('done','failed') ORDER BY finished_at DESC LIMIT 12`, c.id);
  const plan = await chatJSON<{ note: string; tasks: { title: string; description: string; type: string; priority: number }[] }>(
    `You are the CEO agent of an AI-run company, planning tonight's work. Pick the ${room} highest-leverage tasks that move the company toward its first paying customers. Avoid repeating finished work.
Tasks must be doable by AI agents with: static-website editing, web research, X posts, Meta ads, email outreach/support, Stripe payment links.
Return JSON {"note": one sentence on tonight's focus, "tasks": [{"title", "description" (specific, with definition of done), "type": fix|feature|research|marketing|outreach|support|ops, "priority": 1|2|3}]}.`,
    `${companyBrief(c)}

Metrics: ${JSON.stringify(companyMetrics(c))}

Open tasks:
${open.map((t) => `- ${t.title}`).join('\n') || '(none)'}

Recently finished:
${recent.map((t) => `- [${t.status}] ${t.title}${t.error ? ` (error: ${t.error.slice(0, 100)})` : ''}`).join('\n') || '(none)'}`,
    { companyId: c.id },
  );
  const tasks = (plan.tasks ?? []).slice(0, room);
  for (const t of tasks) insertTask(c, { ...t, source: 'night' });
  activity(c.id, `> Night plan: ${plan.note ?? `${tasks.length} new tasks`}`);
  return tasks.length;
}

/** Summary of the last 24h, saved on the dashboard and emailed to the owner. */
export async function morningReport(c: Company, force = false) {
  const { day } = localNow();
  if (!force && get('SELECT id FROM reports WHERE company_id = ? AND day = ?', c.id, day)) return null;
  const since = new Date(Date.now() - 86_400_000).toISOString();

  // Written without the AI, on purpose. The report is a list of decisions and a count of what
  // ran, both of which are already facts in the database: asking a model to restate them costs
  // money, makes the shape different every morning, and adds the one thing the owner said they
  // did not want, which is more words. Whatever the agents have to say lives on their tasks.
  const content = briefText(c, decisions(c), lastNight(c, since));

  run('INSERT INTO reports (company_id, day, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(company_id, day) DO UPDATE SET content = excluded.content, created_at = excluded.created_at', c.id, day, content, now());
  emit('reports', c.id);
  activity(c.id, '> Morning report ready');
  const owner = setting('owner_email');
  if (emailConfigured() && owner) {
    // The count goes in the subject, so the inbox answers "does this need me?" unopened.
    const n = decisions(c).length;
    const subject = n ? `${c.name} — ${n} decision${n === 1 ? '' : 's'}` : `${c.name} — nothing needs you`;
    await queueEmail(c, { to: owner, kind: 'report', subject, body: content }).catch((e) => activity(c.id, `> Report email failed: ${errMsg(e)}`));
  }
  return content;
}
