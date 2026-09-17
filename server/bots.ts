/**
 * The bot team: templates, the bots hired from them, and each bot's notebook.
 *
 * Three layers, three owners, and every function here keeps to them:
 *
 *  - Skills belong to a template. Teaching one changes it for every company that hired the bot,
 *    and it is the only layer that goes into an exported template.
 *  - Memory belongs to one bot at one company. Every read filters on both, so a note written at
 *    one company can never reach a prompt at another.
 *  - A task is the unit of work. A bot's routines create tasks; they never run anything directly,
 *    so the budget, Auto Mode and Night Task keep the same say over routine work as over any other.
 */
import {
  all, get, now, run, type Bot, type BotColor, type BotMemory, type BotRoutine, type BotSkill, type BotTemplate,
  type Cadence, type Company, type TaskType,
} from './db.ts';
import { setSetting, setting } from './settings.ts';
import { emit } from './events.ts';
import { HEALTH_LABEL, integrationHealth, type IntegrationKey } from './health.ts';
import { SECRET_RE } from './publish.ts';
import { localNow } from './util.ts';

export const TASK_TYPES: TaskType[] = ['fix', 'feature', 'research', 'marketing', 'outreach', 'support', 'ops'];
export const COLORS: BotColor[] = ['moon', 'blue', 'green', 'coral', 'amber', 'violet', 'teal', 'pink'];
const CADENCES: Cadence[] = ['daily', 'weekdays', 'weekly'];
/** Integrations a template may say it needs. The ones a bot can do nothing without. */
const NEEDABLE: IntegrationKey[] = ['search', 'email', 'inbox', 'vercel', 'stripe', 'x', 'meta', 'github'];

/** How much of a bot's notebook goes into one prompt. Every character here is paid for on every call. */
export const MEMORY_BUDGET = 4000;
export const NOTE_MAX = 500;

const parseList = <T extends string>(json: string, allowed: readonly T[]): T[] => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is T => allowed.includes(x)) : [];
  } catch {
    return [];
  }
};
const parseIds = (json: string): number[] => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
};

export const templateTypes = (t: Pick<BotTemplate, 'task_types'>) => parseList(t.task_types, TASK_TYPES);
export const templateNeeds = (t: Pick<BotTemplate, 'needs'>) => parseList(t.needs, NEEDABLE);
export const botRoutineIds = (b: Pick<Bot, 'routines'>) => parseIds(b.routines);

// ── Built-in templates ─────────────────────────────────────────────────────

interface TemplateSpec {
  key: string; name: string; blurb: string; role: string; color: BotColor;
  task_types: TaskType[]; needs: IntegrationKey[];
  skills: { title: string; body: string }[];
  routines: { title: string; description: string; task_type: TaskType; cadence: Cadence; weekday?: number; hour: number; default_on: boolean }[];
}

const WEBSITE_RULES = `- The website is plain static files (HTML/CSS/JS) — no build step, no npm, no server code. index.html is the home page.
- Always list_files and read_file before editing; write_file takes the COMPLETE new file content.
- Use relative links and asset paths (styles.css, pricing.html) — never root-absolute ones like /styles.css.
- Responsive, accessible, fast: semantic HTML, one stylesheet, system or Google fonts, no heavy frameworks.
- Waitlist / signup forms: <form data-waitlist><input type="email" required><button>…</button></form>. The platform submits and counts them automatically — do not write JS handlers for them.
- Payments: call create_payment_link and link a button to the returned URL. Never embed API keys anywhere.
- Never invent testimonials, customer logos, user counts, press mentions or metrics.`;

