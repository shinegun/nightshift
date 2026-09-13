/**
 * OpEx panel — the cost side of the business, in Settings.
 *
 * Metered lines (model tokens, X posts) are counted server-side from what the app actually did.
 * The owner adds everything else they pay for — domain, hosting, API plans — and it is normalised
 * to a monthly figure so one number answers "what does this cost me a month".
 */
import { useCallback, useEffect, useState } from 'react';
import { api, del, post } from './api.ts';
import { toast, useLive, usd } from './lib.tsx';

interface Expense {
  id: number; name: string; amount_usd: number; period: 'month' | 'year' | 'once';
  company_id: number | null; note: string; created_at: string;
}

interface OpexData {
  day: string; monthLabel: string; daysElapsed: number; daysInMonth: number;
  today: number; month: number; perDay: number; fixedMonthly: number; cap: number; rate: number;
  lines: { key: string; label: string; amount: number; detail: string; metered: boolean }[];
  subscriptions: Expense[];
  perCompany: { slug: string; name: string; tokens: number; posts: number }[];
  companies: { id: number; slug: string; name: string }[];
}

const PERIODS: [Expense['period'], string][] = [['month', 'per month'], ['year', 'per year'], ['once', 'one-off']];
const monthly = (e: Expense, month: string) =>
  e.period === 'year' ? e.amount_usd / 12
    : e.period === 'once' ? (e.created_at.slice(0, 7) === month ? e.amount_usd : 0)
      : e.amount_usd;
/** Money columns all get the same precision — mixed 2/3 decimals makes a column hard to scan. */
const col = (n: number) => `$${n.toFixed(2)}`;

export function OpexPanel() {
  const [d, setD] = useState<OpexData | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', amount: '', period: 'month', companyId: '' });
  const load = useCallback(() => api<OpexData>('/opex').then(setD).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  useLive(null, load);

  const add = async () => {
    if (!form.name.trim() || form.amount === '') return toast('Name and amount, please.', 'error');
    setBusy(true);
    try {
      await post('/expenses', {
        name: form.name.trim(), amount: Number(form.amount), period: form.period,
        companyId: form.companyId === '' ? null : Number(form.companyId),
      });
      setForm({ name: '', amount: '', period: 'month', companyId: '' });
      await load();
      toast('Added to OpEx.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add it', 'error');
    } finally { setBusy(false); }
  };

  const remove = async (e: Expense) => {
    await del(`/expenses/${e.id}`);
    await load();
    toast(`Removed ${e.name}.`, 'success');
  };

  if (!d) return <p className="empty">Working out what this costs…</p>;

  const over = d.cap > 0 && d.month > d.cap;
  const pct = d.cap > 0 ? (d.month / d.cap) * 100 : 0;
  const projected = d.perDay * d.daysInMonth;
  const monthName = new Date(`${d.monthLabel}-01T00:00:00`).toLocaleString(undefined, { month: 'long' });

  return (
    <div className="opex">
      <div className="opex-head">
        <span className="opex-total mono">{usd(d.month)}</span>
        <span className="muted small">
          {monthName} so far{d.cap > 0 ? <> · ceiling {usd(d.cap)}</> : null} · {usd(d.today)} today
        </span>
      </div>
      {d.cap > 0 && (
        <>
          <div className={`meter ${over ? 'over' : pct > 75 ? 'warn' : ''}`} role="img"
            aria-label={`${Math.round(pct)}% of your monthly ceiling used`}>
            <div className="meter-fill" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <p className={`small ${over ? 'error' : 'muted'}`}>
            {over
              ? <>Past your {usd(d.cap)} ceiling by {usd(d.month - d.cap)} — the daily token budget is separate, so nothing stops on its own.</>
              : <>{Math.round(pct)}% of your ceiling · at {usd(d.perDay)}/day you're on track for <strong>{usd(projected)}</strong> by month end ({d.daysElapsed} of {d.daysInMonth} days in).</>}
          </p>
        </>
      )}

      <table className="opex-table">
        <thead><tr><th>Line</th><th>What it is</th><th className="num">This month</th></tr></thead>
        <tbody>
          {d.lines.map((l) => (
            <tr key={l.key}>
              <td>
                {l.label}
                {!l.metered && <span className="badge" title="Entered by you">manual</span>}
              </td>
              <td className="muted small">{l.detail}</td>
              <td className="num">{col(l.amount)}</td>
            </tr>
          ))}
          <tr className="opex-total-row">
            <td><strong>Total</strong></td>
            <td className="muted small">tokens + X posts + subscriptions</td>
            <td className="num"><strong>{col(d.month)}</strong></td>
          </tr>
        </tbody>
      </table>

      <div className="opex-subs">
        <p className="eyebrow">Subscriptions you pay for</p>
        {d.subscriptions.length === 0
          ? <p className="empty">Nothing yet. Domain, hosting, API plans, prepaid top-ups — anything that isn't counted per call.</p>
          : (
            <table className="opex-table">
              <thead><tr><th>Name</th><th>Billed</th><th className="num">Per month</th><th /></tr></thead>
              <tbody>
                {d.subscriptions.map((e) => (
                  <tr key={e.id}>
                    <td>
                      {e.name}
                      {e.company_id && <span className="muted small"> · {d.companies.find((c) => c.id === e.company_id)?.name}</span>}
                    </td>
                    <td className="muted small">{col(e.amount_usd)} {PERIODS.find(([p]) => p === e.period)?.[1] ?? ''}</td>
                    <td className="num">{col(monthly(e, d.monthLabel))}</td>
                    <td className="num"><button className="btn small ghost danger" onClick={() => void remove(e)} title="Remove">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        <div className="opex-add">
          <label className="field"><span>What</span>
            <input value={form.name} placeholder="safastack.com domain"
              onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field"><span>Amount (USD)</span>
            <input type="number" step="any" min="0" value={form.amount} placeholder="0.99"
              onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
          <label className="field"><span>Billed</span>
            <select value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
              {PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
          <label className="field"><span>Company (optional)</span>
            <select value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value })}>
              <option value="">All / shared</option>
              {d.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          <button className="btn small primary" disabled={busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
      </div>

      {d.perCompany.length > 1 && (
        <div className="opex-subs">
          <p className="eyebrow">Per company · {monthName}</p>
          <table className="opex-table">
            <thead><tr><th>Company</th><th className="num">Tokens</th><th className="num">Posts</th><th className="num">X cost</th><th className="num">Total</th></tr></thead>
            <tbody>
              {d.perCompany.map((c) => (
                <tr key={c.slug}>
                  <td><a href={`#/c/${c.slug}`}>{c.name}</a></td>
                  <td className="num">{col(c.tokens)}</td>
                  <td className="num">{c.posts}</td>
                  <td className="num">{col(c.posts * d.rate)}</td>
                  <td className="num">{col(c.tokens + c.posts * d.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="muted small">
        Tokens come from the <code>usage</code> table, X posts from published tweets × the per-post rate
        {d.rate > 0 ? ` (${usd(d.rate)})` : ''}. Prepaid balances are counted as they are consumed, so a
        top-up doesn't inflate a month you haven't spent it in.
      </p>
    </div>
  );
}
