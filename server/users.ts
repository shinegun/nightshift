/**
 * Who may drive Nightshift.
 *
 * Everyone here can do everything: this is a co-founder tool, not a permission system. What the
 * separate rows buy is the two things a shared password cannot give you —
 *
 *   1. attribution: the activity log can say who approved the email, and
 *   2. revocation: one person can be removed without changing everyone else's password.
 *
 * Passwords are stored as scrypt hashes and are never logged, returned to the browser, or written
 * to the activity log. Add people with `npm run user -- add`, which reads the password from the
 * terminal without echoing it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { all, get, now, run } from './db.ts';

export interface User {
  id: number; username: string; name: string;
  password_hash: string; created_at: string; last_seen_at: string | null;
}
/** A user as the browser may see one: no hash, ever. */
export type PublicUser = Omit<User, 'password_hash'>;

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function passwordMatches(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, key] = parts;
  const expected = Buffer.from(key, 'base64');
  try {
    const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Basic auth sends the password on every request, and scrypt is deliberately slow, so a dashboard
 * that polls would spend most of its time hashing. Remember a verified pair briefly instead. The
 * pepper is new each boot, so nothing here survives a restart or means anything outside it.
 */
const PEPPER = randomBytes(32);
const VERIFY_TTL_MS = 5 * 60_000;
const verified = new Map<string, { user: PublicUser; at: number }>();
const cacheKey = (username: string, password: string) =>
  `${username}:${createHash('sha256').update(PEPPER).update(password).digest('base64')}`;

export const publicUser = ({ password_hash, ...rest }: User): PublicUser => rest;

/** The user for these credentials, or null. Constant-ish time: a miss still costs a hash. */
export function verifyUser(username: string, password: string): PublicUser | null {
  if (!username || !password) return null;
  const key = cacheKey(username, password);
  const hit = verified.get(key);
  if (hit && Date.now() - hit.at < VERIFY_TTL_MS) return hit.user;

  const row = get<User>('SELECT * FROM users WHERE username = ?', username);
  if (!row || !passwordMatches(password, row.password_hash)) {
    verified.delete(key);
    return null;
  }
  const user = publicUser(row);
  verified.set(key, { user, at: Date.now() });
  return user;
}

export const userCount = () => Number(get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0);
export const listUsers = (): PublicUser[] =>
  all<User>('SELECT * FROM users ORDER BY id').map(publicUser);

export function addUser(username: string, name: string, password: string): PublicUser {
  const clean = username.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,32}$/.test(clean)) throw new Error('Username must be 2-32 characters: a-z, 0-9, - or _');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  if (get('SELECT id FROM users WHERE username = ?', clean)) throw new Error(`"${clean}" already exists`);
  const { id } = run(
    'INSERT INTO users (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
    clean, name.trim() || clean, hashPassword(password), now(),
  );
  return { id, username: clean, name: name.trim() || clean, created_at: now(), last_seen_at: null };
}

export function setPassword(username: string, password: string) {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  const { changes } = run('UPDATE users SET password_hash = ? WHERE username = ?', hashPassword(password), username.trim().toLowerCase());
  if (!changes) throw new Error(`No user "${username}"`);
  verified.clear(); // the old password must stop working immediately, cache or no cache
}

export function removeUser(username: string) {
  // Removing the last one would lock everybody out of a dashboard that has no other way in.
  if (userCount() <= 1) throw new Error('That is the only account left. Add another before removing this one.');
  const { changes } = run('DELETE FROM users WHERE username = ?', username.trim().toLowerCase());
  if (!changes) throw new Error(`No user "${username}"`);
  verified.clear();
}

/** Cheap enough to do on every request, and it is what makes "last seen" honest. */
export function touchUser(id: number) {
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), id);
}

/**
 * The person behind the current request, if there is one. Agent work runs outside any request and
 * gets null, which is the distinction the activity log wants: you, Ilham, or nobody.
 */
export const actorStore = new AsyncLocalStorage<PublicUser>();
export const currentActor = (): PublicUser | null => actorStore.getStore() ?? null;

/**
 * Carries a single-password setup forward. Without this, adding accounts would lock the owner out
 * of their own dashboard on the next restart. The password comes from the environment as it always
 * did; nothing new is chosen here.
 */
export function adoptLegacyPassword(password: string) {
  if (!password || userCount() > 0) return null;
  const user = addUser('admin', 'Owner', password);
  console.log('[users] moved DASHBOARD_PASSWORD to an account named "admin" — add others with: npm run user -- add');
  return user;
}
