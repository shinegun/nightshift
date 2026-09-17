import { all, get, now, run, type Company, type Doc, type Email, type TaskType } from '../db.ts';
import { companySetting, setting } from '../settings.ts';
import { activity, emit } from '../events.ts';
import type { ToolDef } from '../llm.ts';
import { integrationHealth, type IntegrationKey } from '../health.ts';
import { BOUNCE, gateWriting, readableText, writingNote } from '../humanizer.ts';
import { fetchUrl, webSearch } from '../integrations/search.ts';
import { emailConfigured } from '../integrations/email.ts';
import { deploySite } from '../integrations/vercel.ts';
import { createPaymentLink } from '../integrations/stripe.ts';
import { queueAd, queueCommit, queueEmail, queueTweet } from '../actions.ts';
import { status as gitStatus } from '../git.ts';
import { deleteSiteFile, listFiles, readSiteFile, writeSiteFile } from '../sites.ts';
import { truncate } from '../util.ts';
import { proposeMemory } from '../bots.ts';
import { describeReport, openPage } from '../browser.ts';

export interface ToolCtx {
  company: Company;
  taskId?: number;
  counters: Record<string, number>;
  siteChanged: boolean;
  limits?: Record<string, number>; // per-context overrides of Tool.limit
  rejected?: Map<string, number>; // humanizer bounces per item
  blockedBy?: number; // request id this task is now waiting on
  botId?: number; // the bot doing this work; its notes and handoffs are filed under it
}

interface Tool {
  description: string;
  params: Record<string, unknown>;
  required?: string[];
  limit?: number; // max calls per run
  run: (args: any, ctx: ToolCtx) => Promise<string> | string;
}

const str = (description: string) => ({ type: 'string', description });
const TASK_TYPES: TaskType[] = ['fix', 'feature', 'research', 'marketing', 'outreach', 'support', 'ops'];

/** Tool families agents may use: anything set up, even if its last attempt failed (a retry may work). */
export function integrationStatus(c: Company) {
  const h = integrationHealth(c);
  const usable = (k: IntegrationKey) => h[k].state !== 'off';
  return { email: usable('email'), vercel: usable('vercel'), stripe: usable('stripe'), x: usable('x'), meta: usable('meta') };
}

export function companyMetrics(c: Company) {
  const q = (sql: string, ...p: (string | number)[]) => Number(Object.values(get(sql, ...p) ?? { n: 0 })[0] ?? 0);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const revenue = all<{ currency: string; cents: number }>('SELECT currency, SUM(amount_cents) AS cents FROM revenue WHERE company_id = ? GROUP BY currency', c.id);
  return {
    visitors_total: q('SELECT COUNT(DISTINCT visitor) FROM visits WHERE company_id = ?', c.id),
    visitors_7d: q('SELECT COUNT(DISTINCT visitor) FROM visits WHERE company_id = ? AND ts >= ?', c.id, weekAgo),
    pageviews_7d: q('SELECT COUNT(*) FROM visits WHERE company_id = ? AND ts >= ?', c.id, weekAgo),
    waitlist: q('SELECT COUNT(*) FROM waitlist WHERE company_id = ?', c.id),
    revenue: revenue.map((r) => `${(r.cents / 100).toFixed(2)} ${r.currency.toUpperCase()}`),
    tasks_open: q(`SELECT COUNT(*) FROM tasks WHERE company_id = ? AND status IN ('todo','running')`, c.id),
    tasks_done: q(`SELECT COUNT(*) FROM tasks WHERE company_id = ? AND status = 'done'`, c.id),
    emails_unread: q(`SELECT COUNT(*) FROM emails WHERE company_id = ? AND direction = 'in' AND read = 0`, c.id),
  };
}

export function saveDocument(c: Company, title: string, content: string, kind = 'note') {
  const existing = get<Doc>('SELECT * FROM documents WHERE company_id = ? AND lower(title) = lower(?)', c.id, title);
  if (existing) run('UPDATE documents SET content = ?, kind = ?, updated_at = ? WHERE id = ?', content, kind, now(), existing.id);
  else run('INSERT INTO documents (company_id, kind, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', c.id, kind, title, content, now(), now());
  emit('docs', c.id);
  return existing ? 'updated' : 'created';
}

