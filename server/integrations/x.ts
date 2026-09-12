import crypto from 'node:crypto';
import type { Company } from '../db.ts';
import { companySetting } from '../settings.ts';

// X API v2 with OAuth 1.0a user context (API key/secret + access token/secret
// from the X developer portal, app permissions set to "Read and write").

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function creds(c: Company) {
  const k = {
    consumerKey: companySetting(c, 'x_api_key'),
    consumerSecret: companySetting(c, 'x_api_secret'),
    token: companySetting(c, 'x_access_token'),
    tokenSecret: companySetting(c, 'x_access_secret'),
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

export async function testX(c: Company) {
  const data = await x(c, 'GET', 'https://api.x.com/2/users/me');
  return { username: data.data?.username };
}
