/**
 * A real browser a bot can look through, and nothing more.
 *
 * `fetch_url` reads a page's HTML; it never runs the page's JavaScript, so a page that builds
 * itself in the browser (the holdings table, a waitlist form wired up by a script) reads as
 * empty. This opens the page in headless Chromium and returns what a visitor would see.
 *
 * Read-only is enforced here, not asked for in the prompt, because a page can contain text aimed
 * at the bot and a prompt can be talked out of a rule:
 *
 *  - There is no click, type or submit. The bot names a URL and gets text back.
 *  - Every request that isn't GET/HEAD is aborted, so even the page's own scripts can't post a
 *    form, sign anyone up or record a visit.
 *  - The top-level page must be this company's preview or its own live site. Pages can still
 *    load public scripts and fonts, but nothing on localhost, the tailnet or a private network —
 *    otherwise a page could reach the dashboard from inside the server.
 *  - Each call gets a new browser context: no cookies, no storage, no saved logins.
 *  - One page at a time, with a hard time limit, because Chromium is the heaviest thing on this box.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import type { Company } from './db.ts';
import { setting } from './settings.ts';
import { truncate } from './util.ts';

const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 4456);
const rawPublicHost = process.env.PUBLIC_HOST ?? process.env.HOST ?? '127.0.0.1';
const PUBLIC_HOST = rawPublicHost === '0.0.0.0' || rawPublicHost === '::' ? '127.0.0.1' : rawPublicHost;
/** The public listener, which serves company sites without the dashboard's sign-in. */
export const PREVIEW_ORIGIN = `http://${net.isIPv6(PUBLIC_HOST) ? `[${PUBLIC_HOST}]` : PUBLIC_HOST}:${PUBLIC_PORT}`;

const NAV_TIMEOUT_MS = 20_000;
const TOTAL_TIMEOUT_MS = 35_000;
const TEXT_MAX = 12_000;
const LIST_MAX = 15;

export class BrowserError extends Error {}

const hostOf = (u: string) => {
  try { return new URL(u).host.toLowerCase(); } catch { return ''; }
};

/**
 * Turns what the bot asked for into a URL it may open: a path means the company's preview, and a
 * full URL must be the company's own live site (or the public copy of its preview).
 */
