import { all, now, run, type Company } from './db.ts';
import { companyConfig, companySetting, setting } from './settings.ts';
import { emit } from './events.ts';
import { X_WHERE_TO_GET, missingForPosting, xCredentialState } from './integrations/x.ts';
import { companyAddress, imapHost } from './integrations/email.ts';
import { errMsg } from './util.ts';

// The one place that knows whether each integration can be used — and if not, exactly why.
// Static checks catch missing or malformed settings; runtime failures (rejected key,
// provider down, permission denied) are reported here by whatever code hit them and
// cleared by the next success. Nothing is allowed to fail silently.

export type IntegrationKey = 'ai' | 'search' | 'email' | 'inbox' | 'vercel' | 'publicUrl' | 'stripe' | 'x' | 'meta';
/** ready = usable · off = not set up / misconfigured · error = set up, but the last real attempt failed */
export interface Health { state: 'ready' | 'off' | 'error'; message: string; at?: string }

export const INTEGRATIONS: IntegrationKey[] = ['ai', 'search', 'email', 'inbox', 'vercel', 'publicUrl', 'stripe', 'x', 'meta'];
export const HEALTH_LABEL: Record<IntegrationKey, string> = {
  ai: 'AI', search: 'Web search', email: 'Email sending', inbox: 'Inbox', vercel: 'Vercel deploy',
  publicUrl: 'Visitor tracking', stripe: 'Stripe', x: 'X', meta: 'Meta Ads',
};

/** Which settings belong to which integration — scopes company overrides and clears stale errors after edits. */
const OWNED_BY: [RegExp, IntegrationKey[]][] = [
  [/^(llm_|price_)/, ['ai']],
  [/^(search_provider|tavily_|brave_)/, ['search']],
  [/^(email_|resend_|smtp_|owner_email)/, ['email']],
  [/^(email_from|imap_)/, ['inbox']],
  [/^vercel_/, ['vercel']],
  [/^public_base_url$/, ['publicUrl']],
  [/^stripe_/, ['stripe']],
  [/^x_/, ['x']],
  [/^(meta_|ads_)/, ['meta']],
];
const owners = (settingKey: string) => OWNED_BY.filter(([re]) => re.test(settingKey)).flatMap(([, k]) => k);

type CompanyRef = Pick<Company, 'id' | 'config'>;

/** Company-scoped when that company uses its own account for the integration. */
function scope(key: IntegrationKey, c?: CompanyRef) {
  if (c && Object.keys(companyConfig(c)).some((k) => owners(k).includes(key))) return `${key}@${c.id}`;
  return key;
}

/** Auth, permission and network failures say something about the account; a bad request usually doesn't. */
export function isAccountProblem(e: unknown) {
  const status = (e as { status?: number } | null)?.status;
  const name = (e as Error | null)?.name;
  return status === 401 || status === 403 || e instanceof TypeError || name === 'TimeoutError' || name === 'AbortError';
}

export function reportIssue(key: IntegrationKey, err: unknown, c?: CompanyRef) {
  if (staticProblem(key, c)) return; // the settings check already explains it
  run(
    'INSERT INTO issues (key, message, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET message = excluded.message, at = excluded.at',
    scope(key, c), errMsg(err).slice(0, 600), now(),
  );
  emit('health', c?.id);
}

export function clearIssue(key: IntegrationKey, c?: CompanyRef) {
  if (run('DELETE FROM issues WHERE key = ?', scope(key, c)).changes) emit('health', c?.id);
}

/** Edited settings may have fixed the last failure; the next real attempt re-reports if not. */
export function clearIssuesForSettings(settingKeys: string[], c?: Pick<Company, 'id'>) {
  const affected = new Set(settingKeys.flatMap(owners));
  for (const k of affected) {
    if (c) run('DELETE FROM issues WHERE key = ?', `${k}@${c.id}`);
    else run('DELETE FROM issues WHERE key = ? OR key LIKE ?', k, `${k}@%`);
  }
  if (affected.size) emit('health', c?.id);
}

const missing = (fields: [string, string][]) => fields.filter(([, v]) => !v).map(([label]) => label);

