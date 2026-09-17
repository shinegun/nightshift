/**
 * The team, as the dashboard shows it: a card per bot on Work, and a profile page per bot.
 *
 * The profile keeps the three layers visibly apart because they have different owners. Skills are
 * shared by every company that hired this bot, so editing one says so. Memory belongs to this
 * company alone. History is what the bot did here, and it comes first: at 7am the question is
 * "what did it do", not "what should I tell it".
 */
import { useCallback, useEffect, useState } from 'react';
import { api, del, patch, post } from './api.ts';
import type { BotColor, BotProfile, BotState, BotSummary, DashboardData } from './types.ts';
import { Card, Empty, HealthNote, Pill, go, timeAgo, toast, useAction } from './lib.tsx';
import { AnimatePresence, Row } from './motion.tsx';
import { Mascot } from './Mascot.tsx';
import { Modal } from './modals.tsx';
import { TYPE_LABEL } from './TaskQueue.tsx';
import type { PanelProps } from './Dashboard.tsx';

export const BOT_COLORS: BotColor[] = ['moon', 'blue', 'green', 'coral', 'amber', 'violet', 'teal', 'pink'];

const MOOD: Record<BotState, string> = { working: 'working', waiting: 'confused', idle: 'idle', paused: 'night' };
export const STATE_LABEL: Record<BotState, string> = { working: 'working', waiting: 'needs you', idle: 'idle', paused: 'paused' };

/** The moon, on the bot's own colour. Its face is the bot's state, so a glance at the team reads it. */
export function BotAvatar({ color, state = 'idle', size = 44 }: { color: BotColor; state?: BotState; size?: number }) {
  return (
    <span className={`bot-avatar c-${color}`} style={{ width: size, height: size }} aria-hidden>
      <Mascot mood={MOOD[state]} size={Math.round(size * 1.05)} />
    </span>
  );
}

export const StateDot = ({ state }: { state: BotState }) => <span className={`state-dot s-${state}`} aria-hidden />;

/** The team list in the rail comes from the dashboard's payload, announced the same way as the Needs-you count. */
export const publishTeam = (bots: BotSummary[] | null) => dispatchEvent(new CustomEvent('ns-team', { detail: bots }));

export function useTeam(active: boolean) {
  const [bots, setBots] = useState<BotSummary[] | null>(null);
  useEffect(() => {
    if (!active) { setBots(null); return; }
    const on = (e: Event) => setBots((e as CustomEvent).detail as BotSummary[] | null);
    addEventListener('ns-team', on);
    return () => removeEventListener('ns-team', on);
  }, [active]);
  return bots;
}

export function TeamBeacon({ bots }: { bots: BotSummary[] }) {
  useEffect(() => { publishTeam(bots); }, [bots]);
  useEffect(() => () => { publishTeam(null); }, []);
  return null;
}

const botHref = (slug: string, id: number) => `#/c/${encodeURIComponent(slug)}/bot/${id}`;

// ── Work: the team card ──

