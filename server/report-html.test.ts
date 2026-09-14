/**
 * The HTML report reads the text report back. That makes the text format load-bearing in a way it
 * was not before, so the reader is pinned down here: both report shapes that exist in the wild,
 * and the ways a title can be hostile.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, reportHtml } from './report-html.ts';
import type { Company } from './db.ts';

const company = { name: 'Acme', slug: 'acme' } as Company;

const CURRENT = [
  '3 decisions for you.',
  '',
  '1. Push "fix: the thing" to main',
  '2. Give us live-mode Stripe keys',
  '3. Approve or discard 5 drafted emails',
  '   ...and 2 more in the dashboard.',
  '',
  '7 tasks ran. 5 finished, 2 did not.',
  '   unfinished: Ship the pricing page',
  '   ...and 1 more.',
  'AI spend: $1.65 today, $5.00 this month of $30.',
].join('\n');

// What the reports written before 2026-09-14 look like.
const LEGACY = [
  'Done overnight: ✓ One thing; ✓ Another thing.',
  'Numbers: 12 visitors, 1 new waitlist signups, AI spend $2.71.',
  'Needs you: the daily AI budget ($2) was spent.',
].join('\n');

test('reads the current report into its parts', () => {
  const p = parseReport(CURRENT);
  assert.equal(p.headline, '3 decisions for you.');
  assert.deepEqual(p.decisions, [
    'Push "fix: the thing" to main',
    'Give us live-mode Stripe keys',
    'Approve or discard 5 drafted emails',
  ]);
  assert.match(p.decisionsMore, /2 more in the dashboard/);
  assert.equal(p.ran, '7 tasks ran. 5 finished, 2 did not.');
  assert.deepEqual(p.unfinished, ['Ship the pricing page']);
  assert.match(p.unfinishedMore, /1 more/);
  assert.match(p.spend, /^AI spend:/);
  assert.deepEqual(p.sections, []);
});

test('the two "...and N more" lines attach to the right list', () => {
  const p = parseReport(CURRENT);
  assert.match(p.decisionsMore, /dashboard/);
  assert.doesNotMatch(p.unfinishedMore, /dashboard/);
});

test('a legacy report becomes sections, not a headline of prose', () => {
  const p = parseReport(LEGACY);
  assert.equal(p.headline, 'Morning report');
  assert.equal(p.sections.length, 3);
  assert.deepEqual(p.sections.map((s) => s.heading), ['Done overnight', 'Numbers', 'Needs you']);
  assert.equal(p.decisions.length, 0);
});

test('a wrapped decision stays one decision instead of becoming a stray note', () => {
  // Reports written before decision titles were forced onto one line carry commit bodies.
  const p = parseReport('1 decision for you.\n\n1. Push "feat: thing" to main\n- a bullet from the commit body\n\nNo tasks ran.');
  assert.equal(p.decisions.length, 1);
  assert.match(p.decisions[0], /a bullet from the commit body/);
  assert.deepEqual(p.sections, []);
});

test('a quiet morning renders without a decision list', () => {
  const p = parseReport('Nothing needs you.\n\nNo tasks ran.\nAI spend: $0.00 today, $0.00 this month.');
  assert.equal(p.headline, 'Nothing needs you.');
  assert.equal(p.decisions.length, 0);
  assert.equal(p.ran, 'No tasks ran.');
  const html = reportHtml(company, 'Nothing needs you.\n\nNo tasks ran.', '2026-09-14');
  assert.match(html, /Nothing is waiting on you/);
});

test('titles cannot break out of the style attribute or inject markup', () => {
  const nasty = '2 decisions for you.\n\n1. Push "<script>alert(1)</script>" to main\n2. A " quote & an <b>';
  const html = reportHtml(company, nasty, '2026-09-14');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot; quote &amp; an &lt;b&gt;/);
});

test('font stacks never contain a double quote, which would end the style attribute', () => {
  const html = reportHtml(company, CURRENT, '2026-09-14');
  for (const style of html.matchAll(/style="([^"]*)"/g)) {
    assert.doesNotMatch(style[1], /font-family:[^;]*"/);
  }
  // The decision text and its number both survived, which only happens if the styles parsed.
  assert.match(html, /Give us live-mode Stripe keys/);
});

test('the date shown is the report day, not the day it is rendered', () => {
  const html = reportHtml(company, CURRENT, '2026-09-13');
  assert.match(html, /Sunday, 13 September 2026/);
  assert.doesNotMatch(html, /14 September/);
});