export const BUILTINS: TemplateSpec[] = [
  {
    key: 'engineer', name: 'Engineer', color: 'blue', task_types: ['fix', 'feature'], needs: ['vercel'],
    blurb: 'Fixes bugs and ships features on the company website.',
    role: 'You are the Engineer bot. You fix reported problems and build requested features in the company website. For a fix, make the smallest correct change; for a feature, build it completely.',
    skills: [
      { title: 'Website rules', body: WEBSITE_RULES },
      { title: 'Finish with a commit', body: '- When the task changed files and the site has a git repository, call commit_changes once at the end with a message that says what changed and why. It goes to a branch and waits for the owner.' },
    ],
    routines: [],
  },
  {
    key: 'research', name: 'Research', color: 'green', task_types: ['research'], needs: ['search'],
    blurb: 'Watches the market and rivals, and cites its sources.',
    role: 'You are the Research bot. Investigate with web_search and fetch_url, rely on real sources, cite URLs, and flag uncertainty. Save the findings with write_document.',
    skills: [
      { title: 'Cite or drop it', body: '- Every claim that matters gets a URL. If you could not confirm something, say so rather than smoothing it over.' },
    ],
    routines: [
      { title: 'Check on competitors', description: 'Look at the main competitors\' sites and recent news. Save what changed since the last check (pricing, features, positioning) to the "Competitor watch" document, and create a task only if something needs a response.', task_type: 'research', cadence: 'weekly', weekday: 1, hour: 10, default_on: true },
    ],
  },
  {
    key: 'marketing', name: 'Marketing', color: 'coral', task_types: ['marketing'], needs: ['x'],
    blurb: 'Posts for X, runs capped ad campaigns, and sharpens landing copy.',
    role: 'You are the Marketing bot. Grow awareness and signups: posts for X, Meta ad campaigns, landing-page copy improvements.',
    skills: [
      { title: 'Posting rules', body: `- X posts: max 280 characters, plain and specific, at most one hashtag, no emoji walls.
- Only create a Meta ad when the website is publicly deployed (has a public URL). Keep budgets modest.
- Improving the website copy is also marketing — you have the file tools for that.` },
    ],
    routines: [
      { title: 'Draft this week\'s post', description: 'Draft one X post about something real that changed or shipped this week. If nothing did, say so and skip the post.', task_type: 'marketing', cadence: 'weekly', weekday: 1, hour: 9, default_on: true },
    ],
  },
  {
    key: 'outreach', name: 'Outreach', color: 'amber', task_types: ['outreach'], needs: ['email', 'search'],
    blurb: 'Finds well-matched prospects and drafts short first emails.',
    role: 'You are the Outreach bot. Find a handful of well-matched prospects and write short, personal, honest cold emails.',
    skills: [
      { title: 'Outreach rules', body: `- Only email addresses a business publishes for contact. Never guess or scrape personal emails.
- Max 5 emails per task. Each one personal, under 120 words, with a clear one-line opt-out ("Not relevant? Just reply 'no' and I won't follow up.").
- Never pretend to be a human founder with a fake name; sign as the company.` },
    ],
    routines: [
      { title: 'Find 5 prospects', description: 'Find up to 5 well-matched prospects that publish a contact address and draft a first email to each.', task_type: 'outreach', cadence: 'weekdays', hour: 9, default_on: false },
    ],
  },
  {
    key: 'support', name: 'Support', color: 'violet', task_types: ['support'], needs: ['email', 'inbox'],
    blurb: 'Answers the inbox and hands real bugs to Engineer.',
    role: 'You are the Support bot. Read the inbox and answer customers helpfully and honestly.',
    skills: [
      { title: 'Stay honest', body: `- Be honest about what the product can do today; it may be early. Never promise features or dates.
- If something needs the owner (refunds, legal, partnerships), say so in your summary instead of committing.` },
      { title: 'Triage every email', body: `- Sort each email first: a question (answer it), a bug (the product is broken), a feature request, or noise (ignore it).
- For a bug, reply to the customer, then hand it to Engineer with create_task (type "fix"). Put in the description: what the customer saw, the email ids, and how many customers reported it. Check list_tasks first; if the bug is already queued, don't create it twice.
- For a feature request, create a task (type "feature", priority 3) only if more than one customer asked or the owner's roadmap already points that way.` },
    ],
    routines: [
      { title: 'Sweep the inbox', description: 'Read the inbox and answer anything that has not had a reply yet. Triage each email as usual.', task_type: 'support', cadence: 'daily', hour: 17, default_on: false },
    ],
  },
  {
    key: 'ops', name: 'Ops', color: 'teal', task_types: ['ops'], needs: ['stripe'],
    blurb: 'Pricing, payment links, documents and admin.',
    role: 'You are the Ops bot. Handle pricing, payment links, documents and business admin.',
    skills: [],
    routines: [],
  },
];

function insertTemplate(spec: TemplateSpec, builtin: boolean): number {
  const t = run(
    `INSERT INTO bot_templates (key, name, blurb, role, color, task_types, needs, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    spec.key, spec.name, spec.blurb, spec.role, spec.color, JSON.stringify(spec.task_types), JSON.stringify(spec.needs),
    builtin ? 1 : 0, now(), now(),
  ).id;
  spec.skills.forEach((s, i) => run(
    'INSERT INTO bot_skills (template_id, title, body, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    t, s.title, s.body, i + 1, now(), now(),
  ));
  for (const r of spec.routines) {
    run(
      `INSERT INTO bot_routines (template_id, title, description, task_type, cadence, weekday, hour, default_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      t, r.title, r.description, r.task_type, r.cadence, r.weekday ?? 1, r.hour, r.default_on ? 1 : 0,
    );
  }
  return t;
}

/** Built-ins are created once and then belong to the owner: teaching a skill edits them in place. */
export function seedBuiltins() {
  for (const spec of BUILTINS) {
    if (!get('SELECT id FROM bot_templates WHERE key = ?', spec.key)) insertTemplate(spec, true);
  }
}

// ── Reading ────────────────────────────────────────────────────────────────

export const templateById = (id: number) => get<BotTemplate>('SELECT * FROM bot_templates WHERE id = ?', id);
export const botById = (id: number) => get<Bot>('SELECT * FROM bots WHERE id = ?', id);
export const skillsOf = (templateId: number) =>
  all<BotSkill>('SELECT * FROM bot_skills WHERE template_id = ? ORDER BY position, id', templateId);
