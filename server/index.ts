// First, so .env is in the environment before any module reads it.
import './env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { actorStore, adoptLegacyPassword, currentActor, listUsers, removeUser, touchUser, userCount, verifyUser } from './users.ts';
import { streamSSE } from 'hono/streaming';
import {
  DATA_DIR, all, companyBySlug, db, get, now, run,
  type AdCampaign, type Commit, type Company, type Doc, type Email, type Expense, type Message, type Request, type Task, type Thread, type Tweet,
} from './db.ts';
import { COMPANY_KEYS, SECRET_KEYS, companyConfig, flag, num, publicSettings, setting, updateSettings } from './settings.ts';
import { activity, emit, subscribe } from './events.ts';
import { listModels, spentThisMonth, spentToday, testLLM } from './llm.ts';
import { TRACKER_JS, injectTracker, listFiles, listVersions, restoreVersion, safePath, siteDir } from './sites.ts';
import { publishPlan, summarize } from './publish.ts';
import { webSearch } from './integrations/search.ts';
import { companyAddress, testEmail, testImap } from './integrations/email.ts';
import { deploySite, testVercel } from './integrations/vercel.ts';
import { createPaymentLink, testStripe } from './integrations/stripe.ts';
import { testX } from './integrations/x.ts';
import { testMeta } from './integrations/meta.ts';
import { opex, opexSummary } from './costs.ts';
import { deliverEmail, deliverTweet, pushCommit, queueAd, queueEmail, queueTweet, setAdStatus } from './actions.ts';
import { bootstrap, createCompany } from './agents/bootstrap.ts';
import { chatWithCofounder } from './agents/chat.ts';
import { morningReport, planNight } from './agents/night.ts';
import { runTask } from './agents/runner.ts';
import { companyMetrics, insertTask, integrationStatus, saveDocument } from './agents/tools.ts';
import { isNight, startScheduler } from './scheduler.ts';
import { clearIssue, clearIssuesForSettings, dismissIssue, integrationHealth, openIssues, reportIssue, type IntegrationKey } from './health.ts';
import { decisions } from './decisions.ts';
import { deleteImages, readImage, saveImage } from './uploads.ts';
import { status as gitStatus } from './git.ts';
import { errMsg, localNow } from './util.ts';

const PORT = Number(process.env.PORT ?? 4455);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 4456);
const HOST = process.env.HOST ?? '127.0.0.1';
// The two listeners want opposite things, so they get separate addresses. The dashboard should be
// as hard to reach as possible (localhost, or one private interface such as a tailnet address);
// the public endpoint has to stay reachable by whatever tunnels it, which runs on this machine.
// Defaults to HOST so existing single-address setups keep working.
const PUBLIC_HOST = process.env.PUBLIC_HOST ?? HOST;
const PASSWORD = process.env.DASHBOARD_PASSWORD ?? '';
const PROD = process.env.NODE_ENV === 'production';
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);

class HttpError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) { super(message); this.status = status; }
}
const bad = (m: string) => new HttpError(400, m);

// ── Public surface: tracker, visits, waitlist, hosted sites ────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
};
// Agent-written pages run in an opaque origin so their scripts can never reach the dashboard API.
const SITE_HEADERS = {
  'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-cache',
};

function publicRoutes(app: Hono) {
  app.use('/public/*', cors({ origin: '*', allowMethods: ['POST', 'OPTIONS'], allowHeaders: ['content-type'] }));

  app.get('/t.js', (c) => c.body(TRACKER_JS, 200, {
    'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*',
  }));

  app.post('/public/track', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const co = typeof b.site === 'string' ? companyBySlug(b.site) : undefined;
    if (!co) return c.json({ ok: false }, 404);
    // Sandboxed pages can't use localStorage: fall back to a daily IP+browser fingerprint (hashed, never stored raw).
    const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return `fp${(h >>> 0).toString(16)}`; };
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
    const visitor = String(b.v ?? '').slice(0, 64) || fnv(`${ip}|${c.req.header('user-agent') ?? ''}|${now().slice(0, 10)}`);
    run('INSERT INTO visits (company_id, path, referrer, visitor, ts) VALUES (?, ?, ?, ?, ?)',
      co.id, String(b.path ?? '/').slice(0, 300), String(b.ref ?? '').slice(0, 300), visitor, now());
    emit('visit', co.id);
    return c.json({ ok: true });
  });

  app.post('/public/waitlist', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const co = typeof b.site === 'string' ? companyBySlug(b.site) : undefined;
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!co) return c.json({ ok: false }, 404);
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return c.json({ ok: false, error: 'Invalid email' }, 400);
    const r = run('INSERT OR IGNORE INTO waitlist (company_id, email, created_at) VALUES (?, ?, ?)', co.id, email, now());
    if (r.changes) {
      const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM waitlist WHERE company_id = ?', co.id)?.n ?? 0;
      activity(co.id, `> New waitlist signup — ${n} total`);
    }
    return c.json({ ok: true });
  });

  const serveSite = (c: Context) => {
    const slug = c.req.param('slug') ?? '';
    if (!companyBySlug(slug)) return c.text('Not found', 404);
    const rel = decodeURIComponent(c.req.path.slice(`/s/${slug}/`.length)) || 'index.html';
    let p: string;
    try { p = safePath(slug, rel); } catch { return c.text('Bad path', 400); }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p) && fs.existsSync(`${p}.html`)) p = `${p}.html`;
    if (!fs.existsSync(p)) return c.html('<!doctype html><title>Not found</title><p style="font-family:system-ui;padding:2rem">Page not found.</p>', 404, SITE_HEADERS);
    const ext = path.extname(p).toLowerCase();
    const buf = fs.readFileSync(p);
    // Owner previews (dashboard iframe, "Open preview") aren't traffic; the public port / tunnel is.
    const host = c.req.header('host') ?? '';
    const preview = ALLOWED_HOSTS.has(host.replace(/:\d+$/, '').toLowerCase()) && !host.endsWith(`:${PUBLIC_PORT}`);
    const html = () => {
      const out = injectTracker(buf.toString('utf8'), slug, '');
      return preview ? out.replace(`data-site="${slug}"`, `data-site="${slug}" data-preview`) : out;
    };
    const body = ext === '.html' || ext === '.htm' ? html() : new Uint8Array(buf);
    return c.body(body, 200, { ...SITE_HEADERS, 'content-type': MIME[ext] ?? 'application/octet-stream' });
  };
  app.get('/s/:slug', (c) => c.redirect(`/s/${c.req.param('slug')}/`));
  app.get('/s/:slug/*', serveSite);
}

