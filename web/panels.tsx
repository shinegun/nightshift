import { useEffect, useState } from 'react';
import { api, patch, post } from './api.ts';
import type { AdCampaign, GitState, Task, TaskStatus } from './types.ts';
import { Card, Empty, HealthNote, Markdown, Pill, money, timeAgo, toast, useAction } from './lib.tsx';
import { TaskQueue, TYPE_LABEL } from './TaskQueue.tsx';
import type { PanelProps } from './Dashboard.tsx';

// ── Today ──

const KIND_LABEL: Record<string, string> = {
  budget: 'budget', commit: 'push', email: 'email', post: 'post', ad: 'ads', request: 'you', blocked: 'blocked',
};

/**
 * The whole morning, in one card: how many decisions, what they are, and what ran. Everything
 * else on this page is here for when you go looking, not for you to read every day.
 */
export function BriefCard({ d }: PanelProps) {
  const list = d.decisions ?? [];
  const unfinished = d.tasks.filter((t) => t.status === 'failed');
  return (
    <Card title="Today" className="brief">
      <p className="brief-head">
        {list.length ? `${list.length} decision${list.length === 1 ? '' : 's'} for you.` : 'Nothing needs you.'}
      </p>
      {list.length > 0 && (
        <ol className="brief-list">
          {list.map((item, i) => (
            <li key={`${item.kind}${item.id ?? i}`}>
              <span className={`badge type-${item.kind === 'budget' || item.kind === 'blocked' ? 'fix' : 'research'}`}>{KIND_LABEL[item.kind] ?? item.kind}</span>
              <span>{item.title}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="muted small brief-foot">
        {d.tasks.length ? `${d.tasks.filter((t) => t.status === 'done').length} tasks done` : 'No tasks yet'}
        {unfinished.length > 0 && `, ${unfinished.length} unfinished`}.
      </p>
    </Card>
  );
}

// ── Needs you ──

export function ApprovalsCard({ d, load, setModal }: PanelProps) {
  const { busy, run } = useAction();
  const emails = d.emails.filter((e) => e.status === 'pending_approval');
  const tweets = d.tweets.filter((t) => t.status === 'pending_approval');
  const ads = d.ads.filter((a) => a.status === 'paused');
  const failed = d.tasks.filter((t) => t.status === 'failed').length;
  const requests = d.requests ?? [];
  const [answering, setAnswering] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const commits = (d.commits ?? []).filter((g) => g.status === 'pending_approval' || g.status === 'failed');
  if (!emails.length && !tweets.length && !ads.length && !failed && !requests.length && !commits.length) return null;
  const act = (key: string, path: string, msg: string) => run(key, async () => { await post(path); await load(); }, msg);

  return (
    <Card title="Needs you" className="approvals">
      <ul className="list">
        {commits.map((g) => (
          <li key={`g${g.id}`} className="list-item request">
            <div className="grow">
              <div className="task-title"><span className="badge warn">Push</span><strong>{g.message}</strong></div>
              <p className="muted small mono">{g.branch}{g.remote ? ` \u2192 ${g.remote}` : ' (no remote)'}</p>
              {g.summary && <pre className="email-body">{g.summary}</pre>}
              {g.error && <p className="error small">{g.error}</p>}
              <div className="row-actions wrap">
                <button className="btn small primary" disabled={busy !== null}
                  onClick={() => act(`g${g.id}`, `/commits/${g.id}/approve`, 'Pushed')}>
                  {g.status === 'failed' ? 'Try the push again' : 'Approve and push'}
                </button>
                <button className="btn small ghost" disabled={busy !== null}
                  onClick={() => act(`gr${g.id}`, `/commits/${g.id}/reject`, 'Discarded')}>Discard</button>
              </div>
            </div>
          </li>
        ))}
        {requests.map((r) => (
          <li key={`r${r.id}`} className="list-item request">
            <div className="grow">
              <div className="task-title"><span className="badge warn">Your turn</span><strong>{r.title}</strong></div>
              {r.why && <p className="muted small">{r.why}</p>}
              {r.steps && <Markdown text={r.steps} />}
              {r.unblocks && <p className="muted small">Unblocks: {r.unblocks}</p>}
              {answering === r.id ? (
                <div className="stack">
                  <input autoFocus placeholder="Optional note back, e.g. the repo URL" value={note} onChange={(e) => setNote(e.target.value)} />
                  <div className="row-actions">
                    <button className="btn small primary" disabled={busy !== null} onClick={() => run(`req${r.id}`, async () => {
                      await post(`/requests/${r.id}/done`, { answer: note });
                      setAnswering(null); setNote('');
                      await load();
                    }, 'Thanks. The team can carry on.')}>Save</button>
                    <button className="btn small ghost" onClick={() => setAnswering(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="row-actions">
                  <button className="btn small primary" disabled={busy !== null} onClick={() => { setNote(''); setAnswering(r.id); }}>I've done this</button>
                  <button className="btn small ghost" disabled={busy !== null} onClick={() => run(`req${r.id}`, async () => { await post(`/requests/${r.id}/dismiss`); await load(); }, 'Dismissed')}>Not doing it</button>
                </div>
              )}
            </div>
          </li>
        ))}
        {tweets.map((t) => (
          <li key={`t${t.id}`} className="list-item">
            <div className="grow"><span className="badge">X post</span> {t.text}</div>
            <div className="row-actions">
              <button className="btn small primary" disabled={busy !== null} onClick={() => act(`t${t.id}`, `/tweets/${t.id}/approve`, 'Posted to X')}>Post</button>
              <button className="btn small ghost" disabled={busy !== null} onClick={() => act(`t${t.id}`, `/tweets/${t.id}/reject`, 'Discarded')}>Discard</button>
            </div>
          </li>
        ))}
        {emails.map((e) => (
          <li key={`e${e.id}`} className="list-item clickable" onClick={() => setModal({ kind: 'email', id: e.id })}>
            <div className="grow"><span className="badge">Email</span> To {e.to_addr}: <strong>{e.subject}</strong></div>
            <div className="row-actions" onClick={(ev) => ev.stopPropagation()}>
              <button className="btn small primary" disabled={busy !== null} onClick={() => act(`e${e.id}`, `/emails/${e.id}/approve`, 'Email sent')}>Send</button>
              <button className="btn small ghost" disabled={busy !== null} onClick={() => act(`e${e.id}`, `/emails/${e.id}/reject`, 'Discarded')}>Discard</button>
            </div>
          </li>
        ))}
        {ads.map((a) => (
          <li key={`a${a.id}`} className="list-item">
            <div className="grow"><span className="badge">Meta ad</span> {a.name} · {(a.daily_budget_cents / 100).toFixed(2)}/day (paused)</div>
            <div className="row-actions">
              <button className="btn small primary" disabled={busy !== null} onClick={() => act(`a${a.id}`, `/ads/${a.id}/activate`, 'Campaign is live')}>Start spending</button>
            </div>
          </li>
        ))}
        {failed > 0 && <li className="list-item"><div className="grow"><span className="badge warn">Tasks</span> {failed} task{failed > 1 ? 's' : ''} failed — open the Failed tab to retry.</div></li>}
      </ul>
    </Card>
  );
}

// ── Business ──

export function BusinessCard({ d }: PanelProps) {
  const m = d.metrics;
  return (
    <Card title="Business">
      <div className="stats">
        <div className="stat"><span className="stat-label">Visitors · 7d</span><span className="stat-value">{m.visitors_7d}</span><span className="stat-sub">{m.visitors_total} all time · {m.pageviews_7d} views</span></div>
        <div className="stat"><span className="stat-label">Waitlist</span><span className="stat-value">{m.waitlist}</span></div>
        <div className="stat"><span className="stat-label">Revenue</span><span className="stat-value">{d.revenueTotal[0] ?? '0.00'}</span>{d.revenueTotal.slice(1).map((r) => <span key={r} className="stat-sub">{r}</span>)}</div>
        <div className="stat"><span className="stat-label">Tasks done</span><span className="stat-value">{m.tasks_done}</span><span className="stat-sub">{m.tasks_open} open</span></div>
      </div>
      <HealthNote h={d.health.stripe} label="Revenue tracking" />
    </Card>
  );
}

// ── Website ──

/**
 * Whether this company's site folder is under version control, and what state it is in. Fetched
 * separately from the dashboard payload: asking git costs a subprocess, and the dashboard polls.
 */
function GitLine({ slug }: { slug: string }) {
  const [git, setGit] = useState<GitState | null>(null);
  useEffect(() => { api<GitState>(`/companies/${encodeURIComponent(slug)}/git`).then(setGit).catch(() => setGit(null)); }, [slug]);

  if (!git) return <div className="kv"><span>Git</span><span className="muted">checking…</span></div>;
  if (git.error) return <div className="kv"><span>Git</span><span className="error">{git.error}</span></div>;
  if (!git.repo) {
    return (
      <div className="kv">
        <span>Git</span>
        <span className="muted">
          not a repository. Agents can still write and deploy; they just cannot record or share the work.
          Run <code>git init</code> and add a remote in the site folder to turn it on.
        </span>
      </div>
    );
  }
  const dirty = git.changedCount
    ? `${git.changedCount} uncommitted change${git.changedCount === 1 ? '' : 's'}`
    : 'nothing uncommitted';
  return (
    <div className="kv">
      <span>Git</span>
      <span>
        <span className="mono">{git.branch}</span> · {dirty}
        {git.ahead > 0 && ` · ${git.ahead} unpushed`}
        {git.remote ? <span className="muted"> · {git.remote.replace(/^git@github\.com:|^https:\/\/github\.com\//, '').replace(/\.git$/, '')}</span>
          : <span className="muted"> · no remote, so nothing can be pushed</span>}
      </span>
    </div>
  );
}

export function WebsiteCard({ d, base, load }: PanelProps) {
  const { busy, run } = useAction();
  const [version, setVersion] = useState('');
  const c = d.company;
  return (
    <Card title="Website" action={<a className="btn small ghost" href={d.previewUrl} target="_blank" rel="noreferrer">Open preview ↗</a>}>
      <div className="site-preview">
        <iframe title="Website preview" src={d.previewUrl} sandbox="allow-scripts allow-forms" />
      </div>
      <div className="kv">
        <span>Public URL</span>
        {c.site_url ? <a href={c.site_url} target="_blank" rel="noreferrer">{c.site_url.replace(/^https:\/\//, '')}</a> : <span className="muted">not deployed</span>}
      </div>
      <div className="kv"><span>Folder</span><span>{d.files.length} files · {(d.files.reduce((s, f) => s + f.size, 0) / 1024).toFixed(1)} KB</span></div>
      <GitLine slug={d.company.slug} />
      <div className="kv">
        <span>Publishes</span>
        <span>{d.publish.files.length} files · {(d.publish.bytes / 1024).toFixed(1)} KB{d.publish.skipped.length ? ` · ${d.publish.skipped.length} kept private` : ''}</span>
      </div>
      <details className="publish">
        <summary>What goes live, and what stays private</summary>
        <p className="hint">Goes live:</p>
        <ul className="publish-list">
          {d.publish.files.map((f) => <li key={f.path}><code>{f.path}</code><span className="muted"> — {f.reason}</span></li>)}
        </ul>
        {d.publish.skipped.length > 0 && (
          <>
            <p className="hint">Stays private:</p>
            <ul className="publish-list kept">
              {d.publish.skipped.map((f) => <li key={f.path}><code>{f.path}</code><span className="muted"> — {f.reason}</span></li>)}
            </ul>
          </>
        )}
        {d.publish.missing.map((m) => <p className="hint" key={m}>A page asks for <code>{m}</code> and it is not in the folder yet. The page has to handle that itself.</p>)}
        {d.publish.warnings.map((w) => <p className="hint" key={w}>{w}</p>)}
      </details>
      {d.publish.blocked.length > 0 && (
        <p className="health error">Deploy blocked — {d.publish.blocked.join('; ')}</p>
      )}
      <div className="row-actions wrap">
        {d.integrations.vercel ? (
          <button className="btn small primary" disabled={busy === 'deploy' || !d.publish.files.length || d.publish.blocked.length > 0}
            onClick={() => run('deploy', async () => { await post(`${base}/deploy`); await load(); }, 'Deployed to Vercel')}>
            {busy === 'deploy' ? 'Deploying…' : c.site_url ? 'Redeploy' : 'Deploy to Vercel'}
          </button>
        ) : null}
        {d.versions.length > 0 && (
          <>
            <select value={version} onChange={(e) => setVersion(e.target.value)} aria-label="Site version">
              <option value="">Versions ({d.versions.length})…</option>
              {d.versions.map((v) => <option key={v.id} value={v.id}>{new Date(v.ts).toLocaleString()} — {v.label}</option>)}
            </select>
            <button className="btn small" disabled={!version || busy === 'restore'}
              onClick={() => confirm('Restore this version? The current site is saved as a version first.') && run('restore', async () => { await post(`${base}/versions/${version}/restore`); setVersion(''); await load(); }, 'Version restored')}>
              Restore
            </button>
          </>
        )}
      </div>
      <HealthNote h={d.health.vercel} label="Publishing" />
      {c.site_url && <HealthNote h={d.health.publicUrl} label="Visitor tracking" />}
    </Card>
  );
}

// ── Tasks ──

const TABS: { key: TaskStatus; label: string }[] = [
  { key: 'todo', label: 'To do' }, { key: 'running', label: 'Running' }, { key: 'blocked', label: 'Waiting on you' },
  { key: 'done', label: 'Done' }, { key: 'failed', label: 'Failed' },
];

export function TasksCard({ d, base, load, setModal }: PanelProps) {
  const [tab, setTab] = useState<TaskStatus>('todo');
  const { busy, run } = useAction();
  const counts = Object.fromEntries(TABS.map((t) => [t.key, d.tasks.filter((x) => x.status === t.key).length]));
  const rows = d.tasks.filter((t) => t.status === tab);
  const runNow = (t: Task) => run(`run${t.id}`, async () => { await post(`/tasks/${t.id}/run`); await load(); }, 'Task started');

  return (
    <Card title="Tasks" className="span-2" action={<button className="btn small" onClick={() => setModal({ kind: 'newTask' })}>+ New task</button>}>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label} <span className="count">{counts[t.key]}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 ? <Empty>{tab === 'todo' ? 'Queue is empty. Add a task, ask your co-founder, or let Night Task plan some.' : 'Nothing here.'}</Empty> : tab === 'todo' ? (
        <TaskQueue tasks={rows} base={base} disabled={busy !== null} running={d.running} onOpen={(id) => setModal({ kind: 'task', id })} onRun={runNow} onSaved={load} />
      ) : (
        <ul className="list tasks">
          {rows.map((t) => (
            <li key={t.id} className="list-item clickable" onClick={() => setModal({ kind: 'task', id: t.id })}>
              <div className="grow">
                <div className="task-title"><span className={`badge type-${t.type}`}>{TYPE_LABEL[t.type] ?? t.type}</span>{t.priority === 1 && <span className="badge warn">High</span>}<strong>{t.title}</strong></div>
                <p className="muted clamp small">{t.status === 'done' || t.status === 'blocked' ? (t.result ?? '').replace(/[#*_`]/g, '') : t.status === 'failed' ? t.error : t.description}</p>
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                {t.status === 'running' && <span className="spinner" aria-label="Running" />}
                {(t.status === 'todo' || t.status === 'failed') && (
                  <button className="btn small" disabled={busy !== null || d.running} title={d.running ? 'Another task is running' : ''} onClick={() => runNow(t)}>
                    {t.status === 'failed' ? 'Retry' : 'Run'}
                  </button>
                )}
                {t.status === 'done' && <span className="muted small">{timeAgo(t.finished_at)}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Documents ──

export function DocsCard({ d, setModal }: PanelProps) {
  return (
    <Card title="Documents">
      {d.docs.length === 0 ? <Empty>Mission, research and roadmap appear here once setup runs.</Empty> : (
        <ul className="list docs">
          {d.docs.map((doc) => (
            <li key={doc.id} className="list-item clickable" onClick={() => setModal({ kind: 'doc', id: doc.id })}>
              <span className="doc-icon" aria-hidden>▤</span>
              <div className="grow"><strong>{doc.title}</strong><div className="muted small">{doc.kind} · updated {timeAgo(doc.updated_at)}</div></div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Morning report ──

/** The section headings both the written report and the plain fallback use. */
const REPORT_SECTIONS = ['done overnight', 'numbers', 'needs you', "today's focus"];

/**
 * The report is plain text, because it is also an email. Here we give it back the shape the
 * text implies: headings as headings, indented detail lines as indented detail.
 */
function ReportBody({ text }: { text: string }) {
  return (
    <div className="report">
      {text.split('\n').map((raw, k) => {
        const line = raw.trim();
        if (!line) return null;
        const heading = line.replace(/:$/, '');
        if (REPORT_SECTIONS.includes(heading.toLowerCase())) return <h4 key={k}>{heading}</h4>;
        if (k === 0) return <p key={k} className="report-lede">{line}</p>;
        return <p key={k} className={`report-line${/^\s\s+\S/.test(raw) ? ' indent' : ''}`}>{line}</p>;
      })}
    </div>
  );
}

export function ReportCard({ d, base, load }: PanelProps) {
  const { busy, run } = useAction();
  const [i, setI] = useState(0);
  const r = d.reports[i];
  return (
    <Card title="Morning report" action={
      <button className="btn small ghost" disabled={busy === 'rep' || d.company.status !== 'live'} onClick={() => run('rep', async () => { await post(`${base}/report`); setI(0); await load(); }, 'Report written')}>
        {busy === 'rep' ? 'Writing…' : 'Write now'}
      </button>
    }>
      {!r ? <Empty>Your first report arrives the morning after launch.</Empty> : (
        <>
          <div className="report-nav">
            <button className="btn small ghost" disabled={i >= d.reports.length - 1} onClick={() => setI(i + 1)}>‹</button>
            <span className="mono small">{r.day}</span>
            <button className="btn small ghost" disabled={i === 0} onClick={() => setI(i - 1)}>›</button>
          </div>
          <ReportBody text={r.content} />
        </>
      )}
    </Card>
  );
}

// ── X ──

export function XCard({ d, base, load }: PanelProps) {
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const [edit, setEdit] = useState<{ id: number; text: string } | null>(null);
  const shown = d.tweets.filter((t) => t.status !== 'rejected').slice(0, 6);
  return (
    <Card title="X (Twitter)">
      <HealthNote h={d.health.x} label="Posting to X" />
      {shown.length === 0 ? <Empty>No posts yet.</Empty> : (
        <ul className="list">
          {shown.map((t) => (
            <li key={t.id} className="tweet">
              {edit?.id === t.id ? (
                <>
                  <textarea value={edit.text} onChange={(e) => setEdit({ id: t.id, text: e.target.value })} rows={3} maxLength={280} />
                  <div className="row-actions">
                    <span className="muted small">{edit.text.length}/280</span>
                    <button className="btn small" onClick={() => run('save', async () => { await patch(`/tweets/${t.id}`, { text: edit.text }); setEdit(null); await load(); })}>Save</button>
                    <button className="btn small ghost" onClick={() => setEdit(null)}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <p>{t.text}</p>
                  <div className="row-actions">
                    <Pill status={t.status} />
                    <span className="muted small">{timeAgo(t.posted_at ?? t.created_at)}</span>
                    {t.status === 'posted' && t.external_id && <a className="small" href={`https://x.com/i/status/${t.external_id}`} target="_blank" rel="noreferrer">view ↗</a>}
                    {(t.status === 'pending_approval' || t.status === 'failed') && <button className="btn small ghost" onClick={() => setEdit({ id: t.id, text: t.text })}>Edit</button>}
                    {t.status === 'failed' && (
                      <button className="btn small primary" disabled={busy !== null}
                        onClick={() => run(`retry${t.id}`, async () => { await post(`/tweets/${t.id}/approve`); await load(); }, 'Sent to X')}>
                        Try posting again
                      </button>
                    )}
                  </div>
                  {t.error && <p className="error small">{t.error}</p>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="compose-inline" onSubmit={(e) => { e.preventDefault(); void run('tw', async () => { await post(`${base}/tweets`, { text }); setText(''); await load(); }, 'Posted'); }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={280} placeholder="Write a post yourself…" />
        <button className="btn small" disabled={!text.trim() || busy === 'tw' || !d.integrations.x}>Post now</button>
      </form>
    </Card>
  );
}

// ── Email ──

export function EmailCard({ d, setModal }: PanelProps) {
  const [tab, setTab] = useState<'in' | 'out'>('in');
  const rows = d.emails.filter((e) => e.direction === tab).slice(0, 12);
  const received = d.emails.filter((e) => e.direction === 'in').length;
  const sent = d.emails.filter((e) => e.direction === 'out' && e.status === 'sent').length;
  return (
    <Card title="Email" action={<button className="btn small" disabled={!d.integrations.email} onClick={() => setModal({ kind: 'compose' })}>Compose</button>}>
      {d.company.email ? <p className="mono small address">{d.company.email}</p> : null}
      <HealthNote h={d.health.email} label="Sending" />
      <HealthNote h={d.health.inbox} label="Inbox" />
      <div className="tabs">
        <button className={tab === 'in' ? 'active' : ''} onClick={() => setTab('in')}>Inbox <span className="count">{received}</span></button>
        <button className={tab === 'out' ? 'active' : ''} onClick={() => setTab('out')}>Sent <span className="count">{sent}</span></button>
      </div>
      {rows.length === 0 ? <Empty>{tab === 'in' ? (d.health.inbox.state === 'ready' ? 'No mail yet — replies to the company address land here.' : 'Not receiving mail yet — see the Inbox note above.') : 'Nothing sent yet.'}</Empty> : (
        <ul className="list">
          {rows.map((e) => (
            <li key={e.id} className={`list-item clickable ${e.direction === 'in' && !e.read ? 'unread' : ''}`} onClick={() => setModal({ kind: 'email', id: e.id })}>
              <div className="grow">
                <strong className="clamp-1">{e.subject}</strong>
                <div className="muted small clamp-1">{e.direction === 'in' ? e.from_addr : `to ${e.to_addr}`} · {timeAgo(e.created_at)}</div>
              </div>
              {e.direction === 'out' && e.status !== 'sent' && <Pill status={e.status} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Meta Ads ──

function insights(a: AdCampaign) {
  try { return a.insights ? (JSON.parse(a.insights) as Record<string, string>) : null; } catch { return null; }
}

export function AdsCard({ d, load, setModal }: PanelProps) {
  const { busy, run } = useAction();
  return (
    <Card title="Meta Ads" action={<button className="btn small" disabled={!d.integrations.meta} onClick={() => setModal({ kind: 'newAd' })}>+ Campaign</button>}>
      <HealthNote h={d.health.meta} label="Meta Ads" />
      {d.ads.length === 0 ? <Empty>Not running. Campaigns are always created paused — nothing spends until you press Start.</Empty> : (
        <ul className="list">
          {d.ads.map((a) => {
            const ins = insights(a);
            return (
              <li key={a.id} className="list-item">
                <div className="grow">
                  <strong>{a.name}</strong> <Pill status={a.status} />
                  <div className="muted small">{(a.daily_budget_cents / 100).toFixed(2)}/day · {a.countries}{ins ? ` · ${ins.impressions ?? 0} impr · ${ins.clicks ?? 0} clicks · ${ins.spend ?? 0} spent` : ''}</div>
                  {a.error && <p className="error small">{a.error}</p>}
                </div>
                <div className="row-actions">
                  {a.status === 'paused' && <button className="btn small primary" disabled={busy !== null} onClick={() => run(`a${a.id}`, async () => { await post(`/ads/${a.id}/activate`); await load(); }, 'Campaign is live')}>Start</button>}
                  {a.status === 'active' && <button className="btn small" disabled={busy !== null} onClick={() => run(`a${a.id}`, async () => { await post(`/ads/${a.id}/pause`); await load(); }, 'Paused')}>Pause</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ── Payments ──

export function PaymentsCard({ d, base, load }: PanelProps) {
  const { busy, run } = useAction();
  const [form, setForm] = useState({ name: '', amount: '', currency: 'myr', interval: 'one_time' });
  const [open, setOpen] = useState(false);
  return (
    <Card title="Payments" action={<button className="btn small" disabled={!d.integrations.stripe} onClick={() => setOpen(!open)}>{open ? 'Close' : '+ Payment link'}</button>}>
      <HealthNote h={d.health.stripe} label="Payments" />
      {open && (
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          void run('pl', async () => { await post(`${base}/payment-links`, { ...form, amount: Number(form.amount) }); setOpen(false); setForm({ ...form, name: '', amount: '' }); await load(); }, 'Payment link created');
        }}>
          <input required placeholder="Product name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="row">
            <input required type="number" min="0.5" step="0.01" placeholder="Price" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            <input required placeholder="Currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} style={{ maxWidth: '6rem' }} />
            <select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })}>
              <option value="one_time">One-time</option><option value="month">Monthly</option><option value="year">Yearly</option>
            </select>
          </div>
          <button className="btn small primary" disabled={busy === 'pl'}>Create</button>
        </form>
      )}
      {d.paymentLinks.length === 0 ? <Empty>No payment links yet. Agents create them when a task needs checkout.</Empty> : (
        <ul className="list">
          {d.paymentLinks.map((p) => (
            <li key={p.id} className="list-item">
              <div className="grow"><strong>{p.name}</strong><div className="muted small">{money(p.amount_cents, p.currency)}</div></div>
              <button className="btn small ghost" onClick={() => { void navigator.clipboard.writeText(p.url); toast('Link copied', 'success'); }}>Copy link</button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Waitlist ──

export function WaitlistCard({ d }: PanelProps) {
  return (
    <Card title={`Waitlist · ${d.metrics.waitlist}`}>
      {d.waitlist.length === 0 ? <Empty>Signups from your website's waitlist form land here.</Empty> : (
        <ul className="list compact">
          {d.waitlist.map((w) => <li key={w.email} className="list-item"><span className="grow mono small">{w.email}</span><span className="muted small">{timeAgo(w.created_at)}</span></li>)}
        </ul>
      )}
    </Card>
  );
}
