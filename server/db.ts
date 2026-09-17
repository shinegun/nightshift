import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.NIGHTSHIFT_DATA ?? 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'nightshift.db');
export const db = new DatabaseSync(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort — the DB holds API keys */ }

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Everyone who may drive the agents. All of them can do everything; the point of separate rows is
-- that actions can say who took them, and that one person can be removed without changing the
-- other's password. Passwords are scrypt hashes, never the password itself.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  idea TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'bootstrapping',
  mood TEXT NOT NULL DEFAULT 'booting',
  auto_mode INTEGER NOT NULL DEFAULT 0,
  night_mode INTEGER NOT NULL DEFAULT 1,
  email TEXT NOT NULL DEFAULT '',
  site_url TEXT NOT NULL DEFAULT '',
  vercel_project TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'note',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'feature',
  status TEXT NOT NULL DEFAULT 'todo',
  priority INTEGER NOT NULL DEFAULT 2,
  source TEXT NOT NULL DEFAULT 'user',
  result TEXT,
  error TEXT,
  steps INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One conversation with the co-founder. The chat used to be a single stream per company, which
-- made "what did we decide about pricing?" unanswerable and replayed twenty unrelated turns into
-- every prompt. A thread is the unit of both.
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_company ON threads(company_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  from_addr TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  message_id TEXT UNIQUE,
  in_reply_to TEXT,
  error TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tweets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  posted_at TEXT
);

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT NOT NULL,
  countries TEXT NOT NULL DEFAULT 'MY',
  daily_budget_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  external TEXT NOT NULL DEFAULT '{}',
  insights TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, email)
);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  path TEXT NOT NULL DEFAULT '/',
  referrer TEXT NOT NULL DEFAULT '',
  visitor TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  external_id TEXT UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  url TEXT NOT NULL,
  external_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  company_id INTEGER,
  task_id INTEGER,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  cached_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);

-- Commits an agent wants to make to a company's site repository. Like emails and posts, these
-- wait for the owner unless the gate is turned off, because a push is visible to other people.
CREATE TABLE IF NOT EXISTS commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  branch TEXT NOT NULL,
  message TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  sha TEXT,
  remote TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  pushed_at TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  text TEXT NOT NULL
);

-- Recurring or one-off money the owner pays for outside the app: domain, hosting, APIs,
-- prepaid top-ups that aren't metered per call. Metered costs (model tokens, X posts) are
-- computed from usage/tweets instead of being entered here.
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  period TEXT NOT NULL DEFAULT 'month',
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, day)
);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '',
  unblocks TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  source_task_id INTEGER,
  blocked_task_id INTEGER,
  answer TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);

CREATE TABLE IF NOT EXISTS issues (
  key TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_id, status);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_visits_company ON visits(company_id, ts);
