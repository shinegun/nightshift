import { all, get, now, run, type Company, type Task } from '../db.ts';
import { num, setting } from '../settings.ts';
import { activity, emit } from '../events.ts';
import { chat, chatJSON } from '../llm.ts';
import { emailConfigured } from '../integrations/email.ts';
import { queueEmail } from '../actions.ts';
import { errMsg, localNow } from '../util.ts';
import { companyBrief } from './prompts.ts';
import { companyMetrics, insertTask } from './tools.ts';
import { humanize, writingGuide } from '../humanizer.ts';

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
  const done = all<Task>(`SELECT * FROM tasks WHERE company_id = ? AND finished_at >= ? AND status IN ('done','failed')`, c.id, since);
  const q = (sql: string) => Number(Object.values(get(sql, c.id, since) ?? { n: 0 })[0] ?? 0);
  const facts = {
    visitors_24h: q('SELECT COUNT(DISTINCT visitor) FROM visits WHERE company_id = ? AND ts >= ?'),
    new_waitlist_24h: q('SELECT COUNT(*) FROM waitlist WHERE company_id = ? AND created_at >= ?'),
    new_revenue_cents_24h: q('SELECT COALESCE(SUM(amount_cents), 0) FROM revenue WHERE company_id = ? AND created_at >= ?'),
    emails_received_24h: q(`SELECT COUNT(*) FROM emails WHERE company_id = ? AND direction = 'in' AND created_at >= ?`),
    ai_spend_usd_24h: Number(q('SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE company_id = ? AND ts >= ?').toFixed(3)),
    waiting_for_owner_approval: {
      emails: Number(get(`SELECT COUNT(*) AS n FROM emails WHERE company_id = ? AND status = 'pending_approval'`, c.id)?.n ?? 0),
      x_posts: Number(get(`SELECT COUNT(*) AS n FROM tweets WHERE company_id = ? AND status = 'pending_approval'`, c.id)?.n ?? 0),
      paused_ads: Number(get(`SELECT COUNT(*) AS n FROM ad_campaigns WHERE company_id = ? AND status = 'paused'`, c.id)?.n ?? 0),
    },
    waiting_on_you: all<{ title: string }>(`SELECT title FROM requests WHERE company_id = ? AND status = 'open'`, c.id).map((r) => r.title),
    tasks_paused_until_you_help: all<{ title: string }>(`SELECT title FROM tasks WHERE company_id = ? AND status = 'blocked'`, c.id).map((t) => t.title),
    totals: companyMetrics(c),
    tasks_finished: done.map((t) => ({ title: t.title, status: t.status, summary: (t.result ?? t.error ?? '').slice(0, 400) })),
  };

  let content: string;
  try {
    const m = await chat({
      companyId: c.id,
      messages: [
        { role: 'system', content: `You are the CEO agent of ${c.name}. Write the owner's morning report: plain text, ≤200 words. Start with one headline sentence, then "Done overnight", "Numbers", "Needs you" (approvals, keys to connect, decisions), and "Today's focus". Only use the facts given; if nothing happened, say so plainly.\n\n${writingGuide(c)}` },
        { role: 'user', content: JSON.stringify(facts, null, 2) },
      ],
    });
    content = await humanize(m.content?.trim() || '', "the owner's morning report", c);
  } catch (e) {
    content = '';
    activity(c.id, `> Report written without AI (${errMsg(e)})`);
  }
  if (!content) {
    content = `Done overnight: ${done.length ? done.map((t) => `${t.status === 'done' ? '✓' : '✗'} ${t.title}`).join('; ') : 'nothing'}.
Numbers: ${facts.visitors_24h} visitors, ${facts.new_waitlist_24h} new waitlist signups, AI spend $${facts.ai_spend_usd_24h}.`;
  }

  run('INSERT INTO reports (company_id, day, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(company_id, day) DO UPDATE SET content = excluded.content, created_at = excluded.created_at', c.id, day, content, now());
  emit('reports', c.id);
  activity(c.id, '> Morning report ready');
  const owner = setting('owner_email');
  if (emailConfigured() && owner) {
    await queueEmail(c, { to: owner, kind: 'report', subject: `${c.name} — morning report ${day}`, body: content }).catch((e) => activity(c.id, `> Report email failed: ${errMsg(e)}`));
  }
  return content;
}
