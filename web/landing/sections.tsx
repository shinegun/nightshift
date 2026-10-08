// Everything below the office: what the run produced, how the orchestration works, and why.
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { motion, useReducedMotion } from 'motion/react';
import { useMemo, useState, type ReactNode } from 'react';
import { LINKS } from './config.ts';
import { fmtClock, fmtCost, type Tape } from './tape.ts';

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
// Agent-written markdown: raw HTML in it is shown as text, and links open elsewhere.
marked.use({ renderer: { html: ({ text }) => escapeHtml(text) } });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer nofollow'); }
});
const md = (text: string) => DOMPurify.sanitize(marked.parse(text ?? '', { async: false }) as string);

function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.55, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

// ── What the team produced ───────────────────────────────────────────────────

export function Output({ tape }: { tape: Tape }) {
  const asks = useMemo(() => tape.events.filter((e) => e.k === 'ask'), [tape]);
  const nameOf = (who: string) => tape.bots.find((b) => b.key === who)?.name ?? 'CEO';
  const tabs = useMemo(() => {
    const list: { id: string; label: string }[] = [];
    if (tape.site) list.push({ id: 'site', label: 'Website' });
    for (const d of tape.docs) list.push({ id: `doc:${d.kind}:${d.title}`, label: d.title });
    if (tape.outbox.length + asks.length) list.push({ id: 'outbox', label: `Needs the owner (${tape.outbox.length + asks.length})` });
    return list;
  }, [tape, asks]);
  const [tab, setTab] = useState(tabs[0]?.id ?? '');
  const doc = tape.docs.find((d) => `doc:${d.kind}:${d.title}` === tab);

  return (
    <section id="output" className="section output">
      <Reveal className="section-head">
        <h2>What the team made in {fmtClock(tape.durationMs)}</h2>
        <p>Nothing here was edited afterwards. These are the files and drafts the agents left behind in that run.</p>
      </Reveal>
      <Reveal className="viewer">
        <div className="tabs" role="tablist" aria-label="Output of the run">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <div className="viewer-body" role="tabpanel">
          {tab === 'site' && tape.site && (
            // Sandboxed with no same-origin access, the same way Nightshift serves every company site.
            <iframe className="site-frame" title={`${tape.company.name} website, built by the Engineer bot`} src={tape.site} sandbox="allow-scripts" loading="lazy" />
          )}
          {doc && <article className="prose" dangerouslySetInnerHTML={{ __html: md(doc.content) }} />}
          {tab === 'outbox' && (
            <ul className="drafts">
              {tape.outbox.map((o, i) => (
                <li key={i}>
                  <header>
                    <strong>{o.what === 'email' ? `Email to ${o.to}` : 'Post for X'}</strong>
                    <span className="tag">Waiting for approval</span>
                  </header>
                  {o.subject && <p className="draft-subject">{o.subject}</p>}
                  <p className="draft-body">{o.body}</p>
                </li>
              ))}
              {asks.map((a, i) => a.k === 'ask' && (
                <li key={`ask${i}`}>
                  <header>
                    <strong>{nameOf(a.by)} asked the owner</strong>
                    <span className="tag">Only a human can do this</span>
                  </header>
                  <p className="draft-subject">{a.title}</p>
                  <p className="draft-body">{a.why}</p>
                </li>
              ))}
            </ul>
          )}
          {!tabs.length && <p className="empty">This recording has no output to show.</p>}
        </div>
      </Reveal>
    </section>
  );
}

// ── How the orchestration works ──────────────────────────────────────────────

const PIPELINE: { title: string; body: string }[] = [
  { title: 'One sentence', body: 'You type an idea. That is the only input the run needs.' },
  { title: 'The CEO agent plans', body: 'One model call writes the name and mission. Another reads the research and writes a roadmap and the first tasks.' },
  { title: 'A shared queue', body: 'Each task is a row in SQLite with a type and a priority. The type decides which bot picks it up.' },
  { title: 'A bot works it', body: 'Its role, skills and notebook become the prompt. Then it loops: the model asks for a tool, the server runs it, the result goes back.' },
  { title: 'A human says yes', body: 'Emails, posts, ads and commits are saved as drafts. Nothing reaches the outside world until the owner approves it.' },
];

