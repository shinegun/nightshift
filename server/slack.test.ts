/**
 * The Slack bridge against a fake Slack: what becomes a task, what gets posted once and only
 * once, what a button press changes, and who is allowed to press it.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NIGHTSHIFT_DATA = mkdtempSync(path.join(tmpdir(), 'nightshift-slack-'));

const { get, run } = await import('./db.ts');
const { setSetting } = await import('./settings.ts');
const bots = await import('./bots.ts');
const { setSlackCall } = await import('./integrations/slack.ts');
const slack = await import('./slack.ts');

type Call = { method: string; params: Record<string, any> };
const calls: Call[] = [];
let tsCounter = 1000;
setSlackCall(async (method, params = {}) => {
  calls.push({ method, params });
  if (method === 'chat.postMessage') return { ok: true, ts: String(++tsCounter) };
  if (method === 'users.info') return { ok: true, user: { profile: { display_name: params.user === 'UILHAM' ? 'Ilham' : 'Aqil' } } };
  if (method === 'chat.getPermalink') return { ok: true, permalink: 'https://example.slack.com/archives/C1/p1' };
  return { ok: true };
});
const posts = () => calls.filter((c) => c.method === 'chat.postMessage');
const clear = () => { calls.length = 0; };
const blocksOf = (params: Record<string, any>) => (typeof params.blocks === 'string' ? JSON.parse(params.blocks) : params.blocks);

setSetting('slack_bot_token', 'xoxb-test');
run(
  `INSERT INTO companies (slug, name, idea, status, email, site_url, vercel_project, config, created_at, updated_at)
   VALUES ('acme', 'Acme', 'idea', 'live', '', '', '', ?, ?, ?)`,
  JSON.stringify({ slack_channel: 'CTEAM0001', slack_feedback_channel: 'CFEED0001' }), new Date().toISOString(), new Date().toISOString(),
);
const acme = () => get<any>(`SELECT * FROM companies WHERE slug = 'acme'`)!;
bots.hireDefaultTeam(acme().id);
const support = () => bots.botForType(acme().id, 'support')!;

// A request that exists before Slack is connected: backlog, not news.
run(`INSERT INTO requests (company_id, title, created_at) VALUES (?, 'Old request', ?)`, acme().id, new Date().toISOString());

test('channels map to their company and role; anything else is ignored', () => {
  assert.equal(slack.companyForChannel('CFEED0001')?.role, 'feedback');
  assert.equal(slack.companyForChannel('CTEAM0001')?.role, 'team');
  assert.equal(slack.companyForChannel('COTHER001'), null);
});

test('connecting posts a hello once and treats the backlog as already seen', async () => {
  clear();
  await slack.syncNotices(acme());
  assert.equal(posts().length, 1);
  assert.match(posts()[0].params.text, /connected for \*Acme\*/);
  assert.match(posts()[0].params.text, /1 thing is already waiting/);
  clear();
  await slack.syncNotices(acme());
  assert.equal(posts().length, 0);
});

test('a feedback message becomes a Support task, acknowledged in its thread', async () => {
  clear();
  await slack.handleEnvelope({ type: 'events_api', payload: { event: { type: 'message', channel: 'CFEED0001', channel_type: 'channel', ts: '111.1', user: 'UAQIL', text: 'The signup button does nothing on mobile' } } });
  const task = get<any>(`SELECT * FROM tasks WHERE source = 'slack'`)!;
  assert.equal(task.type, 'support');
  assert.equal(task.bot_id, support().id);
  assert.match(task.description, /Aqil posted this/);
  assert.ok(calls.some((c) => c.method === 'reactions.add' && c.params.name === 'eyes'));
  const ack = posts().find((p) => p.params.thread_ts === '111.1')!;
  assert.equal(ack.params.username, 'Support');
  // Slack redelivers sometimes; the same message is one task.
  await slack.handleEnvelope({ type: 'events_api', payload: { event: { type: 'message', channel: 'CFEED0001', channel_type: 'channel', ts: '111.1', user: 'UAQIL', text: 'The signup button does nothing on mobile' } } });
  assert.equal(get<any>(`SELECT COUNT(*) AS n FROM tasks WHERE source = 'slack'`).n, 1);
});