// ── Dashboard API ──────────────────────────────────────────────────────────

const api = new Hono();

const mustCompany = (c: Context) => {
  const co = companyBySlug(c.req.param('slug') ?? '');
  if (!co) throw new HttpError(404, 'Company not found');
  return co;
};
const idOf = (c: Context) => {
  const n = Number(c.req.param('id'));
  if (!Number.isInteger(n) || n <= 0) throw bad('Bad id');
  return n;
};
const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, any>;
const strip = ({ config: _config, ...rest }: Company) => rest;
const isRunning = (companyId: number) => Boolean(get(`SELECT id FROM tasks WHERE company_id = ? AND status = 'running'`, companyId));

// People — who can drive the agents. Adding someone means choosing a password, which belongs in a
// terminal rather than a browser tab, so that lives in `npm run user -- add`.
api.get('/users', (c) => c.json({ users: listUsers(), me: currentActor() }));

api.delete('/users/:username', (c) => {
  try {
    removeUser(c.req.param('username'));
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 400);
  }
});

api.get('/state', (c) => c.json({
  companies: all<Company>('SELECT * FROM companies ORDER BY updated_at DESC').map((co) => ({ ...strip(co), metrics: companyMetrics(co) })),
  spentToday: spentToday(),
  spentThisMonth: spentThisMonth(),
  opex: opexSummary(),
  budget: num('daily_budget_usd'),
  monthlyBudget: num('monthly_budget_usd'),
  llmConfigured: Boolean(setting('llm_api_key')),
  model: setting('llm_model'),
  schedulerPaused: flag('scheduler_paused'),
  night: isNight(localNow().hour),
  issues: openIssues(),
  syncedAt: setting('synced_at'),
}));

// OpEx — the cost side, for the meter and Settings → OpEx. Metered lines (tokens, X posts) are
// counted from what the app did; subscriptions are entered by the owner.

api.get('/opex', (c) => c.json({ ...opex(), companies: all<{ id: number; slug: string; name: string }>('SELECT id, slug, name FROM companies ORDER BY id') }));

api.post('/expenses', async (c) => {
  const b = await body(c);
  const name = String(b.name ?? '').trim();
  if (!name) throw bad('Give it a name — e.g. "safastack.com domain".');
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0) throw bad('Amount must be a number (USD) — e.g. 0.99.');
  const period = ['month', 'year', 'once'].includes(String(b.period)) ? String(b.period) : 'month';
  const companyId = b.companyId == null || b.companyId === '' ? null : Number(b.companyId);
  const id = run(
    'INSERT INTO expenses (name, amount_usd, period, company_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    name.slice(0, 80), amount, period, companyId, String(b.note ?? '').slice(0, 200), now(),
  ).id;
  emit('opex');
  return c.json({ id });
});

api.delete('/expenses/:id', (c) => {
  run('DELETE FROM expenses WHERE id = ?', Number(c.req.param('id')));
  emit('opex');
  return c.json({ ok: true });
});

// Companies

api.post('/companies', async (c) => {
  const b = await body(c);
  const idea = String(b.idea ?? '').trim();
  if (idea.length < 10) throw bad('Describe your idea in at least a sentence.');
  if (!setting('llm_api_key')) throw bad('Add your AI API key in Settings first.');
  const co = await createCompany(idea.slice(0, 2000), typeof b.name === 'string' ? b.name : undefined);
  dismissIssue('unrouted-mail'); // its "you don't have a company yet" advice is now stale
  return c.json({ slug: co.slug });
});

