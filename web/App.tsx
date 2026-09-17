import { useCallback, useEffect, useState } from 'react';
import { api, del } from './api.ts';
import type { AppState } from './types.ts';
import { Toaster, useLive, useRoute } from './lib.tsx';
import { AnimatePresence, Collapse, EASE, MotionProvider, motion } from './motion.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Home } from './Home.tsx';
import { Dashboard } from './Dashboard.tsx';
import { Settings } from './Settings.tsx';
import { Library } from './Library.tsx';

export function App() {
  const route = useRoute();
  const [state, setState] = useState<AppState | null>(null);
  const load = useCallback(() => api<AppState>('/state').then(setState).catch(() => {}), []);
  useEffect(() => { void load(); }, [load, route.join('/')]);
  useLive(null, load);

  const page = route[0] === 'c' && route[1] ? 'dashboard' : route[0] === 'settings' ? 'settings' : route[0] === 'library' ? 'library' : 'home';
  // Either cap stops the agents, so either one should turn the meter red.
  const over = state
    && ((state.budget > 0 && state.spentToday >= state.budget)
      || (state.monthlyBudget > 0 && state.spentThisMonth >= state.monthlyBudget));

  return (
    <MotionProvider>
    <div className="shell">
      <Sidebar state={state} route={route} page={page} over={over} />

      <div className="pane">

      {/* Banners appear and disappear under you while you are reading the page, so they open and
          close on their own height instead of shoving everything down a step. */}
      <AnimatePresence initial={false}>
      {state && !state.llmConfigured && page !== 'settings' && (
        <Collapse key="llm"><div className="banner">Your AI team needs a brain. <a href="#/settings">Add your DeepSeek API key in Settings →</a></div></Collapse>
      )}
      {state?.schedulerPaused && page !== 'settings' && (
        <Collapse key="paused"><div className="banner subtle">The scheduler is paused — Auto Mode and Night Task won't run. <a href="#/settings">Resume in Settings</a></div></Collapse>
      )}
      {state && state.issues.length > 0 && (
        <Collapse key="issues"><div className="banner warn" role="alert">
          ✗ <strong>{state.issues[0].label}:</strong> {state.issues[0].message}
          {state.issues.length > 1 && <span className="muted"> (+{state.issues.length - 1} more problem{state.issues.length > 2 ? 's' : ''})</span>}
          {page !== 'settings' && <> <a href="#/settings">Open Settings →</a></>}
          <button className="btn small ghost" onClick={() => void del(`/issues/${encodeURIComponent(state?.issues[0]?.key ?? '')}`).then(load)}>Dismiss</button>
        </div></Collapse>
      )}
      {over && page !== 'settings' && (
        <Collapse key="over"><div className="banner">Today's AI budget is used up. Work resumes tomorrow, or <a href="#/settings">raise the budget</a>.</div></Collapse>
      )}
      </AnimatePresence>

      <main>
        {/* mode="wait" so the outgoing page is gone before the new one rises — crossfading two
            full pages on top of each other reads as a glitch, not a transition. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={page === 'dashboard' ? `dash:${route[1]}` : page}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            {page === 'home' && <Home state={state} />}
            {page === 'dashboard' && <Dashboard key={route[1]} slug={route[1]} view={route[2]} sub={route[3]} />}
            {page === 'library' && <Library slug={route[1]} />}
            {page === 'settings' && <Settings onSaved={load} />}
          </motion.div>
        </AnimatePresence>
      </main>
      </div>
      <Toaster />
    </div>
    </MotionProvider>
  );
}
