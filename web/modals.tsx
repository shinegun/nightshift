import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, del, patch, post } from './api.ts';
import type { DashboardData, Doc, Email, Task, TaskLog } from './types.ts';
import { Markdown, Pill, timeAgo, useAction, useLive, usd } from './lib.tsx';

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <header className="modal-head"><h2>{title}</h2><button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ── Task detail with the agent's work log ──

const LOG_LABEL: Record<string, string> = { thinking: 'thinking', tool_call: 'tool', tool_result: 'result', message: 'note', error: 'error' };

export function TaskModal({ id, slug, onClose, onChange }: { id: number; slug: string; onClose: () => void; onChange: () => void }) {
  const [data, setData] = useState<{ task: Task; logs: TaskLog[] } | null>(null);
  const [showThinking, setShowThinking] = useState(false);
  const { busy, run } = useAction();
  const load = useCallback(() => api<{ task: Task; logs: TaskLog[] }>(`/tasks/${id}`).then(setData).catch(() => {}), [id]);
  useEffect(() => { void load(); }, [load]);
  useLive(slug, load);
  if (!data) return <Modal title="Task" onClose={onClose}><p className="muted">Loading…</p></Modal>;
  const t = data.task;
  const logs = data.logs.filter((l) => showThinking || l.kind !== 'thinking');
  const act = (key: string, fn: () => Promise<unknown>, msg?: string) => run(key, async () => { await fn(); await load(); onChange(); }, msg);

  return (
    <Modal wide onClose={onClose} title={<>{t.title} <Pill status={t.status} /></>}>
      <div className="meta-row mono small">
        <span>#{t.id}</span><span>{t.type}</span><span>priority {t.priority}</span><span>from {t.source}</span>
        <span>{t.steps} steps</span><span>{usd(t.cost_usd)}</span>
        {t.finished_at && <span>finished {timeAgo(t.finished_at)}</span>}
      </div>
      {t.description && <><h3>Brief</h3><Markdown text={t.description} /></>}
      {t.result && <><h3>Result</h3><Markdown text={t.result} /></>}
      {t.error && <p className="error">{t.error}</p>}
      <div className="row-actions wrap">
        {(t.status === 'todo' || t.status === 'failed' || t.status === 'cancelled') && (
          <button className="btn primary small" disabled={busy !== null} onClick={() => act('run', async () => {
            if (t.status === 'cancelled') await patch(`/tasks/${t.id}`, { status: 'todo' });
            await post(`/tasks/${t.id}/run`);
          }, 'Task started')}>{t.status === 'todo' ? 'Run now' : 'Retry'}</button>
        )}
        {t.status === 'running' && <button className="btn small" disabled={busy !== null} onClick={() => act('cancel', () => post(`/tasks/${t.id}/cancel`), 'Cancelling after the current step')}>Cancel</button>}
        {t.status !== 'running' && <button className="btn small ghost danger" disabled={busy !== null} onClick={() => confirm('Delete this task?') && act('del', async () => { await del(`/tasks/${t.id}`); onClose(); })}>Delete</button>}
      </div>
      <div className="log-head">
        <h3>Work log</h3>
        <label className="small"><input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} /> show reasoning</label>
      </div>
      {logs.length === 0 ? <p className="empty">{t.status === 'todo' ? 'Not started yet.' : 'No log entries.'}</p> : (
        <ol className="log">
          {logs.map((l) => (
            <li key={l.id} className={`log-${l.kind}`}>
              <span className="log-kind mono">{LOG_LABEL[l.kind] ?? l.kind}</span>
              <pre>{l.content}</pre>
            </li>
          ))}
          {t.status === 'running' && <li className="log-running"><span className="spinner" /> working…</li>}
        </ol>
      )}
    </Modal>
  );
}

// ── Documents ──