api.get('/companies/:slug', (c) => {
  const co = mustCompany(c);
  const cfg = companyConfig(co);
  const overrides = Object.fromEntries(COMPANY_KEYS.map((k) => {
    const v = String(cfg[k] ?? '');
    return [k, SECRET_KEYS.has(k) ? { set: Boolean(v), hint: v ? `••••${v.slice(-4)}` : '' } : { set: Boolean(v), hint: '', value: v }];
  }));
  // The list only ever shows a clamped one-line preview of these three, and `messages` is never
  // read in the browser at all. Sending them whole made this payload ~350 KB, refetched on every
  // activity event. TaskModal fetches the full row from /tasks/:id when you open one.
  const tasks = all<Task>(
    `SELECT id, company_id, title, type, status, priority, source, steps, cost_usd,
            created_at, started_at, finished_at, position,
            substr(description, 1, 280) AS description,
            substr(result, 1, 280) AS result,
            substr(error, 1, 280) AS error
       FROM tasks WHERE company_id = ? AND status != 'cancelled'
     ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'todo' THEN 1 ELSE 2 END,
              CASE WHEN status = 'todo' THEN position ELSE 0 END,
              CASE WHEN status = 'todo' THEN id ELSE 0 END,
              COALESCE(finished_at, started_at, created_at) DESC
     LIMIT 300`, co.id);
  const revenue = all<{ currency: string; cents: number }>('SELECT currency, SUM(amount_cents) AS cents FROM revenue WHERE company_id = ? GROUP BY currency ORDER BY cents DESC', co.id);
  return c.json({
    company: strip(co),
    overrides,
    metrics: companyMetrics(co),
    integrations: integrationStatus(co),
    health: integrationHealth(co),
    activity: all('SELECT * FROM (SELECT * FROM activity WHERE company_id = ? ORDER BY id DESC LIMIT 40) ORDER BY id', co.id),
    tasks,
    docs: all(`SELECT id, kind, title, created_at, updated_at FROM documents WHERE company_id = ?
               ORDER BY CASE kind WHEN 'mission' THEN 0 WHEN 'research' THEN 1 WHEN 'roadmap' THEN 2 ELSE 3 END, updated_at DESC`, co.id),
    requests: all<Request>(`SELECT * FROM requests WHERE company_id = ? AND status = 'open' ORDER BY id`, co.id),
    // The same list the morning brief is built from, so the two can never disagree.
    decisions: decisions(co),
    commits: all<Commit>('SELECT * FROM commits WHERE company_id = ? ORDER BY id DESC LIMIT 20', co.id),
    emails: all<Email>('SELECT * FROM emails WHERE company_id = ? ORDER BY id DESC LIMIT 60', co.id),
    tweets: all<Tweet>('SELECT * FROM tweets WHERE company_id = ? ORDER BY id DESC LIMIT 30', co.id),
    ads: all<AdCampaign>('SELECT * FROM ad_campaigns WHERE company_id = ? ORDER BY id DESC', co.id),
    paymentLinks: all('SELECT * FROM payment_links WHERE company_id = ? ORDER BY id DESC', co.id),
    revenueTotal: revenue.map((r) => `${(r.cents / 100).toFixed(2)} ${r.currency.toUpperCase()}`),
    reports: all('SELECT * FROM reports WHERE company_id = ? ORDER BY day DESC LIMIT 7', co.id),
    waitlist: all('SELECT email, created_at FROM waitlist WHERE company_id = ? ORDER BY id DESC LIMIT 50', co.id),
    versions: listVersions(co.slug),
    files: listFiles(co.slug),
    publish: publishPlan(co),
    previewUrl: `/s/${co.slug}/`,
    publicBaseUrl: setting('public_base_url'),
    running: tasks.some((t) => t.status === 'running'),
    spendTotal: get<{ s: number | null }>('SELECT SUM(cost_usd) AS s FROM usage WHERE company_id = ?', co.id)?.s ?? 0,
    night: isNight(localNow().hour),
  });
});

