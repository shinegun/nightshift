// Records one real Nightshift run as a "tape" the public landing page can replay.
//
//   npx tsx scripts/record-demo.mts "<idea>" [--name <company>] [--tasks 5] [--budget 1]
//   npx tsx scripts/record-demo.mts --resume --data data/demo-recordings/<id> [--only outreach,ops] [--tasks 3]
//   npx tsx scripts/record-demo.mts --export-only --data data/demo-recordings/<id>
//
// The run happens in its own data folder (data/demo-recordings/<id>), never in the live one:
// a fresh database that is given only the AI and search settings. No Vercel token, so nothing is
// deployed. Email and X get placeholder credentials, so the bots can draft messages and posts,
// and every one of them stops at "waiting for your approval" exactly as it would in production.
// Nothing can be delivered, because nobody approves and the credentials are not real.
//
// The tape is public, so the export masks email addresses and refuses to write anything that
// looks like an API key.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(`--${name}`);
const valued = new Set(['name', 'tasks', 'budget', 'data', 'out', 'live', 'only']);
const idea = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]?.replace(/^--/, '') ?? '')).join(' ').trim();

const exportOnly = has('export-only');
/** Work more of the queue of a recording that already exists, then export it again. */
const resume = has('resume');
const onlyTypes = (opt('only') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
if (!exportOnly && !resume && !idea) {
  console.error('Usage: npx tsx scripts/record-demo.mts "<idea>" [--name <company>] [--tasks 5] [--budget 1]');
  process.exit(1);
}

const ROOT = process.cwd();
const LIVE_DATA = path.resolve(opt('live') ?? process.env.NIGHTSHIFT_DATA ?? 'data');
const OUT_DIR = path.resolve(opt('out') ?? 'web/landing/public/demo');
const dataDir = path.resolve(opt('data') ?? path.join(LIVE_DATA, 'demo-recordings', new Date().toISOString().replace(/[:.]/g, '-')));
const MAX_TASKS = Number(opt('tasks') ?? 5);
const BUDGET = opt('budget') ?? '1';
const TIME_LIMIT_MS = 40 * 60_000;

/** What the recording may take from the live settings: how to reach the model and the search provider. */
const BORROWED = [
  'llm_api_key', 'llm_base_url', 'llm_model', 'llm_thinking', 'llm_timeout_sec',
  'price_input_miss', 'price_input_hit', 'price_output',
  'search_provider', 'tavily_api_key', 'brave_api_key', 'writing_spelling', 'humanizer',
];
const BORROWED_SECRETS = ['llm_api_key', 'tavily_api_key', 'brave_api_key'];

/** Reads the borrowed settings from a copy of the live database, WAL included, then deletes the copy. */
function borrowSettings(): Record<string, string> {
  const src = path.join(LIVE_DATA, 'nightshift.db');
  if (!fs.existsSync(src)) return {};
  const tmp = path.join(dataDir, '.live-copy');
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, path.join(tmp, `nightshift.db${ext}`));
    const live = new DatabaseSync(path.join(tmp, 'nightshift.db'));
    const rows = live.prepare(`SELECT key, value FROM settings WHERE key IN (${BORROWED.map(() => '?').join(',')})`).all(...BORROWED) as { key: string; value: string }[];
    live.close();
    return Object.fromEntries(rows.filter((r) => r.value !== '').map((r) => [r.key, r.value]));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

fs.mkdirSync(dataDir, { recursive: true });
process.env.NIGHTSHIFT_DATA = dataDir;

// The Engineer's read-only browser opens the company preview on the public port. The live server
// does not know this company, so the recording serves its own copy of the site folder.
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const sitesDir = path.join(dataDir, 'sites');
const preview = http.createServer((req, res) => {
  const m = /^\/s\/([a-z0-9-]+)\/(.*)$/.exec(decodeURIComponent((req.url ?? '').split('?')[0]));
  const base = m ? path.join(sitesDir, m[1]) : '';
  let file = m ? path.resolve(base, m[2] || 'index.html') : '';
  if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!m || !file.startsWith(base + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
});
if (!exportOnly) {
  await new Promise<void>((r) => preview.listen(0, '127.0.0.1', r));
  process.env.PUBLIC_HOST = '127.0.0.1';
  process.env.PUBLIC_PORT = String((preview.address() as AddressInfo).port);
}

// Server modules open the database as they load, so they come in only after NIGHTSHIFT_DATA is set.
const { all, get, run } = await import('../server/db.ts');
const { setSetting, setting } = await import('../server/settings.ts');
const { SECRET_RE } = await import('../server/publish.ts');

type Row = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!exportOnly) {
  const borrowed = borrowSettings();
  if (!borrowed.llm_api_key && !process.env.DEEPSEEK_API_KEY) {
    console.error(`No AI key found in ${LIVE_DATA}/nightshift.db or DEEPSEEK_API_KEY. Nothing recorded.`);
    process.exit(1);
  }
  for (const [k, v] of Object.entries(borrowed)) setSetting(k, v);
  setSetting('daily_budget_usd', BUDGET);
  setSetting('monthly_budget_usd', '0');
  // Placeholder credentials: enough for the email and X tools to exist, useless for sending.
  setSetting('email_provider', 'resend');
  setSetting('email_from', 'team@nightshift-demo.example');
  setSetting('resend_api_key', 'placeholder-not-a-key');
  for (const k of ['x_api_key', 'x_api_secret', 'x_access_token', 'x_access_secret']) setSetting(k, 'placeholder-not-a-key');
  for (const k of ['approve_emails', 'approve_tweets', 'approve_ads', 'approve_git']) setSetting(k, 'true');

  const { createCompany } = await import('../server/agents/bootstrap.ts');
  const { runTask } = await import('../server/agents/runner.ts');
  const { subscribe } = await import('../server/events.ts');
  subscribe((e) => { if (e.type === 'activity') console.log(`  ${(e.data as { text: string }).text}`); });

  const started = Date.now();
  console.log(`Recording into ${path.relative(ROOT, dataDir)} (model ${setting('llm_model')}, budget $${BUDGET})`);
  let id: number;
  if (resume) {
    id = Number(setting('demo_company_id'));
    if (!id) { console.error(`Nothing to resume in ${dataDir}.`); process.exit(1); }
    // The time the recording sat idle is not part of the run, so it is taken out of the tape.
    const pauses: [string, string][] = JSON.parse(setting('demo_pauses') || '[]');
    setSetting('demo_pauses', JSON.stringify([...pauses, [setting('demo_finished_at'), new Date(started).toISOString()]]));
  } else {
    setSetting('demo_started_at', new Date(started).toISOString());
    id = (await createCompany(idea, opt('name'))).id;
    setSetting('demo_company_id', String(id));
  }

  // createCompany returns once the mission exists and carries on with the rest in the background.
  const statusOf = () => get<{ status: string }>('SELECT status FROM companies WHERE id = ?', id)?.status;
  while (statusOf() === 'bootstrapping' && Date.now() - started < TIME_LIMIT_MS) await sleep(1500);
  if (statusOf() !== 'live') console.warn(`Setup ended as "${statusOf()}". Exporting what happened anyway.`);

  // Then the queue the CEO planned, one task at a time, the way Auto Mode works it.
  const typed = onlyTypes.length ? `AND type IN (${onlyTypes.map(() => '?').join(',')})` : '';
  for (let n = 0; n < MAX_TASKS && statusOf() === 'live' && Date.now() - started < TIME_LIMIT_MS; n++) {
    const next = get<{ id: number }>(`SELECT id FROM tasks WHERE company_id = ? AND status = 'todo' ${typed} ORDER BY position, id LIMIT 1`, id, ...onlyTypes);
    if (!next) break;
    await runTask(next.id);
  }
  setSetting('demo_finished_at', new Date().toISOString());
  // The folder is kept so the tape can be exported again, but not with keys in it.
  for (const k of BORROWED_SECRETS) run('DELETE FROM settings WHERE key = ?', k);
}

// ── Export ───────────────────────────────────────────────────────────────────

const companyId = Number(setting('demo_company_id'));
const c = get<Row>('SELECT * FROM companies WHERE id = ?', companyId);
if (!c) { console.error(`No recorded company in ${dataDir}.`); process.exit(1); }
const t0 = Date.parse(setting('demo_started_at'));
const pauses = (JSON.parse(setting('demo_pauses') || '[]') as [string, string][]).map(([from, to]) => [Date.parse(from), Date.parse(to)]);
/** Milliseconds into the run, not counting any stretch the recording was paused. */
const at = (ts: string) => {
  const ms = Date.parse(ts);
  const idle = pauses.reduce((n, [from, to]) => n + (ms >= to ? to - from : 0), 0);
  return Math.max(0, ms - t0 - idle);
};

const maskEmails = (s: string) => s.replace(/\b[A-Za-z0-9][A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '•••@$1');
const noTitledNames = (s: string) => s.replace(/\b(?:Dr|Prof|Professor|Mr|Ms|Mrs)\.?\s+[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?/gu, '[name]');
const clean = (s: unknown, n: number) => {
  const text = noTitledNames(maskEmails(String(s ?? '').replace(/\n…\[truncated \d+ chars\]$/, '…').replace(/\s+\n/g, '\n').trim()));
  return text.length > n ? `${text.slice(0, n).trimEnd()}…` : text;
};

/** A draft is addressed to a real person who never received it. Their name stays out of the tape. */
const noGreetingName = (body: string) => String(body ?? '').replace(/^(\s*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)))\b[^\n,:]*([,:]?)/i, '$1 [name]$2');

const bots = all<Row>(
  `SELECT b.id, b.name, b.color, t.key FROM bots b JOIN bot_templates t ON t.id = b.template_id WHERE b.company_id = ? ORDER BY b.id`, companyId,
);
const botKey = (id: number | null) => bots.find((b) => b.id === id)?.key as string | undefined;
const tasks = all<Row>('SELECT * FROM tasks WHERE company_id = ? ORDER BY id', companyId);
// Outreach is work about real people: who teaches what, who to write to. A public tape shows that
// the bot searched and drafted, and leaves out what it read and concluded about them.
const aboutPeople = new Set(tasks.filter((t) => t.type === 'outreach').map((t) => t.id as number));
const duringPeopleTask = (ts: string) => tasks.some((t) => aboutPeople.has(t.id) && t.started_at && t.started_at <= ts && (!t.finished_at || ts <= t.finished_at));
const WITHHELD = 'Left out of the public recording, because it names the people this task was about.';
/** Whoever was mid-task at that moment did it; between tasks, it was the CEO. */
const workerAt = (ts: string) => {
  const t = tasks.find((x) => x.started_at && x.started_at <= ts && (!x.finished_at || ts <= x.finished_at));
  return (t && botKey(t.bot_id)) ?? 'ceo';
};

/** The one argument worth showing for a tool call: what it searched, opened or wrote. */
function callSummary(raw: string) {
  const sp = raw.indexOf(' ');
  const tool = sp < 0 ? raw : raw.slice(0, sp);
  const json = sp < 0 ? '' : raw.slice(sp + 1);
  let args: Row = {};
  try { args = JSON.parse(json); } catch {
    // Logged arguments are cut at 1200 characters, which usually breaks the JSON. Pull the first string instead.
    for (const m of json.matchAll(/"([a-z_]+)":\s*"((?:[^"\\]|\\.)*)"/g)) {
      try { args[m[1]] ??= JSON.parse(`"${m[2]}"`); } catch { /* a string the cut landed inside */ }
    }
  }
  const key = ['query', 'url', 'path', 'title', 'to', 'question', 'text', 'name'].find((k) => typeof args[k] === 'string' && args[k]);
  return { tool, arg: key ? clean(args[key], 140) : '' };
}

