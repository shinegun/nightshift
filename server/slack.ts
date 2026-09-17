/**
 * The company's Slack, wired to its bots.
 *
 * Three jobs, one channel map. Each company names two channels in Company settings:
 *
 *  - Feedback channel: every new top-level message becomes a Support task. The thread under it
 *    hears back when the task ends, and Support can answer there with reply_in_slack.
 *  - Team channel: Nightshift posts what needs a decision (with buttons that act on it), work one
 *    bot hands another, failures, and the morning report. Mention the app there, or DM it, to
 *    talk to a bot: "@Nightshift support what's in your queue?".
 *
 * Every Slack message is untrusted input, exactly like an email: it can start a task or a
 * conversation, never change a setting, and a bot can only *propose* a note from it.
 */
import {
  all, get, now, run, type Bot, type BotColor, type Company, type Email, type Request, type Task, type Tweet, companyById,
} from './db.ts';
import { companyConfig, flag, setting } from './settings.ts';
import { activity, emit, subscribe } from './events.ts';
import { actorStore } from './users.ts';
import { errMsg, localNow, truncate } from './util.ts';
import { oneLine } from './decisions.ts';
import { slackCall, slackState, startSocket, type SlackEnvelope } from './integrations/slack.ts';
import { deliverEmail, deliverTweet } from './actions.ts';
import { insertTask } from './agents/tools.ts';
import { talkToBot } from './agents/talk.ts';
import { chatWithCofounder } from './agents/chat.ts';
import {
  BotError, addOwnerMemory, addSkill, botById, editMemory, forgetMemory, memoryById, teamSummary, templateById, templateTypes,
} from './bots.ts';
import { RequestClosed, dismissRequest, markRequestDone, requestById } from './requests.ts';

// ── Formatting ─────────────────────────────────────────────────────────────

/** Slack treats <, > and & as markup. Anything a person or a model wrote goes through this. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Model markdown, near enough to Slack's mrkdwn to read well. */
export function mrkdwn(md: string) {
  return esc(md)
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>');
}

const EMOJI: Record<BotColor, string> = {
  moon: ':crescent_moon:', blue: ':large_blue_circle:', green: ':large_green_circle:', coral: ':large_red_circle:',
  amber: ':large_orange_circle:', violet: ':large_purple_circle:', teal: ':ocean:', pink: ':cherry_blossom:',
};

type Who = { name: string; color: BotColor } | null | undefined;
/** One Slack app, but each bot posts under its own name and colour. */
const identity = (who: Who) => (who ? { username: who.name, icon_emoji: EMOJI[who.color] ?? EMOJI.moon } : { username: 'Nightshift', icon_emoji: EMOJI.moon });

export function dashboardUrl(c: Pick<Company, 'slug'>, view = '') {
  const base = (process.env.DASHBOARD_URL ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 4455}`).replace(/\/+$/, '');
  return `${base}/#/c/${encodeURIComponent(c.slug)}${view ? `/${view}` : ''}`;
}

async function post(channel: string, text: string, opts: { who?: Who; thread?: string; blocks?: unknown[] } = {}) {
  const r = await slackCall('chat.postMessage', {
    channel, text, thread_ts: opts.thread, blocks: opts.blocks, unfurl_links: false, unfurl_media: false, ...identity(opts.who),
  });
  return String(r.ts);
}

const react = (channel: string, ts: string, name: string) =>
  slackCall('reactions.add', { channel, timestamp: ts, name }).catch(() => {});

const users = new Map<string, string>();
async function userName(id: string) {
  if (!id) return 'Someone';
  if (users.has(id)) return users.get(id)!;
  const u = await slackCall('users.info', { user: id }).catch(() => null);
  const name = u?.user?.profile?.display_name || u?.user?.real_name || u?.user?.name || 'Someone';
  users.set(id, name);
  return name;
}

export function allowedUser(id: string) {
  const list = setting('slack_allowed_users').split(/[\s,]+/).filter(Boolean);
  return !list.length || list.includes(id);
}

// ── Channels ───────────────────────────────────────────────────────────────

const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;
export const teamChannel = (c: Company) => { const v = (companyConfig(c).slack_channel ?? '').trim(); return CHANNEL_ID.test(v) ? v : ''; };
export const feedbackChannel = (c: Company) => { const v = (companyConfig(c).slack_feedback_channel ?? '').trim(); return CHANNEL_ID.test(v) ? v : ''; };

export function companyForChannel(channel: string): { company: Company; role: 'team' | 'feedback' } | null {
  for (const c of all<Company>('SELECT * FROM companies')) {
    if (feedbackChannel(c) === channel) return { company: c, role: 'feedback' };
    if (teamChannel(c) === channel) return { company: c, role: 'team' };
  }
  return null;
}

// ── Links ──────────────────────────────────────────────────────────────────