api.patch('/companies/:slug', async (c) => {
  const co = mustCompany(c);
  const b = await body(c);
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const k of ['name', 'tagline', 'email', 'vercel_project'] as const) {
    if (typeof b[k] === 'string') { sets.push(`${k} = ?`); vals.push(b[k].trim().slice(0, 200)); }
  }
  if (typeof b.name === 'string' && !b.name.trim()) throw bad('Name cannot be empty');
  for (const k of ['auto_mode', 'night_mode'] as const) {
    if (typeof b[k] === 'boolean') {
      sets.push(`${k} = ?`); vals.push(b[k] ? 1 : 0);
      activity(co.id, `> ${k === 'auto_mode' ? 'Auto Mode' : 'Night Task'} ${b[k] ? 'on' : 'off'}`);
    }
  }
  if (b.overrides && typeof b.overrides === 'object') {
    const cfg = companyConfig(co);
    for (const [k, v] of Object.entries(b.overrides as Record<string, unknown>)) {
      if (!COMPANY_KEYS.includes(k)) continue;
      if (v === null) delete cfg[k];
      else if (typeof v === 'string' && v.trim()) cfg[k] = v.trim();
    }
    sets.push('config = ?'); vals.push(JSON.stringify(cfg));
    clearIssuesForSettings(Object.keys(b.overrides as Record<string, unknown>), co);
  }
  if (sets.length) run(`UPDATE companies SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...vals, now(), co.id);
  emit('company', co.id);
  return c.json({ ok: true });
});

api.delete('/companies/:slug', (c) => {
  const co = mustCompany(c);
  if (isRunning(co.id)) throw new HttpError(409, 'A task is running — cancel it first.');
  run('DELETE FROM companies WHERE id = ?', co.id);
  run('DELETE FROM settings WHERE key IN (?, ?)', `launch_post:${co.id}`, `night_planned:${co.id}`);
  fs.rmSync(siteDir(co.slug), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'site-versions', co.slug), { recursive: true, force: true });
  emit('company');
  return c.json({ ok: true });
});

api.post('/companies/:slug/bootstrap', (c) => {
  const co = mustCompany(c);
  if (co.status === 'bootstrapping' && isRunning(co.id)) throw new HttpError(409, 'Setup is already running.');
  void bootstrap(co.id);
  return c.json({ ok: true });
});

api.post('/companies/:slug/night', async (c) => c.json({ created: await planNight(mustCompany(c)) }));
api.post('/companies/:slug/report', async (c) => c.json({ content: await morningReport(mustCompany(c), true) }));

// Tasks

api.post('/companies/:slug/tasks', async (c) => {
  const co = mustCompany(c);
  const b = await body(c);
  if (!String(b.title ?? '').trim()) throw bad('Title is required');
  const id = insertTask(co, { title: b.title, description: b.description, type: b.type, priority: b.priority, source: 'user' });
  if (b.run && !isRunning(co.id)) void runTask(id);
  return c.json({ id });
});

/** Drag-and-drop order for the To do queue. The top task runs next. */
api.post('/companies/:slug/tasks/reorder', async (c) => {
  const co = mustCompany(c);
  const ids: unknown = (await body(c)).ids;
  if (!Array.isArray(ids) || !ids.every((n) => Number.isInteger(n))) throw bad('Expected { ids: [task ids in the new order] }');
  const todo = all<{ id: number }>(`SELECT id FROM tasks WHERE company_id = ? AND status = 'todo' ORDER BY position, id`, co.id).map((t) => t.id);
  const inQueue = new Set(todo);
  const stale = (ids as number[]).filter((id) => !inQueue.has(id));
  if (stale.length) {
    const many = stale.length > 1;
    throw bad(`${many ? 'Tasks' : 'Task'} ${stale.map((id) => `#${id}`).join(', ')} ${many ? "aren't" : "isn't"} in this company's To do list any more (started, finished or deleted). The list has been refreshed, so try the drag again.`);
  }
  // Anything the client didn't send (e.g. added mid-drag) keeps its relative order at the end.
  const order = [...new Set(ids as number[]), ...todo.filter((id) => !(ids as number[]).includes(id))];
  db.exec('BEGIN');
  try {
    order.forEach((id, i) => run('UPDATE tasks SET position = ? WHERE id = ?', i + 1, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  emit('tasks', co.id);
  return c.json({ ok: true, order });
});

api.get('/tasks/:id', (c) => {
  const task = get<Task>('SELECT * FROM tasks WHERE id = ?', idOf(c));
  if (!task) throw new HttpError(404, 'Task not found');
  const logs = all('SELECT * FROM (SELECT * FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT 400) ORDER BY id', task.id);
  return c.json({ task, logs });
});

api.post('/tasks/:id/run', (c) => {
  const task = get<Task>('SELECT * FROM tasks WHERE id = ?', idOf(c));
  if (!task) throw new HttpError(404, 'Task not found');
  if (!['todo', 'failed'].includes(task.status)) throw bad(`Task is ${task.status}`);
  if (isRunning(task.company_id)) throw new HttpError(409, 'Another task for this company is running.');
  if (!setting('llm_api_key')) throw bad('Add your AI API key in Settings first.');
  void runTask(task.id);
  return c.json({ ok: true });
});

api.post('/tasks/:id/cancel', (c) => {
  const id = idOf(c);
  run(`UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status IN ('todo','running')`, id);
  const t = get<Task>('SELECT company_id FROM tasks WHERE id = ?', id);
  if (t) emit('tasks', t.company_id);
  return c.json({ ok: true });
});

api.patch('/tasks/:id', async (c) => {
  const id = idOf(c);
  const task = get<Task>('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status === 'running') throw new HttpError(409, 'Task is running');
  const b = await body(c);
  run(
    'UPDATE tasks SET title = ?, description = ?, type = ?, priority = ?, status = ? WHERE id = ?',
    String(b.title ?? task.title).slice(0, 160), String(b.description ?? task.description),
    ['fix', 'feature', 'research', 'marketing', 'outreach', 'support', 'ops'].includes(b.type) ? b.type : task.type,
    [1, 2, 3].includes(b.priority) ? b.priority : task.priority,
    b.status === 'todo' ? 'todo' : task.status, id,
  );
  emit('tasks', task.company_id);
  return c.json({ ok: true });
});

api.delete('/tasks/:id', (c) => {
  const task = get<Task>('SELECT * FROM tasks WHERE id = ?', idOf(c));
  if (!task) throw new HttpError(404, 'Task not found');
  if (task.status === 'running') throw new HttpError(409, 'Cancel the task first');
  run('DELETE FROM tasks WHERE id = ?', task.id);
  emit('tasks', task.company_id);
  return c.json({ ok: true });
});

// Requests: work only the owner can do

const requestById = (c: Context) => {
  const r = get<Request>('SELECT * FROM requests WHERE id = ?', idOf(c));
  if (!r) throw new HttpError(404, 'Request not found');
  if (r.status !== 'open') throw bad(`This request is already ${r.status}.`);
  return r;
};

/** Owner did it: close the request and put the paused task back in the queue with their note. */
api.post('/requests/:id/done', async (c) => {
  const r = requestById(c);
  const answer = String((await body(c)).answer ?? '').trim().slice(0, 2000);
  run(`UPDATE requests SET status = 'done', answer = ?, done_at = ? WHERE id = ?`, answer, now(), r.id);
  activity(r.company_id, `> You handled: ${r.title}`);
  const task = r.blocked_task_id ? get<Task>(`SELECT * FROM tasks WHERE id = ? AND status = 'blocked'`, r.blocked_task_id) : undefined;
  if (task) {
    const note = `\n\nOwner note (${new Date().toISOString().slice(0, 10)}) on "${r.title}": ${answer || 'done'}`;
    run(`UPDATE tasks SET status = 'todo', description = ?, error = NULL, finished_at = NULL WHERE id = ?`, task.description + note, task.id);
    activity(r.company_id, `> Back in the queue: ${task.title}`);
  }
  emit('requests', r.company_id);
  emit('tasks', r.company_id);
  return c.json({ ok: true, requeued: task?.id ?? null });
});

/** Owner won't do it: close it and let the task run again so the agent can find another way or explain. */
api.post('/requests/:id/dismiss', (c) => {
  const r = requestById(c);
  run(`UPDATE requests SET status = 'dismissed', done_at = ? WHERE id = ?`, now(), r.id);
  const task = r.blocked_task_id ? get<Task>(`SELECT * FROM tasks WHERE id = ? AND status = 'blocked'`, r.blocked_task_id) : undefined;
  if (task) {
    const note = `\n\nOwner note: they will not do "${r.title}". Find another way or explain in your summary why this task can't be finished without it.`;
    run(`UPDATE tasks SET status = 'todo', description = ?, finished_at = NULL WHERE id = ?`, task.description + note, task.id);
  }
  emit('requests', r.company_id);
  emit('tasks', r.company_id);
  return c.json({ ok: true });
});

// Documents

api.get('/docs/:id', (c) => {
  const d = get<Doc>('SELECT * FROM documents WHERE id = ?', idOf(c));
  if (!d) throw new HttpError(404, 'Document not found');
  return c.json(d);
});

api.put('/docs/:id', async (c) => {
  const id = idOf(c);
  const d = get<Doc>('SELECT * FROM documents WHERE id = ?', id);
  if (!d) throw new HttpError(404, 'Document not found');
  const b = await body(c);
  run('UPDATE documents SET title = ?, content = ?, updated_at = ? WHERE id = ?', String(b.title ?? d.title), String(b.content ?? d.content), now(), id);
  emit('docs', d.company_id);
  return c.json(get<Doc>('SELECT * FROM documents WHERE id = ?', id));
});

api.delete('/docs/:id', (c) => {
  const d = get<Doc>('SELECT * FROM documents WHERE id = ?', idOf(c));
  if (!d) throw new HttpError(404, 'Document not found');
  run('DELETE FROM documents WHERE id = ?', d.id);
  emit('docs', d.company_id);
  return c.json({ ok: true });
});

api.post('/companies/:slug/docs', async (c) => {
  const co = mustCompany(c);
  const b = await body(c);
  if (!String(b.title ?? '').trim()) throw bad('Title is required');
  saveDocument(co, String(b.title), String(b.content ?? ''), String(b.kind ?? 'note'));
  return c.json({ ok: true });
});

// Co-founder chat

// Conversations with the co-founder, newest first, each with how much is in it.
api.get('/companies/:slug/threads', (c) => c.json(all(
  `SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) AS messages,
          (SELECT content FROM messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last
     FROM threads t WHERE t.company_id = ? ORDER BY t.updated_at DESC, t.id DESC`, mustCompany(c).id)));

api.patch('/threads/:id', async (c) => {
  const t = threadById(c);
  const title = String((await body(c)).title ?? '').trim().slice(0, 80);
  if (!title) throw bad('A conversation needs a title');
  run('UPDATE threads SET title = ? WHERE id = ?', title, t.id);
  emit('messages', t.company_id);
  return c.json({ ...t, title });
});

api.delete('/threads/:id', (c) => {
  const t = threadById(c);
  // The messages go with it: ON DELETE CASCADE is declared, but it only fires with foreign keys on.
  // The uploads go too, or the folder keeps growing with pictures nothing can reach.
  deleteImages(t.company_id, all<{ image: string }>('SELECT image FROM messages WHERE thread_id = ? AND image IS NOT NULL', t.id).map((r) => r.image));
  run('DELETE FROM messages WHERE thread_id = ?', t.id);
  run('DELETE FROM threads WHERE id = ?', t.id);
  emit('messages', t.company_id);
  return c.json({ ok: true });
});

api.get('/companies/:slug/messages', (c) => {
  const co = mustCompany(c);
  const thread = Number(c.req.query('thread') ?? 0);
  if (!thread) return c.json([]);
  return c.json(all('SELECT * FROM (SELECT * FROM messages WHERE thread_id = ? AND company_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id', thread, co.id));
});

api.post('/companies/:slug/messages', async (c) => {
  const co = mustCompany(c);
  const b = await body(c);
  const text = String(b.text ?? '').trim();
  const raw = typeof b.image === 'string' ? b.image : '';
  if (!text && !raw) throw bad('Message is empty');
  let image: string | undefined;
  if (raw) {
    try { image = saveImage(co.id, raw).file; } catch (e) { throw bad(errMsg(e)); }
  }
  return c.json(await chatWithCofounder(co, text.slice(0, 8000) || 'Have a look at this.', {
    threadId: Number(b.thread_id ?? 0) || undefined,
    // The browser's own signal: pressing Stop closes the connection, which ends the model call
    // rather than leaving it to finish and bill.
    signal: c.req.raw.signal,
    think: b.think === true,
    image,
  }));
});

// Attachments are served from here rather than statically: data/ holds every company's private
// files, and this route is behind the same sign-in as the rest of the API.
api.get('/messages/:id/image', (c) => {
  const m = get<Message>('SELECT * FROM messages WHERE id = ?', idOf(c));
  if (!m?.image) throw new HttpError(404, 'No image on that message');
  const img = readImage(m.company_id, m.image);
  if (!img) throw new HttpError(404, 'That image is no longer on disk');
  // The stored name carries a random suffix and never changes, so this can be cached hard.
  return new Response(new Uint8Array(img.body), {
    headers: { 'content-type': img.mime, 'cache-control': 'private, max-age=31536000, immutable' },
  });
});

// Email

api.post('/companies/:slug/emails', async (c) => {
  const co = mustCompany(c);
  const b = await body(c);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.to ?? ''))) throw bad('Enter a valid recipient');
  return c.json(await queueEmail(co, { to: b.to, subject: String(b.subject ?? ''), body: String(b.body ?? ''), kind: 'owner', force: true }));
});

