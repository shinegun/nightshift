import crypto from 'node:crypto';
import type { Company } from '../db.ts';
import { companySetting, setting } from '../settings.ts';

// X API v2 with OAuth 1.0a user context: consumer key + secret (the portal's "API Key"
// and "API Key Secret") plus the account owner's access token + secret, from the X
// developer portal, with the app's permissions set to "Read and write".

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const OAUTH_ROOT = 'https://api.x.com/oauth';

function creds(c?: ConfigOnly) {
  const v = (k: string) => (c ? companySetting(c, k) : setting(k)).trim();
  const k = {
    consumerKey: v('x_api_key'),
    consumerSecret: v('x_api_secret'),
    token: v('x_access_token'),
    tokenSecret: v('x_access_secret'),
  };
  if (!k.consumerKey || !k.consumerSecret || !k.token || !k.tokenSecret) {
    throw new Error('X is not connected — add the 4 X API keys in Settings (or on this company)');
  }
  return k;
}

function authHeader(method: string, url: string, k: ReturnType<typeof creds>) {
  const oauth: Record<string, string> = {
    oauth_consumer_key: k.consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: k.token,
    oauth_version: '1.0',
  };
  const u = new URL(url);
  const params: [string, string][] = [...Object.entries(oauth), ...u.searchParams.entries()];
  const paramStr = params.map(([a, b]) => [enc(a), enc(b)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([a, b]) => `${a}=${b}`).join('&');
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(paramStr)].join('&');
  const signature = crypto.createHmac('sha1', `${enc(k.consumerSecret)}&${enc(k.tokenSecret)}`).update(base).digest('base64');
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature }).map(([a, b]) => `${enc(a)}="${enc(b)}"`).join(', ')}`;
}

async function x(c: Company, method: 'GET' | 'POST', url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { authorization: authHeader(method, url, creds(c)), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`X ${res.status}: ${data.detail ?? data.title ?? JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export async function postTweet(c: Company, text: string): Promise<{ id: string }> {
  if (text.length > 280) throw new Error(`Tweet is ${text.length} characters (max 280)`);
  const data = await x(c, 'POST', 'https://api.x.com/2/tweets', { text });
  return { id: String(data.data?.id) };
}

// ── Credentials: what posting needs, and what the bearer token is for ───────
//
// Posting (POST /2/tweets) requires the four OAuth 1.0a values, acting as the account
// owner. The bearer token X hands out alongside an app is app-only: it can read public
// data, but it can never post as a user. So it is kept and checked separately, and it
// never counts as "connected".

type ConfigOnly = Pick<Company, 'config'>;

/** Which of the five X values are saved. With no company, the global settings are used. */
export function xCredentialState(c?: ConfigOnly) {
  const v = (k: string) => (c ? companySetting(c, k) : setting(k)).trim();
  return {
    apiKey: Boolean(v('x_api_key')),
    apiSecret: Boolean(v('x_api_secret')),
    accessToken: Boolean(v('x_access_token')),
    accessSecret: Boolean(v('x_access_secret')),
    bearer: Boolean(v('x_bearer_token')),
  };
}

/** Labels of what posting still needs. Empty = ready to post. */
export function missingForPosting(c?: ConfigOnly): string[] {
  const s = xCredentialState(c);
  return [
    !s.apiKey && 'consumer key',
    !s.apiSecret && 'consumer secret',
    !s.accessToken && 'access token',
    !s.accessSecret && 'access token secret',
  ].filter(Boolean) as string[];
}

export const X_WHERE_TO_GET =
  'X portal → your app → Keys and tokens. The key and secret are under "Consumer Keys" (the portal also calls them API Key and API Key Secret); the tokens are under "Access Token and Secret". Set App permissions to "Read and write" in User authentication settings first, then generate — a token made while the app was read-only stays read-only.';

/** App-only call: proves a bearer token is live. Read-only by nature — it cannot post. */
async function appOnlyGet(url: string, bearer: string) {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as { data?: { username?: string }; detail?: string; title?: string };
  if (!res.ok) {
    throw Object.assign(new Error(`X ${res.status}: ${data.detail ?? data.title ?? 'request refused'}`), { status: res.status });
  }
  return data;
}

/**
 * PIN-based (out-of-band) 3-legged OAuth, step 1: ask X for a request token.
 * X documents this flow for apps that cannot embed a browser, which is exactly a
 * self-hosted server. The request token is temporary and single-use.
 */
export async function xRequestTokenPin(c?: ConfigOnly): Promise<{ token: string; secret: string; authorizeUrl: string }> {
  const url = `${OAUTH_ROOT}/request_token?oauth_callback=oob`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: authHeader('POST', url, creds(c)), 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`X ${res.status} asking for a request token: ${body.slice(0, 200)}`);
  const p = new URLSearchParams(body);
  const token = p.get('oauth_token') ?? '';
  const secret = p.get('oauth_token_secret') ?? '';
  if (!token || !secret) throw new Error(`X did not return a request token: ${body.slice(0, 200)}`);
  return { token, secret, authorizeUrl: `https://api.x.com/oauth/authorize?oauth_token=${encodeURIComponent(token)}` };
}