interface Link { id: number; company_id: number; kind: string; ref: string; channel: string; ts: string; value: string; resolved: number }
const linkOf = (companyId: number, kind: string, ref: string) =>
  get<Link>('SELECT * FROM slack_links WHERE company_id = ? AND kind = ? AND ref = ?', companyId, kind, ref);
const saveLink = (companyId: number, kind: string, ref: string, channel: string, ts: string, value = '', resolved = 0) =>
  run(
    `INSERT INTO slack_links (company_id, kind, ref, channel, ts, value, resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_id, kind, ref) DO UPDATE SET channel = excluded.channel, ts = excluded.ts, value = excluded.value, resolved = excluded.resolved`,
    companyId, kind, ref, channel, ts, value, resolved, now(),
  );

// ── Intake ─────────────────────────────────────────────────────────────────

export async function takeFeedback(c: Company, ev: { channel: string; ts: string; user: string; text: string }) {
  if (linkOf(c.id, 'intake-msg', ev.ts)) return null; // Slack delivered it twice
  const who = await userName(ev.user);
  const link = await slackCall('chat.getPermalink', { channel: ev.channel, message_ts: ev.ts }).then((r) => r.permalink as string).catch(() => '');
  const text = ev.text.trim();
  const id = insertTask(c, {
    title: `Slack: ${oneLine(text, 100) || 'a message with no text'}`,
    description: `${who} posted this in the team's Slack feedback channel:\n\n${text}\n\n${link ? `Link: ${link}\n\n` : ''}`
      + 'Triage it the way you would an email. To answer them in the Slack thread, use reply_in_slack.',
    type: 'support', priority: 2, source: 'slack',
  });
  saveLink(c.id, 'intake-msg', ev.ts, ev.channel, ev.ts, String(id), 1);
  saveLink(c.id, 'intake', `task:${id}`, ev.channel, ev.ts);
  activity(c.id, `> Slack feedback from ${who} became task #${id}`);
  await react(ev.channel, ev.ts, 'eyes');
  const bot = get<Bot>('SELECT b.* FROM tasks t JOIN bots b ON b.id = t.bot_id WHERE t.id = ?', id);
  await post(ev.channel, `Got it. ${bot ? bot.name : 'The team'} will look at this (task #${id}).`, { who: bot, thread: ev.ts }).catch(() => {});
  return id;
}

/** The Slack thread a task came from, if it came from the feedback channel. */
function intakeFor(c: Company, taskId: number): Link | undefined {
  return linkOf(c.id, 'intake', `task:${taskId}`);
}