const threadById = (c: Context) => {
  const t = get<Thread>('SELECT * FROM threads WHERE id = ?', idOf(c));
  if (!t) throw new HttpError(404, 'Conversation not found');
  return t;
};

const emailById = (c: Context) => {
  const e = get<Email>('SELECT * FROM emails WHERE id = ?', idOf(c));
  if (!e) throw new HttpError(404, 'Email not found');
  return e;
};

api.post('/emails/:id/approve', async (c) => {
  const e = emailById(c);
  if (e.direction !== 'out' || !['pending_approval', 'failed'].includes(e.status)) throw bad(`Email is ${e.status}`);
  run(`UPDATE emails SET status = 'sending' WHERE id = ?`, e.id);
  return c.json(await deliverEmail(e.id));
});
api.post('/emails/:id/reject', (c) => {
  const e = emailById(c);
  run(`UPDATE emails SET status = 'rejected' WHERE id = ? AND status IN ('pending_approval','failed')`, e.id);
  emit('email', e.company_id);
  return c.json({ ok: true });
});
api.post('/emails/:id/read', (c) => {
  const e = emailById(c);
  run('UPDATE emails SET read = 1 WHERE id = ?', e.id);
  emit('email', e.company_id);
  return c.json({ ok: true });
});
api.patch('/emails/:id', async (c) => {
  const e = emailById(c);
  if (e.status !== 'pending_approval') throw bad('Only drafts awaiting approval can be edited');
  const b = await body(c);
  run('UPDATE emails SET to_addr = ?, subject = ?, body = ? WHERE id = ?', String(b.to ?? e.to_addr), String(b.subject ?? e.subject), String(b.body ?? e.body), e.id);
  return c.json({ ok: true });
});

