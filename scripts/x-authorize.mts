#!/usr/bin/env node
// Authorize Nightshift to post as a DIFFERENT X account, without moving your developer app.
//
//   npx tsx scripts/x-authorize.mts --company safastack
//   npx tsx scripts/x-authorize.mts                      (writes the global X account)
//   npx tsx scripts/x-authorize.mts --company safastack --clear-global
//
// How it works: X's PIN-based (out-of-band) 3-legged OAuth — the flow X documents for apps
// that cannot embed a browser. The consumer key/secret belong to your app and stay where
// they are; what changes is the account owner's access token and secret, which are written
// to the company you name (or the global settings). Your personal account is then no longer
// the posting identity for that company.
//
// Secrets are never printed. The PIN you type is hidden, single-use and expires quickly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The database and site folders are resolved relative to the working directory, so run
// from the repo root no matter where the command was typed. Without this, running the
// script from your home folder would quietly create and use an empty database in ~/data.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repoRoot);
if (!fs.existsSync(path.join(repoRoot, 'data', 'nightshift.db'))) {
  console.error(`No Nightshift database at ${path.join(repoRoot, 'data', 'nightshift.db')} — nothing to authorize against.`);
  process.exit(1);
}

const { xRequestTokenPin, xExchangePin, testX } = await import('../server/integrations/x.ts');
const { companyBySlug, run, now } = await import('../server/db.ts');
const { setSetting } = await import('../server/settings.ts');

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const slug = arg('--company');
const clearGlobal = argv.includes('--clear-global');

const company = slug ? companyBySlug(slug) : undefined;
if (slug && !company) {
  console.error(`No company with slug "${slug}". Create it in the dashboard first.`);
  process.exit(1);
}

/** Read a line without echoing it. */
function hidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdout.write(prompt);
    return new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        if (buf.includes('\n')) resolve(buf.trim());
      });
    });
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf.trim());
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u007f') {
        buf = buf.slice(0, -1);
      } else if (ch >= ' ') {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

console.log('\nNightshift → X account authorization');
console.log(company ? `  target: company "${company.name}" (its own posting account)` : '  target: global settings (all companies without an override)');
console.log('  the consumer key/secret and bearer token stay as they are — only the account changes\n');

const req = await xRequestTokenPin(company).catch((e: unknown) => {
  console.error(`Could not start the flow: ${e instanceof Error ? e.message : String(e)}`);
  console.error('A request token needs the consumer key and secret, and the app needs "Read and write" permission.');
  process.exit(1);
});

console.log('1. Open this in a browser — IMPORTANT: a private/incognito window (or a separate');
console.log('   browser profile) signed in as the account that should post, NOT your main one:\n');
console.log(`   ${req.authorizeUrl}\n`);
console.log('   Approve access as that account. X then shows a PIN.\n');

const pin = await hidden('2. PIN (hidden): ');
const tok = await xExchangePin(company, req, pin).catch((e: unknown) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

if (company) {
  const cfg = JSON.parse(company.config || '{}') as Record<string, string>;
  cfg.x_access_token = tok.accessToken;
  cfg.x_access_secret = tok.accessSecret;
  run('UPDATE companies SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify(cfg), now(), company.id);
} else {
  setSetting('x_access_token', tok.accessToken);
  setSetting('x_access_secret', tok.accessSecret);
}

if (clearGlobal && company) {
  run(`DELETE FROM settings WHERE key IN ('x_access_token','x_access_secret')`);
  console.log('\nCleared the global X access token/secret, so no company can post as your main account.');
}

console.log(`\nSaved (token not shown). Posting identity is now @${tok.screenName ?? '(unknown)'}.`);

try {
  const check = await testX(company ?? ({ config: '{}' } as never));
  console.log(`Checked with X: ${check.message}`);
} catch (e) {
  console.log(`Could not verify yet: ${e instanceof Error ? e.message : String(e)}`);
}

console.log(
  [
    '',
    'Next:',
    company ? `  • Dashboard → ${company.name} → Settings icon → Company settings → check the X rows show "saved".` : '  • Dashboard → Settings → X → Test connection.',
    '  • Revoke the old access token in the X portal (Keys and tokens → Access Token → Regenerate)',
    '    once you are happy, so the previous account can no longer be used.',
    '  • Nothing posts without your approval: X posts sit in "Needs you" until you press Post.',
    '',
  ].join('\n'),
);