/** A bot's answer in the Slack thread its task came from. Waits for approval if Settings asks for it. */
export async function queueSlackReply(c: Company, botId: number | undefined, taskId: number | undefined, text: string) {
  const body = text.trim();
  if (!body) throw new Error('The reply is empty.');
  if (body.length > 3000) throw new Error('Keep a Slack reply under 3000 characters.');
  const link = taskId ? intakeFor(c, taskId) : undefined;
  if (!link) throw new Error('This task did not come from Slack, so there is no thread to reply in.');
  const needsApproval = flag('approve_slack');
  const id = run(
    `INSERT INTO slack_replies (company_id, bot_id, task_id, channel, thread_ts, text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    c.id, botId ?? null, taskId ?? null, link.channel, link.ts, body, needsApproval ? 'pending_approval' : 'posting', now(),
  ).id;
  emit('slack', c.id);
  if (needsApproval) {
    activity(c.id, '> Drafted a Slack reply — waiting for your approval');
    return { id, status: 'pending_approval' as const };
  }
  await postSlackReply(id);
  return { id, status: 'posted' as const };
}

interface SlackReply { id: number; company_id: number; bot_id: number | null; task_id: number | null; channel: string; thread_ts: string; text: string; status: string; error: string | null; created_at: string }
const replyById = (id: number) => get<SlackReply>('SELECT * FROM slack_replies WHERE id = ?', id);

export async function postSlackReply(id: number) {
  const r = replyById(id);
  if (!r) throw new Error('Reply not found');
  try {
    await post(r.channel, mrkdwn(r.text), { who: r.bot_id ? botById(r.bot_id) : null, thread: r.thread_ts });
    run(`UPDATE slack_replies SET status = 'posted', error = NULL, posted_at = ? WHERE id = ?`, now(), id);
    activity(r.company_id, '> Replied in Slack');
  } catch (e) {
    run(`UPDATE slack_replies SET status = 'failed', error = ? WHERE id = ?`, errMsg(e), id);
    throw e;
  } finally {
    emit('slack', r.company_id);
  }
}

export function rejectSlackReply(id: number) {
  const r = replyById(id);
  if (!r) throw new Error('Reply not found');
  run(`UPDATE slack_replies SET status = 'rejected' WHERE id = ? AND status IN ('pending_approval','failed')`, id);
  emit('slack', r.company_id);
}

export const pendingSlackReplies = (c: Company) => all<SlackReply & { bot_name: string | null }>(
  `SELECT r.*, b.name AS bot_name FROM slack_replies r LEFT JOIN bots b ON b.id = r.bot_id
    WHERE r.company_id = ? AND r.status IN ('pending_approval','failed') ORDER BY r.id`, c.id,
);

// ── Notices ────────────────────────────────────────────────────────────────

type Button = { label: string; verb: string; style?: 'primary' | 'danger' };
interface Notice {
  ref: string;
  who?: Who;
  /** One line, used for the notification text and kept for the "resolved" rewrite. */
  line: string;
  detail?: string;
  buttons?: Button[];
  /** Info-only notices are resolved the moment they are posted. */
  info?: boolean;
}

const botOfTask = (taskId: number | null | undefined) =>
  taskId ? get<Bot>('SELECT b.* FROM tasks t JOIN bots b ON b.id = t.bot_id WHERE t.id = ?', taskId) : undefined;

/** Everything in this company that deserves a line in the team channel right now. */
function currentNotices(c: Company): Notice[] {
  const out: Notice[] = [];
  for (const r of all<Request>(`SELECT * FROM requests WHERE company_id = ? AND status = 'open' ORDER BY id`, c.id)) {
    const bot = botOfTask(r.source_task_id);
    out.push({
      ref: `request:${r.id}`, who: bot, line: `:raising_hand: *${esc(bot?.name ?? 'The team')} needs you:* ${esc(r.title)}`,
      detail: [r.why, r.steps && `*How:*\n${r.steps}`].filter(Boolean).map((x) => mrkdwn(truncate(String(x), 1400))).join('\n\n'),
      buttons: [{ label: "I've done this", verb: 'done', style: 'primary' }, { label: 'Not doing it', verb: 'dismiss' }],
    });
  }
  for (const m of all<{ id: number; bot_id: number; content: string; source_task_id: number | null }>(
    `SELECT id, bot_id, content, source_task_id FROM bot_memories WHERE company_id = ? AND status = 'proposed' ORDER BY id`, c.id,
  )) {
    const bot = botById(m.bot_id);
    out.push({
      ref: `memory:${m.id}`, who: bot, line: `:memo: *${esc(bot?.name ?? 'A bot')} wants to remember* (${esc(c.name)} only)`,
      detail: `> ${esc(m.content)}`,
      buttons: [{ label: 'Keep', verb: 'keep', style: 'primary' }, { label: 'Forget', verb: 'forget' }],
    });
  }
  for (const r of pendingSlackReplies(c).filter((x) => x.status === 'pending_approval')) {
    const bot = r.bot_id ? botById(r.bot_id) : null;
    out.push({
      ref: `reply:${r.id}`, who: bot, line: `:speech_balloon: *${esc(bot?.name ?? 'A bot')} wants to reply in the feedback thread*`,
      detail: `> ${mrkdwn(truncate(r.text, 1500)).replace(/\n/g, '\n> ')}`,
      buttons: [{ label: 'Post it', verb: 'post', style: 'primary' }, { label: 'Discard', verb: 'discard' }],
    });
  }
  for (const e of all<Email>(`SELECT * FROM emails WHERE company_id = ? AND direction = 'out' AND status = 'pending_approval' ORDER BY id`, c.id)) {
    out.push({
      ref: `email:${e.id}`, line: `:email: *Email waiting to go out* to ${esc(e.to_addr)}: ${esc(e.subject)}`,
      detail: `\`\`\`${esc(truncate(e.body, 1500))}\`\`\``,
      buttons: [{ label: 'Send', verb: 'send', style: 'primary' }, { label: 'Discard', verb: 'discard' }],
    });
  }
  for (const t of all<Tweet>(`SELECT * FROM tweets WHERE company_id = ? AND status = 'pending_approval' ORDER BY id`, c.id)) {
    out.push({
      ref: `tweet:${t.id}`, line: ':bird: *X post waiting to go out*', detail: `> ${esc(t.text)}`,
      buttons: [{ label: 'Post', verb: 'post', style: 'primary' }, { label: 'Discard', verb: 'discard' }],
    });
  }
  for (const g of all<{ id: number; message: string; branch: string }>(`SELECT id, message, branch FROM commits WHERE company_id = ? AND status = 'pending_approval' ORDER BY id`, c.id)) {
    out.push({ ref: `commit:${g.id}`, line: `:twisted_rightwards_arrows: *A push is waiting:* ${esc(oneLine(g.message))} → \`${esc(g.branch)}\` (review the diff on the dashboard)` });
  }
  for (const a of all<{ id: number; name: string; daily_budget_cents: number }>(`SELECT id, name, daily_budget_cents FROM ad_campaigns WHERE company_id = ? AND status = 'paused' ORDER BY id`, c.id)) {
    out.push({ ref: `ad:${a.id}`, line: `:moneybag: *Ad campaign waiting to start:* ${esc(a.name)} at ${(a.daily_budget_cents / 100).toFixed(2)}/day (start it on the dashboard)` });
  }
  for (const t of all<{ id: number; title: string; from_bot_id: number; bot_id: number | null }>(
    `SELECT id, title, from_bot_id, bot_id FROM tasks WHERE company_id = ? AND from_bot_id IS NOT NULL AND (bot_id IS NULL OR bot_id != from_bot_id) ORDER BY id DESC LIMIT 20`, c.id,
  )) {
    const from = botById(t.from_bot_id);
    const to = t.bot_id ? botById(t.bot_id) : null;
    out.push({ ref: `handoff:${t.id}`, who: from, info: true, line: `:arrow_right: *${esc(from?.name ?? 'A bot')}* handed to *${esc(to?.name ?? 'nobody yet')}*: ${esc(t.title)} (#${t.id})` });
  }
  for (const t of all<Task>(`SELECT * FROM tasks WHERE company_id = ? AND status = 'failed' ORDER BY finished_at DESC LIMIT 20`, c.id)) {
    const bot = botOfTask(t.id);
    out.push({ ref: `failed:${t.id}:${t.finished_at}`, who: bot, info: true, line: `:warning: *${esc(bot?.name ?? 'A bot')} couldn't finish:* ${esc(t.title)} (#${t.id})`, detail: t.error ? esc(truncate(oneLine(t.error, 300), 300)) : undefined });
  }
  const report = get<{ day: string; content: string }>('SELECT day, content FROM reports WHERE company_id = ? ORDER BY day DESC LIMIT 1', c.id);
  if (report) out.push({ ref: `report:${report.day}`, info: true, line: `:sunrise: *Morning report for ${esc(c.name)}, ${report.day}*`, detail: `\`\`\`${esc(truncate(report.content, 2800))}\`\`\`` });
  return out;
}

