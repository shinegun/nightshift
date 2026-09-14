/**
 * The left rail: everywhere you can go, in the one place horizontal space is cheap.
 *
 * It replaces a topbar *and* the row of view tabs that used to sit inside the dashboard. Those
 * two together, plus the banner and the company header, pushed the first card 395px down a
 * 936px window — over a third of the screen spent on chrome before any content. Nav moved into
 * a column because a 1718px-wide window had 478px of unused horizontal room and no vertical room
 * to spare.
 *
 * Borrowed from resend.com/emails: 14px labels at normal weight, 32px rows, and an active state
 * that is a filled rounded pill rather than a border or a bolder font — the selected row should
 * be obvious without being louder than the page it points at.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { AppState } from './types.ts';
import { usd } from './lib.tsx';
import { EASE, motion } from './motion.tsx';

/**
 * How many things are waiting on you, published by the dashboard.
 *
 * The count comes from `needsYouCount(d)`, which needs the full dashboard payload the sidebar
 * does not have. Rather than fetch it twice (and risk the tab and the card disagreeing, which is
 * the bug the single-count rule exists to prevent), the dashboard announces it on a window event
 * — the same way `toast()` already talks across the tree.
 */
export const publishNeedsYou = (n: number) => dispatchEvent(new CustomEvent('ns-needs-you', { detail: n }));

function useNeedsYou(active: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) { setN(0); return; }
    const on = (e: Event) => setN((e as CustomEvent).detail as number);
    addEventListener('ns-needs-you', on);
    return () => removeEventListener('ns-needs-you', on);
  }, [active]);
  return n;
}

// Small stroke icons, drawn here rather than pulled in as a dependency — five of them at 16px is
// not worth a package, and hand-drawing them keeps the weight consistent with the 1px hairlines
// used elsewhere in the app.
const Icon = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg className="side-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden
    fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const ICONS = {
  today: 'M2 4.5h12M2 4.5v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7M2 4.5 8 9l6-4.5',
  work: 'M2.5 4h11M2.5 8h11M2.5 12h7',
  outbox: 'M14 2 7 9M14 2l-4.5 12L7 9 2 6.5 14 2Z',
  site: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM2 8h12M8 2c1.6 1.7 2.4 3.7 2.4 6S9.6 12.3 8 14c-1.6-1.7-2.4-3.7-2.4-6S6.4 3.7 8 2Z',
  numbers: 'M2.5 13.5v-4M6.5 13.5v-8M10.5 13.5v-5M14 13.5v-10',
  companies: 'M2.5 6.5 8 2.5l5.5 4v7h-11v-7ZM6.5 13.5v-4h3v4',
  settings: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM13 8a5 5 0 0 0-.1-1l1.3-1-1.5-2.6-1.6.6a5 5 0 0 0-1.7-1L9.2 1.4H6.8L6.6 3a5 5 0 0 0-1.7 1l-1.6-.6L1.8 6l1.3 1a5 5 0 0 0 0 2l-1.3 1 1.5 2.6 1.6-.6a5 5 0 0 0 1.7 1l.2 1.6h2.4l.2-1.6a5 5 0 0 0 1.7-1l1.6.6 1.5-2.6-1.3-1c.06-.33.1-.66.1-1Z',
};

function Item({ href, icon, label, badge, active }: {
  href: string; icon: keyof typeof ICONS; label: string; badge?: number; active: boolean;
}) {
  return (
    <a className={`side-item ${active ? 'active' : ''}`} href={href} aria-current={active ? 'page' : undefined}>
      {/* One pill that travels between rows, rather than five that take turns being visible. */}
      {active && <motion.span className="side-pill" layoutId="side-pill" transition={{ duration: 0.25, ease: EASE }} />}
      <Icon d={ICONS[icon]} />
      <span className="side-label">{label}</span>
      {badge ? <span className="side-badge">{badge}</span> : null}
    </a>
  );
}

const VIEWS = [
  { key: 'today', label: 'Today', icon: 'today' },
  { key: 'work', label: 'Work', icon: 'work' },
  { key: 'outbox', label: 'Outbox', icon: 'outbox' },
  { key: 'site', label: 'Site', icon: 'site' },
  { key: 'numbers', label: 'Numbers', icon: 'numbers' },
] as const;

