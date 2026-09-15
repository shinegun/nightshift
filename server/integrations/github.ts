/**
 * GitHub Actions, as seen from Nightshift.
 *
 * A company's site folder is often a git checkout whose CI does real work: SafaStack's daily
 * holdings ingest writes the snapshot that the whole product is built on. When that job fails it
 * fails on GitHub, where nothing here was watching, so a dead pipeline stayed invisible until
 * someone happened to look. On 2026-09-14 that was a full day.
 *
 * This module answers two questions and stops there:
 *   1. Did the newest run of each workflow pass?
 *   2. If not, which step failed and what did it print?
 *
 * It is read-only. Nothing here dispatches a run, edits a workflow, or pushes a commit: a failure
 * becomes a reported issue for the owner to look at, not a repair attempt.
 */
import { setting } from '../settings.ts';
import { clearIssue, reportIssue } from '../health.ts';
import type { Company } from '../db.ts';
import { status as gitStatus } from '../git.ts';

const API = 'https://api.github.com';

/** How many recent runs to consider per repository. */
const RUN_WINDOW = 20;
/** Log lines kept when nothing in the log looks like a diagnostic: just a tail at the marker. */
const LOG_LINES = 40;
/** Hard ceiling on a stored window, however far the diagnostic sits from the error marker. */
const LOG_MAX_LINES = 150;

export interface RepoRef { owner: string; repo: string }

/**
 * Owner and repo from a git remote URL. Accepts the three spellings git hands out:
 *   git@github.com:owner/repo.git · https://github.com/owner/repo.git · ssh://git@github.com/owner/repo
 * Anything not on github.com returns null, because this module can only speak to GitHub.
 */
export function parseRepo(remote: string | null | undefined): RepoRef | null {
  if (!remote) return null;
  const m = remote.trim().match(/^(?:git@github\.com:|(?:ssh:\/\/)?(?:git@)?(?:https?:\/\/)?(?:[^@/]+@)?github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!owner || !repo || repo.includes('/')) return null;
  return { owner, repo };
}

async function github(path: string) {
  const token = setting('github_token');
  if (!token) throw new Error('No GitHub token — create a fine-grained token with Actions: read and add it in Settings');
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'nightshift',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    const hint = res.status === 401 || res.status === 403
      ? 'GitHub rejected the token (expired, revoked, or missing the Actions: read permission?)'
      : res.status === 404
        ? 'GitHub returned 404 — either the repository does not exist or this token cannot see it'
        : `GitHub ${res.status}`;
    throw Object.assign(new Error(`${hint}: ${body.message ?? ''}`.trim()), { status: res.status });
  }
  return res.json() as Promise<any>;
}

export interface WorkflowRun {
  id: number;
  /** The workflow's name, e.g. "Daily holdings ingest". */
  name: string;
  /** GitHub's own run counter, the "#8" a human reads in the UI. */
  number: number;
  /** queued · in_progress · completed */
  status: string;
  /** success · failure · cancelled · null while it is still running. */
  conclusion: string | null;
  event: string;
  createdAt: string;
  url: string;
  sha: string;
}

const toRun = (r: any): WorkflowRun => ({
  id: r.id,
  name: r.name ?? '',
  number: r.run_number ?? 0,
  status: r.status ?? '',
  conclusion: r.conclusion ?? null,
  event: r.event ?? '',
  createdAt: r.created_at ?? '',
  url: r.html_url ?? '',
  sha: (r.head_sha ?? '').slice(0, 7),
});

/** The newest run of each distinct workflow, newest first. One row per workflow, not per run. */
export async function latestRunPerWorkflow(ref: RepoRef): Promise<WorkflowRun[]> {
  const data = await github(`/repos/${ref.owner}/${ref.repo}/actions/runs?per_page=${RUN_WINDOW}`);
  const runs = ((data.workflow_runs ?? []) as any[]).map(toRun);
  const newest = new Map<string, WorkflowRun>();
  // The list arrives newest first, so the first sighting of a workflow name is its newest run.
  for (const r of runs) if (!newest.has(r.name)) newest.set(r.name, r);
  return [...newest.values()];
}

export interface FailureDetail {
  run: WorkflowRun;
  /** The job that failed, and the first step inside it that did. */
  job: string;
  step: string;
  /** Step number as GitHub counts them, so "4 of 12" reads the same in both places. */
  stepNumber: number;
  stepCount: number;
  /** The part of that job's log worth reading: from the diagnostic to the error marker. */
  log: string[];
  /** The single most useful line in it, already picked. */
  line: string;
}

/**
 * What actually broke. GitHub reports a run as failed without saying where, so this walks the
 * run's jobs to the first step that failed and pulls the end of the log, which is where a build
 * error prints. Returns null when nothing in the run is marked failed.
 */
export async function failureDetail(ref: RepoRef, run: WorkflowRun): Promise<FailureDetail | null> {
  const data = await github(`/repos/${ref.owner}/${ref.repo}/actions/runs/${run.id}/jobs`);
  for (const job of (data.jobs ?? []) as any[]) {
    const steps = (job.steps ?? []) as any[];
    const failed = steps.find((s) => s.conclusion === 'failure');
    if (!failed) continue;
    return {
      run,
      job: job.name ?? '',
      step: failed.name ?? '',
      stepNumber: failed.number ?? 0,
      stepCount: steps.length,
      ...(await jobWindow(ref, job.id).catch(() => ({ log: [], line: '' }))),
    };
  }
  return null;
}

