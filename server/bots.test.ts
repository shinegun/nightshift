/**
 * The bot team's promises, pinned down: a note never crosses companies, an unreviewed note never
 * reaches a prompt, a template file never carries memory, and a routine files its work once.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NIGHTSHIFT_DATA = mkdtempSync(path.join(tmpdir(), 'nightshift-bots-'));

const { all, get, run } = await import('./db.ts');
const bots = await import('./bots.ts');
const { insertTask } = await import('./agents/tools.ts');
const { agentSystemPrompt } = await import('./agents/prompts.ts');
const { setSetting } = await import('./settings.ts');

const company = (slug: string, name: string) => {
  run(
    `INSERT INTO companies (slug, name, idea, status, email, site_url, vercel_project, config, created_at, updated_at)
     VALUES (?, ?, 'idea', 'live', '', '', '', '{}', ?, ?)`,
    slug, name, new Date().toISOString(), new Date().toISOString(),
  );
  const c = get<any>('SELECT * FROM companies WHERE slug = ?', slug)!;
  bots.hireDefaultTeam(c.id);
  return c;
};

const northwind = company('northwind', 'Northwind');
const acme = company('acme', 'Acme');
const supportAt = (c: { id: number }) => bots.botForType(c.id, 'support')!;

test('every built-in is seeded once, and a new company gets the whole team', () => {
  bots.seedBuiltins();
  const keys = all<{ key: string }>('SELECT key FROM bot_templates WHERE builtin = 1 ORDER BY key').map((r) => r.key);
  assert.deepEqual(keys, ['engineer', 'marketing', 'ops', 'outreach', 'research', 'support']);
  assert.equal(bots.teamSummary(northwind).length, 6);
});

test('a task goes to the bot for its type, whoever inserts it', () => {
  const fix = insertTask(northwind, { title: 'Broken button', type: 'fix', source: 'user' });
  const feature = insertTask(northwind, { title: 'Pricing page', type: 'feature', source: 'user' });
  const engineer = bots.botForType(northwind.id, 'fix')!;
  assert.equal(get<any>('SELECT bot_id FROM tasks WHERE id = ?', fix).bot_id, engineer.id);
  assert.equal(get<any>('SELECT bot_id FROM tasks WHERE id = ?', feature).bot_id, engineer.id);
  // The inbox inserts with raw SQL and still gets its bot.
  run(`INSERT INTO tasks (company_id, title, type, source, created_at) VALUES (?, 'Reply to Sarah', 'support', 'inbox', ?)`, acme.id, new Date().toISOString());
  assert.equal(get<any>(`SELECT bot_id FROM tasks WHERE title = 'Reply to Sarah'`).bot_id, supportAt(acme).id);
});

test('a note stays proposed, out of the prompt, until the owner keeps it', () => {
  const bot = supportAt(northwind);
  const { id } = bots.proposeMemory(bot, 'Sarah is on the annual plan and was refunded once in July.');
  assert.doesNotMatch(agentSystemPrompt(northwind, 'support', bot), /annual plan/);
  bots.editMemory(bots.memoryById(id)!, { status: 'active' });
  assert.match(agentSystemPrompt(northwind, 'support', bot), /annual plan/);
});

test("one company's notes never reach another company's prompt", () => {
  const acmeSupport = supportAt(acme);
  const prompt = agentSystemPrompt(acme, 'support', acmeSupport);
  assert.doesNotMatch(prompt, /annual plan/);
  assert.match(prompt, /no notes about Acme yet/);
});

test('notes refuse credentials and duplicates', () => {
  const bot = supportAt(northwind);
  assert.throws(() => bots.proposeMemory(bot, 'the key is sk-abcdefghijklmnopqrstuvwxyz123456'), /credential/);
  const first = bots.proposeMemory(bot, 'Prefers replies under five sentences.');
  const again = bots.proposeMemory(bot, 'prefers replies under five sentences.');
  assert.equal(again.duplicate, true);
  assert.equal(again.id, first.id);
});

test('the prompt keeps what never changes first and the date last', () => {
  const bot = supportAt(northwind);
  const prompt = agentSystemPrompt(northwind, 'support', bot);
  const skill = prompt.indexOf('## Triage every email');
  const company = prompt.indexOf('You work for Northwind');
  const date = prompt.indexOf('Today is');
  assert.ok(skill > 0 && skill < company && company < date, 'skills, then company, then date');
  // Two companies share the whole fixed part, which is what a prefix cache can reuse.
  const other = agentSystemPrompt(acme, 'support', supportAt(acme));
  const fixed = prompt.slice(0, prompt.indexOf('\n---\n'));
  assert.ok(other.startsWith(fixed));
});

test('the notebook is cut at its budget, newest first', () => {
  const bot = supportAt(acme);
  for (let i = 0; i < 20; i++) {
    const { id } = bots.proposeMemory(bot, `Fact number ${i}: ${'x'.repeat(400)}`);
    bots.editMemory(bots.memoryById(id)!, { status: 'active' });
    run('UPDATE bot_memories SET updated_at = ? WHERE id = ?', new Date(2026, 0, 1 + i).toISOString(), id);
  }
  const { lines, left } = bots.memoryForPrompt(bot);
  assert.ok(lines.join('\n').length <= bots.MEMORY_BUDGET);
  assert.match(lines[0], /Fact number 19/);
  assert.equal(lines.length + left, 20);
});

test('one bot per template per company', () => {
  const t = get<any>(`SELECT id FROM bot_templates WHERE key = 'support'`);
  assert.throws(() => bots.hireBot(northwind.id, t.id), /already has a Support bot/);
});

test('a routine waits for its time, files one task, and not again while that one waits', () => {
  const at = { day: '2026-09-14', hour: 10, minute: 0, tz: 'UTC' }; // a Monday
  assert.equal(bots.routineDue({ cadence: 'weekly', weekday: 1, hour: 10 }, at), true);
  assert.equal(bots.routineDue({ cadence: 'weekly', weekday: 2, hour: 10 }, at), false);
  assert.equal(bots.routineDue({ cadence: 'weekdays', weekday: 1, hour: 11 }, at), false);
  assert.equal(bots.routineDue({ cadence: 'weekdays', weekday: 1, hour: 9 }, { ...at, day: '2026-09-13' }), false); // Sunday

  const research = bots.botForType(northwind.id, 'research')!;
  const routine = bots.routinesOf(research.template_id)[0];
  run(`UPDATE bot_routines SET cadence = 'daily', hour = 0 WHERE id = ?`, routine.id);
  run('DELETE FROM settings WHERE key = ?', `routine:${research.id}:${routine.id}`);
  const count = () => get<any>(`SELECT COUNT(*) AS n FROM tasks WHERE bot_id = ? AND source = ?`, research.id, `routine:${routine.id}`).n;
  bots.queueRoutines([northwind], insertTask);
  assert.equal(count(), 1);
  bots.queueRoutines([northwind], insertTask);
  assert.equal(count(), 1, 'at most once a day');
  run('DELETE FROM settings WHERE key = ?', `routine:${research.id}:${routine.id}`);
  bots.queueRoutines([northwind], insertTask);
  assert.equal(count(), 1, 'not while the last one is still queued');
});

test('hiring marks a slot that already passed today as done', () => {
  const t = get<any>(`SELECT id FROM bot_templates WHERE key = 'research'`);
  const research = bots.botForType(acme.id, 'research')!;
  bots.fireBot(research);
  const routine = bots.routinesOf(t.id)[0];
  const id = bots.hireBot(acme.id, t.id, { routineIds: [routine.id] });
  bots.queueRoutines([acme], insertTask);
  assert.equal(get<any>(`SELECT COUNT(*) AS n FROM tasks WHERE bot_id = ?`, id).n, 0);
});

test('letting a bot go deletes its notes and hands its queue on', () => {
  const t = bots.importTemplate({
    format: bots.TEMPLATE_FORMAT, name: 'Night Support', role: 'You answer email at night.', task_types: ['support'], skills: [],
  });
  const extra = bots.hireBot(northwind.id, t);
  const note = bots.proposeMemory(bots.botById(extra)!, 'Night shift note.');
  const task = insertTask(northwind, { title: 'Late email', type: 'support', source: 'user', botId: extra });
  bots.fireBot(bots.botById(extra)!);
  assert.equal(bots.memoryById(note.id), undefined);
  assert.equal(get<any>('SELECT bot_id FROM tasks WHERE id = ?', task).bot_id, supportAt(northwind).id);
  bots.deleteTemplate(bots.templateById(t)!);
});

test('saving a template warns about private details and never carries memory', () => {
  const bot = supportAt(northwind);
  run(`INSERT INTO emails (company_id, direction, status, from_addr, subject, body, created_at) VALUES (?, 'in', 'received', 'Sarah Lee <sarah@example.com>', 'Refund', '', ?)`,
    northwind.id, new Date().toISOString());
  const leaky = bots.addSkill(bot.template_id, 'Refunds', '- Give Sarah a free month when Northwind is late.');
  const first = bots.saveAsTemplate(bot, { name: 'My Support', skillIds: [leaky] });
  assert.equal(first.id, null);
  assert.ok(first.warnings.some((w) => w.includes('Sarah')));
  assert.ok(first.warnings.some((w) => w.includes('Northwind')));

  const saved = bots.saveAsTemplate(bot, { name: 'My Support', skillIds: [leaky], confirm: true });
  assert.ok(saved.id);
  const file = JSON.stringify(bots.exportTemplate(bots.templateById(saved.id!)!));
  assert.doesNotMatch(file, /annual plan/);
  assert.doesNotMatch(file, /memor/i);
  bots.removeSkill(bots.skillById(leaky)!);
});

test('an imported template is checked, and its routines start switched off', () => {
  assert.throws(() => bots.importTemplate({ format: 'something-else' }), /isn't a Nightshift bot template/);
  assert.throws(() => bots.importTemplate({
    format: bots.TEMPLATE_FORMAT, name: 'Sneaky', role: 'r', task_types: ['ops'],
    skills: [{ title: 'Keys', body: 'use ghp_abcdefghijklmnopqrstuvwxyz0123' }],
  }), /API key/);
  const id = bots.importTemplate({
    format: bots.TEMPLATE_FORMAT, name: 'Blogger', role: 'You write posts.', task_types: ['marketing', 'nonsense'],
    routines: [{ title: 'Post', task_type: 'marketing', cadence: 'daily', hour: 8, default_on: true }],
  });
  const t = bots.templateById(id)!;
  assert.deepEqual(bots.templateTypes(t), ['marketing']);
  assert.equal(bots.routinesOf(id)[0].default_on, 0);
  bots.deleteTemplate(t);
});

test('built-ins keep their role but can be taught', () => {
  const t = get<any>(`SELECT * FROM bot_templates WHERE key = 'ops'`);
  assert.throws(() => bots.editTemplate(t, { role: 'something else' }), /keeps its name and role/);
  const id = bots.addSkill(t.id, 'CC the owner', '- CC the owner on anything about refunds.');
  assert.equal(bots.templateById(t.id)!.version, t.version + 1);
  bots.removeSkill(bots.skillById(id)!);
});

test('the one-time migration does not rehire bots an owner let go', () => {
  setSetting('bots_migrated', 'done');
  const ops = bots.botForType(acme.id, 'ops')!;
  bots.fireBot(ops);
  bots.seedBuiltins();
  assert.equal(bots.botForType(acme.id, 'ops'), undefined);
});