const actionId = (ref: string, verb: string) => `ns|${ref}|${verb}`;

function noticeBlocks(c: Company, n: Notice) {
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: truncate(n.detail ? `${n.line}\n${n.detail}` : n.line, 2900) } }];
  const buttons = (n.buttons ?? []).map((b) => ({
    type: 'button', text: { type: 'plain_text', text: b.label }, action_id: actionId(n.ref, b.verb), value: String(c.id), ...(b.style ? { style: b.style } : {}),
  }));
  if (!n.info) buttons.push({ type: 'button', text: { type: 'plain_text', text: 'Open dashboard' }, action_id: actionId(n.ref, 'open'), value: String(c.id), url: dashboardUrl(c) } as never);
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons });
  return blocks;
}

/** What became of an item, once it's no longer waiting. null while it still is. */
function outcome(c: Company, ref: string): string | null {
  const [kind, raw] = ref.split(':');
  const id = Number(raw);
  switch (kind) {
    case 'request': {
      const r = get<{ status: string }>('SELECT status FROM requests WHERE id = ?', id);
      return !r ? 'Gone' : r.status === 'open' ? null : r.status === 'done' ? 'Done' : 'Not doing it';
    }
    case 'memory': {
      const m = memoryById(id);
      return !m ? 'Forgotten' : m.status === 'active' ? 'Kept' : null;
    }
    case 'reply': {
      const r = replyById(id);
      return !r ? 'Gone' : r.status === 'posted' ? 'Posted' : r.status === 'rejected' ? 'Discarded' : null;
    }
    case 'email': {
      const e = get<{ status: string }>('SELECT status FROM emails WHERE id = ?', id);
      return !e ? 'Gone' : e.status === 'sent' ? 'Sent' : e.status === 'rejected' ? 'Discarded' : null;
    }
    case 'tweet': {
      const t = get<{ status: string }>('SELECT status FROM tweets WHERE id = ?', id);
      return !t ? 'Gone' : t.status === 'posted' ? 'Posted' : t.status === 'rejected' ? 'Discarded' : null;
    }
    case 'commit': {
      const g = get<{ status: string }>('SELECT status FROM commits WHERE id = ?', id);
      return !g ? 'Gone' : g.status === 'pushed' ? 'Pushed' : g.status === 'rejected' ? 'Discarded' : null;
    }
    case 'ad': {
      const a = get<{ status: string }>('SELECT status FROM ad_campaigns WHERE id = ?', id);
      return !a ? 'Gone' : a.status === 'active' ? 'Started' : a.status === 'paused' ? null : a.status;
    }
    default:
      return 'Done';
  }
}

const syncing = new Map<number, Promise<void>>();

/** Post what's new, update what's been dealt with. Safe to call as often as you like. */
export function syncNotices(c: Company): Promise<void> {
  const running = syncing.get(c.id);
  if (running) return running.then(() => syncNotices(c));
  const p = doSync(c).finally(() => syncing.delete(c.id));
  syncing.set(c.id, p);
  return p;
}

