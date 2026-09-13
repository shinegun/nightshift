import { useCallback, useEffect, useState } from 'react';
import { api, del } from './api.ts';
import type { AppState } from './types.ts';
import { Toaster, useLive, useRoute, usd } from './lib.tsx';
import { Home } from './Home.tsx';
import { Dashboard } from './Dashboard.tsx';
import { Settings } from './Settings.tsx';

export function App() {
  const route = useRoute();
  const [state, setState] = useState<AppState | null>(null);
  const load = useCallback(() => api<AppState>('/state').then(setState).catch(() => {}), []);
  useEffect(() => { void load(); }, [load, route.join('/')]);
  useLive(null, load);

  const page = route[0] === 'c' && route[1] ? 'dashboard' : route[0] === 'settings' ? 'settings' : 'home';
  // Either cap stops the agents, so either one should turn the meter red.
  const over = state
    && ((state.budget > 0 && state.spentToday >= state.budget)
      || (state.monthlyBudget > 0 && state.spentThisMonth >= state.monthlyBudget));

  return (
    <div className="shell">
      <nav className="topbar">
        <a className="brand" href="#/"><span className="brand-moon" aria-hidden>☾</span> Nightshift</a>
        <div className="topbar-links">
          <a href="#/" className={page === 'home' ? 'active' : ''}>Companies</a>
          <a href="#/settings" className={page === 'settings' ? 'active' : ''}>Settings</a>
        </div>
        {state && (
          // One number, because only one of these stops the agents: today's model spend against
          // the daily cap. The other two mattered enough to keep, not enough to make you parse
          // three figures and two different meanings of "mo" on every page.
          <details className={`menu spend ${over ? 'over' : ''}`}>
            <summary className="mono spend-summary">
              {state.night ? '☾' : '☀'} {usd(state.spentToday)}{state.budget > 0 ? ` / ${usd(state.budget)}` : ''} today ▾
            </summary>
            <div className="menu-items spend-items">
              <div className={`spend-row ${over ? 'over' : ''}`}>
                <span>AI tokens today</span>
                <span className="mono">{usd(state.spentToday)} / {state.budget > 0 ? usd(state.budget) : '∞'}</span>
              </div>
              <div className="spend-row">
                <span>AI tokens this month</span>
                <span className="mono">{usd(state.spentThisMonth)} / {state.monthlyBudget > 0 ? usd(state.monthlyBudget) : '∞'}</span>
              </div>
              {state.opex && (
                <div className={`spend-row ${state.opex.cap > 0 && state.opex.month > state.opex.cap ? 'over' : ''}`}>
                  <span>Everything this month</span>
                  <span className="mono">{usd(state.opex.month)}{state.opex.cap > 0 ? ` / ${usd(state.opex.cap)}` : ''}</span>
                </div>
              )}
              <p className="spend-note muted small">
                The first two are model tokens only, and either one reaching its cap pauses the agents.
                The last adds X posts and subscriptions, and only reports.
              </p>
            </div>
          </details>
        )}
      </nav>

      {state && !state.llmConfigured && page !== 'settings' && (
        <div className="banner">Your AI team needs a brain. <a href="#/settings">Add your DeepSeek API key in Settings →</a></div>
      )}
      {state?.schedulerPaused && page !== 'settings' && (
        <div className="banner subtle">The scheduler is paused — Auto Mode and Night Task won't run. <a href="#/settings">Resume in Settings</a></div>
      )}
      {state && state.issues.length > 0 && (
        <div className="banner warn" role="alert">
          ✗ <strong>{state.issues[0].label}:</strong> {state.issues[0].message}
          {state.issues.length > 1 && <span className="muted"> (+{state.issues.length - 1} more problem{state.issues.length > 2 ? 's' : ''})</span>}
          {page !== 'settings' && <> <a href="#/settings">Open Settings →</a></>}
          <button className="btn small ghost" onClick={() => void del(`/issues/${encodeURIComponent(state?.issues[0]?.key ?? '')}`).then(load)}>Dismiss</button>
        </div>
      )}
      {over && page !== 'settings' && (
        <div className="banner">Today's AI budget is used up. Work resumes tomorrow, or <a href="#/settings">raise the budget</a>.</div>
      )}

      <main>
        {page === 'home' && <Home state={state} />}
        {page === 'dashboard' && <Dashboard key={route[1]} slug={route[1]} />}
        {page === 'settings' && <Settings onSaved={load} />}
      </main>
      <Toaster />
    </div>
  );
}