/**
 * Where a new task joins the To do queue: High priority goes to the end of the
 * High block at the top (so urgent work jumps the line in arrival order);
 * everything else goes to the bottom. The owner can drag it anywhere after that.
 */
function queuePosition(companyId: number, priority: number) {
  const todo = all<{ priority: number; position: number }>(
    `SELECT priority, position FROM tasks WHERE company_id = ? AND status = 'todo' AND position IS NOT NULL ORDER BY position`, companyId,
  );
  if (!todo.length) return 1;
  const last = todo[todo.length - 1].position;
  if (priority !== 1) return last + 1;
  const firstOther = todo.findIndex((t) => t.priority !== 1);
  if (firstOther === -1) return last + 1;
  const before = firstOther === 0 ? todo[0].position - 1 : todo[firstOther - 1].position;
  return (before + todo[firstOther].position) / 2;
}

export function insertTask(c: Company, t: {
  title: string; description?: string; type?: string; priority?: number; source: string;
  /** Who does it. Left out, the database picks the bot for the task type. */
  botId?: number;
  /** The bot that asked for it, when this is one bot handing work to another. */
  fromBotId?: number;
}) {
  const type = TASK_TYPES.includes(t.type as TaskType) ? t.type : 'feature';
  const priority = [1, 2, 3].includes(Number(t.priority)) ? Number(t.priority) : 2;
  const r = run(
    'INSERT INTO tasks (company_id, title, description, type, priority, position, source, bot_id, from_bot_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    c.id, String(t.title).slice(0, 160), String(t.description ?? ''), type, priority, queuePosition(c.id, priority), t.source,
    t.botId ?? null, t.fromBotId ?? null, now(),
  );
  emit('tasks', c.id);
  return r.id;
}

