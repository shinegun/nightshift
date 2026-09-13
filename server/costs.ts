/**
 * OpEx — what running this actually costs, in one place.
 *
 * Two kinds of money are tracked:
 *   • metered: model tokens (the `usage` table) and X posts (`tweets` × the per-post rate).
 *     Nobody enters these; they are counted from what the app actually did.
 *   • fixed: domain, hosting, API plans, prepaid top-ups that aren't metered per call. The owner
 *     enters them once in Settings → OpEx.
 *
 * The point is one number to compare against the owner's own monthly ceiling, so "am I spending
 * more on this than I meant to" is answerable at a glance.
 */
import { all, get, type Expense } from './db.ts';
import { localNow } from './util.ts';
import { num } from './settings.ts';

/** A recurring cost is normalised to a month; a one-off is charged whole where it was entered. */
export function monthlyAmount(e: Expense, month: string): number {
  if (e.period === 'year') return e.amount_usd / 12;
  if (e.period === 'once') return e.created_at.slice(0, 7) === month ? e.amount_usd : 0;
  return e.amount_usd;
}

/** What X charges per published post on the owner's plan (plans differ, so it is a setting). */
export function xPostRate(): number {
  const r = num('x_cost_per_post_usd');
  return Number.isFinite(r) && r >= 0 ? r : 0.03;
}

/** The local day a post went out; rows written before that column existed only have the UTC time. */
const postedDay = (t = 'tweets') => `COALESCE(${t}.posted_day, substr(${t}.posted_at, 1, 10))`;

export interface OpexLine {
  key: 'tokens' | 'x' | 'subscriptions';
  label: string;
  amount: number;
  detail: string;
  metered: boolean;
}

export interface Opex {
  day: string;
  /** 'YYYY-MM' — the month every figure below covers. */
  monthLabel: string;
  daysElapsed: number;
  daysInMonth: number;
  /** Everything so far today (local day) and month-to-date. */
  today: number;
  month: number;
  /** Month-to-date ÷ days elapsed — the run rate, i.e. what this is on track to cost. */
  perDay: number;
  /** Recurring costs normalised to a month. */
  fixedMonthly: number;
  cap: number;
  rate: number;
  lines: OpexLine[];
  subscriptions: Expense[];
  perCompany: { slug: string; name: string; tokens: number; posts: number }[];
}

const rows = (sql: string, ...p: (string | number)[]) => get<{ s: number | null; n: number }>(sql, ...p) ?? { s: 0, n: 0 };

export function opex(): Opex {
  const day = localNow().day;
  const month = day.slice(0, 7);
  const rate = xPostRate();

  const tokensToday = rows('SELECT SUM(cost_usd) AS s, COUNT(*) AS n FROM usage WHERE day = ?', day);
  const tokensMonth = rows('SELECT SUM(cost_usd) AS s, COUNT(*) AS n FROM usage WHERE day LIKE ?', `${month}-%`);
  const postsToday = rows(`SELECT 0 AS s, COUNT(*) AS n FROM tweets WHERE status = 'posted' AND ${postedDay()} = ?`, day);
  const postsMonth = rows(`SELECT 0 AS s, COUNT(*) AS n FROM tweets WHERE status = 'posted' AND substr(${postedDay()}, 1, 7) = ?`, month);

  const subscriptions = all<Expense>('SELECT * FROM expenses ORDER BY created_at, id');
  const fixedMonthly = subscriptions.reduce((t, e) => t + monthlyAmount(e, month), 0);

  const tokensMonthTotal = tokensMonth.s ?? 0;
  const postsCostMonth = postsMonth.n * rate;
  const postsCostToday = postsToday.n * rate;

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const daysElapsed = Math.min(Number(day.slice(8, 10)), daysInMonth);

  const lines: OpexLine[] = [
    {
      key: 'tokens', label: 'Model tokens', metered: true, amount: tokensMonthTotal,
      detail: `${tokensMonth.n.toLocaleString()} call${tokensMonth.n === 1 ? '' : 's'} this month · ${tokensToday.n} today`,
    },
    {
      key: 'x', label: 'X posts', metered: true, amount: postsCostMonth,
      detail: postsMonth.n === 0
        ? `none this month · $${rate.toFixed(3)} each`
        : `${postsMonth.n} post${postsMonth.n === 1 ? '' : 's'} × $${rate.toFixed(3)} · ${postsToday.n} today`,
    },
    {
      key: 'subscriptions', label: 'Subscriptions', metered: false, amount: fixedMonthly,
      detail: subscriptions.length === 0
        ? 'nothing entered yet — add domain, hosting, API plans'
        : `${subscriptions.length} item${subscriptions.length === 1 ? '' : 's'} · recurring`,
    },
  ];

  const perCompany = all<{ slug: string; name: string }>('SELECT slug, name FROM companies ORDER BY id').map((c) => ({
    ...c,
    tokens: rows('SELECT SUM(u.cost_usd) AS s, COUNT(*) AS n FROM usage u JOIN companies co ON co.id = u.company_id WHERE co.slug = ? AND u.day LIKE ?', c.slug, `${month}-%`).s ?? 0,
    posts: rows(`SELECT 0 AS s, COUNT(*) AS n FROM tweets t JOIN companies co ON co.id = t.company_id WHERE co.slug = ? AND t.status = 'posted' AND substr(${postedDay('t')}, 1, 7) = ?`, c.slug, month).n,
  }));

  return {
    day, monthLabel: month, daysElapsed, daysInMonth,
    today: (tokensToday.s ?? 0) + postsCostToday,
    month: tokensMonthTotal + postsCostMonth + fixedMonthly,
    perDay: daysElapsed > 0 ? (tokensMonthTotal + postsCostMonth + fixedMonthly) / daysElapsed : 0,
    fixedMonthly, cap: num('opex_cap_usd'), rate,
    lines, subscriptions, perCompany,
  };
}

/** Just the headline figures, for the always-visible meter in the top bar. */
export function opexSummary() {
  const o = opex();
  return { today: o.today, month: o.month, perDay: o.perDay, cap: o.cap };
}