export function TeamCard({ d, slug }: PanelProps) {
  const bots = d.bots ?? [];
  const handoffs = d.handoffs ?? [];
  return (
    <Card title="Team" className="span-2 team-card"
      action={<a className="btn small" href={`#/library/${encodeURIComponent(slug)}`}>+ Hire a bot</a>}>
      {handoffs.length > 0 && (
        <div className="handoffs">
          <span className="eyebrow">Handoffs today</span>
          <ul className="list compact">
            {handoffs.map((h) => (
              <li key={h.id} className="list-item">
                <span className="grow clamp-1">
                  <strong>{h.from_name}</strong> handed to <strong>{h.to_name ?? 'nobody yet'}</strong>: {h.title}
                </span>
                <Pill status={h.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {bots.length === 0 ? (
        <Empty>No bots work here yet. Hire one from the library and it picks up its kind of tasks.</Empty>
      ) : (
        <div className="bot-grid">
          {bots.map((b) => (
            <a key={b.id} className={`bot-tile state-${b.state}`} href={botHref(slug, b.id)}>
              <div className="bot-tile-head">
                <BotAvatar color={b.color} state={b.state} />
                <div className="grow">
                  <strong>{b.name}</strong>
                  <div className="small muted"><StateDot state={b.state} />{STATE_LABEL[b.state]}</div>
                </div>
                <span className="small muted">{b.queued ? `${b.queued} queued` : ''}</span>
              </div>
              <p className="small clamp-1 bot-now">
                {b.now ? <>Now: {b.now.title}</>
                  : b.state === 'waiting' ? <span className="warn-text">Waiting on you, see Today</span>
                  : b.next ? <span className="muted">Next: {b.next.title}</span>
                  : b.lastDone ? <span className="muted">Last: {b.lastDone.title} · {timeAgo(b.lastDone.finished_at)}</span>
                  : <span className="muted">Nothing yet</span>}
              </p>
              <p className="small muted clamp-1">
                {b.routines.length ? `Routine: ${b.routines[0].title}, ${b.routines[0].when}${b.routines.length > 1 ? ` (+${b.routines.length - 1})` : ''}` : 'No routines'}
              </p>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Needs you: notes to review ──

/** A bot's proposed note, as a row in Needs you. The only place a note can be kept. */
export function noteRows(d: DashboardData, act: (key: string, fn: () => Promise<unknown>, msg: string) => void, busy: string | null, editing: number | null, setEditing: (id: number | null) => void, draft: string, setDraft: (s: string) => void) {
  return (d.notesToReview ?? []).map((n) => (
    <Row key={`m${n.id}`} className="list-item request">
      <div className="grow">
        <div className="task-title"><span className="badge">{n.bot_name} wants to remember</span></div>
        {editing === n.id ? (
          <div className="stack">
            <textarea rows={2} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500} />
            <div className="row-actions">
              <button className="btn small primary" disabled={busy !== null || !draft.trim()}
                onClick={() => act(`m${n.id}`, async () => { await patch(`/memories/${n.id}`, { content: draft, status: 'active' }); setEditing(null); }, 'Kept')}>Keep this version</button>
              <button className="btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <p className="note-text">{n.content}</p>
            <p className="muted small">
              For this company only{n.source_task_id ? ` · from task #${n.source_task_id}` : ''} · {timeAgo(n.created_at)}
            </p>
            <div className="row-actions">
              <button className="btn small primary" disabled={busy !== null}
                onClick={() => act(`m${n.id}`, () => patch(`/memories/${n.id}`, { status: 'active' }), 'Kept')}>Keep</button>
              <button className="btn small" disabled={busy !== null} onClick={() => { setDraft(n.content); setEditing(n.id); }}>Edit</button>
              <button className="btn small ghost" disabled={busy !== null}
                onClick={() => act(`mf${n.id}`, () => del(`/memories/${n.id}`), 'Forgotten')}>Forget</button>
            </div>
          </>
        )}
      </div>
    </Row>
  ));
}

// ── Bot profile ──

export function BotPage({ d, slug, botId, setModal }: PanelProps & { botId: number }) {
  const [p, setP] = useState<BotProfile | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { busy, run } = useAction();
  const base = `/companies/${encodeURIComponent(slug)}/bots/${botId}`;
  const load = useCallback(() => api<BotProfile>(base).then((x) => { setP(x); setError(''); }).catch((e) => setError(e.message)), [base]);
  // The dashboard refetches on every live event; following it keeps this page just as current
  // without a second event stream.
  useEffect(() => { void load(); }, [load, d]);

  if (error && !p) return <div className="alert">{error} · <a href={`#/c/${encodeURIComponent(slug)}/work`}>Back to the team</a></div>;
  if (!p) return <p className="muted">Loading…</p>;

  const b = p.bot;
  const others = p.template.usedIn.filter((u) => u.slug !== slug);
  const closeMenu = (e: React.MouseEvent) => (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
  const proposed = p.memory.filter((m) => m.status === 'proposed');
  const kept = p.memory.filter((m) => m.status === 'active');

  return (
    <div className="bot-page">
      <a className="small muted back-link" href={`#/c/${encodeURIComponent(slug)}/work`}>← Team</a>
      <header className="card bot-head">
        <BotAvatar color={b.color} state={b.state} size={72} />
        <div className="grow">
          <h1>{b.name}</h1>
          <p className="small muted"><StateDot state={b.state} />{STATE_LABEL[b.state]} · at {d.company.name}
            {b.queued ? ` · ${b.queued} queued` : ''}</p>
          <p className="small muted">
            {p.template.builtin ? 'Built-in' : 'Your template'} “{p.template.name}” · v{p.template.version}
            {others.length ? ` · also works at ${others.map((o) => o.name).join(', ')}` : ''}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn" disabled={busy !== null}
            onClick={() => run('pause', async () => { await patch(base, { status: b.status === 'paused' ? 'active' : 'paused' }); await load(); },
              b.status === 'paused' ? `${b.name} is back at work` : `${b.name} paused`)}>
            {b.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <details className="menu">
            <summary className="btn">More ▾</summary>
            <div className="menu-items" onClick={closeMenu}>
              <button onClick={() => setSaving(true)}>Save as template</button>
              <a className="menu-link" href="#/library">Open the bot library</a>
              <button className="danger" onClick={() => {
                if (confirm(`Let ${b.name} go? Its ${p.memory.length} note${p.memory.length === 1 ? '' : 's'} about ${d.company.name} will be deleted. Its queued tasks move to another bot that does the same work, if there is one.`)) {
                  void run('fire', async () => { await del(base); go(`/c/${encodeURIComponent(slug)}/work`); }, `${b.name} let go`);
                }
              }}>Let {b.name} go</button>
            </div>
          </details>
        </div>
      </header>
      {b.status === 'paused' && <p className="health off">Paused. Its routines don't file new work, and its queued tasks still run if you press Run.</p>}
      {p.needs.filter((n) => n.state !== 'ready').map((n) => (
        <HealthNote key={n.key} h={{ state: n.state!, message: n.message ?? '' }} label={n.label} />
      ))}

      <div className="grid">
        <Card title="What it did here" className="span-2">
          {p.tasks.length === 0 ? <Empty>No work yet. Its first routine or task will show up here.</Empty> : (
            <ul className="list tasks">
              {p.tasks.map((t) => (
                <li key={t.id} className="list-item clickable" onClick={() => setModal({ kind: 'task', id: t.id })}>
                  <div className="grow">
                    <div className="task-title">
                      <span className={`badge type-${t.type}`}>{TYPE_LABEL[t.type] ?? t.type}</span>
                      {t.source.startsWith('routine:') && <span className="badge">Routine</span>}
                      {t.from_name && <span className="badge">From {t.from_name}</span>}
                      <strong>{t.title}</strong>
                    </div>
                  </div>
                  <Pill status={t.status} />
                  <span className="muted small">{timeAgo(t.finished_at ?? t.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
          {p.handedOff.length > 0 && (
            <>
              <h3>Handed to other bots</h3>
              <ul className="list compact">
                {p.handedOff.map((h) => (
                  <li key={h.id} className="list-item clickable" onClick={() => setModal({ kind: 'task', id: h.id })}>
                    <span className="grow clamp-1">→ {h.to_name ?? 'no bot'}: {h.title}</span>
                    <Pill status={h.status} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title={`Memory · ${d.company.name} only`}>
          <p className="hint">What {b.name} knows about this company. Other companies never see it.</p>
          {proposed.length > 0 && (
            <p className="health off">{proposed.length} new note{proposed.length > 1 ? 's' : ''} waiting. <a href={`#/c/${encodeURIComponent(slug)}`}>Review in Today →</a></p>
          )}
          {kept.length === 0 ? <Empty>Nothing kept yet.</Empty> : (
            <ul className="list">
              <AnimatePresence initial={false}>
                {kept.map((m) => <MemoryRow key={m.id} id={m.id} content={m.content} source={m.source} taskId={m.source_task_id} onChange={load} />)}
              </AnimatePresence>
            </ul>
          )}
          <div className="meter" title="How much of each prompt the notes use">
            <div className="meter-fill" style={{ width: `${Math.min(100, (p.memoryBudget.used / p.memoryBudget.max) * 100)}%` }} />
          </div>
          <p className="muted small">{(p.memoryBudget.used / 1000).toFixed(1)}k of {p.memoryBudget.max / 1000}k characters go into each task. Older notes past that are left out.</p>
        </Card>

        <Card title="Skills · every company">
          <p className="hint">How {b.name} does the job. A change here reaches every company that hired this bot{others.length ? ` (${[d.company.name, ...others.map((o) => o.name)].join(', ')})` : ''}.</p>
          {p.skills.length === 0 ? <Empty>No skills yet. Teach one below.</Empty> : (
            <ul className="list">
              {p.skills.map((s) => <SkillRow key={s.id} id={s.id} title={s.title} body={s.body} onChange={load} />)}
            </ul>
          )}
        </Card>

        <TeachCard bot={b.name} company={d.company.name} base={base} onDone={load} />

        <Card title="Routines">
          {p.routines.length === 0 ? <Empty>This bot has no routines. It works on tasks as they come.</Empty> : (
            <ul className="list">
              {p.routines.map((r) => (
                <li key={r.id} className="list-item">
                  <label className="check grow">
                    <input type="checkbox" checked={r.on} disabled={busy !== null} onChange={(e) => {
                      const ids = p.routines.filter((x) => (x.id === r.id ? e.target.checked : x.on)).map((x) => x.id);
                      void run('routine', async () => { await patch(base, { routineIds: ids }); await load(); });
                    }} />
                    <span><strong>{r.title}</strong> <span className="muted small">· {r.when}</span><br /><span className="muted small">{r.description}</span></span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">A routine adds a task to the queue at its time. Auto Mode, Night Task and the budget still decide when it runs. Switching one on waits for its next slot.</p>
        </Card>
      </div>

      {saving && <SaveTemplateModal profile={p} slug={slug} company={d.company.name} onClose={() => setSaving(false)} />}
    </div>
  );
}

function MemoryRow({ id, content, source, taskId, onChange }: { id: number; content: string; source: string; taskId: number | null; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  const { busy, run } = useAction();
  return (
    <Row className="list-item">
      <div className="grow">
        {editing ? (
          <div className="stack">
            <textarea rows={2} value={draft} maxLength={500} onChange={(e) => setDraft(e.target.value)} />
            <div className="row-actions">
              <button className="btn small primary" disabled={busy !== null || !draft.trim()}
                onClick={() => run('save', async () => { await patch(`/memories/${id}`, { content: draft }); setEditing(false); onChange(); }, 'Saved')}>Save</button>
              <button className="btn small ghost" onClick={() => { setDraft(content); setEditing(false); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <p className="note-text">{content}</p>
            <p className="muted small">{source === 'owner' ? 'You taught this' : taskId ? `Learned in task #${taskId}` : 'Learned in a task'}</p>
          </>
        )}
      </div>
      {!editing && (
        <div className="row-actions">
          <button className="btn small ghost" onClick={() => setEditing(true)}>Edit</button>
          <button className="btn small ghost danger" disabled={busy !== null}
            onClick={() => run('forget', async () => { await del(`/memories/${id}`); onChange(); }, 'Forgotten')}>Forget</button>
        </div>
      )}
    </Row>
  );
}

function SkillRow({ id, title, body, onChange }: { id: number; title: string; body: string; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState(title);
  const [b, setB] = useState(body);
  const { busy, run } = useAction();
  if (editing) {
    return (
      <li className="list-item">
        <div className="grow stack">
          <input value={t} maxLength={80} onChange={(e) => setT(e.target.value)} aria-label="Skill title" />
          <textarea rows={6} value={b} maxLength={4000} onChange={(e) => setB(e.target.value)} aria-label="Skill instructions" />
          <div className="row-actions">
            <button className="btn small primary" disabled={busy !== null}
              onClick={() => run('skill', async () => { await patch(`/skills/${id}`, { title: t, body: b }); setEditing(false); onChange(); }, 'Skill updated everywhere')}>Save for every company</button>
            <button className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      </li>
    );
  }
  return (
    <li className="list-item skill">
      <details className="grow">
        <summary><strong>{title}</strong></summary>
        <pre className="skill-body">{body}</pre>
        <div className="row-actions">
          <button className="btn small" onClick={() => { setT(title); setB(body); setEditing(true); }}>Edit</button>
          <button className="btn small ghost danger" disabled={busy !== null} onClick={() => {
            if (confirm(`Remove "${title}"? Every company that hired this bot loses it.`)) {
              void run('rm', async () => { await del(`/skills/${id}`); onChange(); }, 'Skill removed');
            }
          }}>Remove</button>
        </div>
      </details>
    </li>
  );
}

/** Teaching by talking: one sentence, and the owner says where it applies. */
function TeachCard({ bot, company, base, onDone }: { bot: string; company: string; base: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [asked, setAsked] = useState(false);
  const { busy, run } = useAction();
  const teach = (scope: 'everywhere' | 'here') => run('teach', async () => {
    await post(`${base}/teach`, { text, scope });
    setText(''); setAsked(false); onDone();
  }, scope === 'everywhere' ? `Every ${bot} bot learned that` : `${bot} will remember that for ${company}`);
  return (
    <Card title={`Teach ${bot}`}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (text.trim()) setAsked(true); }}>
        <textarea rows={3} value={text} maxLength={500} placeholder="Always CC me on refund replies"
          onChange={(e) => { setText(e.target.value); setAsked(false); }} />
        {!asked ? (
          <div className="row-actions"><button className="btn" disabled={!text.trim()}>Teach</button></div>
        ) : (
          <div className="teach-ask">
            <p className="small">Got it. Is that a rule for…</p>
            <div className="row-actions wrap">
              <button type="button" className="btn small" disabled={busy !== null} onClick={() => teach('everywhere')}>Every company</button>
              <button type="button" className="btn small primary" disabled={busy !== null} onClick={() => teach('here')}>Just {company}</button>
              <button type="button" className="btn small ghost" onClick={() => setAsked(false)}>Cancel</button>
            </div>
            <p className="muted small">Every company makes it a skill, shared wherever {bot} works. Just {company} saves it as a note only this company's {bot} reads.</p>
          </div>
        )}
      </form>
    </Card>
  );
}

// ── Save as template ──

function SaveTemplateModal({ profile, slug, company, onClose }: { profile: BotProfile; slug: string; company: string; onClose: () => void }) {
  const [name, setName] = useState(`${profile.bot.name} (copy)`);
  const [blurb, setBlurb] = useState(profile.template.blurb);
  const [picked, setPicked] = useState<number[]>(profile.skills.map((s) => s.id));
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState<number | null>(null);
  const { busy, run } = useAction();
  const save = (confirm: boolean) => run('save', async () => {
    const r = await post<{ id: number | null; warnings: string[] }>(`/companies/${encodeURIComponent(slug)}/bots/${profile.bot.id}/template`, { name, blurb, skillIds: picked, confirm });
    setWarnings(r.warnings);
    if (r.id) { setSaved(r.id); toast('Saved to your library', 'success'); }
  });
  const toggle = (id: number) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  if (saved) {
    return (
      <Modal title="Saved to your library" onClose={onClose}>
        <p>“{name}” is under Mine in the bot library. Any company can hire it, and each one starts with an empty notebook.</p>
        <div className="row-actions">
          <button className="btn" onClick={() => void downloadTemplate(saved)}>Export file</button>
          <a className="btn primary" href="#/library">Open the library</a>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Save ${profile.bot.name} as a template`} onClose={onClose} wide>
      <div className="stack">
        <div className="row">
          <label className="field grow"><span>Name</span><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field grow"><span>One line about it</span><input value={blurb} maxLength={160} onChange={(e) => setBlurb(e.target.value)} /></label>
        </div>
        <div className="export-split">
          <section className="export-in">
            <h3>Goes in the template</h3>
            <p className="small muted">Its role, the routines (times only, all off until someone switches them on), and the skills you tick.</p>
            {profile.skills.length === 0 ? <Empty>No skills to include.</Empty> : profile.skills.map((s) => (
              <label key={s.id} className="check"><input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} /> {s.title}</label>
            ))}
          </section>
          <section className="export-out">
            <h3>Never leaves {company}</h3>
            <ul className="small">
              <li>{profile.memory.length} memory note{profile.memory.length === 1 ? '' : 's'}</li>
              <li>Task history and work logs</li>
              <li>Customer emails</li>
              <li>API keys and settings</li>
            </ul>
            <p className="small muted">There is no option to include these.</p>
          </section>
        </div>
        {warnings.length > 0 && (
          <div className="health error" role="alert">
            <strong>These skills mention things from {company}:</strong>
            <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            Untick them, or edit the skill on the profile first. Saving anyway shares that text with every company that hires the template.
          </div>
        )}
        <div className="row-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          {warnings.length > 0
            ? <button className="btn danger" disabled={busy !== null} onClick={() => save(true)}>Save anyway</button>
            : <button className="btn primary" disabled={busy !== null || !name.trim()} onClick={() => save(false)}>Save to my library</button>}
        </div>
      </div>
    </Modal>
  );
}

export async function downloadTemplate(id: number) {
  const file = await api<{ name: string }>(`/library/${id}/export`);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${file.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.nightshift-bot.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
