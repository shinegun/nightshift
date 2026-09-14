import { setting } from './settings.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Current day (YYYY-MM-DD) and hour in the configured timezone. */
export function localNow(date = new Date()) {
  let tz = setting('timezone');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = 'UTC'; }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), tz };
}

export function slugify(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company';
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

/** Parse a JSON object out of a model reply, tolerating code fences or leading prose. */
export function extractJSON<T = any>(text: string): T | null {
  const attempts = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const a of attempts) {
    try { return JSON.parse(a) as T; } catch { /* next */ }
  }
  return null;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Removes tool-call markup a model emitted as prose instead of as a tool call.
 *
 * DeepSeek writes calls in its own markup, and when a model wants a tool it cannot have — the
 * agent loop withholds them on its final step — it sometimes writes that markup into the reply.
 * The owner should never see it. Agents are told about the last step (see runner.ts and
 * agents/chat.ts) so this is the net under that, not the fix for it.
 *
 * U+FF5C is the fullwidth vertical line the markers are built from.
 */
export function stripToolMarkup(text: string): string {
  return text
    // A complete block, opener through closer.
    .replace(/<\uFF5C[^>]*\bcalls>[\s\S]*?<\/\uFF5C[^>]*\bcalls>/g, '')
    // One that ran out of output before its closer.
    .replace(/<\uFF5C[^>]*\bcalls>[\s\S]*$/g, '')
    // Any stray opener or closer left behind.
    .replace(/<\/?\uFF5C[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