type Ev = { t: number; k: string } & Row;
const events: Ev[] = [];

for (const a of all<Row>('SELECT ts, text FROM activity WHERE company_id = ? ORDER BY id', companyId)) {
  events.push({ t: at(a.ts), k: 'say', text: clean(String(a.text).replace(/^>\s*/, ''), 200) });
}
for (const t of tasks) {
  events.push({
    t: at(t.created_at), k: 'task_new', id: t.id, title: clean(t.title, 120), type: t.type, bot: botKey(t.bot_id) ?? 'ceo',
    from: t.from_bot_id ? botKey(t.from_bot_id) : 'ceo',
  });
  if (t.started_at) events.push({ t: at(t.started_at), k: 'task_start', id: t.id });
  if (t.finished_at && t.status !== 'running') {
    events.push({ t: at(t.finished_at), k: 'task_end', id: t.id, status: t.status, steps: t.steps, result: aboutPeople.has(t.id) ? WITHHELD : clean(t.result ?? t.error ?? '', 600) });
  }
}
for (const l of all<Row>(
  'SELECT l.task_id, l.ts, l.kind, l.content FROM task_logs l JOIN tasks t ON t.id = l.task_id WHERE t.company_id = ? ORDER BY l.id', companyId,
)) {
  if (l.kind !== 'tool_call' && aboutPeople.has(l.task_id)) continue;
  if (l.kind === 'tool_call') events.push({ t: at(l.ts), k: 'step', id: l.task_id, kind: 'call', ...callSummary(l.content) });
  else if (l.kind === 'tool_result') events.push({ t: at(l.ts), k: 'step', id: l.task_id, kind: 'result', text: clean(l.content, 220) });
  else events.push({ t: at(l.ts), k: 'step', id: l.task_id, kind: l.kind, text: clean(l.content, 320) });
}
const docs = all<Row>('SELECT kind, title, content, created_at FROM documents WHERE company_id = ? ORDER BY id', companyId);
for (const d of docs) events.push({ t: at(d.created_at), k: 'doc', kind: d.kind, title: clean(d.title, 100), by: workerAt(d.created_at) });