CREATE INDEX IF NOT EXISTS idx_activity_company ON activity(company_id, id);
CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day);
`);

export type Row = Record<string, unknown>;
export type Param = string | number | bigint | boolean | null | undefined | Uint8Array;

const norm = (params: Param[]) =>
  params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)) as any[];

export function all<T = Row>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...norm(params)) as T[];
}

export function get<T = Row>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...norm(params)) as T | undefined;
}

export function run(sql: string, ...params: Param[]) {
  const r = db.prepare(sql).run(...norm(params));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

export const now = () => new Date().toISOString();

// ── Migrations (additive, safe to re-run) ──────────────────────────────────

if (!all<{ name: string }>('PRAGMA table_info(tasks)').some((col) => col.name === 'position')) {
  // Queue order for the To do list (drag-and-drop). Seeded from the old order: priority, then age.
  db.exec('ALTER TABLE tasks ADD COLUMN position REAL');
  db.exec(`UPDATE tasks SET position = (
    SELECT rn FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY priority, id) AS rn FROM tasks) t
    WHERE t.id = tasks.id)`);
}

if (!all<{ name: string }>('PRAGMA table_info(activity)').some((col) => col.name === 'actor')) {
  // Who caused this line. NULL means the agents did it on their own, which is most of them, and
  // is exactly what you want to be able to tell apart once more than one person has a login.
  db.exec('ALTER TABLE activity ADD COLUMN actor TEXT');
}

if (!all<{ name: string }>('PRAGMA table_info(tasks)').some((col) => col.name === 'messages')) {
  // The agent conversation, kept only while a task is paused for budget. Without it, a task that
  // runs out of budget at step 20 throws away everything it already paid for and starts over.
  db.exec('ALTER TABLE tasks ADD COLUMN messages TEXT');
}

if (!all<{ name: string }>('PRAGMA table_info(messages)').some((col) => col.name === 'thread_id')) {
  // Which conversation a message belongs to. Everything written before threads existed is one
  // conversation per company — it genuinely was one — rather than being orphaned or dropped.
  db.exec('ALTER TABLE messages ADD COLUMN thread_id INTEGER REFERENCES threads(id) ON DELETE CASCADE');
  db.exec(`INSERT INTO threads (company_id, title, created_at, updated_at)
           SELECT company_id, 'Earlier conversation', MIN(created_at), MAX(created_at)
             FROM messages GROUP BY company_id`);
  db.exec(`UPDATE messages SET thread_id = (
    SELECT id FROM threads WHERE threads.company_id = messages.company_id AND threads.title = 'Earlier conversation')`);
}
if (!all<{ name: string }>('PRAGMA table_info(messages)').some((col) => col.name === 'image')) {
  // Filename of an image the owner attached, under data/uploads/<company_id>/. The file stays on
  // disk rather than in the row: a base64 image in `content` would be replayed into every prompt
  // and shipped to the browser with every poll.
  db.exec('ALTER TABLE messages ADD COLUMN image TEXT');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id)');

if (!all<{ name: string }>('PRAGMA table_info(tweets)').some((col) => col.name === 'posted_day')) {
  // The local day a post went out. posted_at is UTC, so counting OpEx per local day/month from
  // it would misfile posts made near midnight.
  db.exec('ALTER TABLE tweets ADD COLUMN posted_day TEXT');
  db.exec("UPDATE tweets SET posted_day = substr(posted_at, 1, 10) WHERE posted_at IS NOT NULL");
}

// ── Bots ───────────────────────────────────────────────────────────────────
// A bot is three layers with three owners. Skills (how to do the job) belong to a template and
// travel to every company that hires it. Memory (what the bot knows) belongs to one bot at one
// company and never leaves it. The work itself happens per task. Keeping those owners separate in
// the schema is what lets one template serve many companies without any of them seeing another's
// notes.

db.exec(`
CREATE TABLE IF NOT EXISTS bot_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'moon',
  task_types TEXT NOT NULL DEFAULT '[]',
  needs TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES bot_templates(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Recurring work a template knows how to do. Whether it runs is decided per hired bot.
CREATE TABLE IF NOT EXISTS bot_routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES bot_templates(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  task_type TEXT NOT NULL,
  cadence TEXT NOT NULL DEFAULT 'weekly',
  weekday INTEGER NOT NULL DEFAULT 1,
  hour INTEGER NOT NULL DEFAULT 9,
  default_on INTEGER NOT NULL DEFAULT 0
);

-- A template hired into a company. One per template per company, which keeps "which bot does
-- this task belong to" a lookup rather than a decision.
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES bot_templates(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'moon',
  status TEXT NOT NULL DEFAULT 'active',
  routines TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (company_id, template_id)
);

-- A bot's notebook at one company. A note starts 'proposed' and only reaches a prompt once the
-- owner keeps it: an unreviewed note would be repeated to the model on every later task, and a
-- customer could otherwise write one ("I was promised free refunds") just by emailing.
CREATE TABLE IF NOT EXISTS bot_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  source TEXT NOT NULL DEFAULT 'task',
  source_task_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bots_company ON bots(company_id);
CREATE INDEX IF NOT EXISTS idx_bot_skills_template ON bot_skills(template_id, position);
CREATE INDEX IF NOT EXISTS idx_bot_memories_owner ON bot_memories(company_id, bot_id, status);
`);

if (!all<{ name: string }>('PRAGMA table_info(tasks)').some((col) => col.name === 'bot_id')) {
  // Which bot does the task, and which bot handed it over. from_bot_id is what makes a handoff
  // ("Support passed this bug to Engineer") something the dashboard can show.
  db.exec('ALTER TABLE tasks ADD COLUMN bot_id INTEGER REFERENCES bots(id) ON DELETE SET NULL');
  db.exec('ALTER TABLE tasks ADD COLUMN from_bot_id INTEGER REFERENCES bots(id) ON DELETE SET NULL');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_bot ON tasks(bot_id, status)');

// Every place that inserts a task (the inbox, the co-founder, the owner, other bots) gets its bot
// here, from the task type, instead of each of them having to know about bots. Built-in templates
// win a tie so a saved copy of Support doesn't quietly take over the inbox.
db.exec(`
CREATE TRIGGER IF NOT EXISTS tasks_assign_bot AFTER INSERT ON tasks
WHEN NEW.bot_id IS NULL
BEGIN
  UPDATE tasks SET bot_id = (
    SELECT b.id FROM bots b
      JOIN bot_templates t ON t.id = b.template_id, json_each(t.task_types) j
     WHERE b.company_id = NEW.company_id AND j.value = NEW.type
     ORDER BY t.builtin DESC, b.id LIMIT 1
  ) WHERE id = NEW.id;
END;
`);

// ── Row types ──────────────────────────────────────────────────────────────

export interface Company {
  id: number; slug: string; name: string; idea: string; tagline: string;
  status: 'bootstrapping' | 'live' | 'paused' | 'error'; mood: string;
  auto_mode: number; night_mode: number; email: string; site_url: string;
  vercel_project: string; config: string; created_at: string; updated_at: string;
}

export type TaskType = 'fix' | 'feature' | 'research' | 'marketing' | 'outreach' | 'support' | 'ops';
/** blocked = paused until the owner does something only a human can do (see the requests table). */
export type TaskStatus = 'todo' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';

export interface Thread {
  id: number; company_id: number; title: string; created_at: string; updated_at: string;
}

export interface Message {
  id: number; company_id: number; thread_id: number | null; role: 'user' | 'assistant';
  content: string; image: string | null; created_at: string;
}

export interface Request {
  id: number; company_id: number; title: string; why: string; steps: string; unblocks: string;
  status: 'open' | 'done' | 'dismissed'; source_task_id: number | null; blocked_task_id: number | null;
  answer: string | null; created_at: string; done_at: string | null;
}

export interface Task {
  id: number; company_id: number; title: string; description: string; type: TaskType;
  status: TaskStatus; priority: number; position: number | null; source: string; result: string | null; error: string | null;
  steps: number; cost_usd: number; created_at: string; started_at: string | null; finished_at: string | null;
  /** Saved agent conversation, set only while the task is paused for budget. */
  messages: string | null;
  bot_id: number | null;
  /** The bot that created this task, when one bot handed work to another. */
  from_bot_id: number | null;
}

export interface Commit {
  id: number; company_id: number;
  status: 'pending_approval' | 'pushing' | 'pushed' | 'failed' | 'rejected';
  branch: string; message: string; summary: string;
  sha: string | null; remote: string | null; error: string | null;
  created_at: string; pushed_at: string | null;
}

export interface Doc {
  id: number; company_id: number; kind: string; title: string; content: string;
  created_at: string; updated_at: string;
}

export interface Email {
  id: number; company_id: number; direction: 'in' | 'out';
  status: 'received' | 'sent' | 'pending_approval' | 'failed' | 'rejected';
  kind: string; from_addr: string; to_addr: string; subject: string; body: string;
  message_id: string | null; in_reply_to: string | null; error: string | null; read: number; created_at: string;
}

export interface Tweet {
  id: number; company_id: number; text: string;
  status: 'pending_approval' | 'posted' | 'failed' | 'rejected';
  external_id: string | null; error: string | null; created_at: string; posted_at: string | null;
  posted_day: string | null;
}

export interface AdCampaign {
  id: number; company_id: number; name: string; headline: string; body: string; link: string;
  countries: string; daily_budget_cents: number; status: 'draft' | 'paused' | 'active' | 'failed';
  external: string; insights: string | null; error: string | null; created_at: string; updated_at: string;
}

export interface Expense {
  id: number; name: string; amount_usd: number; period: ExpensePeriod;
  company_id: number | null; note: string; created_at: string;
}

/** month/year recur; 'once' is charged whole in the month it was entered. */
export type ExpensePeriod = 'month' | 'year' | 'once';

export type BotColor = 'moon' | 'blue' | 'green' | 'coral' | 'amber' | 'violet' | 'teal' | 'pink';
export type Cadence = 'daily' | 'weekdays' | 'weekly';

export interface BotTemplate {
  id: number; key: string; name: string; blurb: string; role: string; color: BotColor;
  /** JSON arrays: the task types this bot takes, and the integrations its skills use. */
  task_types: string; needs: string;
  builtin: number; version: number; created_at: string; updated_at: string;
}

export interface BotSkill {
  id: number; template_id: number; title: string; body: string; position: number; created_at: string; updated_at: string;
}

export interface BotRoutine {
  id: number; template_id: number; title: string; description: string; task_type: TaskType;
  cadence: Cadence; weekday: number; hour: number; default_on: number;
}

export interface Bot {
  id: number; company_id: number; template_id: number; name: string; color: BotColor;
  status: 'active' | 'paused';
  /** JSON array of the routine ids switched on for this bot. */
  routines: string;
  created_at: string; updated_at: string;
}

export interface BotMemory {
  id: number; company_id: number; bot_id: number; content: string;
  status: 'proposed' | 'active'; source: 'task' | 'owner'; source_task_id: number | null;
  created_at: string; updated_at: string;
}

export const companyById = (id: number) => get<Company>('SELECT * FROM companies WHERE id = ?', id);

export const companyBySlug = (slug: string) => get<Company>('SELECT * FROM companies WHERE slug = ?', slug);