/** PIN-based OAuth, step 3: trade the PIN X shows the user for that account's access token. */
export async function xExchangePin(
  c: ConfigOnly | undefined,
  req: { token: string; secret: string },
  pin: string,
): Promise<{ accessToken: string; accessSecret: string; screenName?: string; userId?: string }> {
  const clean = pin.replace(/\D/g, '');
  if (!clean) throw new Error('That does not look like a PIN — X shows a short number to type here.');
  const url = `${OAUTH_ROOT}/access_token?oauth_verifier=${encodeURIComponent(clean)}`;
  const k = creds(c);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: authHeader('POST', url, { ...k, token: req.token, tokenSecret: req.secret }),
      'content-type': 'application/x-www-form-urlencoded',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? `X rejected that PIN (401). PINs are single-use and expire quickly — start again and type the newest one.`
        : `X ${res.status} exchanging the PIN: ${body.slice(0, 200)}`,
    );
  }
  const p = new URLSearchParams(body);
  const accessToken = p.get('oauth_token') ?? '';
  const accessSecret = p.get('oauth_token_secret') ?? '';
  if (!accessToken || !accessSecret) throw new Error(`X did not return an access token: ${body.slice(0, 200)}`);
  return { accessToken, accessSecret, screenName: p.get('screen_name') ?? undefined, userId: p.get('user_id') ?? undefined };
}

/** Turn an X API failure into the thing to actually fix, when we can be sure what it means. */
export function explainXFailure(msg: string): string {
  if (/^X (401|403)\b/.test(msg)) {
    return `${msg}. X refused these keys. Usual cause: the access token was generated while the app was read-only — set App permissions to "Read and write" in User authentication settings, then regenerate the Access Token and Secret.`;
  }
  if (/^X 402\b/.test(msg)) {
    return `${msg}. That is X's plan response rather than a key problem: your API access does not include posting. Check the plan shown on your app's page at developer.x.com.`;
  }
  if (/^X 429\b/.test(msg)) {
    return `${msg}. Rate limit or monthly write cap reached — check the usage page for your app, and space posts out.`;
  }
  return msg;
}

/**
 * Check the saved X credentials and say exactly what still blocks posting.
 * Throws (with the precise reason) while posting isn't possible — the dashboard then keeps
 * the X section marked as not usable instead of showing a false green.
 */
export async function testX(c: Company): Promise<{ username?: string; readyToPost: boolean; message: string }> {
  const missing = missingForPosting(c);
  const bearer = companySetting(c, 'x_bearer_token').trim();

  if (!missing.length) {
    try {
      const data = await x(c, 'GET', 'https://api.x.com/2/users/me');
      const username = data.data?.username as string | undefined;
      return { username, readyToPost: true, message: `Ready to post as @${username ?? 'your account'}.` };
    } catch (e) {
      throw new Error(explainXFailure(e instanceof Error ? e.message : String(e)));
    }
  }

  let bearerNote = '';
  if (bearer) {
    try {
      const probe = await appOnlyGet('https://api.x.com/2/users/by/username/x', bearer);
      // A liveness check only: app-only auth can read a public user and that is the whole of
      // its power. Never print the probed handle — it isn't the user's account, and naming it
      // reads like a claim about who they are.
      bearerNote = probe.data?.username
        ? 'Your bearer token is saved and works for read-only lookups, but a bearer token is app-only: it can never post as you. '
        : 'Your bearer token is saved, but it is app-only: it can never post as you. ';
    } catch (e) {
      bearerNote = `Your bearer token was refused (${e instanceof Error ? e.message : String(e)}) — and even a valid one cannot post as you. `;
    }
  }
  throw new Error(`${bearerNote}Posting still needs: ${missing.join(', ')}. Get them at ${X_WHERE_TO_GET}`);
}
