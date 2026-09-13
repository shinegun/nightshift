import { all, get, now, run, type Company, type Task } from '../db.ts';
import { num, setting } from '../settings.ts';
import { activity, emit } from '../events.ts';
import { budgetStop, chat, chatJSON, spentThisMonth, spentToday } from '../llm.ts';
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

/** The slice of the report facts the plain writer reads. */
type ReportFacts = {
  visitors_24h: number;
  new_waitlist_24h: number;
  new_revenue_cents_24h: number;
  emails_received_24h: number;
  ai_spend_usd_24h: number;
  waiting_for_owner_approval: { emails: number; x_posts: number; paused_ads: number };
  waiting_on_you: string[];
  tasks_paused_until_you_help: string[];
  ai_budget: {
    daily_cap_usd: number; spent_today_usd: number;
    monthly_cap_usd: number; spent_this_month_usd: number;
    work_paused_today: boolean; paused_by: 'daily' | 'monthly' | null;
  };
};

/**
 * The report we write when the AI cannot. It runs on the same facts and uses the same four
 * sections as the written one, because the day the budget runs out is the day you most need to
 * know what is waiting for you. Anything that needs a decision goes under "Needs you": the old
 * version dropped approvals, open requests and blocked tasks entirely, and ran every finished
 * task together into one line.
 */
export function plainReport(c: Company, facts: ReportFacts, done: Task[]) {
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const cap = facts.ai_budget.daily_cap_usd;
  const lines: string[] = [];
  const section = (title: string, body: string[]) => {
    if (!body.length) return;
    lines.push('', title, ...body);
  };
  /** Long lists stop being readable; say how many were left out rather than printing all of them. */
  const capped = (items: string[], limit: number, noun: string) =>
    items.length > limit ? [...items.slice(0, limit), `... and ${items.length - limit} more ${noun}`] : items;

  const monthly = facts.ai_budget.paused_by === 'monthly';
  lines.push(
    facts.ai_budget.work_paused_today
      ? monthly
        ? `Work stopped for the rest of the month: the $${facts.ai_budget.monthly_cap_usd} monthly AI cap is spent. Everything below is where it stopped.`
        : `Work stopped once the $${cap} daily AI cap was spent. Everything below is where it stopped.`
      : done.length
        ? `${done.length} ${done.length === 1 ? 'task' : 'tasks'} finished in the last 24 hours.`
        : 'Nothing moved in the last 24 hours.',
  );

  section(
    'Done overnight',
    capped(done.map((t) => `${t.status === 'done' ? '✓' : '✗'} ${t.title}`), 8, 'tasks'),
  );

  section('Numbers', [
    `Visitors: ${facts.visitors_24h}`,
    `New waitlist signups: ${facts.new_waitlist_24h}`,
    `Emails received: ${facts.emails_received_24h}`,
    `Revenue: ${money(facts.new_revenue_cents_24h)}`,
    `AI spend: $${facts.ai_spend_usd_24h}${cap > 0 ? ` of a $${cap} daily cap` : ' (no daily cap set)'}`,
    ...(facts.ai_budget.monthly_cap_usd > 0
      ? [`AI spend this month: $${facts.ai_budget.spent_this_month_usd} of $${facts.ai_budget.monthly_cap_usd}`]
      : []),
  ]);

  const needs: string[] = [];
  const a = facts.waiting_for_owner_approval;
  if (a.emails) needs.push(`${a.emails} ${a.emails === 1 ? 'email is' : 'emails are'} waiting for your approval`);
  if (a.x_posts) needs.push(`${a.x_posts} X ${a.x_posts === 1 ? 'post is' : 'posts are'} waiting for your approval`);
  if (a.paused_ads) needs.push(`${a.paused_ads} ad ${a.paused_ads === 1 ? 'campaign is' : 'campaigns are'} paused`);
  if (facts.ai_budget.work_paused_today) {
    needs.push(
      monthly
        ? `Raise the monthly AI budget. $${facts.ai_budget.spent_this_month_usd} of $${facts.ai_budget.monthly_cap_usd} is spent and work is paused until the 1st.`
        : `Raise the daily AI budget. $${facts.ai_budget.spent_today_usd} of $${cap} is spent and work is paused until midnight.`,
    );
  }
  if (facts.waiting_on_you.length) {
    needs.push(`${facts.waiting_on_you.length} open ${facts.waiting_on_you.length === 1 ? 'request' : 'requests'}:`);
    needs.push(...capped(facts.waiting_on_you.map((t) => `  - ${t}`), 5, 'requests'));
  }
  if (facts.tasks_paused_until_you_help.length) {
    needs.push(`${facts.tasks_paused_until_you_help.length} blocked ${facts.tasks_paused_until_you_help.length === 1 ? 'task' : 'tasks'}:`);
    needs.push(...capped(facts.tasks_paused_until_you_help.map((t) => `  - ${t}`), 5, 'tasks'));
  }
  section('Needs you', needs.length ? needs : ['Nothing is waiting on you.']);

  const next = all<Task>(
    `SELECT * FROM tasks WHERE company_id = ? AND status = 'todo' ORDER BY priority, position, id LIMIT 5`,
    c.id,
  );
  section("Today's focus", next.length ? next.map((t) => `- ${t.title}`) : ['The queue is empty.']);

  return lines.join('\n');
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
    ai_budget: (() => {
      const cap = num('daily_budget_usd'), spent = spentToday();
      const monthlyCap = num('monthly_budget_usd'), spentMonth = spentThisMonth();
      const stop = budgetStop();
      return {
        daily_cap_usd: cap,
        spent_today_usd: Number(spent.toFixed(3)),
        monthly_cap_usd: monthlyCap,
        spent_this_month_usd: Number(spentMonth.toFixed(3)),
        work_paused_today: stop !== null,
        // 'monthly' means waiting for the 1st, not for midnight, which is a different message.
        paused_by: stop?.scope ?? null,
      };
    })(),
    totals: companyMetrics(c),
    tasks_finished: done.map((t) => ({ title: t.title, status: t.status, summary: (t.result ?? t.error ?? '').slice(0, 400) })),
  };

  let content: string;
  try {
    const m = await chat({
      companyId: c.id,
      messages: [
        { role: 'system', content: `You are the CEO agent of ${c.name}. Write the owner's morning report: plain text, ≤200 words. Start with one headline sentence, then "Done overnight", "Numbers", "Needs you" (approvals, keys to connect, decisions), and "Today's focus". Only use the facts given; if nothing happened, say so plainly. If ai_budget.work_paused_today is true, say in the first sentence that work stopped once the AI cap was spent, and put raising the cap under "Needs you". Use ai_budget.paused_by to say which cap: "daily" comes back at midnight, "monthly" not until the 1st.\n\n${writingGuide(c)}` },
        { role: 'user', content: JSON.stringify(facts, null, 2) },
      ],
    });
    content = await humanize(m.content?.trim() || '', "the owner's morning report", c);
  } catch (e) {
    content = '';
    activity(c.id, `> Report written without AI (${errMsg(e)})`);
  }
  if (!content) content = plainReport(c, facts, done);

  run('INSERT INTO reports (company_id, day, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(company_id, day) DO UPDATE SET content = excluded.content, created_at = excluded.created_at', c.id, day, content, now());
  emit('reports', c.id);
  activity(c.id, '> Morning report ready');
  const owner = setting('owner_email');
  if (emailConfigured() && owner) {
    await queueEmail(c, { to: owner, kind: 'report', subject: `${c.name} — morning report ${day}`, body: content }).catch((e) => activity(c.id, `> Report email failed: ${errMsg(e)}`));
  }
  return content;
}
