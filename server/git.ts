/**
 * Git for a company's site folder.
 *
 * Agents can write files but could never record or share that work, so anything needing a commit
 * became a request for the owner to type `git push`. This closes that gap without handing an agent
 * a shell: every call here is a fixed argv array passed to the `git` binary with no shell involved,
 * run inside one company's site directory. There is no command passthrough, and nothing here
 * interpolates model output into an argument list.
 *
 * What an agent may do is narrower still: stage the working tree, commit, and push one branch.
 * It cannot rewrite history, force-push, change remotes, or touch any other repository.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { siteDir } from './sites.ts';

const run = promisify(execFile);

/** Branch names an agent may create. Keeps its work off whatever the humans call home. */
const BRANCH_RE = /^[a-z0-9][a-z0-9._/-]{0,80}$/;
const TIMEOUT_MS = 60_000;

export class GitError extends Error {}

async function git(slug: string, args: string[]): Promise<string> {
  const cwd = siteDir(slug);
  try {
    const { stdout } = await run('git', args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      // No shell, and a fixed environment: nothing an agent writes can become a command.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string; code?: unknown };
    throw new GitError((err.stderr || err.stdout || err.message || 'git failed').toString().trim().slice(0, 600));
  }
}

export const isRepo = (slug: string) => fs.existsSync(path.join(siteDir(slug), '.git'));

export interface GitStatus {
  repo: boolean;
  branch: string;
  remote: string | null;
  /** Paths with uncommitted changes, and how many there are in total. */
  changed: string[];
  changedCount: number;
  ahead: number;
}

/** What the working tree looks like right now. Read-only: safe to call whenever. */
export async function status(slug: string): Promise<GitStatus> {
  if (!isRepo(slug)) return { repo: false, branch: '', remote: null, changed: [], changedCount: 0, ahead: 0 };
  const branch = (await git(slug, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const porcelain = (await git(slug, ['status', '--porcelain'])).split('\n').filter(Boolean);
  const changed = porcelain.map((line) => line.slice(3).trim());
  let remote: string | null = null;
  try {
    remote = (await git(slug, ['remote', 'get-url', 'origin'])).trim() || null;
  } catch {
    remote = null; // a repo with no origin is fine; it just cannot be pushed
  }
  let ahead = 0;
  try {
    ahead = Number((await git(slug, ['rev-list', '--count', `origin/${branch}..HEAD`])).trim()) || 0;
  } catch {
    ahead = 0; // no upstream yet
  }
  return { repo: true, branch, remote, changed, changedCount: changed.length, ahead };
}

/** A short, human-readable summary of what would be committed. Used in the approval card. */
export async function diffSummary(slug: string): Promise<string> {
  if (!isRepo(slug)) return '';
  const stat = await git(slug, ['diff', '--stat', 'HEAD', '--']);
  const untracked = (await git(slug, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const lines = [stat.trim(), untracked.length ? `new files: ${untracked.slice(0, 20).join(', ')}` : '']
    .filter(Boolean)
    .join('\n');
  return lines.slice(0, 4000);
}

export interface CommitResult { branch: string; sha: string; pushed: boolean; remote: string | null }

/**
 * Stage everything the repository's own .gitignore allows, commit, and push one branch.
 *
 * The commit lands on `branch`, which defaults to a new agent branch rather than whatever is
 * checked out: an agent's work should arrive as something to look at, not as a surprise on main.
 */
export async function commitAndPush(
  slug: string,
  { message, branch, author = 'Nightshift agent', email = 'agent@nightshift.local', push = true }:
  { message: string; branch: string; author?: string; email?: string; push?: boolean },
): Promise<CommitResult> {
  if (!isRepo(slug)) throw new GitError(`${slug} has no git repository. Run "git init" in its site folder and add a remote first.`);
  if (!BRANCH_RE.test(branch)) throw new GitError(`Refusing branch name "${branch}": lowercase letters, digits, dot, dash, slash and underscore only.`);
  if (!message.trim()) throw new GitError('A commit needs a message.');

  const before = await status(slug);
  await git(slug, ['checkout', '-B', branch]);
  await git(slug, ['add', '--all', '--']);

  // Nothing staged means nothing to record; say so rather than making an empty commit.
  try {
    await git(slug, ['diff', '--cached', '--quiet']);
    throw new GitError('Nothing to commit: the site folder matches the last commit.');
  } catch (e) {
    if (e instanceof GitError && e.message.startsWith('Nothing to commit')) throw e;
    // A non-zero exit from --quiet is the normal "there are staged changes" signal.
  }

  await git(slug, ['-c', `user.name=${author}`, '-c', `user.email=${email}`, 'commit', '-m', message]);
  const sha = (await git(slug, ['rev-parse', 'HEAD'])).trim();

  if (!push) return { branch, sha, pushed: false, remote: before.remote };
  if (!before.remote) throw new GitError(`Committed ${sha.slice(0, 8)} on ${branch}, but this repository has no "origin" remote to push to.`);
  // Never force: a rejected push is information, not something to overwrite.
  await git(slug, ['push', '--set-upstream', 'origin', branch]);
  return { branch, sha, pushed: true, remote: before.remote };
}