// X

api.post('/companies/:slug/tweets', async (c) => c.json(await queueTweet(mustCompany(c), String((await body(c)).text ?? ''), true)));

const tweetById = (c: Context) => {
  const t = get<Tweet>('SELECT * FROM tweets WHERE id = ?', idOf(c));
  if (!t) throw new HttpError(404, 'Post not found');
  return t;
};
api.post('/tweets/:id/approve', async (c) => {
  const t = tweetById(c);
  if (!['pending_approval', 'failed'].includes(t.status)) throw bad(`Post is ${t.status}`);
  return c.json(await deliverTweet(t.id));
});
api.post('/tweets/:id/reject', (c) => {
  const t = tweetById(c);
  run(`UPDATE tweets SET status = 'rejected' WHERE id = ?`, t.id);
  emit('tweet', t.company_id);
  return c.json({ ok: true });
});
api.patch('/tweets/:id', async (c) => {
  const t = tweetById(c);
  const text = String((await body(c)).text ?? '').trim();
  if (!text || text.length > 280) throw bad('Posts must be 1–280 characters');
  run(`UPDATE tweets SET text = ?, status = 'pending_approval', error = NULL WHERE id = ? AND status IN ('pending_approval','failed')`, text, t.id);
  emit('tweet', t.company_id);
  return c.json({ ok: true });
});

// Git — a commit an agent prepared, waiting on the owner to approve the push.

const commitById = (c: Context) => {
  const row = get<Commit>('SELECT * FROM commits WHERE id = ?', idOf(c));
  if (!row) throw new HttpError(404, 'Commit not found');
  return row;
};