export function DocModal({ id, onClose, onChange }: { id: number; onClose: () => void; onChange: () => void }) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const { busy, run } = useAction();
  useEffect(() => { void api<Doc>(`/docs/${id}`).then(setDoc); }, [id]);
  if (!doc) return <Modal title="Document" onClose={onClose}><p className="muted">Loading…</p></Modal>;
  return (
    <Modal wide title={doc.title} onClose={onClose}>
      <div className="meta-row mono small"><span>{doc.kind}</span><span>created {new Date(doc.created_at).toLocaleDateString()}</span><span>updated {timeAgo(doc.updated_at)}</span></div>
      {draft === null ? <Markdown text={doc.content} /> : <textarea className="doc-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={24} />}
      <div className="row-actions">
        {draft === null ? <button className="btn small" onClick={() => setDraft(doc.content)}>Edit</button> : (
          <>
            <button className="btn small primary" disabled={busy !== null} onClick={() => run('save', async () => { const d = await api<Doc>(`/docs/${id}`, { method: 'PUT', body: { content: draft } }); setDoc(d); setDraft(null); onChange(); }, 'Saved')}>Save</button>
            <button className="btn small ghost" onClick={() => setDraft(null)}>Cancel</button>
          </>
        )}
        <button className="btn small ghost danger" onClick={() => confirm('Delete this document?') && run('del', async () => { await del(`/docs/${id}`); onChange(); onClose(); })}>Delete</button>
      </div>
    </Modal>
  );
}

// ── Email ──

function EmailField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="email-field"><span>{label}</span>{children}</label>;
}

export function EmailModal({ email, onClose, onChange, onReply }: { email?: Email; onClose: () => void; onChange: () => void; onReply: (to: string) => void }) {
  const { busy, run } = useAction();
  const [draft, setDraft] = useState(email ? { to: email.to_addr, subject: email.subject, body: email.body } : null);
  useEffect(() => { if (email?.direction === 'in' && !email.read) void post(`/emails/${email.id}/read`).then(onChange); }, [email?.id]);
  if (!email || !draft) return null;
  const pending = email.status === 'pending_approval';
  return (
    <Modal wide title={pending ? 'Review email' : email.subject} onClose={onClose}>
      <div className="meta-row mono small">
        <Pill status={email.status} />
        <span>{email.kind}</span>
        <span>{new Date(email.created_at).toLocaleString()}</span>
      </div>
      {email.error && <p className="error">{email.error}</p>}
      {pending ? (
        <div className="email-sheet">
          <EmailField label="From"><span className="email-fixed">{email.from_addr}</span></EmailField>
          <EmailField label="To"><input value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></EmailField>
          <EmailField label="Subject"><input className="email-subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></EmailField>
          <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={16} aria-label="Message" />
        </div>
      ) : (
        <div className="email-sheet">
          <EmailField label="From"><span className="email-fixed">{email.from_addr}</span></EmailField>
          <EmailField label="To"><span className="email-fixed">{email.to_addr}</span></EmailField>
          <pre className="email-body">{email.body}</pre>
        </div>
      )}
      <div className="row-actions wrap">
        {pending && (
          <>
            <button className="btn primary small" disabled={busy !== null} onClick={() => run('send', async () => { await patch(`/emails/${email.id}`, draft); await post(`/emails/${email.id}/approve`); onChange(); onClose(); }, 'Email sent')}>Approve & send</button>
            <button className="btn small ghost" disabled={busy !== null} onClick={() => run('rej', async () => { await post(`/emails/${email.id}/reject`); onChange(); onClose(); })}>Discard</button>
          </>
        )}
        {email.status === 'failed' && <button className="btn small" disabled={busy !== null} onClick={() => run('retry', async () => { await post(`/emails/${email.id}/approve`); onChange(); onClose(); }, 'Email sent')}>Retry send</button>}
        {email.direction === 'in' && <button className="btn small" onClick={() => onReply(email.from_addr)}>Reply</button>}
      </div>
    </Modal>
  );
}

export function ComposeEmailModal({ base, to = '', from, onClose, onChange }: { base: string; to?: string; from: string; onClose: () => void; onChange: () => void }) {
  const [m, setM] = useState({ to, subject: '', body: '' });
  const { busy, run } = useAction();
  return (
    <Modal wide title="New email" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void run('send', async () => { await post(`${base}/emails`, m); onChange(); onClose(); }, 'Email sent'); }}>
        <div className="email-sheet">
          {from && <EmailField label="From"><span className="email-fixed">{from}</span></EmailField>}
          <EmailField label="To"><input required autoFocus type="email" placeholder="name@company.com" value={m.to} onChange={(e) => setM({ ...m, to: e.target.value })} /></EmailField>
          <EmailField label="Subject"><input required className="email-subject" placeholder="What it's about" value={m.subject} onChange={(e) => setM({ ...m, subject: e.target.value })} /></EmailField>
          <textarea required rows={14} placeholder="Write your message…" value={m.body} onChange={(e) => setM({ ...m, body: e.target.value })} aria-label="Message" />
        </div>
        <div className="row-actions wrap">
          <button className="btn primary" disabled={busy !== null}>Send</button>
        </div>
      </form>
    </Modal>
  );
}