const TOOLS: Record<string, Tool> = {
  // ── research ──
  web_search: {
    description: 'Search the web. Returns titles, URLs and snippets.',
    params: { query: str('Search query'), num: { type: 'integer', description: 'Results to return (1-10, default 6)' } },
    required: ['query'], limit: 15,
    run: async ({ query, num }) => {
      const results = await webSearch(String(query), Math.min(Math.max(Number(num) || 6, 1), 10));
      return results.length ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n') : 'No results.';
    },
  },
  fetch_url: {
    description: 'Fetch a public web page and return its readable text.',
    params: { url: str('Absolute http(s) URL') }, required: ['url'], limit: 15,
    run: ({ url }) => fetchUrl(String(url)),
  },

  open_page: {
    description:
      'Open one of this company\'s own pages in a real browser (JavaScript runs) and read what a visitor sees, plus any JavaScript errors and failed requests. '
      + 'Pass a path on the preview site ("/holdings.html") or a URL on the company\'s live site. Read-only: it cannot click, type or submit, '
      + 'and form posts are blocked. Use fetch_url for other websites.',
    params: {
      url: str('A path on the preview site such as /index.html, or a URL on the company\'s live site'),
      selector: str('Optional CSS selector: return only the text inside the first match'),
      wait_for: str('Optional CSS selector to wait for (up to 10s) before reading, for content a script adds late'),
    },
    required: ['url'], limit: 8,
    run: async ({ url, selector, wait_for }, { company }) => {
      const fresh = get<Company>('SELECT * FROM companies WHERE id = ?', company.id) ?? company;
      const r = await openPage(fresh, String(url ?? ''), {
        selector: selector ? String(selector) : undefined,
        waitFor: wait_for ? String(wait_for) : undefined,
      });
      return describeReport(r);
    },
  },

  // ── website ──
  list_files: {
    description: 'List files in the company website.',
    params: {},
    run: (_a, { company }) => {
      const files = listFiles(company.slug);
      return files.length ? files.map((f) => `${f.path} (${f.size} bytes)`).join('\n') : 'The site is empty.';
    },
  },
  read_file: {
    description: 'Read a website file.',
    params: { path: str('Path relative to the site root, e.g. index.html') }, required: ['path'],
    run: ({ path }, { company }) => truncate(readSiteFile(company.slug, String(path)), 60_000),
  },
  write_file: {
    description: 'Create or overwrite a website file with the COMPLETE content.',
    params: { path: str('Path relative to the site root'), content: str('Full file content') },
    required: ['path', 'content'], limit: 30,
    run: ({ path, content }, ctx) => {
      const bounced = gateWriting(ctx, `write_file:${path}`, readableText(String(path), String(content)), 'write_file');
      if (bounced) return bounced;
      writeSiteFile(ctx.company.slug, String(path), String(content));
      ctx.siteChanged = true;
      emit('site', ctx.company.id);
      return `Wrote ${path} (${Buffer.byteLength(String(content))} bytes).`;
    },
  },
  delete_file: {
    description: 'Delete a website file.',
    params: { path: str('Path relative to the site root') }, required: ['path'],
    run: ({ path }, ctx) => {
      deleteSiteFile(ctx.company.slug, String(path));
      ctx.siteChanged = true;
      return `Deleted ${path}.`;
    },
  },
  deploy_site: {
    description: 'Publish the website to production on Vercel. Only the files the site actually links are uploaded; tooling, internal notes and sample data stay private. Returns the public URL.',
    params: {}, limit: 2,
    run: async (_a, { company }) => {
      const fresh = get<Company>('SELECT * FROM companies WHERE id = ?', company.id)!;
      const r = await deploySite(fresh);
      emit('site', company.id);
      const kb = (r.bytes / 1024).toFixed(1);
      const held = r.skipped
        ? ` Not published: ${r.skipped} file${r.skipped === 1 ? '' : 's'} in the folder that no page reaches (tooling, internal notes, sample data) — the Website panel lists each one with the reason.`
        : '';
      const gaps = r.plan.missing.length
        ? ` A page asks for ${r.plan.missing.join(', ')} and it is not in the folder yet; the page handles that itself.`
        : '';
      const warn = r.plan.warnings.length ? ` Warnings: ${r.plan.warnings.join(' ')}` : '';
      return `Deployed ${r.published} files (${kb} KB). Live at ${r.url}.${held}${gaps}${warn}`;
    },
  },

  commit_changes: {
    description:
      'Record your file changes in the company\'s git repository and push them to a branch, so the work is saved and someone can review it. '
      + 'Use this once at the end of a task that changed files, not after each edit. It commits everything currently changed in the site folder, '
      + 'so say what the whole change does. It goes to a branch and waits for the owner to approve the push; it never writes to their main branch directly.',
    params: {
      message: str('Commit message: one line saying what changed and why'),
      branch: str('Branch name (optional). Defaults to one named for today.'),
    },
    required: ['message'], limit: 2,
    run: async (a, { company }) => {
      const r = await queueCommit(company, { message: String(a.message), branch: a.branch ? String(a.branch) : undefined });
      return r.status === 'pending_approval'
        ? `Commit prepared on branch ${r.branch} with ${r.files} changed file(s). It is waiting for the owner to approve the push.`
        : `Pushed ${'sha' in r ? r.sha.slice(0, 8) : ''} to ${r.branch}.`;
    },
  },

  git_status: {
    description: 'Check the company\'s git repository: current branch, how many files differ from the last commit, and whether a remote exists. Read-only.',
    params: {}, limit: 3,
    run: async (_a, { company }) => {
      const s = await gitStatus(company.slug);
      if (!s.repo) return 'This company has no git repository. Files are still saved and deployable; they are just not version-controlled.';
      const files = s.changedCount ? `${s.changedCount} changed file(s): ${s.changed.slice(0, 25).join(', ')}` : 'nothing changed since the last commit';
      return `On branch ${s.branch}. ${files}. Remote: ${s.remote ?? 'none'}.${s.ahead ? ` ${s.ahead} commit(s) not pushed.` : ''}`;
    },
  },

  // ── knowledge ──
  write_document: {
    description: 'Create or update a company document (markdown). A document with the same title is replaced.',
    params: {
      title: str('Document title'),
      kind: { type: 'string', enum: ['research', 'roadmap', 'mission', 'note', 'plan', 'report'] },
      content: str('Markdown content'),
    },
    required: ['title', 'content'], limit: 5,
    run: ({ title, kind, content }, { company }) => `Document "${title}" ${saveDocument(company, String(title), String(content), kind ?? 'note')}.${writingNote(String(content))}`,
  },
  read_document: {
    description: 'Read a company document by title.',
    params: { title: str('Document title') }, required: ['title'],
    run: ({ title }, { company }) => {
      const d = get<Doc>('SELECT * FROM documents WHERE company_id = ? AND lower(title) = lower(?)', company.id, String(title));
      return d ? truncate(d.content, 30_000) : `No document titled "${title}".`;
    },
  },
  create_task: {
    description: 'Add a follow-up task to the company task queue.',
    params: {
      title: str('Short imperative title'),
      description: str('What exactly to do and what "done" looks like'),
      type: { type: 'string', enum: TASK_TYPES },
      priority: { type: 'integer', enum: [1, 2, 3], description: '1 = high, 2 = normal, 3 = low' },
    },
    required: ['title', 'description', 'type'], limit: 2,
    run: (a, ctx) => {
      const { company } = ctx;
      const open = Number(Object.values(get(`SELECT COUNT(*) AS n FROM tasks WHERE company_id = ? AND status = 'todo'`, company.id) ?? { n: 0 })[0]);
      if (open >= 25) return 'Not created: the queue already has 25 open tasks.';
      const id = insertTask(company, { title: a.title, description: a.description, type: a.type, priority: a.priority, source: 'agent', fromBotId: ctx.botId });
      const to = get<{ name: string }>('SELECT b.name FROM tasks t JOIN bots b ON b.id = t.bot_id WHERE t.id = ?', id);
      return `Created task #${id}${to ? ` for the ${to.name} bot` : ''}.`;
    },
  },
  remember: {
    description: 'Save one durable fact about this company to your notebook, for later tasks. The owner reviews it before it is used.',
    params: { note: str('One fact, in a sentence or two (under 500 characters)') },
    required: ['note'], limit: 3,
    run: ({ note }, ctx) => {
      if (!ctx.botId) return 'You have no notebook here.';
      const r = proposeMemory({ id: ctx.botId, company_id: ctx.company.id }, String(note ?? ''), ctx.taskId);
      return r.duplicate
        ? 'You already have that note. Nothing saved.'
        : 'Saved for the owner to review. It becomes part of your memory once they keep it.';
    },
  },
  list_tasks: {
    description: 'List the company tasks.',
    params: { status: { type: 'string', enum: ['todo', 'done', 'failed', 'all'] } },
    run: ({ status }, { company }) => {
      const rows = all<{ id: number; title: string; status: string; type: string }>(
        `SELECT id, title, status, type FROM tasks WHERE company_id = ? ${status && status !== 'all' ? 'AND status = ?' : ''} ORDER BY id DESC LIMIT 40`,
        ...(status && status !== 'all' ? [company.id, status] : [company.id]),
      );
      return rows.map((t) => `#${t.id} [${t.status}] (${t.type}) ${t.title}`).join('\n') || 'No tasks.';
    },
  },
  ask_owner: {
    description: 'Ask the owner to do something only a human can do: create an account or repo, verify a domain, pay for something, paste an API key, or make a legal or brand decision. Use this instead of creating a task for that work.',
    params: {
      title: str('What the owner must do. Short and imperative.'),
      why: str('Why it is needed, in one or two sentences'),
      steps: str('Numbered steps they can follow, exact and specific: real URLs, and the exact Settings section name when a key is involved'),
      unblocks: str('What this unblocks once it is done'),
      blocks_this_task: { type: 'boolean', description: 'True if this task cannot continue until the owner does it' },
    },
    required: ['title', 'why', 'steps'], limit: 2,
    run: (a, ctx) => {
      const title = String(a.title).slice(0, 140);
      const open = get<{ id: number }>(`SELECT id FROM requests WHERE company_id = ? AND status = 'open' AND lower(title) = lower(?)`, ctx.company.id, title);
      if (open) return `Already asked (request #${open.id}) and still open. Don't ask twice; carry on with what you can do.`;
      const r = run(
        `INSERT INTO requests (company_id, title, why, steps, unblocks, source_task_id, blocked_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.company.id, title, String(a.why ?? ''), String(a.steps ?? ''), String(a.unblocks ?? ''),
        ctx.taskId, a.blocks_this_task && ctx.taskId ? ctx.taskId : null, now(),
      );
      if (a.blocks_this_task && ctx.taskId) ctx.blockedBy = r.id;
      activity(ctx.company.id, `> Needs you: ${title}`);
      emit('requests', ctx.company.id);
      return `Asked the owner (request #${r.id}). It is on the dashboard under "Needs you".${
        a.blocks_this_task ? ' This task is now paused until they do it, so stop here and write your summary.' : ''
      }${writingNote(`${a.why} ${a.steps}`)}`;
    },
  },
  get_metrics: {
    description: 'Current business metrics: visitors, waitlist, revenue, tasks, unread email.',
    params: {},
    run: (_a, { company }) => JSON.stringify(companyMetrics(company), null, 2),
  },

  // ── email ──
  read_inbox: {
    description: 'Read recent emails received by the company.',
    params: { limit: { type: 'integer', description: 'Max emails (default 10)' } },
    run: ({ limit }, { company }) => {
      const rows = all<Email>(`SELECT * FROM emails WHERE company_id = ? AND direction = 'in' ORDER BY id DESC LIMIT ?`, company.id, Math.min(Number(limit) || 10, 30));
      run(`UPDATE emails SET read = 1 WHERE company_id = ? AND direction = 'in'`, company.id);
      return rows.map((e) => `--- email #${e.id} | ${e.created_at}\nFrom: ${e.from_addr}\nSubject: ${e.subject}\n\n${truncate(e.body, 4000)}`).join('\n\n') || 'Inbox is empty.';
    },
  },
  reply_email: {
    description: 'Reply to a received email.',
    params: { email_id: { type: 'integer' }, body: str('Plain-text reply') },
    required: ['email_id', 'body'], limit: 10,
    run: async ({ email_id, body }, ctx) => {
      const { company } = ctx;
      const bounced = gateWriting(ctx, `reply_email:${email_id}`, String(body), 'reply_email');
      if (bounced) return bounced;
      const e = get<Email>(`SELECT * FROM emails WHERE id = ? AND company_id = ? AND direction = 'in'`, Number(email_id), company.id);
      if (!e) return `No received email #${email_id}.`;
      const subject = /^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`;
      const r = await queueEmail(company, { to: e.from_addr, subject, body: String(body), kind: 'support', inReplyTo: e.message_id });
      return r.status === 'sent' ? 'Reply sent.' : 'Reply drafted and waiting for owner approval.';
    },
  },
  send_email: {
    description: 'Send a new email (outreach, follow-ups, partners).',
    params: { to: str('Recipient address'), subject: str('Subject'), body: str('Plain-text body') },
    required: ['to', 'subject', 'body'], limit: 5,
    run: async ({ to, subject, body }, ctx) => {
      const { company } = ctx;
      const bounced = gateWriting(ctx, `send_email:${to}`, `${subject}\n${body}`, 'send_email');
      if (bounced) return bounced;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to))) return `"${to}" is not a valid email address.`;
      const r = await queueEmail(company, { to: String(to), subject: String(subject), body: String(body), kind: 'outreach' });
      return r.status === 'sent' ? 'Email sent.' : 'Email drafted and waiting for owner approval.';
    },
  },

  // ── growth ──
  post_to_x: {
    description: 'Post to the company X (Twitter) account. Max 280 characters.',
    params: { text: str('Post text') }, required: ['text'], limit: 3,
    run: async ({ text }, ctx) => {
      const bounced = gateWriting(ctx, 'post_to_x', String(text), 'post_to_x', 3);
      if (bounced) return bounced;
      const r = await queueTweet(ctx.company, String(text));
      return r.status === 'posted' ? 'Posted.' : 'Drafted and waiting for owner approval.';
    },
  },
  create_meta_ad: {
    description: 'Create a Meta (Facebook/Instagram) traffic campaign pointing at a URL.',
    params: {
      name: str('Internal campaign name'),
      headline: str('Ad headline (≤40 chars)'),
      body: str('Primary text (≤125 chars)'),
      link: str('Destination URL — must be the public website'),
      countries: str('Comma-separated ISO country codes, e.g. "MY,SG"'),
      daily_budget: { type: 'number', description: "Daily budget in the ad account's currency" },
    },
    required: ['name', 'headline', 'body', 'link', 'countries', 'daily_budget'], limit: 1,
    run: async (a, ctx) => {
      const { company } = ctx;
      const bounced = gateWriting(ctx, 'create_meta_ad', `${a.headline}\n${a.body}`, 'create_meta_ad');
      if (bounced) return bounced;
      if (!/^https:\/\//.test(String(a.link))) return 'The link must be a public https URL (deploy the site first).';
      const r = await queueAd(company, { name: a.name, headline: a.headline, body: a.body, link: a.link, countries: a.countries, dailyBudget: Number(a.daily_budget) });
      return r.status === 'active' ? `Campaign live at ${r.dailyBudget}/day.` : `Campaign created (paused, ${r.dailyBudget}/day) — the owner will activate it.`;
    },
  },
  create_payment_link: {
    description: 'Create a Stripe payment link for a product or subscription. Returns the checkout URL.',
    params: {
      name: str('Product name shown at checkout'),
      amount: { type: 'number', description: 'Price in major units, e.g. 29 for 29.00' },
      currency: str('ISO currency, e.g. usd, myr'),
      interval: { type: 'string', enum: ['one_time', 'month', 'year'] },
    },
    required: ['name', 'amount', 'currency'], limit: 3,
    run: async ({ name, amount, currency, interval }, { company }) => {
      const r = await createPaymentLink(company, {
        name: String(name), amountCents: Number(amount) * 100, currency: String(currency),
        interval: interval === 'month' || interval === 'year' ? interval : null,
      });
      emit('payments', company.id);
      return `Payment link: ${r.url}`;
    },
  },
};

const COMMON = ['list_tasks', 'create_task', 'ask_owner', 'get_metrics', 'read_document', 'write_document'];
const SITE = ['list_files', 'read_file', 'write_file', 'delete_file', 'deploy_site', 'git_status', 'commit_changes'];
const BY_TYPE: Record<TaskType, string[]> = {
  fix: [...SITE, 'web_search', 'fetch_url', 'open_page', 'create_payment_link'],
  feature: [...SITE, 'web_search', 'fetch_url', 'open_page', 'create_payment_link'],
  research: ['web_search', 'fetch_url'],
  marketing: ['web_search', 'fetch_url', 'post_to_x', 'create_meta_ad', ...SITE],
  outreach: ['web_search', 'fetch_url', 'send_email', 'read_inbox'],
  support: ['read_inbox', 'reply_email', 'send_email', 'list_files', 'read_file'],
  ops: ['create_payment_link', 'web_search', 'fetch_url', 'open_page', ...SITE],
};

const NEEDS: Record<string, keyof ReturnType<typeof integrationStatus>> = {
  deploy_site: 'vercel', send_email: 'email', reply_email: 'email', post_to_x: 'x', create_meta_ad: 'meta', create_payment_link: 'stripe',
};

function toDef(name: string): ToolDef {
  const t = TOOLS[name];
  return {
    type: 'function',
    function: { name, description: t.description, parameters: { type: 'object', properties: t.params, required: t.required ?? [] } },
  };
}

/** Tools for a role, minus the ones whose integration isn't connected. */
export function toolsFor(names: string[], c: Company): ToolDef[] {
  const status = integrationStatus(c);
  return [...new Set(names)].filter((n) => TOOLS[n] && (!NEEDS[n] || status[NEEDS[n]])).map(toDef);
}

export const toolsForTask = (type: TaskType, c: Company, hasNotebook = false) =>
  toolsFor([...BY_TYPE[type], ...COMMON, ...(hasNotebook ? ['remember'] : [])], c);

export async function runTool(name: string, args: unknown, ctx: ToolCtx): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) return `Error: unknown tool "${name}".`;
  const used = (ctx.counters[name] ?? 0) + 1;
  const limit = ctx.limits?.[name] ?? tool.limit;
  if (limit && used > limit) return `Error: ${name} can be used at most ${limit} times here.`;
  ctx.counters[name] = used;
  try {
    const result = await tool.run(args ?? {}, ctx);
    if (result.startsWith(BOUNCE)) ctx.counters[name] = used - 1; // a humanizer bounce doesn't use up the tool's limit
    return result;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}