const emails = all<Row>(`SELECT to_addr, subject, body, status, created_at FROM emails WHERE company_id = ? AND direction = 'out' ORDER BY id`, companyId);
const posts = all<Row>('SELECT text, status, created_at FROM tweets WHERE company_id = ? ORDER BY id', companyId);
const outbox = [
  ...emails.map((e) => ({ what: 'email', ts: e.created_at, to: maskEmails(e.to_addr), subject: clean(e.subject, 140), body: clean(noGreetingName(e.body), 1200), status: e.status })),
  ...posts.map((p) => ({ what: 'post', ts: p.created_at, to: '', subject: '', body: clean(p.text, 300), status: p.status })),
].sort((a, b) => a.ts.localeCompare(b.ts));
for (const [i, o] of outbox.entries()) events.push({ t: at(o.ts), k: 'draft', i, what: o.what, by: workerAt(o.ts) });

for (const m of all<Row>('SELECT bot_id, content, created_at FROM bot_memories WHERE company_id = ? ORDER BY id', companyId)) {
  if (duringPeopleTask(m.created_at)) continue;
  events.push({ t: at(m.created_at), k: 'note', bot: botKey(m.bot_id) ?? 'ceo', text: clean(m.content, 220) });
}
// Things only the owner can do. A bot that hits one asks, instead of guessing or giving up.
const asks = all<Row>('SELECT title, why, created_at FROM requests WHERE company_id = ? ORDER BY id', companyId);
for (const r of asks) events.push({ t: at(r.created_at), k: 'ask', title: clean(r.title, 140), why: clean(r.why, 260), by: workerAt(r.created_at) });
const usage = all<Row>('SELECT ts, task_id, prompt_tokens, completion_tokens, cost_usd FROM usage ORDER BY id');
for (const u of usage) {
  const task = tasks.find((t) => t.id === u.task_id);
  events.push({ t: at(u.ts), k: 'llm', who: (task && botKey(task.bot_id)) ?? 'ceo', tok: u.prompt_tokens + u.completion_tokens, cost: u.cost_usd });
}