// ── New task / campaign ──

export function NewTaskModal({ base, onClose, onChange }: { base: string; onClose: () => void; onChange: () => void }) {
  const [t, setT] = useState({ title: '', description: '', type: 'feature', priority: 2 });
  const { busy, run } = useAction();
  const submit = (runNow: boolean) => run('new', async () => { await post(`${base}/tasks`, { ...t, run: runNow }); onChange(); onClose(); }, runNow ? 'Task started' : 'Task added');
  return (
    <Modal title="New task" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(false); }}>
        <input required autoFocus placeholder="What should be done?" value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} />
        <textarea rows={6} placeholder="Details, context, and what 'done' looks like" value={t.description} onChange={(e) => setT({ ...t, description: e.target.value })} />
        <div className="row">
          <select value={t.type} onChange={(e) => setT({ ...t, type: e.target.value })} aria-label="Type">
            <option value="feature">Feature (website)</option><option value="fix">Fix (website)</option><option value="research">Research</option>
            <option value="marketing">Marketing</option><option value="outreach">Outreach</option><option value="support">Support</option><option value="ops">Ops</option>
          </select>
          <select value={t.priority} onChange={(e) => setT({ ...t, priority: Number(e.target.value) })} aria-label="Priority">
            <option value={1}>High</option><option value={2}>Normal</option><option value={3}>Low</option>
          </select>
        </div>
        <div className="row-actions">
          <button className="btn" disabled={busy !== null || !t.title.trim()}>Add to queue</button>
          <button type="button" className="btn primary" disabled={busy !== null || !t.title.trim()} onClick={() => submit(true)}>Add & run now</button>
        </div>
      </form>
    </Modal>
  );
}

export function NewAdModal({ base, link, onClose, onChange }: { base: string; link: string; onClose: () => void; onChange: () => void }) {
  const [a, setA] = useState({ name: '', headline: '', body: '', link, countries: 'MY', dailyBudget: 5 });
  const { busy, run } = useAction();
  return (
    <Modal title="New Meta campaign" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run('ad', async () => { await post(`${base}/ads`, a); onChange(); onClose(); }, 'Campaign created (paused)'); }}>
        <input required placeholder="Campaign name" value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} />
        <input required maxLength={40} placeholder="Headline (≤40 chars)" value={a.headline} onChange={(e) => setA({ ...a, headline: e.target.value })} />
        <textarea required maxLength={125} rows={3} placeholder="Primary text (≤125 chars)" value={a.body} onChange={(e) => setA({ ...a, body: e.target.value })} />
        <input required type="url" placeholder="https://…" value={a.link} onChange={(e) => setA({ ...a, link: e.target.value })} />
        <div className="row">
          <label className="field"><span>Countries</span><input value={a.countries} onChange={(e) => setA({ ...a, countries: e.target.value })} /></label>
          <label className="field"><span>Daily budget</span><input type="number" min={1} step={1} value={a.dailyBudget} onChange={(e) => setA({ ...a, dailyBudget: Number(e.target.value) })} /></label>
        </div>
        <p className="hint">Created paused. Nothing spends until you press Start.</p>
        <button className="btn primary" disabled={busy !== null}>Create campaign</button>
      </form>
    </Modal>
  );
}

// ── Company settings (identity + per-company account overrides) ──

