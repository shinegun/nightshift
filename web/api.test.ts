/**
 * The API client's contract, pinned because getting it wrong is invisible until a page blanks.
 *
 *   npm test
 *
 * An unknown /api path falls through to the SPA catch-all and returns index.html with a 200.
 * Treating that as an empty object handed callers a value where every field was undefined, and the
 * throw then landed in whichever component read a field first, nowhere near the cause.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { api } from './api.ts';

const realFetch = globalThis.fetch;
const stub = (body: string, init: { status?: number; type?: string }) => {
  globalThis.fetch = (async () => new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.type ?? 'application/json' },
  })) as typeof fetch;
};
test.afterEach(() => { globalThis.fetch = realFetch; });

test('JSON comes back parsed', async () => {
  stub(JSON.stringify({ users: [{ id: 1 }] }), {});
  assert.deepEqual(await api('/users'), { users: [{ id: 1 }] });
});

test('HTML with a 200 is an error, not an empty object', async () => {
  stub('<!doctype html><title>Nightshift</title>', { type: 'text/html' });
  await assert.rejects(() => api('/users'), /did not return JSON/);
});

test('the HTML case names the likely cause, because it is always the same one', async () => {
  stub('<!doctype html>', { type: 'text/html' });
  await assert.rejects(() => api('/users'), /older code than this page/);
});

test('an error status uses the server\'s own message', async () => {
  stub(JSON.stringify({ error: 'Commit is pushed' }), { status: 400 });
  await assert.rejects(() => api('/commits/1/approve'), /Commit is pushed/);
});

test('an error status with no usable body still reports the status', async () => {
  stub('nope', { status: 500, type: 'text/plain' });
  await assert.rejects(() => api('/state'), /Request failed \(500\)/);
});

test('malformed JSON is an error rather than a silent empty object', async () => {
  stub('{not json', {});
  await assert.rejects(() => api('/state'), /did not return JSON/);
});