export function resolvePageUrl(c: Pick<Company, 'slug' | 'site_url'>, input: string): string {
  const raw = input.trim();
  if (!raw) throw new BrowserError('Give a URL or a path such as /pricing.html.');
  const preview = `${PREVIEW_ORIGIN}/s/${c.slug}/`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    const rel = raw.replace(/^\/+/, '').replace(new RegExp(`^s/${c.slug}/?`), '');
    return new URL(rel, preview).toString();
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new BrowserError(`"${raw}" is not a valid URL.`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BrowserError('Only http(s) pages can be opened.');
  const base = setting('public_base_url').replace(/\/+$/, '');
  if (base && hostOf(base) === url.host.toLowerCase() && url.pathname.startsWith(`/s/${c.slug}/`)) {
    return new URL(url.pathname.slice(`/s/${c.slug}/`.length) + url.search, preview).toString();
  }
  if (c.site_url && hostOf(c.site_url) === url.host.toLowerCase()) return url.toString();
  throw new BrowserError(
    `Only this company's own pages can be opened: a path on its preview (like /index.html)${c.site_url ? ` or ${c.site_url}` : ''}. Use fetch_url for other sites.`,
  );
}

/** Addresses a page must never reach from inside the server. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe[89ab])/.test(v);
  }
  return true;
}

const PRIVATE_NAME = /(^|\.)(localhost|local|internal|lan|home|ts\.net)$/i;

async function isPublicHost(hostname: string, cache: Map<string, boolean>): Promise<boolean> {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (cache.has(h)) return cache.get(h)!;
  let ok: boolean;
  if (net.isIP(h)) ok = !isPrivateAddress(h);
  else if (PRIVATE_NAME.test(h) || !h.includes('.')) ok = false;
  else {
    try {
      const addrs = await dns.lookup(h, { all: true });
      ok = addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
    } catch {
      ok = false;
    }
  }
  cache.set(h, ok);
  return ok;
}

// One page at a time. A second call waits for the first instead of starting another Chromium.
let queue: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

export interface PageReport {
  url: string; status: number | null; title: string; ms: number; text: string;
  consoleErrors: string[]; pageErrors: string[]; failed: string[]; blocked: string[];
}

export function openPage(c: Pick<Company, 'slug' | 'site_url'>, input: string, opts: { selector?: string; waitFor?: string } = {}): Promise<PageReport> {
  const target = resolvePageUrl(c, input);
  const siteHost = c.site_url ? hostOf(c.site_url) : '';
  const previewHost = hostOf(PREVIEW_ORIGIN);
  const topLevelOk = (u: string) => {
    const h = hostOf(u);
    return h === previewHost ? new URL(u).pathname.startsWith(`/s/${c.slug}/`) : Boolean(siteHost) && h === siteHost;
  };

  return oneAtATime(async () => {
    const started = Date.now();
    let browser: Browser | undefined;
    const killer = setTimeout(() => void browser?.close().catch(() => {}), TOTAL_TIMEOUT_MS);
    const report: PageReport = { url: target, status: null, title: '', ms: 0, text: '', consoleErrors: [], pageErrors: [], failed: [], blocked: [] };
    const push = (list: string[], s: string) => { if (list.length < LIST_MAX && !list.includes(s)) list.push(s); };
    try {
      try {
        browser = await chromium.launch({ headless: true });
      } catch (e) {
        throw new BrowserError(`The browser isn't installed on this server (${e instanceof Error ? e.message.split('\n')[0] : e}). The owner can run "npx playwright-core install chromium-headless-shell".`);
      }
      const context = await browser.newContext({
        acceptDownloads: false, serviceWorkers: 'block', javaScriptEnabled: true,
        viewport: { width: 1280, height: 900 }, userAgent: 'Mozilla/5.0 (X11; Linux) NightshiftBot/1.0 HeadlessChrome',
      });
      const hosts = new Map<string, boolean>();
      const check = async (url: string, method: string, topLevel: boolean): Promise<string | null> => {
        if (!/^https?:/i.test(url)) return null;
        if (!['GET', 'HEAD'].includes(method)) return `${method} request`;
        if (topLevel && !topLevelOk(url)) return 'leaves the company site';
        const u = new URL(url);
        if (u.host.toLowerCase() === previewHost) {
          // The tracker would count the bot as a visitor.
          if (u.pathname === '/t.js' || u.pathname.startsWith('/public/')) return 'visitor tracking';
          return null;
        }
        return (await isPublicHost(u.hostname, hosts)) ? null : 'private address';
      };
      await context.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        const topLevel = req.isNavigationRequest() && req.frame().parentFrame() === null;
        const block = async (target: string, why: string) => {
          push(report.blocked, `${req.method()} ${truncate(target, 160)} (${why})`);
          await route.abort('blockedbyclient');
        };
        const why = await check(url, req.method(), topLevel);
        if (why) return block(url, why);
        if (!/^https?:/i.test(url)) return route.continue();
        // Fetched here with redirects off, so a redirect's target is checked before the browser
        // is allowed to follow it. Left to the browser, it would be followed without asking.
        let response;
        try {
          response = await route.fetch({ maxRedirects: 0, timeout: NAV_TIMEOUT_MS });
        } catch {
          return route.abort('failed').catch(() => {});
        }
        const location = response.status() >= 300 && response.status() < 400 ? response.headers().location : undefined;
        if (location) {
          const next = new URL(location, url).toString();
          const whyNext = await check(next, 'GET', topLevel);
          if (whyNext) return block(next, `redirect ${whyNext}`);
        }
        await route.fulfill({ response });
      });
      const page = await context.newPage();
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') push(report.consoleErrors, `${m.type()}: ${truncate(m.text(), 300)}`); });
      page.on('pageerror', (e) => push(report.pageErrors, truncate(e.message, 300)));
      page.on('requestfailed', (r) => {
        const err = r.failure()?.errorText ?? 'failed';
        if (!err.includes('BLOCKED_BY_CLIENT')) push(report.failed, `${truncate(r.url(), 160)} (${err})`);
      });
      page.on('response', (r) => { if (r.status() >= 400) push(report.failed, `${truncate(r.url(), 160)} (HTTP ${r.status()})`); });

      const res = await page.goto(target, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }).catch((e: Error) => {
        const blocked = report.blocked.length ? ` Blocked: ${report.blocked.join('; ')}.` : '';
        throw new BrowserError(`Could not open ${target}: ${e.message.split('\n')[0]}.${blocked}`);
      });
      report.status = res?.status() ?? null;
      // Give scripts that build the page after load a moment, without waiting on a page that
      // never goes quiet.
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      if (opts.waitFor) {
        await page.waitForSelector(opts.waitFor, { timeout: 10_000 }).catch(() => {
          push(report.pageErrors, `Nothing matched "${opts.waitFor}" within 10s.`);
        });
      }
      report.url = page.url();
      // Belt and braces: whatever happened on the way, only read a page it was allowed to open.
      if (!topLevelOk(report.url)) throw new BrowserError(`The page moved to ${report.url}, which isn't one of this company's pages, so it wasn't read.`);
      report.title = await page.title();
      const text = opts.selector
        ? await page.locator(opts.selector).first().innerText({ timeout: 5_000 }).catch(() => `(nothing matched "${opts.selector}")`)
        : await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
      report.text = truncate(text.replace(/\n{3,}/g, '\n\n').trim(), TEXT_MAX);
      return report;
    } finally {
      clearTimeout(killer);
      report.ms = Date.now() - started;
      await browser?.close().catch(() => {});
    }
  });
}

/** The tool's answer, as the bot reads it. */
export function describeReport(r: PageReport): string {
  const list = (label: string, items: string[]) => (items.length ? `\n${label} (${items.length}):\n${items.map((x) => `- ${x}`).join('\n')}` : '');
  return `Opened ${r.url} (HTTP ${r.status ?? '?'}) in ${(r.ms / 1000).toFixed(1)}s. Title: ${r.title || '(none)'}`
    + list('JavaScript errors', r.pageErrors)
    + list('Console errors and warnings', r.consoleErrors)
    + list('Failed requests', r.failed)
    + list('Blocked by the read-only browser', r.blocked)
    + `\n\n--- What a visitor sees ---\n${r.text || '(the page shows no text)'}`;
}