const OVERRIDES: { key: string; label: string; secret?: boolean }[] = [
  { key: 'email_from', label: 'Send-from address (overrides global)' },
  { key: 'x_api_key', label: 'X consumer key', secret: true },
  { key: 'x_api_secret', label: 'X consumer secret', secret: true },
  { key: 'x_access_token', label: 'X access token', secret: true },
  { key: 'x_access_secret', label: 'X access token secret', secret: true },
  { key: 'x_bearer_token', label: 'X bearer token (read-only, cannot post)', secret: true },
  { key: 'meta_access_token', label: 'Meta access token', secret: true },
  { key: 'meta_ad_account_id', label: 'Meta ad account ID' },
  { key: 'meta_page_id', label: 'Meta Page ID' },
  { key: 'stripe_secret_key', label: 'Stripe secret key (own account)', secret: true },
  { key: 'writing_voice', label: 'Writing voice (e.g. "warm, a bit playful")' },
  { key: 'writing_spelling', label: 'Spelling: auto, british or american' },
];

/** What a deploy is allowed to put on the public website (see server/publish.ts). */
const PUBLISH_RULES: { key: string; label: string; placeholder: string }[] = [
  { key: 'publish_include', label: 'Always publish (globs)', placeholder: 'data/*.json, assets/**' },
  { key: 'publish_exclude', label: 'Never publish (globs)', placeholder: 'pricing.html, drafts/*' },
];

export function CompanySettingsModal({ d, base, onClose, onChange }: { d: DashboardData; base: string; onClose: () => void; onChange: () => void }) {
  const c = d.company;
  const [f, setF] = useState({ name: c.name, tagline: c.tagline, email: c.email, vercel_project: c.vercel_project });
  const [ov, setOv] = useState<Record<string, string | null>>({});
  const { busy, run } = useAction();
  return (
    <Modal wide title="Company settings" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run('save', async () => { await patch(base, { ...f, overrides: ov }); onChange(); onClose(); }, 'Saved'); }}>
        <label className="field"><span>Name</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>Tagline</span><input value={f.tagline} onChange={(e) => setF({ ...f, tagline: e.target.value })} /></label>
        <label className="field"><span>Company email address</span><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="hello+slug@yourdomain.com" /></label>
        <label className="field"><span>Vercel project name</span><input value={f.vercel_project} onChange={(e) => setF({ ...f, vercel_project: e.target.value })} placeholder={`${c.slug}-site`} /></label>
        <h3>Use different accounts for this company</h3>
        <p className="hint">Leave blank to use the global accounts from Settings.</p>
        <div className="field-grid">
          {OVERRIDES.map((o) => {
            const cur = d.overrides[o.key];
            return (
              <label key={o.key} className="field">
                <span>{o.label}{cur?.set && <em className="saved"> · saved {o.secret ? cur.hint : ''}</em>}</span>
                <div className="row">
                  <input
                    type={o.secret ? 'password' : 'text'} autoComplete="off"
                    placeholder={cur?.set ? (o.secret ? 'unchanged' : cur.value) : 'use global'}
                    value={ov[o.key] ?? ''} onChange={(e) => setOv({ ...ov, [o.key]: e.target.value })}
                  />
                  {cur?.set && <button type="button" className="btn small ghost" onClick={() => setOv({ ...ov, [o.key]: null })}>{ov[o.key] === null ? 'will clear' : 'Clear'}</button>}
                </div>
              </label>
            );
          })}
        </div>
        <h3>What may go on the website</h3>
        <p className="hint">
          A deploy publishes only the files this company's pages link. Use these to force files in or keep them out.
          Dotfiles, key-shaped filenames, tooling folders and any page holding something credential-shaped are never
          published, whatever is written here.
        </p>
        <div className="field-grid">
          {PUBLISH_RULES.map((o) => {
            const cur = d.overrides[o.key];
            return (
              <label key={o.key} className="field">
                <span>{o.label}{cur?.value ? ` · ${cur.value}` : ''}</span>
                <div className="row">
                  <input
                    type="text" autoComplete="off"
                    placeholder={cur?.value || o.placeholder}
                    value={ov[o.key] ?? ''} onChange={(e) => setOv({ ...ov, [o.key]: e.target.value })}
                  />
                  {cur?.set && <button type="button" className="btn small ghost" onClick={() => setOv({ ...ov, [o.key]: null })}>{ov[o.key] === null ? 'will clear' : 'Clear'}</button>}
                </div>
              </label>
            );
          })}
        </div>
        <button className="btn primary" disabled={busy !== null}>Save</button>
      </form>
    </Modal>
  );
}