export const routinesOf = (templateId: number) =>
  all<BotRoutine>('SELECT * FROM bot_routines WHERE template_id = ? ORDER BY id', templateId);

/** The bot a task of this type goes to at this company, by the same rule as the insert trigger. */
export function botForType(companyId: number, type: TaskType) {
  return get<Bot>(
    `SELECT b.* FROM bots b JOIN bot_templates t ON t.id = b.template_id, json_each(t.task_types) j
      WHERE b.company_id = ? AND j.value = ? ORDER BY t.builtin DESC, b.id LIMIT 1`, companyId, type,
  );
}

/** The template a type falls back to when no bot at the company takes it (it was let go). */
export function builtinForType(type: TaskType) {
  return get<BotTemplate>(
    `SELECT t.* FROM bot_templates t, json_each(t.task_types) j WHERE t.builtin = 1 AND j.value = ? ORDER BY t.id LIMIT 1`, type,
  );
}

/**
 * The notes that go into a prompt: this bot, this company, kept by the owner. Newest first, cut
 * at a budget so a long-lived bot does not quietly double the price of every call.
 */
export function memoryForPrompt(bot: Pick<Bot, 'id' | 'company_id'>) {
  const rows = all<BotMemory>(
    `SELECT * FROM bot_memories WHERE company_id = ? AND bot_id = ? AND status = 'active' ORDER BY updated_at DESC, id DESC`,
    bot.company_id, bot.id,
  );
  const lines: string[] = [];
  let used = 0;
  for (const m of rows) {
    const line = `- ${m.content.replace(/\s+/g, ' ').trim()}`;
    if (used + line.length > MEMORY_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  return { lines, left: rows.length - lines.length };
}

// ── Hiring ─────────────────────────────────────────────────────────────────

const dayOfWeek = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

export function routineDue(r: Pick<BotRoutine, 'cadence' | 'weekday' | 'hour'>, at = localNow()) {
  if (at.hour < r.hour) return false;
  const dow = dayOfWeek(at.day);
  if (r.cadence === 'weekdays') return dow >= 1 && dow <= 5;
  if (r.cadence === 'weekly') return dow === r.weekday;
  return true;
}

const routineKey = (botId: number, routineId: number) => `routine:${botId}:${routineId}`;

/**
 * A routine switched on waits for its next time rather than firing the moment you hire the bot:
 * if today's slot has already passed, today counts as done.
 */
function skipTodayIfPassed(botId: number, routines: BotRoutine[]) {
  const at = localNow();
  for (const r of routines) if (routineDue(r, at)) setSetting(routineKey(botId, r.id), at.day);
}

export class BotError extends Error {}

export function hireBot(companyId: number, templateId: number, opts: { name?: string; color?: string; routineIds?: number[] } = {}) {
  const t = templateById(templateId);
  if (!t) throw new BotError('That template no longer exists.');
  if (get('SELECT id FROM bots WHERE company_id = ? AND template_id = ?', companyId, templateId)) {
    throw new BotError(`This company already has ${/^[aeiou]/i.test(t.name) ? 'an' : 'a'} ${t.name} bot. One per template, for now.`);
  }
  const routines = routinesOf(t.id);
  const chosen = opts.routineIds
    ? routines.filter((r) => opts.routineIds!.includes(r.id))
    : routines.filter((r) => r.default_on);
  const name = (opts.name ?? '').trim().slice(0, 40) || t.name;
  const color = COLORS.includes(opts.color as BotColor) ? opts.color! : t.color;
  const id = run(
    `INSERT INTO bots (company_id, template_id, name, color, status, routines, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    companyId, t.id, name, color, JSON.stringify(chosen.map((r) => r.id)), now(), now(),
  ).id;
  skipTodayIfPassed(id, chosen);
  // Work already queued for this bot's task types is its work now, unless another bot has it.
  run(
    `UPDATE tasks SET bot_id = ? WHERE company_id = ? AND bot_id IS NULL AND status IN ('todo','blocked','failed')
       AND type IN (SELECT value FROM json_each(?))`,
    id, companyId, t.task_types,
  );
  emit('bots', companyId);
  return id;
}

/** New companies start with the whole built-in team, the same one they had before bots existed. */
export function hireDefaultTeam(companyId: number) {
  for (const t of all<BotTemplate>('SELECT * FROM bot_templates WHERE builtin = 1 ORDER BY id')) {
    if (!get('SELECT id FROM bots WHERE company_id = ? AND template_id = ?', companyId, t.id)) hireBot(companyId, t.id);
  }
}

export function fireBot(bot: Bot) {
  // Unfinished work stays in the queue; the trigger rule picks another bot for it, or none.
  run(`UPDATE tasks SET bot_id = NULL WHERE bot_id = ? AND status IN ('todo','blocked','failed')`, bot.id);
  run('DELETE FROM bots WHERE id = ?', bot.id); // the notebook goes with it (ON DELETE CASCADE)
  run('DELETE FROM settings WHERE key LIKE ?', `routine:${bot.id}:%`);
  for (const t of all<{ id: number; type: TaskType }>(`SELECT id, type FROM tasks WHERE company_id = ? AND bot_id IS NULL AND status IN ('todo','blocked','failed')`, bot.company_id)) {
    const next = botForType(bot.company_id, t.type);
    if (next) run('UPDATE tasks SET bot_id = ? WHERE id = ?', next.id, t.id);
  }
  emit('bots', bot.company_id);
}

export function updateBot(bot: Bot, patch: { name?: unknown; color?: unknown; status?: unknown; routineIds?: unknown }) {
  const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 40) : bot.name;
  const color = COLORS.includes(patch.color as BotColor) ? (patch.color as BotColor) : bot.color;
  const status = patch.status === 'paused' || patch.status === 'active' ? patch.status : bot.status;
  let routines = bot.routines;
  if (Array.isArray(patch.routineIds)) {
    const valid = routinesOf(bot.template_id);
    const next = valid.filter((r) => (patch.routineIds as unknown[]).includes(r.id));
    const before = new Set(botRoutineIds(bot));
    skipTodayIfPassed(bot.id, next.filter((r) => !before.has(r.id)));
    routines = JSON.stringify(next.map((r) => r.id));
  }
  run('UPDATE bots SET name = ?, color = ?, status = ?, routines = ?, updated_at = ? WHERE id = ?', name, color, status, routines, now(), bot.id);
  emit('bots', bot.company_id);
}

// ── Routines ───────────────────────────────────────────────────────────────

/**
 * Put due routine work in the queue. Called on every scheduler tick; each routine files at most
 * one task a day, and none while its last one is still waiting to run.
 */
export function queueRoutines(companies: Company[], insert: (c: Company, t: { title: string; description: string; type: TaskType; priority: number; source: string; botId: number }) => number) {
  const at = localNow();
  for (const c of companies) {
    for (const bot of all<Bot>(`SELECT * FROM bots WHERE company_id = ? AND status = 'active'`, c.id)) {
      const on = new Set(botRoutineIds(bot));
      for (const r of routinesOf(bot.template_id).filter((x) => on.has(x.id))) {
        const key = routineKey(bot.id, r.id);
        if (setting(key) === at.day || !routineDue(r, at)) continue;
        setSetting(key, at.day);
        const source = `routine:${r.id}`;
        if (get(`SELECT id FROM tasks WHERE bot_id = ? AND source = ? AND status IN ('todo','running','blocked')`, bot.id, source)) continue;
        insert(c, { title: r.title, description: r.description, type: r.task_type, priority: 2, source, botId: bot.id });
      }
    }
  }
}

export function describeRoutine(r: Pick<BotRoutine, 'cadence' | 'weekday' | 'hour'>) {
  const time = `${String(r.hour).padStart(2, '0')}:00`;
  if (r.cadence === 'daily') return `every day at ${time}`;
  if (r.cadence === 'weekdays') return `weekdays at ${time}`;
  return `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][r.weekday] ?? 'weekly'} at ${time}`;
}

// ── Memory ─────────────────────────────────────────────────────────────────

export function proposeMemory(bot: Pick<Bot, 'id' | 'company_id'>, content: string, taskId?: number) {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) throw new BotError('The note is empty.');
  if (text.length > NOTE_MAX) throw new BotError(`Keep a note under ${NOTE_MAX} characters. Save one fact at a time.`);
  if (SECRET_RE.test(text)) throw new BotError('That looks like an API key or credential. Never save secrets to memory.');
  const dup = get<{ id: number }>(
    `SELECT id FROM bot_memories WHERE company_id = ? AND bot_id = ? AND lower(content) = lower(?)`, bot.company_id, bot.id, text,
  );
  if (dup) return { id: dup.id, duplicate: true };
  const id = run(
    `INSERT INTO bot_memories (company_id, bot_id, content, status, source, source_task_id, created_at, updated_at) VALUES (?, ?, ?, 'proposed', 'task', ?, ?, ?)`,
    bot.company_id, bot.id, text, taskId ?? null, now(), now(),
  ).id;
  emit('memory', bot.company_id);
  return { id, duplicate: false };
}

/** A note the owner wrote themselves is already reviewed. */
export function addOwnerMemory(bot: Bot, content: string) {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) throw new BotError('The note is empty.');
  if (text.length > NOTE_MAX) throw new BotError(`Keep a note under ${NOTE_MAX} characters.`);
  if (SECRET_RE.test(text)) throw new BotError('That looks like an API key. Keys belong in Settings, not in a bot\'s memory.');
  const id = run(
    `INSERT INTO bot_memories (company_id, bot_id, content, status, source, created_at, updated_at) VALUES (?, ?, ?, 'active', 'owner', ?, ?)`,
    bot.company_id, bot.id, text, now(), now(),
  ).id;
  emit('memory', bot.company_id);
  return id;
}

export const memoryById = (id: number) => get<BotMemory>('SELECT * FROM bot_memories WHERE id = ?', id);

export function editMemory(m: BotMemory, patch: { content?: unknown; status?: unknown }) {
  const content = typeof patch.content === 'string' ? patch.content.replace(/\s+/g, ' ').trim() : m.content;
  if (!content) throw new BotError('The note is empty.');
  if (content.length > NOTE_MAX) throw new BotError(`Keep a note under ${NOTE_MAX} characters.`);
  if (SECRET_RE.test(content)) throw new BotError('That looks like an API key.');
  const status = patch.status === 'active' ? 'active' : m.status;
  run('UPDATE bot_memories SET content = ?, status = ?, updated_at = ? WHERE id = ?', content, status, now(), m.id);
  emit('memory', m.company_id);
}

export function forgetMemory(m: BotMemory) {
  run('DELETE FROM bot_memories WHERE id = ?', m.id);
  emit('memory', m.company_id);
}

// ── Skills and templates ───────────────────────────────────────────────────

const SKILL_TITLE_MAX = 80;
const SKILL_BODY_MAX = 4000;

function checkSkill(title: string, body: string) {
  if (!title.trim()) throw new BotError('A skill needs a title.');
  if (!body.trim()) throw new BotError('A skill needs some instructions.');
  if (title.length > SKILL_TITLE_MAX) throw new BotError(`Keep the title under ${SKILL_TITLE_MAX} characters.`);
  if (body.length > SKILL_BODY_MAX) throw new BotError(`Keep a skill under ${SKILL_BODY_MAX} characters.`);
  if (SECRET_RE.test(`${title}\n${body}`)) throw new BotError('That looks like an API key. Skills are shared with every company that hires this bot.');
}

const bumpTemplate = (templateId: number) =>
  run('UPDATE bot_templates SET version = version + 1, updated_at = ? WHERE id = ?', now(), templateId);

function emitForTemplate(templateId: number) {
  emit('library');
  for (const b of all<{ company_id: number }>('SELECT DISTINCT company_id FROM bots WHERE template_id = ?', templateId)) emit('bots', b.company_id);
}

export function addSkill(templateId: number, title: string, body: string) {
  checkSkill(title, body);
  const pos = get<{ p: number | null }>('SELECT MAX(position) AS p FROM bot_skills WHERE template_id = ?', templateId)?.p ?? 0;
  const id = run(
    'INSERT INTO bot_skills (template_id, title, body, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    templateId, title.trim(), body.trim(), pos + 1, now(), now(),
  ).id;
  bumpTemplate(templateId);
  emitForTemplate(templateId);
  return id;
}

export const skillById = (id: number) => get<BotSkill>('SELECT * FROM bot_skills WHERE id = ?', id);

export function editSkill(s: BotSkill, patch: { title?: unknown; body?: unknown }) {
  const title = typeof patch.title === 'string' ? patch.title : s.title;
  const body = typeof patch.body === 'string' ? patch.body : s.body;
  checkSkill(title, body);
  run('UPDATE bot_skills SET title = ?, body = ?, updated_at = ? WHERE id = ?', title.trim(), body.trim(), now(), s.id);
  bumpTemplate(s.template_id);
  emitForTemplate(s.template_id);
}

export function removeSkill(s: BotSkill) {
  run('DELETE FROM bot_skills WHERE id = ?', s.id);
  bumpTemplate(s.template_id);
  emitForTemplate(s.template_id);
}

export function editTemplate(t: BotTemplate, patch: { name?: unknown; blurb?: unknown; role?: unknown }) {
  if (t.builtin && (patch.name !== undefined || patch.role !== undefined)) {
    throw new BotError('A built-in bot keeps its name and role. Teach it skills, or save a copy to change those.');
  }
  const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 40) : t.name;
  const blurb = typeof patch.blurb === 'string' ? patch.blurb.trim().slice(0, 160) : t.blurb;
  const role = typeof patch.role === 'string' && patch.role.trim() ? patch.role.trim().slice(0, 2000) : t.role;
  if (SECRET_RE.test(`${name}\n${blurb}\n${role}`)) throw new BotError('That looks like an API key.');
  run('UPDATE bot_templates SET name = ?, blurb = ?, role = ?, version = version + 1, updated_at = ? WHERE id = ?', name, blurb, role, now(), t.id);
  emitForTemplate(t.id);
}

export function deleteTemplate(t: BotTemplate) {
  if (t.builtin) throw new BotError('Built-in bots can\'t be deleted.');
  const used = all<{ name: string }>('SELECT c.name FROM bots b JOIN companies c ON c.id = b.company_id WHERE b.template_id = ?', t.id);
  if (used.length) throw new BotError(`Still working at ${used.map((u) => u.name).join(', ')}. Let those bots go first.`);
  run('DELETE FROM bot_templates WHERE id = ?', t.id);
  emit('library');
}

/**
 * Things in skill text that belong to one company and would travel with the template: email
 * addresses, credentials, the company's own name, and names of people who have written to it.
 * A skill is written for one company, so it is easy to type a customer's name into one without
 * noticing that it is about to be shared.
 */
export function scanForPrivate(text: string, c: Pick<Company, 'id' | 'name'>) {
  const found = new Set<string>();
  for (const m of text.match(/[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/gi) ?? []) found.add(`the email address ${m}`);
  if (SECRET_RE.test(text)) found.add('something that looks like an API key');
  const lower = text.toLowerCase();
  if (c.name.trim().length >= 3 && lower.includes(c.name.trim().toLowerCase())) found.add(`the company name "${c.name}"`);
  const people = new Set<string>();
  for (const e of all<{ from_addr: string }>(`SELECT DISTINCT from_addr FROM emails WHERE company_id = ? AND direction = 'in'`, c.id)) {
    const display = e.from_addr.split('<')[0].replace(/["']/g, '').trim();
    for (const part of display.split(/\s+/)) if (/^[A-Z][a-z]{2,}$/.test(part)) people.add(part);
  }
  for (const name of people) {
    if (new RegExp(`\\b${name}\\b`).test(text)) found.add(`"${name}", who has emailed this company`);
  }
  return [...found];
}

const slugKey = (name: string) =>
  `mine-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'bot'}-${Date.now().toString(36)}`;

export function saveAsTemplate(bot: Bot, opts: { name: string; blurb?: string; skillIds: number[]; confirm?: boolean }) {
  const t = templateById(bot.template_id)!;
  const c = get<Company>('SELECT * FROM companies WHERE id = ?', bot.company_id)!;
  const name = opts.name.trim().slice(0, 40);
  if (!name) throw new BotError('Give the template a name.');
  const skills = skillsOf(t.id).filter((s) => opts.skillIds.includes(s.id));
  const warnings = skills.flatMap((s) => scanForPrivate(`${s.title}\n${s.body}`, c).map((w) => `"${s.title}" mentions ${w}`));
  const secret = skills.find((s) => SECRET_RE.test(`${s.title}\n${s.body}`));
  if (secret) throw new BotError(`"${secret.title}" contains something that looks like an API key. Remove it before saving.`);
  if (warnings.length && !opts.confirm) return { id: null, warnings };
  const id = insertTemplate({
    key: slugKey(name), name, blurb: (opts.blurb ?? t.blurb).slice(0, 160), role: t.role, color: bot.color,
    task_types: templateTypes(t), needs: templateNeeds(t),
    skills: skills.map((s) => ({ title: s.title, body: s.body })),
    routines: routinesOf(t.id).map((r) => ({ ...r, default_on: Boolean(r.default_on) })),
  }, false);
  emit('library');
  return { id, warnings };
}

// A template file carries the parts that travel and nothing else. There is no field for memory,
// so there is nothing to forget to strip.
export const TEMPLATE_FORMAT = 'nightshift-bot-template';

export function exportTemplate(t: BotTemplate) {
  return {
    format: TEMPLATE_FORMAT,
    version: 1,
    name: t.name,
    blurb: t.blurb,
    role: t.role,
    color: t.color,
    task_types: templateTypes(t),
    needs: templateNeeds(t),
    skills: skillsOf(t.id).map((s) => ({ title: s.title, body: s.body })),
    routines: routinesOf(t.id).map((r) => ({
      title: r.title, description: r.description, task_type: r.task_type, cadence: r.cadence, weekday: r.weekday, hour: r.hour, default_on: Boolean(r.default_on),
    })),
  };
}

const str = (v: unknown, max: number, label: string) => {
  if (typeof v !== 'string') throw new BotError(`The file is missing "${label}".`);
  if (v.length > max) throw new BotError(`"${label}" is longer than ${max} characters.`);
  return v;
};

/** A template file is someone else's instructions. Everything in it is checked, and a key anywhere refuses the file. */
export function importTemplate(file: unknown) {
  const f = file as Record<string, unknown> | null;
  if (!f || f.format !== TEMPLATE_FORMAT) throw new BotError('That isn\'t a Nightshift bot template.');
  const name = str(f.name, 40, 'name').trim();
  if (!name) throw new BotError('The template has no name.');
  const role = str(f.role, 2000, 'role').trim();
  if (!role) throw new BotError('The template has no role.');
  const types = Array.isArray(f.task_types) ? f.task_types.filter((x): x is TaskType => TASK_TYPES.includes(x)) : [];
  if (!types.length) throw new BotError('The template doesn\'t say which kinds of task it takes.');
  const needs = Array.isArray(f.needs) ? f.needs.filter((x): x is IntegrationKey => NEEDABLE.includes(x)) : [];
  const skills = (Array.isArray(f.skills) ? f.skills : []).slice(0, 30).map((s: any, i: number) => {
    const title = str(s?.title, SKILL_TITLE_MAX, `skills[${i}].title`);
    const body = str(s?.body, SKILL_BODY_MAX, `skills[${i}].body`);
    checkSkill(title, body);
    return { title, body };
  });
  const routines = (Array.isArray(f.routines) ? f.routines : []).slice(0, 10).map((r: any, i: number) => {
    const type = TASK_TYPES.includes(r?.task_type) ? (r.task_type as TaskType) : null;
    if (!type) throw new BotError(`routines[${i}] has an unknown task type.`);
    return {
      title: str(r.title, 120, `routines[${i}].title`),
      description: str(r.description ?? '', 2000, `routines[${i}].description`),
      task_type: type,
      cadence: CADENCES.includes(r.cadence) ? (r.cadence as Cadence) : 'weekly',
      weekday: Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6 ? r.weekday : 1,
      hour: Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23 ? r.hour : 9,
      // Someone else's routine never switches itself on.
      default_on: false,
    };
  });
  const blurb = typeof f.blurb === 'string' ? f.blurb.slice(0, 160) : '';
  if (SECRET_RE.test(`${name}\n${blurb}\n${role}\n${JSON.stringify(routines)}`)) throw new BotError('The file contains something that looks like an API key.');
  const id = insertTemplate({
    key: slugKey(name), name, blurb, role, color: COLORS.includes(f.color as BotColor) ? (f.color as BotColor) : 'moon',
    task_types: types, needs, skills, routines,
  }, false);
  emit('library');
  return id;
}

// ── What the dashboard shows ───────────────────────────────────────────────

export function needsFor(t: BotTemplate, c?: Company) {
  const health = integrationHealth(c);
  return templateNeeds(t).map((k) => ({ key: k, label: HEALTH_LABEL[k], state: health[k].state, message: health[k].message }));
}

export interface BotSummary {
  id: number; name: string; color: BotColor; status: Bot['status'];
  template: { id: number; key: string; name: string; blurb: string; builtin: boolean };
  state: 'working' | 'waiting' | 'idle' | 'paused';
  now: { id: number; title: string } | null;
  next: { id: number; title: string } | null;
  queued: number; waitingOnYou: number; notesToReview: number;
  routines: { id: number; title: string; when: string }[];
  lastDone: { id: number; title: string; finished_at: string } | null;
}

export function teamSummary(c: Company): BotSummary[] {
  const bots = all<Bot & { t_key: string; t_name: string; t_blurb: string; t_builtin: number }>(
    `SELECT b.*, t.key AS t_key, t.name AS t_name, t.blurb AS t_blurb, t.builtin AS t_builtin
       FROM bots b JOIN bot_templates t ON t.id = b.template_id WHERE b.company_id = ? ORDER BY t.builtin DESC, b.id`, c.id,
  );
  return bots.map((b) => {
    const running = get<{ id: number; title: string }>(`SELECT id, title FROM tasks WHERE bot_id = ? AND status = 'running' LIMIT 1`, b.id);
    const next = get<{ id: number; title: string }>(`SELECT id, title FROM tasks WHERE bot_id = ? AND status = 'todo' ORDER BY position, id LIMIT 1`, b.id);
    const queued = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE bot_id = ? AND status = 'todo'`, b.id)?.n ?? 0;
    const waiting = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE bot_id = ? AND status = 'blocked'`, b.id)?.n ?? 0;
    const notes = get<{ n: number }>(`SELECT COUNT(*) AS n FROM bot_memories WHERE bot_id = ? AND company_id = ? AND status = 'proposed'`, b.id, c.id)?.n ?? 0;
    const lastDone = get<{ id: number; title: string; finished_at: string }>(
      `SELECT id, title, finished_at FROM tasks WHERE bot_id = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 1`, b.id,
    ) ?? null;
    const on = new Set(botRoutineIds(b));
    return {
      id: b.id, name: b.name, color: b.color, status: b.status,
      template: { id: b.template_id, key: b.t_key, name: b.t_name, blurb: b.t_blurb, builtin: Boolean(b.t_builtin) },
      state: b.status === 'paused' ? 'paused' : running ? 'working' : waiting || notes ? 'waiting' : 'idle',
      now: running ?? null, next: next ?? null, queued, waitingOnYou: waiting, notesToReview: notes,
      routines: routinesOf(b.template_id).filter((r) => on.has(r.id)).map((r) => ({ id: r.id, title: r.title, when: describeRoutine(r) })),
      lastDone,
    };
  });
}

/** Work one bot passed to another in the last day. */
export function recentHandoffs(c: Company) {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  return all<{ id: number; title: string; status: string; from_name: string; to_name: string | null; created_at: string }>(
    `SELECT t.id, t.title, t.status, t.created_at, f.name AS from_name, b.name AS to_name
       FROM tasks t JOIN bots f ON f.id = t.from_bot_id LEFT JOIN bots b ON b.id = t.bot_id
      WHERE t.company_id = ? AND t.created_at >= ? AND (t.bot_id IS NULL OR t.bot_id != t.from_bot_id)
      ORDER BY t.id DESC LIMIT 6`, c.id, since,
  );
}

export function notesToReview(c: Company) {
  return all<{ id: number; bot_id: number; bot_name: string; bot_color: BotColor; content: string; source_task_id: number | null; created_at: string }>(
    `SELECT m.id, m.bot_id, b.name AS bot_name, b.color AS bot_color, m.content, m.source_task_id, m.created_at
       FROM bot_memories m JOIN bots b ON b.id = m.bot_id
      WHERE m.company_id = ? AND m.status = 'proposed' ORDER BY m.id`, c.id,
  );
}

export function botProfile(bot: Bot, c: Company) {
  const t = templateById(bot.template_id)!;
  const on = new Set(botRoutineIds(bot));
  const summary = teamSummary(c).find((s) => s.id === bot.id)!;
  return {
    bot: summary,
    template: {
      id: t.id, key: t.key, name: t.name, blurb: t.blurb, role: t.role, builtin: Boolean(t.builtin), version: t.version,
      taskTypes: templateTypes(t),
      usedIn: all<{ slug: string; name: string }>('SELECT c.slug, c.name FROM bots b JOIN companies c ON c.id = b.company_id WHERE b.template_id = ? ORDER BY c.name', t.id),
    },
    skills: skillsOf(t.id),
    routines: routinesOf(t.id).map((r) => ({ id: r.id, title: r.title, description: r.description, when: describeRoutine(r), on: on.has(r.id) })),
    needs: needsFor(t, c),
    memory: all<BotMemory>(
      `SELECT * FROM bot_memories WHERE company_id = ? AND bot_id = ? ORDER BY CASE status WHEN 'proposed' THEN 0 ELSE 1 END, updated_at DESC`,
      c.id, bot.id,
    ),
    memoryBudget: { used: memoryForPrompt(bot).lines.join('\n').length, max: MEMORY_BUDGET },
    tasks: all(
      `SELECT t.id, t.title, t.type, t.status, t.source, t.created_at, t.finished_at, f.name AS from_name
         FROM tasks t LEFT JOIN bots f ON f.id = t.from_bot_id
        WHERE t.bot_id = ? AND t.status != 'cancelled'
        ORDER BY CASE t.status WHEN 'running' THEN 0 WHEN 'todo' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, COALESCE(t.finished_at, t.created_at) DESC
        LIMIT 25`, bot.id,
    ),
    handedOff: all(
      `SELECT t.id, t.title, t.status, t.created_at, b.name AS to_name FROM tasks t LEFT JOIN bots b ON b.id = t.bot_id
        WHERE t.from_bot_id = ? ORDER BY t.id DESC LIMIT 10`, bot.id,
    ),
  };
}

export function library(companyId?: number) {
  return all<BotTemplate>('SELECT * FROM bot_templates ORDER BY builtin DESC, name').map((t) => ({
    id: t.id, key: t.key, name: t.name, blurb: t.blurb, role: t.role, color: t.color, builtin: Boolean(t.builtin), version: t.version,
    taskTypes: templateTypes(t),
    needs: templateNeeds(t).map((k) => ({ key: k, label: HEALTH_LABEL[k] })),
    skills: skillsOf(t.id).map((s) => ({ id: s.id, title: s.title, body: s.body })),
    routines: routinesOf(t.id).map((r) => ({ id: r.id, title: r.title, description: r.description, when: describeRoutine(r), defaultOn: Boolean(r.default_on) })),
    usedIn: all<{ slug: string; name: string; botId: number }>(
      'SELECT c.slug, c.name, b.id AS botId FROM bots b JOIN companies c ON c.id = b.company_id WHERE b.template_id = ? ORDER BY c.name', t.id,
    ),
    hiredHere: companyId ? Boolean(get('SELECT id FROM bots WHERE company_id = ? AND template_id = ?', companyId, t.id)) : false,
  }));
}

// ── Start-up ───────────────────────────────────────────────────────────────

seedBuiltins();
// Companies that existed before bots did get the team they were already using, once. A flag
// rather than "has no bots", so an owner who lets every bot go doesn't get them all back.
if (!setting('bots_migrated')) {
  for (const c of all<{ id: number }>('SELECT id FROM companies')) hireDefaultTeam(c.id);
  run(`UPDATE tasks SET bot_id = (
         SELECT b.id FROM bots b JOIN bot_templates t ON t.id = b.template_id, json_each(t.task_types) j
          WHERE b.company_id = tasks.company_id AND j.value = tasks.type ORDER BY t.builtin DESC, b.id LIMIT 1)
       WHERE bot_id IS NULL`);
  setSetting('bots_migrated', now());
}