/**
 * The last lines of one job's log. GitHub serves this as plain text behind a redirect that fetch
 * follows on its own. Timestamps are stripped: every line is prefixed with an ISO date that tells
 * a reader nothing they cannot get from the run itself, and costs a third of the width.
 */
async function jobWindow(ref: RepoRef, jobId: number): Promise<LogWindow> {
  const token = setting('github_token');
  const res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}/actions/jobs/${jobId}/logs`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'nightshift' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { log: [], line: '' };
  return failureWindow(await res.text());
}

/** Every line, timestamp stripped and blanks dropped. Exported for its test. */
export function cleanLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').trimEnd())
    .filter((l) => l.trim() !== '');
}

/**
 * Lines that say something, ranked by how much. A test runner prints "not ok 2 - <what failed>",
 * then every remaining pass, then a summary ending "# fail 1". Position is therefore a bad guide:
 * the count is nearest the end and the name is furthest from it. Tiers are tried in order, and the
 * last match inside the first tier that hits wins.
 */
const DIAGNOSTIC_TIERS = [
  /^not ok \d+\s*-\s*\S/,                                    // TAP: names the failing test
  /^(?:[A-Za-z]+Error|AssertionError)\b|^error:|^npm ERR!/,  // a thrown error
  /^\s*Expected\b|^\s*actual:|^\s*expected:/,                // an assertion's diff
  /^FAIL\b|^# fail [1-9]/,                                   // last resort: a count, with no name
];

function diagnosticIndex(lines: string[]): number {
  for (const tier of DIAGNOSTIC_TIERS) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]!.startsWith('##[') && tier.test(lines[i]!.trim())) return i;
    }
  }
  return -1;
}

export interface LogWindow {
  /** The lines worth showing on the card. */
  log: string[];
  /** The single most useful line, for the one-line health message. */
  line: string;
}

/**
 * The part of a job log worth keeping: from what broke to where it stopped.
 *
 * Neither end of the file is right on its own. A job log ends with the runner tearing itself
 * down — unsetting git config, cleaning up orphan processes, deprecation warnings — so a plain tail
 * reports "Cleaning up orphan processes" as the error. But anchoring only on GitHub's `##[error]`
 * marker is not enough either: in the run this was written against, the marker sat at line 400 and
 * the assertion that explains it at line 301, so no reasonable tail reaches back that far.
 *
 * So the window runs from just above the best diagnostic line through the error marker, capped, and
 * falls back to a tail at the marker when nothing in the log looks like a diagnostic at all.
 */
export function failureWindow(text: string, cap = LOG_LINES): LogWindow {
  const lines = cleanLines(text);
  const errIdx = lines.findLastIndex((l) => l.startsWith('##[error]'));
  const end = errIdx === -1 ? lines.length : errIdx + 1;
  const dIdx = diagnosticIndex(lines.slice(0, end));
  const start = dIdx === -1 ? end - cap : dIdx - 3;
  const log = lines.slice(Math.max(0, start, end - LOG_MAX_LINES), end);
  if (dIdx !== -1) return { log, line: lines[dIdx]!.trim() };
  const marker = errIdx === -1 ? '' : lines[errIdx]!.replace(/^##\[error\]/, '').trim();
  // "Process completed with exit code 1" is the runner restating the obvious; say nothing instead.
  return { log, line: /^Process completed with exit code \d+\.?$/.test(marker) ? '' : marker };
}

/** One line an owner can read without opening GitHub. */
export function describeFailure(d: FailureDetail): string {
  const where = d.stepCount ? `step ${d.stepNumber} of ${d.stepCount}` : `step ${d.stepNumber}`;
  const line = d.line;
  return `${d.run.name} #${d.run.number} failed at ${where}, "${d.step}"${line ? `: ${line.slice(0, 200)}` : ''}`;
}

export interface RepoReport {
  ref: RepoRef;
  runs: WorkflowRun[];
  failures: FailureDetail[];
}

/**
 * Check one company's repository. Reports a failed newest run to the health system and clears the
 * issue once the newest run of every workflow is green again, which is the same contract every
 * other integration here follows.
 */
export async function checkCompanyWorkflows(c: Company): Promise<RepoReport | null> {
  const ref = parseRepo((await gitStatus(c.slug).catch(() => null))?.remote);
  if (!ref) return null;
  try {
    const runs = await latestRunPerWorkflow(ref);
    // A run still in flight says nothing either way: judge only the ones that finished.
    const failed = runs.filter((r) => r.status === 'completed' && r.conclusion === 'failure');
    const failures: FailureDetail[] = [];
    for (const r of failed) {
      const d = await failureDetail(ref, r);
      if (d) failures.push(d);
    }
    if (failures.length) reportIssue('github', new Error(failures.map(describeFailure).join(' · ')), c);
    else clearIssue('github', c);
    return { ref, runs, failures };
  } catch (e) {
    reportIssue('github', e, c);
    throw e;
  }
}

export async function testGithub() {
  const data = await github('/user');
  return { user: data.login ?? 'ok' };
}
