#!/usr/bin/env node
/**
 * Who can sign in to Nightshift.
 *
 *   npm run user -- list
 *   npm run user -- add <username> "Full Name"
 *   npm run user -- password <username>
 *   npm run user -- remove <username>
 *
 * Everyone added here can do everything: approve email, post, spend, change keys. The separate
 * accounts exist so the activity log can say who did what, and so one person can be removed
 * without changing anyone else's password.
 *
 * The password is typed at the prompt and never echoed. It is deliberately not an argument:
 * arguments end up in shell history and in `ps` output for every other user on the machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repoRoot);
if (!fs.existsSync(path.join(repoRoot, 'data', 'nightshift.db'))) {
  console.error(`No Nightshift database at ${path.join(repoRoot, 'data', 'nightshift.db')}. Start the server once first.`);
  process.exit(1);
}

const { addUser, listUsers, removeUser, setPassword } = await import('../server/users.ts');

/** Reads a line with echo off, so the password never appears on screen or in a scrollback buffer. */
function secret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) return reject(new Error('Run this from a terminal: the password prompt needs one.'));
    const rl = readline.createInterface({ input, output: process.stdout, terminal: true });
    const onData = () => { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); process.stdout.write(prompt); };
    process.stdout.write(prompt);
    input.on('data', onData);
    rl.question('', (answer) => { input.off('data', onData); rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function newPassword(): Promise<string> {
  const first = await secret('Password (not shown): ');
  if (first.length < 8) throw new Error('Password must be at least 8 characters');
  if ((await secret('Again: ')) !== first) throw new Error('The two passwords did not match');
  return first;
}

const [command, username, ...nameParts] = process.argv.slice(2);

try {
  switch (command) {
    case 'list': {
      const users = listUsers();
      if (!users.length) { console.log('Nobody yet. Add someone with: npm run user -- add <username> "Full Name"'); break; }
      for (const u of users) {
        console.log(`${u.username.padEnd(16)} ${u.name.padEnd(22)} last seen ${u.last_seen_at ?? 'never'}`);
      }
      break;
    }
    case 'add': {
      if (!username) throw new Error('Usage: npm run user -- add <username> "Full Name"');
      const user = addUser(username, nameParts.join(' '), await newPassword());
      console.log(`Added ${user.name} (${user.username}). They can sign in with that username and password.`);
      break;
    }
    case 'password': {
      if (!username) throw new Error('Usage: npm run user -- password <username>');
      setPassword(username, await newPassword());
      console.log(`Password changed for ${username}. The old one stops working immediately.`);
      break;
    }
    case 'remove': {
      if (!username) throw new Error('Usage: npm run user -- remove <username>');
      removeUser(username);
      console.log(`Removed ${username}. Nobody else's password changes.`);
      break;
    }
    default:
      console.log('Usage:\n  npm run user -- list\n  npm run user -- add <username> "Full Name"\n  npm run user -- password <username>\n  npm run user -- remove <username>');
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
