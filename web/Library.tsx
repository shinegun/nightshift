/**
 * The bot library: every template, whichever company it works at.
 *
 * It is its own page next to Settings, not a view inside a company, because a template belongs to
 * no company. Hiring is what ties one to a company, and a hired bot starts with an empty notebook
 * there.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, patch, post } from './api.ts';
import type { BotColor, LibraryData, Need, Template } from './types.ts';
import { Empty, go, toast, useAction, useLive } from './lib.tsx';
import { Stagger, motion, rise } from './motion.tsx';
import { Modal } from './modals.tsx';
import { TYPE_LABEL } from './TaskQueue.tsx';
import { BOT_COLORS, BotAvatar, downloadTemplate } from './Bots.tsx';

type Tab = 'builtin' | 'mine';

export function Library({ slug }: { slug?: string }) {
  const [data, setData] = useState<LibraryData | null>(null);
  const [company, setCompany] = useState(slug ?? '');
  const [tab, setTab] = useState<Tab>('builtin');
  const [open, setOpen] = useState<number | null>(null);
  const [hiring, setHiring] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const load = useCallback(
    () => api<LibraryData>(`/library${company ? `?company=${encodeURIComponent(company)}` : ''}`).then(setData).catch((e) => toast(e.message, 'error')),
    [company],
  );
  useEffect(() => { void load(); }, [load]);
  useLive(null, load);
  useEffect(() => { if (slug) setCompany(slug); }, [slug]);

  if (!data) return <div className="container"><p className="muted">Loading…</p></div>;
  const mine = data.templates.filter((t) => !t.builtin);
  const shown = data.templates.filter((t) => (tab === 'builtin' ? t.builtin : !t.builtin));
  const here = data.companies.find((c) => c.slug === company);
  const openT = data.templates.find((t) => t.id === open);
  const hireT = data.templates.find((t) => t.id === hiring);

  return (
    <div className="container">
      <header className="settings-head">
        <div>
          {here && <a className="small muted back-link" href={`#/c/${encodeURIComponent(here.slug)}/work`}>← {here.name}</a>}
          <h1>Bot library</h1>
          <p className="lede">Bots you can hire into any company. A template carries a bot's role, skills and routines. Its memory stays at the company it learned it in.</p>
        </div>
        <div className="head-actions">
          <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Hiring for">
            <option value="">Hiring for…</option>
            {data.companies.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
          <button className="btn" onClick={() => setImporting(true)}>Import</button>
        </div>
      </header>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'builtin'} className={tab === 'builtin' ? 'active' : ''} onClick={() => setTab('builtin')}>
          Built-in <span className="count">{data.templates.length - mine.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>
          Mine <span className="count">{mine.length}</span>
        </button>
        <button role="tab" disabled title="Not yet: templates from other people need a review step first">Community (later)</button>
      </div>

      {shown.length === 0 ? (
        <Empty>{tab === 'mine' ? 'Nothing here yet. Open a bot and choose More → Save as template, or import a file.' : 'No built-in bots.'}</Empty>
      ) : (
        <Stagger className="template-grid" gap={0.03}>
          {shown.map((t) => (
            <motion.article key={t.id} className="card template-card" variants={rise}>
              <div className="bot-tile-head">
                <BotAvatar color={t.color} />
                <div className="grow">
                  <strong>{t.name}</strong>
                  <div className="small muted">{t.builtin ? 'built-in' : 'yours'} · v{t.version} · {t.skills.length} skill{t.skills.length === 1 ? '' : 's'}</div>
                </div>
              </div>
              <p className="small">{t.blurb || <span className="muted">No description.</span>}</p>
              <p className="small muted">Takes: {t.taskTypes.map((x) => TYPE_LABEL[x] ?? x).join(', ')}</p>
              <p className="small muted">Needs: {t.needs.length ? t.needs.map((n) => n.label).join(', ') : 'nothing extra'}</p>
              <p className="small muted clamp-1">{t.usedIn.length ? `At: ${t.usedIn.map((u) => u.name).join(', ')}` : 'Not hired anywhere yet'}</p>
              <div className="row-actions template-actions">
                <button className="btn small ghost" onClick={() => setOpen(t.id)}>Details</button>
                {here && t.hiredHere ? (
                  <a className="btn small" href={`#/c/${encodeURIComponent(here.slug)}/bot/${t.usedIn.find((u) => u.slug === here.slug)?.botId}`}>At {here.name} →</a>
                ) : (
                  <button className="btn small primary" onClick={() => setHiring(t.id)}>{here ? `Add to ${here.name}` : 'Add to…'}</button>
                )}
              </div>
            </motion.article>
          ))}
        </Stagger>
      )}

      {openT && <TemplateModal t={openT} onClose={() => setOpen(null)} onChange={load} onHire={() => { setOpen(null); setHiring(openT.id); }} />}
      {hireT && <HireModal t={hireT} companies={data.companies} initial={company} onClose={() => setHiring(null)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={(id) => { setImporting(false); setTab('mine'); setOpen(id); void load(); }} />}
    </div>
  );
}

// ── Details ──

function TemplateModal({ t, onClose, onChange, onHire }: { t: Template; onClose: () => void; onChange: () => void; onHire: () => void }) {
  const [role, setRole] = useState(t.role);
  const [name, setName] = useState(t.name);
  const [blurb, setBlurb] = useState(t.blurb);
  const [adding, setAdding] = useState(false);
  const [skill, setSkill] = useState({ title: '', body: '' });
  const { busy, run } = useAction();
  const dirty = name !== t.name || blurb !== t.blurb || role !== t.role;

  return (
    <Modal title={<><BotAvatar color={t.color} size={28} /> {t.name}</>} onClose={onClose} wide>
      <div className="stack">
        {!t.builtin && (
          <p className="health off">A template is instructions your bots will follow. If it came from someone else, read the role and every skill before you hire it.</p>
        )}
        {t.builtin ? (
          <>
            <p>{t.blurb}</p>
            <h3>Role</h3>
            <p className="small">{t.role}</p>
          </>
        ) : (
          <>
            <div className="row">
              <label className="field grow"><span>Name</span><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
              <label className="field grow"><span>One line about it</span><input value={blurb} maxLength={160} onChange={(e) => setBlurb(e.target.value)} /></label>
            </div>
            <label className="field"><span>Role</span><textarea rows={3} value={role} maxLength={2000} onChange={(e) => setRole(e.target.value)} /></label>
            {dirty && (
              <div className="row-actions">
                <button className="btn small primary" disabled={busy !== null}
                  onClick={() => run('meta', async () => { await patch(`/library/${t.id}`, { name, blurb, role }); onChange(); }, 'Saved')}>Save changes</button>
              </div>
            )}
          </>
        )}

        <h3>Skills <span className="muted small">· shared by every company that hires it</span></h3>
        {t.skills.length === 0 ? <Empty>No skills.</Empty> : (
          <ul className="list">
            {t.skills.map((s) => (
              <li key={s.id} className="list-item skill">
                <details className="grow">
                  <summary><strong>{s.title}</strong></summary>
                  <pre className="skill-body">{s.body}</pre>
                </details>
                <button className="btn small ghost danger" disabled={busy !== null} onClick={() => {
                  if (confirm(`Remove "${s.title}" from ${t.name}${t.usedIn.length ? ` at ${t.usedIn.map((u) => u.name).join(', ')}` : ''}?`)) {
                    void run('rm', async () => { await del(`/skills/${s.id}`); onChange(); }, 'Removed');
                  }
                }}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        {adding ? (
          <div className="stack">
            <input placeholder="Title, e.g. Refund replies" value={skill.title} maxLength={80} onChange={(e) => setSkill({ ...skill, title: e.target.value })} />
            <textarea rows={4} placeholder="- How to do it, one rule per line" value={skill.body} maxLength={4000} onChange={(e) => setSkill({ ...skill, body: e.target.value })} />
            <div className="row-actions">
              <button className="btn small primary" disabled={busy !== null || !skill.title.trim() || !skill.body.trim()}
                onClick={() => run('add', async () => { await post(`/library/${t.id}/skills`, skill); setSkill({ title: '', body: '' }); setAdding(false); onChange(); }, 'Skill added')}>Add skill</button>
              <button className="btn small ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        ) : <div><button className="btn small" onClick={() => setAdding(true)}>+ Add a skill</button></div>}

        <h3>Routines</h3>
        {t.routines.length === 0 ? <Empty>None.</Empty> : (
          <ul className="list compact">
            {t.routines.map((r) => <li key={r.id} className="list-item"><span className="grow"><strong>{r.title}</strong> <span className="muted small">· {r.when}{r.defaultOn ? ' · on by default' : ''}</span></span></li>)}
          </ul>
        )}

        <p className="muted small">
          Works at: {t.usedIn.length ? t.usedIn.map((u, i) => <span key={u.slug}>{i ? ', ' : ''}<a href={`#/c/${encodeURIComponent(u.slug)}/bot/${u.botId}`}>{u.name}</a></span>) : 'nowhere yet'}
        </p>

        <div className="row-actions">
          <button className="btn" onClick={() => void downloadTemplate(t.id).catch((e) => toast(e.message, 'error'))}>Export file</button>
          {!t.builtin && (
            <button className="btn ghost danger" disabled={busy !== null || t.usedIn.length > 0}
              title={t.usedIn.length ? 'Let the bots hired from it go first' : ''}
              onClick={() => { if (confirm(`Delete the template "${t.name}"?`)) void run('del', async () => { await del(`/library/${t.id}`); onClose(); onChange(); }, 'Template deleted'); }}>
              Delete template
            </button>
          )}
          <span className="grow" />
          <button className="btn primary" onClick={onHire}>Hire…</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Hire ──

function HireModal({ t, companies, initial, onClose }: { t: Template; companies: LibraryData['companies']; initial: string; onClose: () => void }) {
  const [slug, setSlug] = useState(initial);
  const [check, setCheck] = useState<{ needs: Need[]; hired: boolean; routines: { id: number; defaultOn: boolean }[] } | null>(null);
  const [routineIds, setRoutineIds] = useState<number[]>(t.routines.filter((r) => r.defaultOn).map((r) => r.id));
  const [name, setName] = useState(t.name);
  const [color, setColor] = useState<BotColor>(t.color);
  const { busy, run } = useAction();

  useEffect(() => {
    setCheck(null);
    if (!slug) return;
    api(`/companies/${encodeURIComponent(slug)}/hire/${t.id}`).then(setCheck).catch((e) => toast(e.message, 'error'));
  }, [slug, t.id]);

  const company = companies.find((c) => c.slug === slug);
  const hire = () => run('hire', async () => {
    const r = await post<{ id: number }>(`/companies/${encodeURIComponent(slug)}/bots`, { templateId: t.id, name, color, routineIds });
    go(`/c/${encodeURIComponent(slug)}/bot/${r.id}`);
  }, `${name} joined ${company?.name}`);

  return (
    <Modal title={`Hire ${t.name}`} onClose={onClose}>
      <ol className="hire-steps">
        <li>
          <h3>Which company?</h3>
          <select value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Company">
            <option value="">Choose a company</option>
            {companies.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
          {check?.hired && <p className="health error">{company?.name} already has this bot. One per template, for now.</p>}
        </li>
        <li>
          <h3>What it needs</h3>
          {!slug ? <p className="muted small">Choose a company to check.</p> : !check ? <p className="muted small">Checking…</p>
            : check.needs.length === 0 ? <p className="small ok">✓ Nothing extra.</p> : (
              <ul className="list compact">
                {check.needs.map((n) => (
                  <li key={n.key} className="list-item">
                    <span className={n.state === 'ready' ? 'ok' : 'warn-text'}>{n.state === 'ready' ? '✓' : '✗'}</span>
                    <span className="grow small"><strong>{n.label}</strong>{n.state !== 'ready' && n.message ? ` · ${n.message}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          {check && check.needs.some((n) => n.state !== 'ready') && (
            <p className="muted small">You can hire it now. The parts that need a missing integration won't work until you set it up in <a href="#/settings">Settings</a>.</p>
          )}
        </li>
        <li>
          <h3>Routines</h3>
          {t.routines.length === 0 ? <p className="muted small">None. It works on tasks as they come.</p> : t.routines.map((r) => (
            <label key={r.id} className="check">
              <input type="checkbox" checked={routineIds.includes(r.id)}
                onChange={(e) => setRoutineIds((x) => (e.target.checked ? [...x, r.id] : x.filter((y) => y !== r.id)))} />
              <span>{r.title} <span className="muted small">· {r.when}</span></span>
            </label>
          ))}
          <p className="muted small">Its first routine runs at the next scheduled time, not right away. 🔒 Emails, posts and pushes still wait for your approval.</p>
        </li>
        <li>
          <h3>Name and look</h3>
          <div className="row">
            <BotAvatar color={color} size={48} />
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          </div>
          <div className="swatches" role="radiogroup" aria-label="Colour">
            {BOT_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c}
                className={`swatch c-${c} ${c === color ? 'on' : ''}`} onClick={() => setColor(c)} />
            ))}
          </div>
        </li>
      </ol>
      <div className="row-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy !== null || !slug || !check || check.hired || !name.trim()} onClick={hire}>
          Hire {name || t.name}{company ? ` at ${company.name}` : ''}
        </button>
      </div>
    </Modal>
  );
}

// ── Import ──

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (id: number) => void }) {
  const [text, setText] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction();
  const submit = () => run('import', async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("That isn't valid JSON."); }
    const r = await post<{ id: number }>('/library/import', { template: parsed });
    onDone(r.id);
  }, 'Imported. Read it before you hire it.');
  return (
    <Modal title="Import a bot template" onClose={onClose}>
      <div className="stack">
        <p className="health off">A template is a set of instructions your bots will follow, with your keys. Only import files from people you trust, and read the role and skills before hiring. Its routines arrive switched off.</p>
        <input ref={file} type="file" accept=".json,application/json" onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setText(await f.text());
        }} />
        <textarea rows={8} placeholder="…or paste the file here" value={text} onChange={(e) => setText(e.target.value)} className="mono" />
        <div className="row-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy !== null || !text.trim()} onClick={submit}>Import</button>
        </div>
      </div>
    </Modal>
  );
}
