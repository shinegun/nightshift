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
  const over = state && state.budget > 0 && state.spentToday >= state.budget;

  return (
    <div className="shell">
      <nav className="topbar">
        <a className="brand" href="#/"><span className="brand-moon" aria-hidden>☾</span> Nightshift</a>
        <div className="topbar-links">
          <a href="#/" className={page === 'home' ? 'active' : ''}>Companies</a>
          <a href="#/settings" className={page === 'settings' ? 'active' : ''}>Settings</a>
        </div>
        {state && (
          <div className={`spend ${over ? 'over' : ''}`} title="AI spend today vs. your daily budget">
            <span className="mono">{state.night ? '☾ night' : '☀ day'}</span>
            <span className="mono">{usd(state.spentToday)} / {state.budget > 0 ? usd(state.budget) : '∞'}</span>
          </div>
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
