import { now, run, type Company } from '../db.ts';
import { setting } from '../settings.ts';
import { filesForDeploy, listFiles } from '../sites.ts';
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

/** Upload the site folder as a production deployment and wait until it's live. */
export async function deploySite(c: Company): Promise<{ url: string; deploymentId: string }> {
  try {
    const r = await deployOnce(c);
    clearIssue('vercel');
    return r;
  } catch (e) {
    if (isAccountProblem(e)) reportIssue('vercel', e);
    throw e;
  }
}

async function deployOnce(c: Company): Promise<{ url: string; deploymentId: string }> {
  if (!listFiles(c.slug).length) throw new Error('The site has no files yet');
  const name = projectNameFor(c);
  const files = filesForDeploy(c.slug, setting('public_base_url'));
  const dep = await vercel('POST', '/v13/deployments', {
    name,
    files,
    target: 'production',
    projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
  });

  let state = dep.readyState as string;
  let info = dep;
  for (let i = 0; i < 40 && !['READY', 'ERROR', 'CANCELED'].includes(state); i++) {
    await sleep(3000);
    info = await vercel('GET', `/v13/deployments/${dep.id}`);
    state = info.readyState;
  }
  if (state !== 'READY') throw new Error(`Deployment ${dep.id} ended in state ${state}`);

  // First deploy of a new project: make sure the production URL is public.
  if (!c.vercel_project) {
    await vercel('PATCH', `/v9/projects/${encodeURIComponent(name)}`, { ssoProtection: null }).catch(() => {});
  }

  const alias: string | undefined = (info.alias ?? []).find((a: string) => a.endsWith('.vercel.app') && !a.includes(dep.id)) ?? info.alias?.[0];
  const url = `https://${alias ?? info.url}`;
  run('UPDATE companies SET site_url = ?, vercel_project = ?, updated_at = ? WHERE id = ?', url, name, now(), c.id);
  return { url, deploymentId: dep.id };
}

export async function testVercel() {
  const data = await vercel('GET', '/v2/user');
  return { user: data.user?.username ?? data.user?.email ?? 'ok' };
}