test('bots, thread replies and mentions in the feedback channel are not intake', async () => {
  const before = get<any>(`SELECT COUNT(*) AS n FROM tasks`).n;
  const ev = (extra: object) => slack.handleEnvelope({ type: 'events_api', payload: { event: { type: 'message', channel: 'CFEED0001', channel_type: 'channel', ts: `2${Math.random()}`, user: 'UAQIL', text: 'hi', ...extra } } });
  await ev({ bot_id: 'B1' });
  await ev({ thread_ts: '111.1' });
  await ev({ subtype: 'message_changed' });
  assert.equal(get<any>(`SELECT COUNT(*) AS n FROM tasks`).n, before);
});

test('a Slack reply waits for approval when asked to, and posts in the right thread', async () => {
  const task = get<any>(`SELECT * FROM tasks WHERE source = 'slack'`)!;
  setSetting('approve_slack', 'true');
  const r = await slack.queueSlackReply(acme(), support().id, task.id, 'Thanks, we are on it.');
  assert.equal(r.status, 'pending_approval');
  clear();
  await slack.syncNotices(acme());
  const notice = posts().find((p) => String(p.params.text).includes('wants to reply'))!;
  assert.equal(notice.params.channel, 'CTEAM0001');
  const actions = blocksOf(notice.params)[1].elements.map((e: any) => e.action_id);
  assert.ok(actions.includes(`ns|reply:${r.id}|post`));

  clear();
  await slack.handleAction({ type: 'block_actions', user: { id: 'UAQIL' }, channel: { id: 'CTEAM0001' }, actions: [{ action_id: `ns|reply:${r.id}|post`, value: String(acme().id) }] });
  const sent = posts().find((p) => p.params.thread_ts === '111.1')!;
  assert.equal(sent.params.username, 'Support');
  assert.ok(calls.some((c) => c.method === 'chat.update' && /Posted by Aqil/.test(JSON.stringify(c.params))));
  await assert.rejects(slack.queueSlackReply(acme(), support().id, 999999, 'x'), /did not come from Slack/);
  setSetting('approve_slack', 'false');
});

test('a proposed note is posted once, and Keep from Slack keeps it', async () => {
  const { id } = bots.proposeMemory(support(), 'Acme customers are mostly clinics.');
  clear();
  await slack.syncNotices(acme());
  await slack.syncNotices(acme());
  assert.equal(posts().filter((p) => String(p.params.text).includes('wants to remember')).length, 1);
  await slack.handleAction({ type: 'block_actions', user: { id: 'UILHAM' }, channel: { id: 'CTEAM0001' }, actions: [{ action_id: `ns|memory:${id}|keep`, value: String(acme().id) }] });
  assert.equal(bots.memoryById(id)!.status, 'active');
  assert.ok(calls.some((c) => c.method === 'chat.update' && /Kept by Ilham/.test(JSON.stringify(c.params))));
});

test('only listed people can press buttons', async () => {
  const { id } = bots.proposeMemory(support(), 'Another fact.');
  setSetting('slack_allowed_users', 'UAQIL');
  clear();
  await slack.handleAction({ type: 'block_actions', user: { id: 'USTRANGER' }, channel: { id: 'CTEAM0001' }, actions: [{ action_id: `ns|memory:${id}|keep`, value: String(acme().id) }] });
  assert.equal(bots.memoryById(id)!.status, 'proposed');
  assert.ok(calls.some((c) => c.method === 'chat.postEphemeral'));
  setSetting('slack_allowed_users', '');
});

test('something resolved on the dashboard is marked resolved in Slack', async () => {
  run(`INSERT INTO requests (company_id, title, why, created_at) VALUES (?, 'Paste the Stripe key', 'Needed for checkout', ?)`, acme().id, new Date().toISOString());
  const req = get<any>(`SELECT id FROM requests WHERE title = 'Paste the Stripe key'`);
  clear();
  await slack.syncNotices(acme());
  assert.ok(posts().some((p) => String(p.params.text).includes('Paste the Stripe key')));
  run(`UPDATE requests SET status = 'done' WHERE id = ?`, req.id);
  clear();
  await slack.syncNotices(acme());
  assert.ok(calls.some((c) => c.method === 'chat.update' && JSON.stringify(c.params).includes('Done')));
});

