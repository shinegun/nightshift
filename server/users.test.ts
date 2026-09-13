/**
 * Tests for sign-in. Run against a throwaway database, never the real one:
 * NIGHTSHIFT_DATA is set before ./users.ts is imported, because db.ts opens the file on import.
 *
 *   npm test
 *
 * The passwords below are fixtures. Nothing here is a real credential.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.NIGHTSHIFT_DATA = mkdtempSync(path.join(tmpdir(), 'nightshift-users-'));

const { addUser, hashPassword, listUsers, removeUser, setPassword, userCount, verifyUser } = await import('./users.ts');

const PASSWORD = 'correct horse battery staple';

test('a stored password is not recoverable from what is stored', () => {
  const stored = hashPassword(PASSWORD);
  assert.ok(!stored.includes(PASSWORD));
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
});

test('the same password hashes differently every time, so equal hashes never leak equal passwords', () => {
  assert.notEqual(hashPassword(PASSWORD), hashPassword(PASSWORD));
});

test('the right password signs in and the wrong one does not', () => {
  addUser('aqil', 'Aqil', PASSWORD);
  assert.equal(verifyUser('aqil', PASSWORD)?.name, 'Aqil');
  assert.equal(verifyUser('aqil', 'wrong'), null);
  assert.equal(verifyUser('nobody', PASSWORD), null);
  assert.equal(verifyUser('', ''), null);
});

test('a user record never carries the hash off to a caller', () => {
  assert.ok(!('password_hash' in (verifyUser('aqil', PASSWORD) as object)));
  for (const u of listUsers()) assert.ok(!('password_hash' in u));
});

test('two people have separate credentials, and one does not open the other', () => {
  addUser('ilham', 'Ilham', 'a different password entirely');
  assert.equal(verifyUser('ilham', 'a different password entirely')?.name, 'Ilham');
  assert.equal(verifyUser('ilham', PASSWORD), null);
  assert.equal(verifyUser('aqil', 'a different password entirely'), null);
});

test('changing a password stops the old one immediately, cache or no cache', () => {
  assert.ok(verifyUser('ilham', 'a different password entirely')); // seed the verify cache
  setPassword('ilham', 'something else again');
  assert.equal(verifyUser('ilham', 'a different password entirely'), null);
  assert.ok(verifyUser('ilham', 'something else again'));
});

test('removing someone revokes only them', () => {
  removeUser('ilham');
  assert.equal(verifyUser('ilham', 'something else again'), null);
  assert.ok(verifyUser('aqil', PASSWORD), 'the other account still works');
});

test('the last account cannot be removed, because nothing else opens the door', () => {
  assert.equal(userCount(), 1);
  assert.throws(() => removeUser('aqil'), /only account/);
  assert.ok(verifyUser('aqil', PASSWORD));
});

test('usernames and passwords are checked before anything is written', () => {
  assert.throws(() => addUser('no', 'Short password', 'short'), /at least 8/);
  assert.throws(() => addUser('has spaces', 'Bad username', PASSWORD), /2-32 characters/);
  assert.throws(() => addUser('aqil', 'Duplicate', PASSWORD), /already exists/);
  assert.equal(userCount(), 1);
});

test('a password containing a colon works, since basic auth splits on the first one only', () => {
  addUser('colon', 'Colon Person', 'pass:with:colons');
  assert.ok(verifyUser('colon', 'pass:with:colons'));
  assert.equal(verifyUser('colon', 'pass'), null);
});

test('an existing short password is migrated rather than refused, and a new one still is not', () => {
  assert.throws(() => addUser('shorty', 'Shorty', 'abc'), /at least 8/);
  // The legacy path allows it: refusing would lock the owner out of a dashboard they already use.
  assert.ok(addUser('legacy', 'Legacy', 'abc', { allowShortPassword: true }));
  assert.ok(verifyUser('legacy', 'abc'));
  assert.throws(() => addUser('empty', 'Empty', '', { allowShortPassword: true }), /password is required/);
});
