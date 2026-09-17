/**
 * The bot's browser may look and must not touch. These pin down both halves: what it can open,
 * and that a page's own scripts can't post, track or reach the server's private network.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.NIGHTSHIFT_DATA = mkdtempSync(path.join(tmpdir(), 'nightshift-browser-'));

// A stand-in for the public listener that serves company previews.
const hits: string[] = [];
const server = http.createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  if (req.url === '/s/acme/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Acme</title><body><p>Static line</p>
      <script src="/t.js"></script>
      <script>
        document.body.insertAdjacentHTML('beforeend', '<p id="late">Built by JavaScript</p>');
        fetch('/public/waitlist', { method: 'POST', body: '{}' }).catch(() => {});
        fetch('/s/acme/data.json').then((r) => r.json()).then((d) => document.body.insertAdjacentHTML('beforeend', '<p>Rows: ' + d.rows + '</p>'));
        fetch('http://127.0.0.1:1/secret').catch(() => {});
        undefinedFunction();
      </script></body>`);
  } else if (req.url === '/s/acme/data.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"rows": 42}');
  } else if (req.url === '/s/acme/leave.html') {
    res.writeHead(302, { location: '/s/other/index.html' });
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.PUBLIC_PORT = String((server.address() as AddressInfo).port);
process.env.PUBLIC_HOST = '127.0.0.1';

const { openPage, resolvePageUrl, isPrivateAddress, describeReport, PREVIEW_ORIGIN } = await import('./browser.ts');
const acme = { slug: 'acme', site_url: 'https://acme.example.com' };

// Let the process exit when the tests are done, without a hook that could close it early.
server.unref();

test('a path opens on the preview, a URL only on the company\'s own site', () => {
  assert.equal(resolvePageUrl(acme, '/pricing.html'), `${PREVIEW_ORIGIN}/s/acme/pricing.html`);
  assert.equal(resolvePageUrl(acme, 's/acme/holdings.html'), `${PREVIEW_ORIGIN}/s/acme/holdings.html`);
  assert.equal(resolvePageUrl(acme, 'https://acme.example.com/a?b=1'), 'https://acme.example.com/a?b=1');
  assert.throws(() => resolvePageUrl(acme, 'https://evil.example.org/'), /Only this company's own pages/);
  assert.throws(() => resolvePageUrl(acme, 'http://100.103.109.19:4455/api/settings'), /Only this company's own pages/);
  assert.throws(() => resolvePageUrl(acme, 'file:///etc/passwd'), /http\(s\)/);
  assert.throws(() => resolvePageUrl({ slug: 'acme', site_url: '' }, 'https://acme.example.com/'), /Only this company's own pages/);
});

test('private and tailnet addresses count as private', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.103.109.19', '0.0.0.0', '::1', 'fd12::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '76.76.21.21', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

let launched = true;
try {
  const { chromium } = await import('playwright-core');
  await (await chromium.launch({ headless: true })).close();
} catch {
  launched = false;
}

test('it runs the page\'s JavaScript and reports its errors', { skip: !launched && 'no Chromium on this machine' }, async () => {
  const r = await openPage(acme, '/index.html', { waitFor: '#late' });
  assert.equal(r.status, 200);
  assert.match(r.text, /Built by JavaScript/);
  assert.match(r.text, /Rows: 42/);
  assert.ok(r.pageErrors.some((e) => e.includes('undefinedFunction')));
  assert.match(describeReport(r), /What a visitor sees/);
});

test('it never posts, never tracks and never reaches private addresses', { skip: !launched && 'no Chromium on this machine' }, async () => {
  hits.length = 0;
  const r = await openPage(acme, '/index.html');
  assert.ok(!hits.some((h) => h.startsWith('POST')), 'no POST reached the server');
  assert.ok(!hits.includes('GET /t.js'), 'tracker not loaded');
  assert.ok(r.blocked.some((b) => b.includes('POST') && b.includes('/public/waitlist')));
  assert.ok(r.blocked.some((b) => b.includes('visitor tracking')));
  assert.ok(r.blocked.some((b) => b.includes('127.0.0.1:1') && b.includes('private address')));
});

test('a redirect off the company\'s pages is stopped', { skip: !launched && 'no Chromium on this machine' }, async () => {
  hits.length = 0;
  await assert.rejects(openPage(acme, '/leave.html'), /redirect leaves the company site/);
  assert.ok(!hits.includes('GET /s/other/index.html'));
});
