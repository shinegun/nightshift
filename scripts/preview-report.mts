/**
 * Prints the no-AI morning report for a company, using the live database, without writing a
 * report row or sending the owner an email. Run it after changing plainReport():
 *
 *   npx tsx scripts/preview-report.mts safastack
 */
import { all, get } from '../server/db.ts';
import { num } from '../server/settings.ts';
import { budgetStop, spentThisMonth, spentToday } from '../server/llm.ts';
import { plainReport } from '../server/agents/night.ts';
import type { Company, Task } from '../server/db.ts';

const slug = process.argv[2] ?? 'safastack';
const c = get<Company>('SELECT * FROM companies WHERE slug = ?', slug);
if (!c) throw new Error(`no company with slug "${slug}"`);

const since = new Date(Date.now() - 86_400_000).toISOString();
const done = all<Task>(
  `SELECT * FROM tasks WHERE company_id = ? AND finished_at >= ? AND status IN ('done','failed')`,
  c.id,
  since,
);
const q = (sql: string) => Number(Object.values(get(sql, c.id, since) ?? { n: 0 })[0] ?? 0);
const n = (sql: string) => Number(get<{ n: number }>(sql, c.id)?.n ?? 0);
const cap = num('daily_budget_usd');
const monthlyCap = num('monthly_budget_usd');
const spent = spentToday();
const spentMonth = spentThisMonth();
const stop = budgetStop();

const facts = {
  visitors_24h: q('SELECT COUNT(DISTINCT visitor) FROM visits WHERE company_id = ? AND ts >= ?'),
  new_waitlist_24h: q('SELECT COUNT(*) FROM waitlist WHERE company_id = ? AND created_at >= ?'),
  new_revenue_cents_24h: q('SELECT COALESCE(SUM(amount_cents), 0) FROM revenue WHERE company_id = ? AND created_at >= ?'),
  emails_received_24h: q(`SELECT COUNT(*) FROM emails WHERE company_id = ? AND direction = 'in' AND created_at >= ?`),
  ai_spend_usd_24h: Number(q('SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE company_id = ? AND ts >= ?').toFixed(3)),
  waiting_for_owner_approval: {
    emails: n(`SELECT COUNT(*) AS n FROM emails WHERE company_id = ? AND status = 'pending_approval'`),
    x_posts: n(`SELECT COUNT(*) AS n FROM tweets WHERE company_id = ? AND status = 'pending_approval'`),
    paused_ads: n(`SELECT COUNT(*) AS n FROM ad_campaigns WHERE company_id = ? AND status = 'paused'`),
  },
  waiting_on_you: all<{ title: string }>(`SELECT title FROM requests WHERE company_id = ? AND status = 'open'`, c.id).map((r) => r.title),
  tasks_paused_until_you_help: all<{ title: string }>(`SELECT title FROM tasks WHERE company_id = ? AND status = 'blocked'`, c.id).map((t) => t.title),
  ai_budget: {
    daily_cap_usd: cap,
    spent_today_usd: Number(spent.toFixed(3)),
    monthly_cap_usd: monthlyCap,
    spent_this_month_usd: Number(spentMonth.toFixed(3)),
    work_paused_today: stop !== null,
    paused_by: stop?.scope ?? null,
  },
};

process.stdout.write(plainReport(c, facts, done) + '\n');