// Stable order for events that share a millisecond: a task is announced before it starts.
const ORDER = ['task_new', 'say', 'task_start', 'llm', 'step', 'doc', 'draft', 'note', 'ask', 'task_end'];
events.sort((a, b) => a.t - b.t || ORDER.indexOf(a.k) - ORDER.indexOf(b.k));

/** The site the Engineer built, as one self-contained page: local styles and scripts folded in. */
function inlineSite(slug: string): string | null {
  const dir = path.join(sitesDir, slug);
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) return null;
  const local = (ref: string) => {
    if (/^([a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:')) return null;
    const p = path.resolve(dir, ref.replace(/^\/+/, '').split(/[?#]/)[0]);
    return p.startsWith(dir + path.sep) && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
  return fs.readFileSync(index, 'utf8')
    .replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
      const css = local(/href=["']([^"']+)["']/i.exec(tag)?.[1] ?? '');
      return css === null ? tag : `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
    })
    .replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi, (tag, _a, src) => {
      const js = local(src);
      return js === null ? tag : `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`;
    });
}

const end = events.at(-1)?.t ?? 0;
const site = inlineSite(c.slug);
const tape = {
  version: 1,
  id: c.slug as string,
  recordedAt: new Date(t0).toISOString(),
  durationMs: end,
  model: setting('llm_model'),
  idea: c.idea as string,
  company: { name: c.name, tagline: c.tagline, status: c.status },
  bots: bots.map((b) => ({ key: b.key, name: b.name, color: b.color })),
  totals: {
    tasks: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    steps: tasks.reduce((n, t) => n + t.steps, 0),
    toolCalls: events.filter((e) => e.k === 'step' && e.kind === 'call').length,
    llmCalls: usage.length,
    tokens: usage.reduce((n, u) => n + u.prompt_tokens + u.completion_tokens, 0),
    costUsd: Number(usage.reduce((n, u) => n + u.cost_usd, 0).toFixed(4)),
    drafts: outbox.length,
    asks: asks.length,
  },
  events,
  docs: docs.map((d) => ({ kind: d.kind, title: d.title, content: duringPeopleTask(d.created_at) ? WITHHELD : maskEmails(d.content) })),
  outbox: outbox.map(({ ts: _ts, ...o }) => o),
  // Served as its own file, in a sandboxed frame, the way Nightshift serves every company site.
  site: site === null ? null : `demo/${c.slug}.site.html`,
};

const json = JSON.stringify(tape);
const leak = SECRET_RE.exec(json + (site ?? ''));
if (leak) {
  console.error(`Not written: the tape contains something shaped like an API key ("${leak[0].slice(0, 8)}…"). Check the run in ${dataDir}.`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `${tape.id}.json`), json);
// Not masked: the addresses on a page the Engineer wrote are placeholders and the company's own.
if (site !== null) fs.writeFileSync(path.join(OUT_DIR, `${tape.id}.site.html`), site);

// The index the landing page reads to offer each recording.
const indexPath = path.join(OUT_DIR, 'index.json');
const index: Row[] = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : [];
const entry = { id: tape.id, idea: tape.idea, name: tape.company.name, tagline: tape.company.tagline, recordedAt: tape.recordedAt, durationMs: tape.durationMs };
fs.writeFileSync(indexPath, `${JSON.stringify([...index.filter((e) => e.id !== tape.id), entry], null, 2)}\n`);

console.log(`\nTape: ${path.relative(ROOT, path.join(OUT_DIR, `${tape.id}.json`))} (${(json.length / 1024).toFixed(0)} KB)`);
console.log(`  ${tape.company.name}: ${tape.totals.tasks} tasks, ${tape.totals.done} done, ${tape.totals.toolCalls} tool calls, ${tape.totals.llmCalls} model calls, $${tape.totals.costUsd}, ${(end / 60_000).toFixed(1)} min`);
preview.close();
process.exit(0);
