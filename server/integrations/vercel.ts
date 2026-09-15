import { now, run, type Company } from '../db.ts';
import { setting } from '../settings.ts';
import { filesForDeploy } from '../sites.ts';
import { publishPlan, summarize, type PublishPlan } from '../publish.ts';
import { sleep } from '../util.ts';
import { clearIssue, isAccountProblem, reportIssue } from '../health.ts';

const API = 'https://api.vercel.com';

async function vercel(method: string, path: string, body?: unknown) {
  const token = setting('vercel_token');
  if (!token) throw new Error('No Vercel token — create one at vercel.com/account/tokens and add it in Settings');
  const team = setting('vercel_team_id');
  const url = `${API}${path}${team ? `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(team)}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? 'Vercel rejected the token (expired, revoked, or wrong team?)' : `Vercel ${res.status}`;
    throw Object.assign(new Error(`${hint}: ${data.error?.message ?? JSON.stringify(data).slice(0, 300)}`), { status: res.status });
  }
  return data;
}

export const projectNameFor = (c: Company) => c.vercel_project || `${c.slug}-site`.slice(0, 90);

// States a deployment never moves on from. BLOCKED belongs here and was missing: Vercel can
// refuse a deployment outright, and a refusal that isn't recognised as final costs the whole
// poll budget (40 x 3s) before the wait gives up and reports it anyway.
export const TERMINAL_STATES = ['READY', 'ERROR', 'CANCELED', 'BLOCKED'];
/** v13 calls it readyState; some deployment payloads carry it as state. */
const stateOf = (d: { readyState?: string; state?: string }) => (d.readyState ?? d.state ?? '') as string;

/** What the owner can actually do about a deployment that never reached READY. */
export function deployProblem(state: string, id: string, waitedSeconds: number) {
  if (!TERMINAL_STATES.includes(state)) {
    return `Vercel was still on "${state}" for deployment ${id} after ${waitedSeconds}s, so we stopped waiting. The deploy may still finish on its own — check the Vercel dashboard before deploying again.`;
  }
  if (state === 'BLOCKED') {
    return `Vercel blocked deployment ${id} before it built, so the site was not updated. Vercel blocks a deployment when the account is over a limit, or when the commit's Git author is not a member of the Vercel account — a Hobby account has exactly one member, so anything deployed under a bot's or a second person's identity is blocked by design. Open the deployment in the Vercel dashboard for the reason it gives.`;
  }
  if (state === 'ERROR') {
    return `Vercel deployment ${id} failed on Vercel's side, so the site was not updated. The build log in the Vercel dashboard has the reason.`;
  }
  if (state === 'CANCELED') {
    return `Vercel deployment ${id} was canceled before it finished, so the site was not updated. A newer deployment of the same project supersedes an older one, so this is expected when two deploys overlap.`;
  }
  return `Deployment ${id} ended in state ${state}, so the site was not updated.`;
}

export interface DeployResult {
  url: string;
  deploymentId: string;
  /** Files uploaded. */
  published: number;
  /** Files in the folder deliberately left out (tooling, internal notes, sample data). */
  skipped: number;
  bytes: number;
  /** The full plan, so the caller can tell the owner what happened and why. */
  plan: PublishPlan;
}

/** Publish this company's website: only the files the site actually reaches, tracker injected. */
export async function deploySite(c: Company, opts: { force?: boolean } = {}): Promise<DeployResult> {
  try {
    const r = await deployOnce(c, Boolean(opts.force));
    clearIssue('vercel');
    return r;
  } catch (e) {
    // A deployment Vercel accepts and then refuses is not an account problem: it carries no HTTP
    // status, so isAccountProblem said no and the failure was recorded nowhere. The deploy failed,
    // the owner was told only if they happened to be watching the request, and the health banner
    // stayed green. This module's rule is that nothing fails silently, so a state Vercel itself
    // ended on is reported the same as a rejected token.
    if (isAccountProblem(e) || (e as { vercelState?: string })?.vercelState) reportIssue('vercel', e);
    throw e;
  }
}

async function deployOnce(c: Company, force: boolean): Promise<DeployResult> {
  const plan = publishPlan(c);
  if (plan.blocked.length && !force) {
    throw new Error(
      `Refusing to publish: ${plan.blocked.join('; ')}. A static host serves whatever it is given, so take the value out of the site files and deploy again.`,
    );
  }
  if (!plan.files.length) {
    throw new Error(plan.skipped.length ? 'Nothing to publish: no HTML pages in the site folder' : 'The site has no files yet');
  }
  const name = projectNameFor(c);
  const files = filesForDeploy(c.slug, setting('public_base_url'), plan.files.map((f) => f.path));
  const dep = await vercel('POST', '/v13/deployments', {
    name,
    files,
    target: 'production',
    projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
  });

  let state = stateOf(dep);
  let info = dep;
  let waited = 0;
  for (let i = 0; i < 40 && !TERMINAL_STATES.includes(state); i++) {
    await sleep(3000);
    waited += 3;
    info = await vercel('GET', `/v13/deployments/${dep.id}`);
    state = stateOf(info);
  }
  // The state travels on the error so deploySite can tell "Vercel refused this" apart from
  // "the request never got there", and report the first to the owner instead of dropping it.
  if (state !== 'READY') throw Object.assign(new Error(deployProblem(state, dep.id, waited)), { vercelState: state });

  // First deploy of a new project: make sure the production URL is public.
  if (!c.vercel_project) {
    await vercel('PATCH', `/v9/projects/${encodeURIComponent(name)}`, { ssoProtection: null }).catch(() => {});
  }

  const alias: string | undefined = (info.alias ?? []).find((a: string) => a.endsWith('.vercel.app') && !a.includes(dep.id)) ?? info.alias?.[0];
  const url = `https://${alias ?? info.url}`;
  run('UPDATE companies SET site_url = ?, vercel_project = ?, updated_at = ? WHERE id = ?', url, name, now(), c.id);
  console.log(`[deploy] ${c.slug}: ${summarize(plan)} -> ${url}`);
  return { url, deploymentId: dep.id, published: plan.files.length, skipped: plan.skipped.length, bytes: plan.bytes, plan };
}

export async function testVercel() {
  const data = await vercel('GET', '/v2/user');
  return { user: data.user?.username ?? data.user?.email ?? 'ok' };
}