/** Git state for a company, fetched on demand: a subprocess is too costly for the dashboard poll. */
api.get('/companies/:slug/git', async (c) => {
  const co = mustCompany(c);
  try {
    return c.json(await gitStatus(co.slug));
  } catch (e) {
    return c.json({ repo: false, branch: '', remote: null, changed: [], changedCount: 0, ahead: 0, error: errMsg(e) });
  }
});

api.post('/commits/:id/approve', async (c) => {
  const row = commitById(c);
  if (!['pending_approval', 'failed'].includes(row.status)) throw bad(`Commit is ${row.status}`);
  return c.json(await pushCommit(row.id));
});
api.post('/commits/:id/reject', (c) => {
  const row = commitById(c);
  run(`UPDATE commits SET status = 'rejected' WHERE id = ?`, row.id);
  emit('commits', row.company_id);
  return c.json({ ok: true });
});

// Meta Ads

api.post('/companies/:slug/ads', async (c) => {
  const co = mustCompany(c);
  const b = await body(c);
  return c.json(await queueAd(co, {
    name: String(b.name ?? ''), headline: String(b.headline ?? ''), body: String(b.body ?? ''),
    link: String(b.link ?? ''), countries: String(b.countries ?? 'MY'), dailyBudget: Number(b.dailyBudget ?? 5),
  }));
});
api.post('/ads/:id/activate', async (c) => { await setAdStatus(idOf(c), 'active'); return c.json({ ok: true }); });
api.post('/ads/:id/pause', async (c) => { await setAdStatus(idOf(c), 'paused'); return c.json({ ok: true }); });

// Payments

api.post('/companies/:slug/payment-links', async (c) => {
  const co = mustCompany(c);
  const b = await body(c);
  const amount = Number(b.amount);
  if (!String(b.name ?? '').trim() || !(amount > 0)) throw bad('Name and a positive amount are required');
  const r = await createPaymentLink(co, {
    name: String(b.name), amountCents: amount * 100, currency: String(b.currency || 'usd'),
    interval: b.interval === 'month' || b.interval === 'year' ? b.interval : null,
  });
  emit('payments', co.id);
  return c.json(r);
});

// Website

/** What a deploy would publish right now, and what it would leave out. */
api.get('/companies/:slug/publish', (c) => {
  const co = mustCompany(c);
  return c.json(publishPlan(co));
});

api.post('/companies/:slug/deploy', async (c) => {
  const co = mustCompany(c);
  const r = await deploySite(co, { force: false });
  activity(co.id, `> Website deployed: ${r.url} — ${summarize(r.plan)}`);
  emit('site', co.id);
  return c.json({
    url: r.url, deploymentId: r.deploymentId, published: r.published, skipped: r.skipped, bytes: r.bytes,
    warnings: r.plan.warnings, publishedPaths: r.plan.files.map((f) => f.path),
  });
});

api.post('/companies/:slug/versions/:version/restore', (c) => {
  const co = mustCompany(c);
  restoreVersion(co.slug, c.req.param('version') ?? '');
  activity(co.id, '> Restored an earlier website version');
  emit('site', co.id);
  return c.json({ ok: true });
});

// Settings

const settingsPayload = () => ({ ...publicSettings(), health: integrationHealth() });
api.get('/settings', (c) => c.json(settingsPayload()));
api.put('/settings', async (c) => {
  const patch = await body(c);
  const before = setting('email_from');
  updateSettings(patch);
  // Company addresses are derived from "Send from". When it changes, refresh the ones the
  // platform generated (empty, or still the old derived form) so no company keeps an address
  // that no longer routes. Addresses the owner typed themselves are left alone.
  if (Object.prototype.hasOwnProperty.call(patch, 'email_from') && setting('email_from') !== before) {
    for (const co of all<Company>('SELECT * FROM companies')) {
      const derived = companyAddress(co.slug, before).toLowerCase();
      if (co.email && co.email.toLowerCase() !== derived) continue;
      const next = companyAddress(co.slug, setting('email_from'));
      if (!next || next === co.email) continue;
      run('UPDATE companies SET email = ?, updated_at = ? WHERE id = ?', next, now(), co.id);
      activity(co.id, `> Company address is now ${next} (Send-from changed)`);
    }
    emit('company');
  }
  clearIssuesForSettings(Object.keys(patch)); // an edit may have fixed the last failure; the next attempt re-reports if not
  emit('settings');
  return c.json(settingsPayload());
});
api.get('/settings/models', async (c) => c.json({ models: await listModels() }));

api.post('/settings/test/:what', async (c) => {
  const global = { config: '{}' } as Company;
  try {
    const tests: Record<string, () => Promise<unknown>> = {
      llm: testLLM,
      search: async () => (await webSearch('small business bookkeeping Malaysia', 3)).map((r) => r.title),
      email: () => testEmail(setting('owner_email')),
      imap: testImap,
      vercel: testVercel,
      stripe: () => testStripe(),
      x: () => testX(global),
      meta: () => testMeta(global),
    };
    const TEST_KEYS: Record<string, IntegrationKey> = {
      llm: 'ai', search: 'search', email: 'email', imap: 'inbox', vercel: 'vercel', stripe: 'stripe', x: 'x', meta: 'meta',
    };
    const what = c.req.param('what') ?? '';
    const fn = tests[what];
    if (!fn) throw bad('Unknown test');
    try {
      const result = await fn();
      clearIssue(TEST_KEYS[what]);
      return c.json({ ok: true, result });
    } catch (e) {
      reportIssue(TEST_KEYS[what], e);
      throw e;
    }
  } catch (e) {
    return c.json({ ok: false, error: errMsg(e) });
  }
});