test('handoffs are announced, and a finished feedback task answers its thread', async () => {
  const task = get<any>(`SELECT * FROM tasks WHERE source = 'slack'`)!;
  const { insertTask } = await import('./agents/tools.ts');
  insertTask(acme(), { title: 'Fix the mobile signup button', type: 'fix', source: 'agent', fromBotId: support().id });
  run(`UPDATE tasks SET status = 'done', result = '**Fixed**: replied and handed to Engineer.' WHERE id = ?`, task.id);
  clear();
  await slack.syncNotices(acme());
  assert.ok(posts().some((p) => /handed to/.test(p.params.text) && /Fix the mobile signup button/.test(p.params.text)));
  const closing = posts().find((p) => p.params.thread_ts === '111.1')!;
  assert.match(closing.params.text, /\*Fixed\*/);
});

test('talking: commands are read from the first words', () => {
  const c = acme();
  assert.equal(slack.parseTalk('<@UAPP> support status', c).command, 'status');
  assert.equal(slack.parseTalk('<@UAPP> support status', c).bot?.name, 'Support');
  assert.equal(slack.parseTalk('<@UAPP> Engineer: do fix the button', c).command, 'do');
  assert.equal(slack.parseTalk('<@UAPP> engineer do fix the button', c).rest, 'fix the button');
  assert.equal(slack.parseTalk('support teach always CC Aqil', c).command, 'teach');
  assert.equal(slack.parseTalk('status', c).command, 'team');
  const free = slack.parseTalk('what should we focus on this week?', c);
  assert.equal(free.command, 'talk');
  assert.equal(free.bot, null);
  // A DM with one company needs no company name.
  assert.equal(slack.parseTalk('support status', null).company?.slug, 'acme');
  assert.equal(slack.parseTalk('acme support status', null).bot?.name, 'Support');
});

test('a status question is answered from the database, as the bot', async () => {
  clear();
  await slack.handleTalk({ channel: 'CTEAM0001', ts: '500.1', user: 'UAQIL', text: '<@UAPP> engineer status' }, acme());
  const reply = posts()[0];
  assert.equal(reply.params.username, 'Engineer');
  assert.equal(reply.params.thread_ts, '500.1');
  assert.match(reply.params.text, /Fix the mobile signup button/);
});

test('teaching from Slack asks where it applies, and the answer files it', async () => {
  clear();
  await slack.handleTalk({ channel: 'CTEAM0001', ts: '600.1', user: 'UAQIL', text: '<@UAPP> support teach always CC Aqil on refunds' }, acme());
  const ask = posts()[0];
  const buttons = blocksOf(ask.params)[1].elements;
  const here = buttons.find((b: any) => b.action_id.endsWith('|here'));
  await slack.handleAction({ type: 'block_actions', user: { id: 'UAQIL' }, channel: { id: 'CTEAM0001' }, message: { ts: '1' }, actions: [here] });
  assert.ok(get<any>(`SELECT id FROM bot_memories WHERE content = 'always CC Aqil on refunds' AND status = 'active' AND source = 'owner'`));
});

test('queueing work from Slack goes to the named bot', async () => {
  clear();
  await slack.handleTalk({ channel: 'CTEAM0001', ts: '700.1', user: 'UAQIL', text: '<@UAPP> research do compare the three biggest rivals on price' }, acme());
  const t = get<any>(`SELECT * FROM tasks WHERE title LIKE 'compare the three%'`)!;
  assert.equal(t.bot_id, bots.botForType(acme().id, 'research')!.id);
  assert.match(posts()[0].params.text, /Queued as task/);
});

test('text from Slack is escaped before it is posted back', () => {
  assert.equal(slack.esc('<!channel> & <@U1>'), '&lt;!channel&gt; &amp; &lt;@U1&gt;');
  assert.equal(slack.mrkdwn('## Done\n**ok** [site](https://x.io)'), '*Done*\n*ok* <https://x.io|site>');
});
