import { setting } from '../settings.ts';
import { decodeEntities, htmlToText, truncate } from '../util.ts';
import { clearIssue, reportIssue } from '../health.ts';

export interface SearchResult { title: string; url: string; snippet: string }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).trim();

async function tavily(query: string, n: number): Promise<SearchResult[]> {
  const key = setting('tavily_api_key');
  if (!key) throw new Error('Tavily selected but no Tavily API key set');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: n, search_depth: 'basic' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  return (data.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
}

async function brave(query: string, n: number): Promise<SearchResult[]> {
  const key = setting('brave_api_key');
  if (!key) throw new Error('Brave selected but no Brave Search API key set');
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Brave ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  return (data.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: strip(r.description ?? '') }));
}

async function duckduckgo(query: string, n: number): Promise<SearchResult[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ q: query }),
    signal: AbortSignal.timeout(30_000),
  });
  const html = await res.text();
  const results: SearchResult[] = [];
  for (const block of html.split('class="result__body"').slice(1)) {
    const a = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    try { url = new URL(url, 'https://duckduckgo.com').searchParams.get('uddg') ?? url; } catch { /* keep raw */ }
    if (url.includes('duckduckgo.com/y.js')) continue; // ad
    const snip = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title: strip(a[2]), url, snippet: snip ? strip(snip[1]) : '' });
    if (results.length >= n) break;
  }
  if (!results.length && (res.status !== 200 || /anomaly|captcha|challenge/i.test(html))) {
    throw new Error(`DuckDuckGo blocked the search (HTTP ${res.status}) — add a free Tavily or Brave key in Settings → Web research`);
  }
  return results;
}

export async function webSearch(query: string, n = 6): Promise<SearchResult[]> {
  const provider = setting('search_provider');
  try {
    const results = provider === 'tavily' ? await tavily(query, n) : provider === 'brave' ? await brave(query, n) : await duckduckgo(query, n);
    clearIssue('search');
    return results;
  } catch (e) {
    reportIssue('search', e);
    throw e;
  }
}

/** Agents read arbitrary web pages; keep them away from this machine and the local network. */
function isPrivateHost(hostname: string) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '::1' || h === '0.0.0.0'
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h);
}

export async function fetchUrl(url: string, maxChars = 12_000): Promise<string> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be fetched');
  if (isPrivateHost(u.hostname)) throw new Error('Refusing to fetch a local/private address');
  const res = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(25_000) });
  const type = res.headers.get('content-type') ?? '';
  if (!/text|json|xml/.test(type)) return `[${res.status}] Non-text content (${type || 'unknown type'}) — not shown.`;
  const body = await res.text();
  const text = /html/.test(type) ? htmlToText(body) : body;
  return truncate(`[${res.status}] ${res.url}\n\n${text}`, maxChars);
}