export function How() {
  return (
    <section id="how" className="section how">
      <Reveal className="section-head">
        <p className="eyebrow">Orchestration</p>
        <h2>How one idea becomes a night of work</h2>
      </Reveal>
      <ol className="pipeline">
        {PIPELINE.map((p, i) => (
          <Reveal key={p.title} delay={i * 0.07}>
            <li>
              <span className="pipe-node" aria-hidden="true" />
              <h3>{p.title}</h3>
              <p>{p.body}</p>
            </li>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

// ── The decisions behind it ──────────────────────────────────────────────────

export function Inside({ tape }: { tape: Tape }) {
  // Real lines from the tape: the first handful of tool calls the busiest task made.
  const trail = useMemo(() => {
    const calls = tape.events.filter((e) => e.k === 'step' && e.kind === 'call');
    const counts = new Map<number, number>();
    for (const e of calls) if (e.k === 'step') counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
    const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const title = tape.events.find((e) => e.k === 'task_new' && e.id === busiest);
    return {
      title: title?.k === 'task_new' ? title.title : '',
      lines: calls.filter((e) => e.k === 'step' && e.id === busiest).slice(0, 6).map((e) => (e.k === 'step' && e.kind === 'call' ? { tool: e.tool, arg: e.arg } : { tool: '', arg: '' })),
    };
  }, [tape]);
  // Who gave work to whom, counted from the tape.
  const handoffs = useMemo(() => {
    const name = (who: string) => tape.bots.find((b) => b.key === who)?.name ?? 'CEO';
    const color = (who: string) => tape.bots.find((b) => b.key === who)?.color ?? 'moon';
    const pairs = new Map<string, { from: string; to: string; fromColor: string; toColor: string; n: number }>();
    for (const e of tape.events) {
      if (e.k !== 'task_new') continue;
      const key = `${e.from}>${e.bot}`;
      const p = pairs.get(key) ?? { from: name(e.from), to: name(e.bot), fromColor: color(e.from), toColor: color(e.bot), n: 0 };
      p.n += 1;
      pairs.set(key, p);
    }
    return [...pairs.values()].sort((a, b) => b.n - a.n).slice(0, 6);
  }, [tape]);

  const note = useMemo(() => {
    const e = tape.events.find((x) => x.k === 'note');
    return e?.k === 'note' ? { who: tape.bots.find((b) => b.key === e.bot)?.name ?? 'A bot', text: e.text } : null;
  }, [tape]);

  return (
    <section id="inside" className="section inside">
      <Reveal className="section-head">
        <h2>Four decisions that shaped it</h2>
      </Reveal>
      <div className="bento">
        <Reveal className="cell cell-trail">
          <h3>Every step leaves a trail</h3>
          <p>Each tool call and its result is saved as a row, so any task can be opened and read back. These are the first calls of one task in this run.</p>
          <div className="trail" aria-label={`Tool calls from the task: ${trail.title}`}>
            <span className="trail-title">{trail.title}</span>
            {trail.lines.map((l, i) => <code key={i}><b>{l.tool}</b> {l.arg}</code>)}
          </div>
        </Reveal>
        <Reveal className="cell cell-cost" delay={0.06}>
          <span className="big">{fmtCost(tape.totals.costUsd)}</span>
          <h3>A budget it cannot pass</h3>
          <p>That is what this whole run cost: {tape.totals.llmCalls} model calls on {tape.model}. Every call is metered against a daily cap. At the cap a task pauses and keeps its conversation, so resuming does not pay twice.</p>
        </Reveal>
        <Reveal className="cell cell-memory" delay={0.06}>
          <h3>Skills travel, memory stays</h3>
          <p>A bot's skills are shared by every company that hires it. Its notebook belongs to one company, and a note only reaches a prompt after the owner has kept it.</p>
          {note && (
            <figure className="note">
              <figcaption>{note.who} proposed this note in the run. It is waiting for review.</figcaption>
              <blockquote>{note.text}</blockquote>
            </figure>
          )}
        </Reveal>
        <Reveal className="cell cell-handoff" delay={0.12}>
          <h3>A handoff is just a task</h3>
          <p>No agent calls another directly. To pass work on, a bot adds a task to the queue and the task's type decides who picks it up. Nothing runs that the queue does not show.</p>
          <ul className="handoffs" aria-label="Who handed work to whom in this run">
            {handoffs.map((h) => (
              <li key={`${h.from}${h.to}`}>
                <span className={`chip c-${h.fromColor}`}>{h.from}</span>
                <span className="arrow" aria-hidden="true">to</span>
                <span className={`chip c-${h.toColor}`}>{h.to}</span>
                <span className="times">{h.n} {h.n === 1 ? 'task' : 'tasks'}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

// ── Stack and sign-off ───────────────────────────────────────────────────────

const STACK: [string, string][] = [
  ['Server', 'Node 22 and Hono in one process. SQLite through node:sqlite, so the whole state is one file.'],
  ['Agents', 'Any OpenAI-compatible model. 24 tools, a 25-step ceiling per task, and a read-only headless browser.'],
  ['Web', 'React 19, Vite and Motion. Live updates arrive over server-sent events.'],
  ['Safety', 'Approval gates on email, posts, ads and commits. Deploys refuse files that contain a key.'],
];

export function Stack({ tape }: { tape: Tape | null }) {
  return (
    <section id="stack" className="section stack">
      <div className="stack-grid">
        <Reveal className="stack-lead">
          <h2>Built end to end by one person</h2>
          <p>
            {LINKS.author} designed and wrote Nightshift: the agent loop, the queue, the approval gates and the dashboard.
            {tape ? ` The run on this page used ${tape.totals.toolCalls} tool calls across ${tape.totals.tasks} tasks.` : ''}
          </p>
          <a className="btn btn-primary" href={LINKS.source} target="_blank" rel="noopener noreferrer">View source</a>
        </Reveal>
        <Reveal delay={0.08}>
          <dl className="stack-list">
            {STACK.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}
