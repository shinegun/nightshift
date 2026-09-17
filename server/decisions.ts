/**
 * The owner's whole job, in one list.
 *
 * Nightshift produces a lot of writing, and most of it is the agents talking to themselves: task
 * logs, summaries, documents, activity lines. That record is worth keeping. It is not worth
 * reading every morning, because almost none of it is a question.
 *
 * This module answers a narrower question: what is actually waiting on a decision only the owner
 * can make? Everything else — what ran, what it wrote, how long it took — stays in the dashboard
 * for the times you go looking. The morning report and the dashboard both read this one list, so
 * they can never disagree about what needs you.
 */
import { all, get, type Company } from './db.ts';
import { num } from './settings.ts';
import { budgetStop, spentThisMonth, spentToday } from './llm.ts';

export type DecisionKind = 'budget' | 'commit' | 'email' | 'post' | 'ad' | 'request' | 'memory' | 'slack' | 'blocked';

export interface Decision {
  kind: DecisionKind;
  /** The row this is about, where there is a single one to act on. */
  id: number | null;
  /** One line. What you are deciding, not what happened. */
  title: string;
  /** Where to act, relative to the company dashboard. */
  action: string;
}

/**
 * Ordered by what stops the most work. A spent budget halts everything, so it leads; a blocked
 * task is last because it is usually downstream of a request that is already listed.
 */
const ORDER: DecisionKind[] = ['budget', 'commit', 'request', 'email', 'post', 'ad', 'slack', 'memory', 'blocked'];

const count = (sql: string, id: number) => Number(get<{ n: number }>(sql, id)?.n ?? 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A decision title is one line — the type says so, and both readers depend on it: the text report
 * is a numbered list split on newlines, and the HTML email parses that list back. A commit message
 * is the one input that regularly arrives as a whole changelog, so take its subject the way git
 * does (first line) and keep it short enough to read in an inbox.
 */
const TITLE_MAX = 120;
export function oneLine(text: string, max = TITLE_MAX): string {
  const first = text.split('\n')[0].replace(/\s+/g, ' ').trim();
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

export function decisions(c: Company): Decision[] {
  const out: Decision[] = [];

  const stop = budgetStop();
  if (stop) {
    out.push({
      kind: 'budget',
      id: null,
      title: stop.scope === 'monthly'
        ? `Raise the monthly AI budget: $${stop.spent.toFixed(2)} of $${stop.cap} spent, work stops until the 1st`
        : `Raise the daily AI budget: $${stop.spent.toFixed(2)} of $${stop.cap} spent, work stops until midnight`,
      action: 'Settings → AI backend',
    });
  }

  const commits = all<{ id: number; branch: string; message: string }>(
    `SELECT id, branch, message FROM commits WHERE company_id = ? AND status = 'pending_approval' ORDER BY id`, c.id,
  );
  for (const g of commits) {
    out.push({ kind: 'commit', id: g.id, title: `Push "${oneLine(g.message)}" to ${g.branch}`, action: 'Website → Commits' });
  }

  for (const r of all<{ id: number; title: string }>(
    `SELECT id, title FROM requests WHERE company_id = ? AND status = 'open' ORDER BY id`, c.id,
  )) {
    out.push({ kind: 'request', id: r.id, title: oneLine(r.title), action: 'Needs you' });
  }

  // Approvals are grouped: fifteen queued emails are one decision about one batch, not fifteen
  // separate mornings' worth of reading.
  const emails = count(`SELECT COUNT(*) AS n FROM emails WHERE company_id = ? AND status = 'pending_approval'`, c.id);
  if (emails) out.push({ kind: 'email', id: null, title: `Approve or discard ${plural(emails, 'drafted email')}`, action: 'Email' });

  const posts = count(`SELECT COUNT(*) AS n FROM tweets WHERE company_id = ? AND status = 'pending_approval'`, c.id);
  if (posts) out.push({ kind: 'post', id: null, title: `Approve or discard ${plural(posts, 'drafted post')}`, action: 'X' });

  const ads = count(`SELECT COUNT(*) AS n FROM ad_campaigns WHERE company_id = ? AND status = 'paused'`, c.id);
  if (ads) out.push({ kind: 'ad', id: null, title: `Start or drop ${plural(ads, 'paused ad campaign')}`, action: 'Ads' });

  const replies = count(`SELECT COUNT(*) AS n FROM slack_replies WHERE company_id = ? AND status = 'pending_approval'`, c.id);
  if (replies) out.push({ kind: 'slack', id: null, title: `Approve or discard ${plural(replies, 'Slack reply', 'Slack replies')}`, action: 'Needs you' });

  // A bot's note does nothing until it is kept, so an unreviewed one is a decision like any draft.
  const notes = count(`SELECT COUNT(*) AS n FROM bot_memories WHERE company_id = ? AND status = 'proposed'`, c.id);
  if (notes) out.push({ kind: 'memory', id: null, title: `Keep or forget ${plural(notes, 'note')} your bots want to remember`, action: 'Needs you' });

  const blocked = count(`SELECT COUNT(*) AS n FROM tasks WHERE company_id = ? AND status = 'blocked'`, c.id);
  if (blocked) out.push({ kind: 'blocked', id: null, title: `${plural(blocked, 'task')} paused until you help`, action: 'Tasks' });

  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

export interface NightSummary {
  ran: number;
  finished: number;
  unfinished: number;
  /** Titles of work that stopped without finishing. The only history worth surfacing unasked. */
  unfinishedTitles: string[];
}

/** What happened, in the smallest form that is still honest: how much ran, and what broke. */
export function lastNight(c: Company, since: string): NightSummary {
  const rows = all<{ status: string; title: string }>(
    `SELECT status, title FROM tasks WHERE company_id = ? AND finished_at >= ? AND status IN ('done','failed')`, c.id, since,
  );
  const bad = rows.filter((r) => r.status !== 'done');
  return {
    ran: rows.length,
    finished: rows.length - bad.length,
    unfinished: bad.length,
    unfinishedTitles: bad.map((r) => r.title),
  };
}

/**
 * The whole report, as text, in the shape of a decision list. Kept deliberately short: the detail
 * lives in the dashboard, and a report nobody finishes reading is worse than a shorter one.
 */
export function briefText(c: Company, d: Decision[], night: NightSummary, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 6;
  const lines: string[] = [];

  lines.push(d.length ? `${plural(d.length, 'decision')} for you.` : 'Nothing needs you.');
  lines.push('');

  d.slice(0, limit).forEach((item, i) => lines.push(`${i + 1}. ${oneLine(item.title)}`));
  if (d.length > limit) lines.push(`   ...and ${d.length - limit} more in the dashboard.`);
  if (d.length) lines.push('');

  const ran = night.ran
    ? `${plural(night.ran, 'task')} ran. ${night.finished} finished${night.unfinished ? `, ${night.unfinished} did not` : ''}.`
    : 'No tasks ran.';
  lines.push(ran);
  // Unfinished work is the one piece of history that is really a decision in disguise.
  for (const t of night.unfinishedTitles.slice(0, 3)) lines.push(`   unfinished: ${oneLine(t)}`);
  if (night.unfinishedTitles.length > 3) lines.push(`   ...and ${night.unfinishedTitles.length - 3} more.`);

  // One money line, because the budget is tight enough that it changes what you decide above.
  const monthCap = num('monthly_budget_usd');
  lines.push(
    `AI spend: $${spentToday().toFixed(2)} today, $${spentThisMonth().toFixed(2)} this month`
    + (monthCap > 0 ? ` of $${monthCap}.` : '.'),
  );

  return lines.join('\n');
}