/** A specific, fixable reason the integration can't be used — or null when its settings look right. */
function staticProblem(key: IntegrationKey, c?: Pick<Company, 'config'>): string | null {
  const s = (k: string) => (c ? companySetting(c, k) : setting(k)).trim();
  switch (key) {
    case 'ai':
      if (!s('llm_api_key')) return 'No API key — paste your DeepSeek key in Settings → AI backend.';
      if (!/^https?:\/\/\S+$/.test(s('llm_base_url'))) return `Base URL "${s('llm_base_url')}" isn't a valid http(s) URL.`;
      if (!s('llm_model')) return 'No model chosen — press "Load models" and pick one.';
      return null;
    case 'search':
      if (s('search_provider') === 'tavily' && !s('tavily_api_key')) return 'Tavily is selected but no Tavily API key is saved.';
      if (s('search_provider') === 'brave' && !s('brave_api_key')) return 'Brave is selected but no Brave Search API key is saved.';
      return null;
    case 'email': {
      const provider = s('email_provider');
      const from = s('email_from');
      if (provider === 'none') return 'Sending is off — pick Resend or SMTP in Settings → Email.';
      if (!from) return 'No "Send from" address.';
      const addr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim();
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(addr)) return `"Send from" (${from}) isn't a valid email address.`;
      if (provider === 'resend' && !s('resend_api_key')) return 'Resend is selected but no Resend API key is saved.';
      if (provider === 'smtp') {
        const m = missing([['SMTP host', s('smtp_host')], ['SMTP username', s('smtp_user')], ['SMTP password', s('smtp_pass')]]);
        if (m.length) return `SMTP is selected but missing: ${m.join(', ')}.`;
      }
      return null;
    }
    case 'inbox': {
      const m = missing([['IMAP username', s('imap_user')], ['IMAP password', s('imap_pass')]]);
      if (m.length === 2) return 'Not set up — add an IMAP username and app password to receive replies.';
      if (m.length) return `Missing: ${m.join(', ')}.`;
      if (!imapHost()) return `IMAP host is empty and can't be guessed from "${s('imap_user').split('@')[1] ?? ''}" — enter your provider's IMAP server.`;
      if (!s('email_from')) return 'Company addresses are built from "Send from", which is empty — incoming mail can\'t be matched to a company.';
      const clash = all<{ email: string; names: string; n: number }>(
        `SELECT LOWER(TRIM(email)) AS email, GROUP_CONCAT(name, ' and ') AS names, COUNT(*) AS n
         FROM companies WHERE TRIM(email) <> '' GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1`,
      )[0];
      if (clash) return `${clash.names} share the address ${clash.email}, so a reply to it can only be filed to one of them. Give each company its own address (or the +slug form).`;
      return null;
    }
    case 'vercel':
      return s('vercel_token') ? null : 'No Vercel token — create one at vercel.com/account/tokens.';
    case 'publicUrl': {
      const url = s('public_base_url');
      if (!url) return "Public URL is empty — sites deployed to Vercel can't report visits or waitlist signups.";
      if (!/^https:\/\/\S+$/.test(url)) return `"${url}" should be an https:// URL that's reachable from the internet.`;
      return null;
    }
    case 'stripe': {
      const k = s('stripe_secret_key');
      if (!k) return 'No Stripe secret key.';
      if (!/^(sk|rk)_(test|live)_/.test(k)) return "That doesn't look like a Stripe secret key — it should start with sk_ or rk_ (publishable pk_ keys can't create payment links).";
      return null;
    }
    case 'x': {
      const missing = missingForPosting(c);
      const own = all<{ slug: string }>("SELECT slug FROM companies WHERE config LIKE '%x_access_token%'");
      const bearerNote = xCredentialState(c).bearer
        ? 'A bearer token is saved, but it is app-only and cannot post. '
        : '';
      if (c) {
        if (!missing.length) return null;
        // A company with no account of its own and no default to fall back on cannot post.
        return missing.length === 4
          ? `${bearerNote}This company has no X account of its own and no default one is set, so it cannot post. Connect its X account (Company → X) — the four values are the consumer key and secret, plus that account's own access token and secret.`
          : `Missing: ${missing.join(', ')}. ${X_WHERE_TO_GET}`;
      }
      // Global scope: these four values are the fallback identity for a company that has none
      // of its own. When a company already posts as its own account, nothing is missing here.
      if (!missing.length || own.length) return null;
      return missing.length === 4
        ? `${bearerNote}Not connected — no company has an X account yet, so nothing can post. Add the four values here as a default, or connect an X account to a company (Company → X). ${X_WHERE_TO_GET}`
        : `Missing: ${missing.join(', ')}. ${X_WHERE_TO_GET}`;
    }
    case 'meta': {
      const m = missing([['access token', s('meta_access_token')], ['ad account ID', s('meta_ad_account_id')], ['Page ID', s('meta_page_id')]]);
      if (m.length === 3) return 'Not connected — add an access token, ad account ID and Page ID.';
      if (m.length) return `Missing: ${m.join(', ')}.`;
      if (!/^(act_)?\d+$/.test(s('meta_ad_account_id'))) return 'Ad account ID should be a number (optionally starting with act_).';
      return null;
    }
  }
}