async function doSync(fresh: Company) {
  const c = companyById(fresh.id);
  if (!c) return;
  const channel = teamChannel(c);
  if (!channel || !setting('slack_bot_token')) return;
  const notices = currentNotices(c);

  // The first time a channel is connected, what's already waiting is the backlog, not news.
  const baselineKey = `${channel}`;
  const baseline = get<{ value: string }>(`SELECT value FROM slack_links WHERE company_id = ? AND kind = 'baseline' AND ref = 'team'`, c.id);
  if (baseline?.value !== baselineKey) {
    for (const n of notices) if (!linkOf(c.id, 'notice', n.ref)) saveLink(c.id, 'notice', n.ref, '', '', '', 1);
    saveLink(c.id, 'baseline', 'team', channel, '', baselineKey, 1);
    if (!baseline) {
      const waiting = notices.filter((n) => !n.info).length;
      await post(channel, `:crescent_moon: Nightshift is connected for *${esc(c.name)}*. New decisions, handoffs and reports will show up here.${waiting ? ` ${waiting} thing${waiting > 1 ? 's are' : ' is'} already waiting on the dashboard.` : ''} Mention me to talk to a bot, e.g. \`@Nightshift support status\`.`).catch(() => {});
    }
  }

  for (const n of notices) {
    if (linkOf(c.id, 'notice', n.ref)) continue;
    // Reserve the key before posting, so two syncs racing can't both post it.
    saveLink(c.id, 'notice', n.ref, channel, '', n.line, n.info ? 1 : 0);
    try {
      const ts = await post(channel, n.line.replace(/[*:]/g, ''), { who: n.who, blocks: noticeBlocks(c, n) });
      run(`UPDATE slack_links SET ts = ? WHERE company_id = ? AND kind = 'notice' AND ref = ?`, ts, c.id, n.ref);
    } catch (e) {
      run(`DELETE FROM slack_links WHERE company_id = ? AND kind = 'notice' AND ref = ?`, c.id, n.ref);
      throw e;
    }
  }

  for (const l of all<Link>(`SELECT * FROM slack_links WHERE company_id = ? AND kind = 'notice' AND resolved = 0`, c.id)) {
    const done = outcome(c, l.ref);
    if (!done) continue;
    await resolveNotice(l, done);
  }

  // Feedback threads hear how their task ended.
  for (const l of all<Link>(`SELECT * FROM slack_links WHERE company_id = ? AND kind = 'intake' AND resolved = 0`, c.id)) {
    const t = get<Task>('SELECT * FROM tasks WHERE id = ?', Number(l.ref.split(':')[1]));
    if (!t) { run('UPDATE slack_links SET resolved = 1 WHERE id = ?', l.id); continue; }
    if (!['done', 'failed', 'blocked', 'cancelled'].includes(t.status)) continue;
    const said = t.status === 'done' ? `Done. ${t.result ?? ''}`
      : t.status === 'blocked' ? `Waiting on the owner before I can finish. ${t.result ?? ''}`
      : t.status === 'cancelled' ? 'This was cancelled.'
      : `I couldn't finish this. ${t.error ?? ''}`;
    run('UPDATE slack_links SET resolved = 1 WHERE id = ?', l.id);
    await post(l.channel, mrkdwn(truncate(said.trim(), 1500)), { who: botOfTask(t.id), thread: l.ts }).catch(() => {});
  }
}

async function resolveNotice(l: Link, done: string, by?: string) {
  run('UPDATE slack_links SET resolved = 1 WHERE id = ?', l.id);
  if (!l.ts || !l.channel) return;
  const text = `${l.value}\n:white_check_mark: ${done}${by ? ` by ${esc(by)}` : ''}`;
  await slackCall('chat.update', { channel: l.channel, ts: l.ts, text: text.replace(/[*:]/g, ''), blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] })
    .catch(() => {});
}

// ── Buttons ────────────────────────────────────────────────────────────────

async function asSlackUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const name = await userName(userId);
  return actorStore.run({ id: 0, username: `slack:${userId}`, name: `${name} (Slack)`, created_at: '', last_seen_at: null }, fn);
}

const ephemeral = (channel: string, user: string, text: string) =>
  slackCall('chat.postEphemeral', { channel, user, text }).catch(() => {});

