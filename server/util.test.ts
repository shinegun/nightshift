/**
 * The owner must never read a model's tool-call markup. It reached them once — a chat reply that
 * ran out of tool calls mid-investigation and wrote four fetch_url calls out as prose — so the
 * shapes that leaked are pinned here.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripToolMarkup } from './util.ts';

// Exactly what landed in the messages table on 2026-09-13, shortened.
const LEAKED = `The push rejection and the dated-file 404 are both worth pinning down.

<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="fetch_url">
<｜｜DSML｜｜ parameter name="url" string="true">https://halal.sh/sitemap.xml</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

test('a leaked call block is removed and the real sentence survives', () => {
  const out = stripToolMarkup(LEAKED);
  assert.equal(out, 'The push rejection and the dated-file 404 are both worth pinning down.');
  assert.doesNotMatch(out, /DSML/);
  assert.doesNotMatch(out, /halal\.sh/);
});

test('a block cut off before its closing tag is still removed whole', () => {
  const cut = 'Here is what I found.\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="fetch_url">\n<｜｜DSML｜｜ parameter name="url"';
  assert.equal(stripToolMarkup(cut), 'Here is what I found.');
});

test('a stray tag with no block around it goes too', () => {
  assert.equal(stripToolMarkup('Done. </｜｜DSML｜｜ invoke>'), 'Done.');
});

test('ordinary replies are returned untouched', () => {
  const plain = 'I queued three tasks. The pricing page is the one I would do first —\nit blocks the others.';
  assert.equal(stripToolMarkup(plain), plain);
});

test('replies that merely mention tools or angle brackets are not mangled', () => {
  const talking = 'I used fetch_url on <https://example.com> and web_search for the rest.';
  assert.equal(stripToolMarkup(talking), talking);
});

test('a reply that was nothing but markup comes back empty, so the caller can fall back', () => {
  assert.equal(stripToolMarkup('<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="x">\n</｜｜DSML｜｜ calls>'), '');
});
