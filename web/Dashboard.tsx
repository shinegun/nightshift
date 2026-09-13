import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, patch, post } from './api.ts';
import type { Activity, DashboardData } from './types.ts';
import { Toggle, go, timeAgo, useAction, useLive } from './lib.tsx';
import { MOODS, Mascot } from './Mascot.tsx';
import { Chat } from './Chat.tsx';
import {
  AdsCard, ApprovalsCard, BriefCard, BusinessCard, DocsCard, EmailCard, PaymentsCard, ReportCard, TasksCard, WaitlistCard, WebsiteCard, XCard,
} from './panels.tsx';
import { CompanySettingsModal, ComposeEmailModal, DocModal, EmailModal, NewAdModal, NewTaskModal, TaskModal } from './modals.tsx';

export type ModalState =
  | null
  | { kind: 'task'; id: number }
  | { kind: 'doc'; id: number }
  | { kind: 'email'; id: number }
  | { kind: 'settings' }
  | { kind: 'newTask' }
  | { kind: 'compose'; to?: string }
  | { kind: 'newAd' };

function Terminal({ lines }: { lines: Activity[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [lines.length]);
  return (
    <div className="terminal" ref={ref} aria-label="Activity feed">
      {lines.length === 0 ? <div className="line dim">&gt; Waiting for activity…</div> : lines.map((l) => (
        <div className="line" key={l.id}>
          <span className="ts">{new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          {/* No actor means the agents did this on their own, which is most lines and needs no label. */}
          {l.actor && <span className="actor">{l.actor}</span>}
          {l.text}
        </div>
      ))}
    </div>
  );
}

export function Dashboard({ slug }: { slug: string }) {
  const [d, setD] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const { busy, run } = useAction();

  const load = useCallback(
    () => api<DashboardData>(`/companies/${encodeURIComponent(slug)}`).then((x) => { setD(x); setError(''); }).catch((e) => setError(e.message)),
    [slug],
  );
  useEffect(() => { void load(); }, [load]);
  useLive(slug, load);

  if (error && !d) return <div className="container"><div className="alert">{error} · <a href="#/">Back to companies</a></div></div>;
  if (!d) return <div className="container"><p className="muted">Loading…</p></div>;

  const c = d.company;
  const base = `/companies/${encodeURIComponent(slug)}`;
  const mood = c.status === 'error' ? 'confused' : c.status === 'bootstrapping' ? 'booting' : d.running ? 'working'
    : d.night && c.night_mode ? 'night' : c.mood === 'triumphant' ? 'triumphant' : 'idle';
  const closeMenu = (e: React.MouseEvent) => (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
  const ctx = { d, slug, base, load, setModal };

  return (
    <div className="container dash">
      <Terminal lines={d.activity} />

      <header className="dash-head">
        <div className="dash-title">
          <Mascot mood={mood} size={96} />
          <div>
            <div className="bubble"><strong>{MOODS[mood]?.label}</strong> <span>{MOODS[mood]?.line}</span></div>
            <h1>{c.name}</h1>
            {c.tagline && <p className="tagline">{c.tagline}</p>}
          </div>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => setChatOpen(true)}>Talk to your co-founder</button>
          <details className="menu">
            <summary className="btn">More ▾</summary>
            <div className="menu-items" onClick={closeMenu}>
              <button onClick={() => setModal({ kind: 'settings' })}>Company settings</button>
              <button disabled={c.status !== 'live'} onClick={() => run('night', () => post(`${base}/night`), 'Planned the next tasks')}>Plan next tasks now</button>
              <button disabled={c.status !== 'live'} onClick={() => run('report', () => post(`${base}/report`), 'Report written')}>Write report now</button>
              <button disabled={c.status === 'bootstrapping'} onClick={() => run('boot', () => post(`${base}/bootstrap`), 'Setup restarted')}>Re-run setup steps</button>
              <button className="danger" onClick={() => {
                if (confirm(`Delete ${c.name}, its website and all its data? This can't be undone.`)) {
                  void run('delete', async () => { await del(base); go('/'); });
                }
              }}>Delete company</button>
            </div>
          </details>
        </div>
      </header>

      <div className="modes">
        <Toggle on={Boolean(c.auto_mode)} disabled={busy === 'mode'} label={<><strong>⚡ Auto Mode</strong><small>work the queue during the day</small></>}
          onChange={(v) => run('mode', async () => { await patch(base, { auto_mode: v }); await load(); })} />
        <Toggle on={Boolean(c.night_mode)} disabled={busy === 'mode'} label={<><strong>☾ Night Task</strong><small>plan + work overnight, report at dawn</small></>}
          onChange={(v) => run('mode', async () => { await patch(base, { night_mode: v }); await load(); })} />
      </div>

      {c.status === 'error' && (
        <div className="alert">
          Setup stopped before finishing — the last line of the feed above says why. Fix it (usually a missing or out-of-credit API key), then{' '}
          <button className="btn small" disabled={busy === 'boot'} onClick={() => run('boot', () => post(`${base}/bootstrap`), 'Setup restarted')}>Retry setup</button>
        </div>
      )}

      <BriefCard {...ctx} />
      <ApprovalsCard {...ctx} />

      <div className="grid">
        <BusinessCard {...ctx} />
        <WebsiteCard {...ctx} />
        <TasksCard {...ctx} />
        <DocsCard {...ctx} />
        <ReportCard {...ctx} />
        <XCard {...ctx} />
        <EmailCard {...ctx} />
        <AdsCard {...ctx} />
        <PaymentsCard {...ctx} />
        <WaitlistCard {...ctx} />
      </div>
      <p className="muted small footer-note">Created {timeAgo(c.created_at)} · AI spend on this company so far ${d.spendTotal.toFixed(3)}</p>

      {modal?.kind === 'task' && <TaskModal id={modal.id} slug={slug} onClose={() => setModal(null)} onChange={load} />}
      {modal?.kind === 'doc' && <DocModal id={modal.id} onClose={() => setModal(null)} onChange={load} />}
      {modal?.kind === 'email' && <EmailModal email={d.emails.find((e) => e.id === modal.id)} onClose={() => setModal(null)} onChange={load} onReply={(to) => setModal({ kind: 'compose', to })} />}
      {modal?.kind === 'settings' && <CompanySettingsModal d={d} base={base} onClose={() => setModal(null)} onChange={load} />}
      {modal?.kind === 'newTask' && <NewTaskModal base={base} onClose={() => setModal(null)} onChange={load} />}
      {modal?.kind === 'compose' && <ComposeEmailModal base={base} to={modal.to} from={c.email} onClose={() => setModal(null)} onChange={load} />}
      {modal?.kind === 'newAd' && <NewAdModal base={base} link={c.site_url} onClose={() => setModal(null)} onChange={load} />}
      {chatOpen && <Chat slug={slug} name={c.name} onClose={() => setChatOpen(false)} />}
    </div>
  );
}

export type PanelProps = {
  d: DashboardData;
  slug: string;
  base: string;
  load: () => Promise<void>;
  setModal: (m: ModalState) => void;
};
