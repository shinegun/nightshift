/**
 * The brief is the owner's whole morning, so its shape is worth pinning down: it must stay short,
 * lead with what needs a decision, and never quietly drop an item it decided not to print.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NIGHTSHIFT_DATA = mkdtempSync(path.join(tmpdir(), 'nightshift-brief-'));

const { briefText } = await import('./decisions.ts');
const { get, run } = await import('./db.ts');

run(
  `INSERT INTO companies (slug, name, idea, status, email, site_url, vercel_project, config, created_at, updated_at)
   VALUES ('acme', 'Acme', 'idea', 'live', '', '', '', '{}', ?, ?)`,
  new Date().toISOString(), new Date().toISOString(),
);
const company = get<any>(`SELECT * FROM companies WHERE slug = 'acme'`)!;

const decision = (n: number) => ({ kind: 'request' as const, id: n, title: `Decision ${n}`, action: 'Needs you' });
const quiet = { ran: 0, finished: 0, unfinished: 0, unfinishedTitles: [] };

test('a quiet night says so in one line, and does not invent a list', () => {
  const out = briefText(company, [], quiet);
  assert.match(out, /^Nothing needs you\./);
  assert.match(out, /No tasks ran\./);
  assert.ok(!out.includes('1.'), 'no numbered list when there is nothing to decide');
});

test('the decision count leads, because it is the only number that changes the morning', () => {
  assert.match(briefText(company, [decision(1)], quiet), /^1 decision for you\./);
  assert.match(briefText(company, [decision(1), decision(2)], quiet), /^2 decisions for you\./);
});

test('a long list is cut, and says how many it cut', () => {
  const out = briefText(company, Array.from({ length: 12 }, (_, i) => decision(i + 1)), quiet);
  assert.ok(out.includes('6. Decision 6'), 'prints up to the limit');
  assert.ok(!out.includes('7. Decision 7'), 'stops at the limit');
  assert.match(out, /\.\.\.and 6 more in the dashboard\./);
  assert.match(out, /^12 decisions for you\./, 'the headline still counts every one');
});

test('the whole brief stays short enough to read without scrolling', () => {
  const out = briefText(company, Array.from({ length: 12 }, (_, i) => decision(i + 1)), {
    ran: 30, finished: 20, unfinished: 10,
    unfinishedTitles: Array.from({ length: 10 }, (_, i) => `Unfinished ${i + 1}`),
  });
  assert.ok(out.split('\n').length <= 16, `brief grew to ${out.split('\n').length} lines`);
});

test('unfinished work is named, because it is a decision wearing a summary', () => {
  const out = briefText(company, [], { ran: 3, finished: 2, unfinished: 1, unfinishedTitles: ['Ship the ingest'] });
  assert.match(out, /3 tasks ran\. 2 finished, 1 did not\./);
  assert.match(out, /unfinished: Ship the ingest/);
});

test('finished work is a count and nothing more', () => {
  const out = briefText(company, [], { ran: 30, finished: 30, unfinished: 0, unfinishedTitles: [] });
  assert.match(out, /30 tasks ran\. 30 finished\./);
  assert.ok(!out.includes('unfinished'), 'nothing to report when nothing broke');
});