api.delete('/issues/:key', (c) => { dismissIssue(c.req.param('key') ?? ''); return c.json({ ok: true }); });

api.get('/usage', (c) => c.json({
  days: all(`SELECT day, SUM(cost_usd) AS cost, COUNT(*) AS calls, SUM(prompt_tokens + completion_tokens) AS tokens
             FROM usage GROUP BY day ORDER BY day DESC LIMIT 14`),
  byCompany: all(`SELECT COALESCE(c.name, '(settings tests)') AS name, SUM(u.cost_usd) AS cost
                  FROM usage u LEFT JOIN companies c ON c.id = u.company_id GROUP BY u.company_id ORDER BY cost DESC`),
}));

// Live updates

api.get('/events', (c) => {
  const slug = c.req.query('slug');
  const only = slug ? companyBySlug(slug)?.id : undefined;
  return streamSSE(c, async (stream) => {
    let open = true;
    const unsubscribe = subscribe((e) => {
      if (!open || (only && e.companyId && e.companyId !== only)) return;
      stream.writeSSE({ data: JSON.stringify({ type: e.type, companyId: e.companyId }) }).catch(() => { open = false; });
    });
    stream.onAbort(() => { open = false; });
    await stream.writeSSE({ event: 'hello', data: '{}' });
    while (open) {
      await stream.sleep(25_000);
      if (open) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => { open = false; });
    }
    unsubscribe();
  });
});

// ── App assembly ───────────────────────────────────────────────────────────

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  // Integration failures (bad key, API down) surface in the UI; keep the log to one line.
  if (!(err instanceof HttpError)) console.error(`[api] ${c.req.method} ${c.req.path}: ${err.message}`);
  return c.json({ error: err.message || 'Server error' }, err instanceof HttpError ? err.status : 500);
});

app.use('*', async (c, next) => {
  if (c.req.path.startsWith('/api/')) {
    // DNS-rebinding guard, for an unauthenticated dashboard only. It exists so a hostile page
    // cannot point a name at 127.0.0.1 and drive an API that asks nobody who they are. Accounts
    // answer that question, so the guard lifts once anyone can sign in — otherwise reaching the
    // dashboard by any name other than localhost (a tailnet address, say) would be refused.
    const host = (c.req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase();
    const authenticated = Boolean(PASSWORD) || userCount() > 0;
    if (!authenticated && !ALLOWED_HOSTS.has(host)) return c.json({ error: `Host "${host}" not allowed — add it to ALLOWED_HOSTS` }, 403);
    // CSRF guard: mutations must be same-origin JSON (forces a CORS preflight for any other site).
    if (c.req.method !== 'GET') {
      if (!(c.req.header('content-type') ?? '').includes('application/json')) return c.json({ error: 'Expected a JSON request' }, 415);
      const origin = c.req.header('origin');
      if (origin && new URL(origin).host !== c.req.header('host')) return c.json({ error: 'Cross-origin request blocked' }, 403);
    }
  }
  await next();
});

// Accounts, not one shared password: everyone can do everything, but actions can say who took
// them and one person can be removed without changing the other's login.
adoptLegacyPassword(PASSWORD);

if (userCount() > 0) {
  const challenge = (c: Context) =>
    c.json({ error: 'Sign in to Nightshift' }, 401, { 'WWW-Authenticate': 'Basic realm="Nightshift", charset="UTF-8"' });

  app.use('*', async (c, next) => {
    if (/^\/(public\/|t\.js|s\/)/.test(c.req.path)) return next();
    const [scheme, encoded] = (c.req.header('authorization') ?? '').split(' ');
    if (scheme !== 'Basic' || !encoded) return challenge(c);
    // Only the first colon separates them, so a password may contain colons.
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    const user = split < 0 ? null : verifyUser(decoded.slice(0, split), decoded.slice(split + 1));
    if (!user) return challenge(c);
    touchUser(user.id);
    // Everything downstream runs inside the actor's context, so activity() can stamp it without
    // every handler having to pass it along.
    return actorStore.run(user, () => next());
  });
}

app.route('/api', api);
publicRoutes(app);

if (PROD) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', (c) => {
    const index = path.resolve('dist/index.html');
    return fs.existsSync(index) ? c.html(fs.readFileSync(index, 'utf8')) : c.text('Run `npm run build` first.', 500);
  });
} else {
  app.get('/', (c) => c.text('Nightshift API is running. In development, open the dashboard at http://localhost:5173'));
}

const publicApp = new Hono();
publicRoutes(publicApp);
publicApp.get('/', (c) => c.text('Nightshift public endpoint'));

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`☾ Nightshift dashboard  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${PROD ? '' : '  (dev UI: http://localhost:5173)'}`);
});
serve({ fetch: publicApp.fetch, port: PUBLIC_PORT, hostname: PUBLIC_HOST }, () => {
  console.log(`  Public endpoint       http://${PUBLIC_HOST}:${PUBLIC_PORT}  (tracker + waitlist + sites — safe to tunnel)`);
});
startScheduler();

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