export function Sidebar({ state, route, page, over }: {
  state: AppState | null; route: string[]; page: string; over: boolean | null;
}) {
  const slug = page === 'dashboard' ? route[1] : '';
  const current = state?.companies.find((c) => c.slug === slug);
  const view = VIEWS.some((v) => v.key === route[2]) ? route[2] : 'today';
  const waiting = useNeedsYou(page === 'dashboard');
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [slug, page]);

  return (
    <aside className="sidebar">
      <a className="brand" href="#/"><span className="brand-moon" aria-hidden>☾</span> Nightshift</a>

      {/* The switcher stands in for Resend's account menu: it names where you are and is the
          only control that changes it, so "which company am I looking at" is never a guess. */}
      <div className="switcher">
        <button className="switch-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="switch-name">{current ? current.name : 'All companies'}</span>
          <span className="switch-caret" aria-hidden>⌄</span>
        </button>
        {open && (
          <motion.div className="switch-menu"
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: EASE }}>
            <a href="#/" className={page === 'home' ? 'on' : ''}>All companies</a>
            {state?.companies.map((c) => (
              <a key={c.slug} href={`#/c/${c.slug}`} className={c.slug === slug ? 'on' : ''}>
                {c.name}
                {c.status !== 'live' && <span className="muted small"> · {c.status.replace(/_/g, ' ')}</span>}
              </a>
            ))}
          </motion.div>
        )}
      </div>

      <nav className="side-nav">
        {current ? (
          VIEWS.map((v) => (
            <Item key={v.key} icon={v.icon} label={v.label} active={view === v.key}
              badge={v.key === 'today' ? waiting : 0}
              href={`#/c/${encodeURIComponent(slug)}${v.key === 'today' ? '' : `/${v.key}`}`} />
          ))
        ) : (
          <Item icon="companies" label="Companies" href="#/" active={page === 'home'} />
        )}
      </nav>

      <div className="side-foot">
        <Item icon="settings" label="Settings" href="#/settings" active={page === 'settings'} />
        {state && <Spend state={state} over={Boolean(over)} />}
      </div>
    </aside>
  );
}

/**
 * Today's model spend against the cap that stops the agents. One number in the rail, the detail
 * on click — the other two figures matter enough to keep and not enough to parse every time.
 */
function Spend({ state, over }: { state: AppState; over: boolean }) {
  const [open, setOpen] = useState(false);
  const pct = state.budget > 0 ? Math.min(100, (state.spentToday / state.budget) * 100) : 0;
  return (
    <div className={`side-spend ${over ? 'over' : ''}`}>
      <button className="spend-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span aria-hidden>{state.night ? '☾' : '☀'}</span>
        <span className="mono">{usd(state.spentToday)}{state.budget > 0 ? ` / ${usd(state.budget)}` : ''}</span>
      </button>
      {state.budget > 0 && (
        <div className="spend-bar"><motion.i animate={{ width: `${pct}%` }} transition={{ duration: 0.5, ease: EASE }} /></div>
      )}
      {open && (
        <motion.div className="spend-detail" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          transition={{ duration: 0.2, ease: EASE }} style={{ overflow: 'hidden' }}>
          <Row label="Tokens today" value={`${usd(state.spentToday)} / ${state.budget > 0 ? usd(state.budget) : '∞'}`} over={over} />
          <Row label="Tokens this month" value={`${usd(state.spentThisMonth)} / ${state.monthlyBudget > 0 ? usd(state.monthlyBudget) : '∞'}`} />
          {state.opex && <Row label="Everything this month" value={`${usd(state.opex.month)}${state.opex.cap > 0 ? ` / ${usd(state.opex.cap)}` : ''}`} over={state.opex.cap > 0 && state.opex.month > state.opex.cap} />}
          <p className="muted small">The first two are model tokens only, and either one reaching its cap pauses the agents. The last adds X posts and subscriptions, and only reports.</p>
        </motion.div>
      )}
    </div>
  );
}

const Row = ({ label, value, over }: { label: string; value: ReactNode; over?: boolean }) => (
  <div className={`spend-row ${over ? 'over' : ''}`}><span>{label}</span><span className="mono">{value}</span></div>
);
