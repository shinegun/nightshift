/**
 * Tests for the pure parts of the GitHub Actions watcher: reading a repo out of a git remote,
 * and turning a job log into something short enough to store and read.
 *
 * Run against a throwaway database, never the real one: NIGHTSHIFT_DATA is set before
 * ./github.ts is imported, because db.ts opens the file on import.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NIGHTSHIFT_DATA = mkdtempSync(path.join(tmpdir(), 'nightshift-github-'));

const { parseRepo, cleanLines, failureWindow, describeFailure } = await import('./github.ts');

test('a repo is read out of every remote spelling git produces', () => {
  const expected = { owner: 'shinegun', repo: 'safastack' };
  for (const remote of [
    'git@github.com:shinegun/safastack.git',
    'git@github.com:shinegun/safastack',
    'https://github.com/shinegun/safastack.git',
    'https://github.com/shinegun/safastack',
    'ssh://git@github.com/shinegun/safastack.git',
    'https://github.com/shinegun/safastack/',
  ]) {
    assert.deepEqual(parseRepo(remote), expected, remote);
  }
});

test('a remote that is not GitHub, or not there at all, is not guessed at', () => {
  for (const remote of [null, undefined, '', 'git@gitlab.com:shinegun/safastack.git', 'https://example.com/a/b', 'not a url']) {
    assert.equal(parseRepo(remote), null, String(remote));
  }
});

test('a deploy-key style host alias is not mistaken for github.com', () => {
  // github.com-work is a different SSH host alias, not github.com.
  assert.equal(parseRepo('git@github.com-work:shinegun/safastack.git'), null);
});

test('log lines lose their timestamps and their blanks', () => {
  const raw = [
    '2026-09-15T05:42:16.1234567Z first',
    '2026-09-15T05:42:16.2234567Z second',
    '',
    '2026-09-15T05:42:16.3234567Z third',
  ].join('\n');
  assert.deepEqual(cleanLines(raw), ['first', 'second', 'third']);
});

test('the window reaches back to the assertion, past the runner cleanup after it', () => {
  // The shape a Node test-runner failure actually has: the named failure, then the remaining
  // passes, then a count, then the runner tidying up. Only the first line says what broke.
  const lines = [
    'not ok 2 - published change documents and the index validate against their schemas',
    "  name: 'AssertionError'",
    ...Array.from({ length: 80 }, (_, i) => `ok ${i + 3} - something else passes`),
    '# fail 1',
    '##[error]Process completed with exit code 1.',
    'Cleaning up orphan processes',
  ];
  const { log, line } = failureWindow(lines.map((l) => `2026-09-15T05:42:16.1234567Z ${l}`).join('\n'));
  // The named failure wins over the trailing count, though the count sits far nearer the end.
  assert.match(line, /^not ok 2 - published change documents/);
  // The window stops at the error marker, so cleanup noise never reaches the card.
  assert.equal(log.at(-1), '##[error]Process completed with exit code 1.');
  assert.ok(!log.includes('Cleaning up orphan processes'));
  // And it reaches back far enough to carry the line that explains it.
  assert.ok(log.some((l) => l.startsWith('not ok 2')));
});

test('with no diagnostic at all, a generic exit marker is not passed off as an explanation', () => {
  const raw = ['doing a thing', '##[error]Process completed with exit code 1.'].join('\n');
  assert.equal(failureWindow(raw).line, '');
});

test('a failure reads as one sentence naming the step and the last real line', () => {
  const line = describeFailure({
    run: { id: 1, name: 'Daily holdings ingest', number: 8, status: 'completed', conclusion: 'failure', event: 'schedule', createdAt: '', url: '', sha: 'abc1234' },
    job: 'ingest',
    step: 'Unit tests (fixtures, no network)',
    stepNumber: 4,
    stepCount: 12,
    log: ['not ok 2 - index validates', '##[error]Process completed with exit code 1.'],
    line: 'not ok 2 - index validates',
  });
  assert.match(line, /Daily holdings ingest #8/);
  assert.match(line, /step 4 of 12/);
  assert.match(line, /Unit tests/);
  assert.match(line, /not ok 2/);
});