export async function handleAction(payload: any) {
  const action = payload.actions?.[0];
  const userId = String(payload.user?.id ?? '');
  const channel = String(payload.channel?.id ?? payload.container?.channel_id ?? '');
  if (!action?.action_id?.startsWith('ns|')) return;
  const [, ref, verb] = String(action.action_id).split('|');
  if (verb === 'open') return; // a link button; Slack opens it
  if (!allowedUser(userId)) return ephemeral(channel, userId, 'You are not on the list of people who can act on Nightshift from Slack.');
  const c = companyById(Number(action.value)) ?? companyById(Number(JSON.parse(action.value || '{}').companyId));
  if (!c) return;
  const [kind, raw] = ref.split(':');
  const id = Number(raw);
  try {
    const result = await asSlackUser(userId, async () => {
      switch (`${kind}:${verb}`) {
        case 'request:done': { const r = requestById(id); if (r) markRequestDone(r, 'Done (from Slack)'); return 'Done'; }
        case 'request:dismiss': { const r = requestById(id); if (r) dismissRequest(r); return 'Not doing it'; }
        case 'memory:keep': { const m = memoryById(id); if (m && m.company_id === c.id) editMemory(m, { status: 'active' }); return 'Kept'; }
        case 'memory:forget': { const m = memoryById(id); if (m && m.company_id === c.id) forgetMemory(m); return 'Forgotten'; }
        case 'reply:post': await postSlackReply(id); return 'Posted';
        case 'reply:discard': rejectSlackReply(id); return 'Discarded';
        case 'email:send': {
          const e = get<Email>(`SELECT * FROM emails WHERE id = ? AND company_id = ?`, id, c.id);
          if (!e || e.status !== 'pending_approval') return outcome(c, ref) ?? 'Already handled';
          run(`UPDATE emails SET status = 'sending' WHERE id = ?`, id);
          await deliverEmail(id);
          return 'Sent';
        }
        case 'email:discard':
          run(`UPDATE emails SET status = 'rejected' WHERE id = ? AND company_id = ? AND status IN ('pending_approval','failed')`, id, c.id);
          emit('email', c.id);
          return 'Discarded';
        case 'tweet:post': {
          const t = get<Tweet>(`SELECT * FROM tweets WHERE id = ? AND company_id = ?`, id, c.id);
          if (!t || t.status !== 'pending_approval') return outcome(c, ref) ?? 'Already handled';
          await deliverTweet(id);
          return 'Posted';
        }
        case 'tweet:discard':
          run(`UPDATE tweets SET status = 'rejected' WHERE id = ? AND company_id = ?`, id, c.id);
          emit('tweet', c.id);
          return 'Discarded';
        case 'teach:everywhere':
        case 'teach:here': {
          const { botId, text } = JSON.parse(action.value) as { botId: number; text: string; companyId: number };
          const bot = botById(botId);
          if (!bot || bot.company_id !== c.id) return 'That bot is gone';
          if (verb === 'everywhere') {
            addSkill(bot.template_id, oneLine(text, 60), text.startsWith('-') ? text : `- ${text}`);
            activity(c.id, `> Taught every ${bot.name} bot: ${oneLine(text, 80)}`);
            return `Taught every ${bot.name} bot`;
          }
          addOwnerMemory(bot, text);
          activity(c.id, `> ${bot.name} will remember that for ${c.name}`);
          return `${bot.name} will remember that for ${c.name}`;
        }
        default:
          return null;
      }
    });
    if (result === null) return;
    const who = await userName(userId);
    const link = linkOf(c.id, 'notice', ref);
    if (link && kind !== 'teach') await resolveNotice(link, result, who);
    else if (payload.message?.ts && channel) {
      await slackCall('chat.update', { channel, ts: payload.message.ts, text: `${result} (${who})`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: ${esc(result)} — ${esc(who)}` } }] }).catch(() => {});
    }
    await syncNotices(c).catch(() => {});
  } catch (e) {
    const msg = e instanceof BotError || e instanceof RequestClosed ? e.message : errMsg(e);
    await ephemeral(channel, userId, `That didn't work: ${msg}`);
    await syncNotices(c).catch(() => {});
  }
}

// ── Talking ────────────────────────────────────────────────────────────────

export interface Parsed { company: Company | null; bot: Bot | null; command: 'help' | 'status' | 'teach' | 'do' | 'team' | 'talk'; rest: string; ask?: string }

const word = (s: string) => s.toLowerCase().replace(/[:,.!?]+$/, '');

/** Who a message is for and what it asks, from its first words. */
export function parseTalk(raw: string, company: Company | null): Parsed {
  let text = raw.replace(/<@[A-Z0-9]+>/g, '').trim();
  const companies = all<Company>('SELECT * FROM companies ORDER BY id');
  let c = company;
  if (!c) {
    const first = word(text.split(/\s+/)[0] ?? '');
    const named = companies.find((x) => x.slug === first || x.name.toLowerCase() === first);
    if (named) { c = named; text = text.slice(text.indexOf(' ') < 0 ? text.length : text.indexOf(' ')).trim(); }
    else if (companies.length === 1) c = companies[0];
  }
  if (!c) return { company: null, bot: null, command: 'help', rest: text, ask: `Which company? Start with its name, e.g. \`${companies[0]?.slug ?? 'acme'} support status\`.` };
  const bots = all<Bot & { key: string }>('SELECT b.*, t.key FROM bots b JOIN bot_templates t ON t.id = b.template_id WHERE b.company_id = ?', c.id);
  const [firstRaw, ...more] = text.split(/\s+/);
  const first = word(firstRaw ?? '');
  const bot = bots.find((b) => b.name.toLowerCase() === first || b.key === first) ?? null;
  if (bot) text = more.join(' ').trim();
  const [verbRaw, ...tail] = text.split(/\s+/);
  const verb = word(verbRaw ?? '');
  const rest = tail.join(' ').trim();
  if (!text || verb === 'help') return { company: c, bot, command: 'help', rest: '' };
  if (['status', 'queue', "what's"].includes(verb) && !rest.replace(/in your queue\??/i, '').trim()) return { company: c, bot, command: bot ? 'status' : 'team', rest: '' };
  if (!bot && ['team', 'status'].includes(verb)) return { company: c, bot, command: 'team', rest: '' };
  if (bot && verb === 'teach' && rest) return { company: c, bot, command: 'teach', rest };
  if (bot && ['do', 'task', 'todo'].includes(verb) && rest) return { company: c, bot, command: 'do', rest };
  return { company: c, bot, command: 'talk', rest: text };
}

const HELP = (c: Company) => `Talk to ${esc(c.name)}'s bots by name:
• \`@Nightshift support status\` — what a bot is doing and what's queued
• \`@Nightshift engineer do fix the signup button on mobile\` — queue a task for that bot
• \`@Nightshift support teach always CC Aqil on refunds\` — teach a bot (you choose: every company, or just this one)
• \`@Nightshift support how many emails came in today?\` — ask it anything
• \`@Nightshift status\` — the whole team · anything without a bot name goes to your co-founder`;

async function transcriptOf(channel: string, threadTs: string, currentTs: string) {
  const r = await slackCall('conversations.replies', { channel, ts: threadTs, limit: 15 }).catch(() => null);
  const lines: string[] = [];
  for (const m of (r?.messages ?? []) as any[]) {
    if (m.ts === currentTs) continue;
    const who = m.bot_id ? (m.username ?? 'Nightshift') : await userName(m.user);
    lines.push(`${who}: ${truncate(String(m.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim(), 600)}`);
  }
  return lines.slice(-12).join('\n');
}

export async function handleTalk(ev: { channel: string; ts: string; thread_ts?: string; user: string; text: string }, company: Company | null) {
  const thread = ev.thread_ts ?? ev.ts;
  if (!allowedUser(ev.user)) return post(ev.channel, 'Sorry, you are not on the list of people who can talk to the bots.', { thread });
  const p = parseTalk(ev.text, company);
  if (!p.company) return post(ev.channel, p.ask!, { thread });
  const c = p.company;
  const speaker = await userName(ev.user);

  if (p.command === 'help') return post(ev.channel, HELP(c), { thread });

  if (p.command === 'team') {
    const lines = teamSummary(c).map((b) =>
      `• *${esc(b.name)}* — ${b.state === 'working' ? `working on ${esc(b.now?.title ?? '')}` : b.state === 'waiting' ? 'waiting on you' : b.state}${b.queued ? ` · ${b.queued} queued` : ''}`);
    return post(ev.channel, `*${esc(c.name)}'s team*\n${lines.join('\n') || 'No bots hired yet.'}\n<${dashboardUrl(c, 'work')}|Open the dashboard>`, { thread });
  }

  const bot = p.bot!;
  if (p.command === 'status') {
    const s = teamSummary(c).find((b) => b.id === bot.id)!;
    const queued = all<{ id: number; title: string }>(`SELECT id, title FROM tasks WHERE bot_id = ? AND status = 'todo' ORDER BY position, id LIMIT 5`, bot.id);
    const text = [
      s.now ? `Working on *${esc(s.now.title)}* (#${s.now.id}).` : s.state === 'paused' ? "I'm paused." : 'Not working on anything right now.',
      queued.length ? `Queued:\n${queued.map((t) => `• ${esc(t.title)} (#${t.id})`).join('\n')}` : 'Nothing queued.',
      s.waitingOnYou ? `${s.waitingOnYou} task${s.waitingOnYou > 1 ? 's are' : ' is'} waiting on you.` : '',
      s.routines.length ? `Routines: ${s.routines.map((r) => `${esc(r.title)} (${r.when})`).join(', ')}.` : '',
    ].filter(Boolean).join('\n');
    return post(ev.channel, text, { who: bot, thread });
  }

  if (p.command === 'do') {
    const t = templateById(bot.template_id);
    const type = (t && templateTypes(t)[0]) || 'ops';
    const id = await asSlackUser(ev.user, async () => insertTask(c, {
      title: oneLine(p.rest, 120), description: `${speaker} asked for this in Slack:\n\n${p.rest}`, type, priority: 2, source: 'slack', botId: bot.id,
    }));
    activity(c.id, `> ${speaker} queued task #${id} for ${bot.name} from Slack`);
    const running = c.auto_mode || c.night_mode;
    return post(ev.channel, `Queued as task #${id}.${running ? '' : ' Auto Mode and Night Task are both off, so it runs when someone presses Run.'}`, { who: bot, thread });
  }

  if (p.command === 'teach') {
    const value = (scope: string) => JSON.stringify({ companyId: c.id, botId: bot.id, text: truncate(p.rest, 1500), scope });
    return post(ev.channel, `Got it. Is that a rule for every company I work at, or just ${c.name}?`, {
      who: bot, thread,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `> ${esc(truncate(p.rest, 1500))}\nIs that a rule for *every company* I work at, or *just ${esc(c.name)}*?` } },
        {
          type: 'actions', elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Every company' }, action_id: `ns|teach:${bot.id}|everywhere`, value: value('everywhere') },
            { type: 'button', text: { type: 'plain_text', text: `Just ${c.name}`.slice(0, 75) }, style: 'primary', action_id: `ns|teach:${bot.id}|here`, value: value('here') },
          ],
        },
      ],
    });
  }

  // A conversation. Mark it seen straight away: the answer takes a model call.
  await react(ev.channel, ev.ts, 'eyes');
  const transcript = ev.thread_ts ? await transcriptOf(ev.channel, ev.thread_ts, ev.ts) : '';
  try {
    if (bot) {
      const reply = await asSlackUser(ev.user, () => talkToBot(c, bot, p.rest, { speaker, transcript }));
      return post(ev.channel, mrkdwn(reply), { who: bot, thread });
    }
    // No bot named: the co-founder, in a dashboard conversation tied to this Slack thread so Ilham
    // and the dashboard see the same exchange.
    const key = `${ev.channel}:${thread}`;
    const link = linkOf(c.id, 'thread', key);
    const r = await asSlackUser(ev.user, () => chatWithCofounder(c, `${speaker} (Slack): ${p.rest}`, { threadId: link ? Number(link.value) : undefined }));
    if (!link) saveLink(c.id, 'thread', key, ev.channel, thread, String(r.threadId), 1);
    return post(ev.channel, mrkdwn(r.reply), { who: { name: 'Co-founder', color: 'moon' }, thread });
  } catch (e) {
    return post(ev.channel, `I couldn't answer that: ${esc(errMsg(e))}`, { who: bot, thread });
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────

export async function handleEnvelope(e: SlackEnvelope) {
  if (e.type === 'interactive' && e.payload?.type === 'block_actions') return handleAction(e.payload);
  if (e.type !== 'events_api') return;
  const ev = e.payload?.event;
  if (!ev || ev.bot_id || ev.subtype) return;
  const mention = slackState.botUserId && String(ev.text ?? '').includes(`<@${slackState.botUserId}>`);

  if (ev.type === 'app_mention') {
    const at = companyForChannel(ev.channel);
    return handleTalk(ev, at?.company ?? null);
  }
  if (ev.type !== 'message') return;
  if (ev.channel_type === 'im') return handleTalk(ev, null);
  if (mention) return; // app_mention handles it
  const at = companyForChannel(ev.channel);
  if (at?.role === 'feedback' && !ev.thread_ts) {
    if (!allowedUser(ev.user)) return;
    await takeFeedback(at.company, ev);
    await syncNotices(at.company).catch(() => {});
  }
}

const NOTICE_EVENTS = new Set(['requests', 'memory', 'email', 'tweet', 'commits', 'ads', 'tasks', 'reports', 'slack']);
const pending = new Map<number, ReturnType<typeof setTimeout>>();

function queueSync(companyId: number) {
  clearTimeout(pending.get(companyId));
  pending.set(companyId, setTimeout(() => {
    pending.delete(companyId);
    const c = companyById(companyId);
    if (c) syncNotices(c).catch((e) => console.error('[slack] notices:', errMsg(e)));
  }, 3_000));
}

export function startSlackBridge() {
  startSocket(handleEnvelope);
  subscribe((e) => { if (e.companyId && NOTICE_EVENTS.has(e.type)) queueSync(e.companyId); });
  // A slow sweep as well, for anything that changed without an event (and for the first run).
  setInterval(() => {
    if (!setting('slack_bot_token')) return;
    for (const c of all<{ id: number }>('SELECT id FROM companies')) queueSync(c.id);
  }, 120_000);
  setTimeout(() => { for (const c of all<{ id: number }>('SELECT id FROM companies')) queueSync(c.id); }, 10_000);
}

/** For Settings: is it live, and which channels are wired. */
export function slackStatus() {
  return {
    connected: slackState.connected,
    since: slackState.since,
    team: slackState.team,
    companies: all<Company>('SELECT * FROM companies ORDER BY name').map((c) => ({
      slug: c.slug, name: c.name, team: teamChannel(c), feedback: feedbackChannel(c),
    })),
    today: localNow().day,
  };
}
