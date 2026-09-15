/**
 * Tests for how a deploy that never reaches READY is classified and explained.
 *
 * Run against a throwaway database, never the real one: NIGHTSHIFT_DATA is set before
 * ./vercel.ts is imported, because db.ts opens the file on import.
 *
 *   npm test
 *
 * Written after a real case on 2026-09-14: three safastack-site deployments sat in BLOCKED,
 * which this module did not recognise as a state a deployment stays in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NIGHTSHIFT_DATA = mkdtempSync(path.join(tmpdir(), 'nightshift-vercel-'));

const { TERMINAL_STATES, deployProblem } = await import('./vercel.ts');

test('BLOCKED is a state a deployment stays in, so the wait ends there', () => {
  assert.ok(TERMINAL_STATES.includes('BLOCKED'));
  // The states a deployment can still move on from must stay out, or a normal deploy would be
  // called finished while it is still building.
  for (const live of ['QUEUED', 'INITIALIZING', 'BUILDING']) assert.ok(!TERMINAL_STATES.includes(live));
});

test('a blocked deploy says the site did not update, and why Vercel does this', () => {
  const msg = deployProblem('BLOCKED', 'dpl_abc', 0);
  assert.match(msg, /dpl_abc/);
  assert.match(msg, /was not updated/);
  assert.match(msg, /Git author/);
  assert.match(msg, /Hobby/);
});

test('a failed build points at the build log rather than repeating the state', () => {
  const msg = deployProblem('ERROR', 'dpl_def', 12);
  assert.match(msg, /dpl_def/);
  assert.match(msg, /build log/);
  assert.doesNotMatch(msg, /ended in state/);
});

test('a canceled deploy explains that a newer deploy supersedes an older one', () => {
  assert.match(deployProblem('CANCELED', 'dpl_ghi', 6), /supersedes/);
});

test('a deploy still running when the wait runs out is not reported as a failure', () => {
  const msg = deployProblem('BUILDING', 'dpl_jkl', 120);
  assert.match(msg, /still on "BUILDING"/);
  assert.match(msg, /120s/);
  // It may yet succeed, so the owner is told to look before deploying over it.
  assert.match(msg, /may still finish/);
  assert.doesNotMatch(msg, /was not updated/);
});

test('a state we have never seen still produces a usable sentence', () => {
  const msg = deployProblem('SOMETHING_NEW', 'dpl_mno', 9);
  assert.match(msg, /dpl_mno/);
  assert.match(msg, /SOMETHING_NEW/);
});