/** Health of every integration, as seen by one company (its overrides) or globally. */
export function integrationHealth(c?: Company): Record<IntegrationKey, Health> {
  const issues = new Map(all<{ key: string; message: string; at: string }>('SELECT * FROM issues').map((r) => [r.key, r]));
  const out = {} as Record<IntegrationKey, Health>;
  for (const k of INTEGRATIONS) {
    const problem = staticProblem(k, c);
    const issue = (c && issues.get(`${k}@${c.id}`)) || issues.get(k);
    // The shared X values are only the fallback identity for a company that has none of its
    // own. With every company posting as its own account they can stay empty, so report 'off'
    // with no warning — neither a fault nor a claim that the empty fallback is ready.
    const emptyFallback = !c && k === 'x' && !problem && missingForPosting(undefined).length > 0;
    out[k] = emptyFallback ? { state: 'off', message: '' }
      : problem ? { state: 'off', message: problem }
      : issue ? { state: 'error', message: issue.message, at: issue.at }
      : { state: 'ready', message: '' };
  }
  return out;
}

const UNROUTED = 'unrouted-mail';

/** Mail that reached the inbox for our domain but matches no company. Kept until dismissed or a company is created. */
export function noteUnroutedMail(list: { to: string; from: string; subject: string }[]) {
  if (!list.length) return;
  const latest = list[list.length - 1];
  const slugs = all<{ slug: string }>('SELECT slug FROM companies ORDER BY id').map((r) => r.slug);
  const example = companyAddress(slugs[0] ?? 'your-company');
  const n = list.length;
  const message = `${n} email${n > 1 ? 's' : ''} to ${latest.to} (latest from ${latest.from}: "${latest.subject}") didn't match any company, so ${n > 1 ? 'they weren\'t' : 'it wasn\'t'} filed. `
    + (slugs.length ? `Company addresses look like ${example}.` : `You don't have a company yet — create one and its address will look like ${example}.`);
  run('INSERT INTO issues (key, message, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET message = excluded.message, at = excluded.at', UNROUTED, message, now());
  emit('health');
}

export function dismissIssue(key: string) {
  if (run('DELETE FROM issues WHERE key = ?', key).changes) emit('health');
}

/** Recorded runtime failures, newest first — shown in the global banner. */
export function openIssues() {
  const names = new Map(all<{ id: number; name: string }>('SELECT id, name FROM companies').map((r) => [r.id, r.name]));
  return all<{ key: string; message: string; at: string }>('SELECT * FROM issues ORDER BY at DESC').map((r) => {
    const [key, companyId] = r.key.split('@') as [IntegrationKey, string | undefined];
    const label = r.key === UNROUTED ? 'Inbox' : HEALTH_LABEL[key] ?? key;
    return { key: r.key, label: companyId ? `${label} (${names.get(Number(companyId)) ?? 'company'})` : label, message: r.message, at: r.at };
  });
}
