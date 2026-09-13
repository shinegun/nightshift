import fs from 'node:fs';
import path from 'node:path';
import type { Company } from './db.ts';
import { listFiles, safePath } from './sites.ts';
import { companySetting, setting } from './settings.ts';

// ── Publishing: what actually goes to the public website ───────────────────
//
// The site folder is the working copy. Agents keep tooling, notes, sample data and
// fixtures next to the pages, and none of that belongs on a public website. So a
// deploy publishes what the site can actually *reach*, not "every file in the folder":
//
//   entry points  every .html/.htm page in the folder, so a page always ships even
//                 when nothing links to it yet
//   reachable     whatever those pages reference, transitively: href/src/srcset and
//                 poster, markdown links, css url()/@import, and quoted asset paths
//                 in js/json. Nothing else.
//   never         dotfiles (.git, .env, .DS_Store), node_modules, credential-shaped
//                 filenames, files over 2 MB, and JSON marked as fixture/demo/sample
//                 data (that is test data, not the product)
//   blocked       a file that would be published contains something that looks like a
//                 credential. The deploy stops until a human looks, because a static
//                 host serves whatever it is given.
//
// Owner overrides, per company (More → Company settings → overrides):
//   publish_include  globs that force files in, e.g. "data/*.json, assets/**"
//   publish_exclude  globs that keep files out, e.g. "pricing.html"
// The hard rules above still win: publish_include cannot smuggle in a dotfile or a key.

const ENTRY_EXT = new Set(['.html', '.htm']);
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.md', '.json', '.svg', '.xml', '.webmanifest']);
const ASSET_PATH_RE = /['"]([A-Za-z0-9._/-]+\.(?:json|html?|css|js|mjs|csv|txt|svg|png|jpe?g|gif|webp|avif|ico|woff2?|xml|webmanifest))['"]/gi;
const MAX_FILE_BYTES = 2_000_000;
const FIXTURE_STATUS = new Set(['fixture', 'demo', 'sample', 'test']);
const SECRET_RE = /(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{30,}|re_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|EAA[A-Za-z0-9]{30,}|vcp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const SECRET_NAME_RE = /(^|\/)(\.env.*|\.npmrc|\.netrc|.*\.(pem|key|p12|pfx)|credentials.*\.json|id_rsa.*|id_ed25519.*)$/i;

export interface PublishEntry { path: string; size: number; reason: string }

export interface PublishPlan {
  /** Files that will be uploaded and served. */
  files: PublishEntry[];
  /** Files in the folder that will not be served, each with the reason why. */
  skipped: PublishEntry[];
  /** Paths the pages reference that do not exist yet (the page has to cope). */
  missing: string[];
  bytes: number;
  /** Reasons a deploy must not proceed as-is. Empty = safe to publish. */
  blocked: string[];
  /** Non-fatal notes worth showing the owner. */
  warnings: string[];
}

/** Directories that are never part of the published website. */
const NON_SITE_DIRS = new Set(['tools', 'scripts', 'fixtures', 'test', 'tests', '__tests__', 'spec', 'specs', 'migrations']);

/** Never published, whatever links to it or forces it in. */
function alwaysNever(rel: string): string | null {
  const parts = rel.split('/');
  if (parts.some((p) => p.startsWith('.') && p !== '.well-known')) return 'a dotfile (.git, .env, .DS_Store)';
  if (rel.startsWith('node_modules/')) return 'inside node_modules';
  if (SECRET_NAME_RE.test(rel)) return 'a filename that normally holds a credential';
  return null;
}

/** Not part of the website unless the owner forces it in with publish_include. */
function notSiteContent(rel: string): string | null {
  const parts = rel.split('/');
  const tooling = parts.slice(0, -1).find((p) => NON_SITE_DIRS.has(p.toLowerCase()) || p === '.github');
  return tooling ? `inside ${tooling}/ — tooling, not part of the website` : null;
}

/** JSON that declares itself fixture/demo/sample data is not the product. */
function fixtureReason(text: string): string | null {
  try {
    const j = JSON.parse(text) as { data_status?: unknown; status?: unknown; dataset?: unknown };
    const s = typeof j.data_status === 'string' ? j.data_status.toLowerCase() : '';
    if (FIXTURE_STATUS.has(s)) return `data_status: ${s}`;
    return null;
  } catch {
    return null;
  }
}

/** Relative paths a file points at, for the extensions we understand. */
function refsFrom(rel: string, text: string): string[] {
  const ext = path.extname(rel).toLowerCase();
  const out: string[] = [];
  if (ENTRY_EXT.has(ext)) {
    for (const m of text.matchAll(/(?:href|src|poster)\s*=\s*["']([^"']+)["']/gi)) out.push(m[1]);
    for (const m of text.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const part of m[1].split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url) out.push(url);
      }
    }
  } else if (ext === '.md') {
    for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)) out.push(m[1]);
  } else if (ext === '.css') {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) out.push(m[1]);
    for (const m of text.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")]+)['"]?/gi)) out.push(m[1]);
  } else if (ext === '.js' || ext === '.mjs' || ext === '.json') {
    // Best effort: a quoted string that looks like a local asset path. This catches the
    // data files a page fetches without ever linking them, e.g. 'data/holdings/latest.json'.
    for (const m of text.matchAll(ASSET_PATH_RE)) out.push(m[1]);
  }
  return out;
}

/** Turn `../data/x.json#a` seen from `docs/page.md` into `data/x.json`, or null. */
function resolveRef(fromRel: string, ref: string): string | null {
  const raw = ref.trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // http:, https:, mailto:, tel:, data:
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean) return null;
  const dir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, decodeURIComponent(clean)));
  if (!joined || joined.startsWith('..')) return null;
  return joined;
}

function globs(raw: string): RegExp[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`));
}

const matchesAny = (res: RegExp[], rel: string) => {
  if (!res.length) return false;
  const base = path.posix.basename(rel);
  return res.some((r) => r.test(rel) || r.test(base));
};

/** Decide what a deploy would publish for this company. Pure read: changes nothing. */
export function publishPlan(c: Pick<Company, 'slug' | 'config'>): PublishPlan {
  const all = listFiles(c.slug);
  const byPath = new Map(all.map((f) => [f.path, f]));
  const includeGlobs = globs(companySetting(c, 'publish_include'));
  const excludeGlobs = globs(companySetting(c, 'publish_exclude'));
  const included = new Map<string, string>();
  const skipped = new Map<string, PublishEntry>();
  const missing: string[] = [];
  const blocked: string[] = [];
  const warnings: string[] = [];

  const readText = (rel: string): string | null => {
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) return null;
    try {
      return fs.readFileSync(safePath(c.slug, rel), 'utf8');
    } catch {
      return null;
    }
  };

  const queue: { rel: string; reason: string }[] = [];
  for (const f of all) if (ENTRY_EXT.has(path.extname(f.path).toLowerCase())) queue.push({ rel: f.path, reason: 'a page' });
  for (const f of all) if (matchesAny(includeGlobs, f.path)) queue.push({ rel: f.path, reason: 'forced by your publish_include rule' });
  if (!queue.length) blocked.push('there are no HTML pages in the site folder, so a deploy would publish nothing usable');

  while (queue.length) {
    const { rel, reason } = queue.shift()!;
    if (included.has(rel) || skipped.has(rel)) continue;
    const file = byPath.get(rel);
    if (!file) {
      if (!missing.includes(rel)) missing.push(rel);
      continue;
    }
    const forced = reason.startsWith('forced');
    const never = alwaysNever(rel);
    if (never) {
      skipped.set(rel, { path: rel, size: file.size, reason: never });
      continue;
    }
    const offSite = notSiteContent(rel);
    if (offSite && !forced) {
      skipped.set(rel, { path: rel, size: file.size, reason: offSite });
      continue;
    }
    if (!forced && matchesAny(excludeGlobs, rel)) {
      skipped.set(rel, { path: rel, size: file.size, reason: 'your publish_exclude rule' });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      skipped.set(rel, { path: rel, size: file.size, reason: `too large for a static deploy (${(file.size / 1_048_576).toFixed(1)} MB)` });
      continue;
    }
    const text = readText(rel);
    if (text !== null && path.extname(rel).toLowerCase() === '.json' && !forced) {
      const fixture = fixtureReason(text);
      if (fixture) {
        skipped.set(rel, { path: rel, size: file.size, reason: `sample data (${fixture})` });
        continue;
      }
    }
    if (text !== null) {
      const hit = text.match(SECRET_RE);
      if (hit) {
        // Never publish, never silently drop: stop and make a human look.
        blocked.push(`${rel} looks like it contains a credential (${hit[0].slice(0, 6)}…, ${hit[0].length} chars)`);
        continue;
      }
    }
    included.set(rel, reason);
    if (text !== null) for (const ref of refsFrom(rel, text)) {
      const target = resolveRef(rel, ref);
      if (target) queue.push({ rel: target, reason: `linked from ${rel}` });
    }
  }

  // Everything left over: no page reaches it, or it is one of the never-publish categories.
  for (const f of all) {
    if (included.has(f.path) || skipped.has(f.path)) continue;
    const never = alwaysNever(f.path);
    const offSite = never ? null : notSiteContent(f.path);
    const text = never || offSite ? null : readText(f.path);
    const fixture = text !== null && path.extname(f.path).toLowerCase() === '.json' ? fixtureReason(text) : null;
    const reason = never
      ? never
      : offSite
        ? offSite
        : f.size > MAX_FILE_BYTES
          ? `too large for a static deploy (${(f.size / 1_048_576).toFixed(1)} MB)`
          : fixture
            ? `sample data (${fixture})`
            : 'no page links to it';
    skipped.set(f.path, { path: f.path, size: f.size, reason });
  }

  const files = [...included.entries()].map(([p, reason]) => ({ path: p, size: byPath.get(p)?.size ?? 0, reason })).sort((a, b) => a.path.localeCompare(b.path));
  const bytes = files.reduce((s, f) => s + f.size, 0);

  if (!setting('public_base_url')) warnings.push('Public URL is empty (Settings → Website hosting), so deployed pages will not report visits or waitlist signups');
  const notLinked = [...skipped.values()].filter((s) => s.reason === 'no page links to it').length;
  if (notLinked) warnings.push(`${notLinked} file${notLinked === 1 ? '' : 's'} in the folder ${notLinked === 1 ? 'is' : 'are'} not reachable from any page and will not be published${notLinked === 1 ? '' : ' — if the site needs one, link it or add a publish_include rule'}`);

  return {
    files,
    skipped: [...skipped.values()].sort((a, b) => a.path.localeCompare(b.path)),
    missing,
    bytes,
    blocked,
    warnings,
  };
}

/** One line for logs, tool output and the activity feed. */
export function summarize(plan: PublishPlan) {
  const kb = (plan.bytes / 1024).toFixed(1);
  const notLinked = plan.skipped.filter((s) => s.reason === 'no page links to it').length;
  const held = plan.skipped.filter((s) => s.reason !== 'no page links to it');
  const heldText = held.length ? `, ${held.length} kept back (${[...new Set(held.map((s) => s.reason))].slice(0, 3).join('; ')})` : '';
  const gaps = plan.missing.length ? `; referenced but not in the folder: ${plan.missing.join(', ')}` : '';
  return `publishing ${plan.files.length} files (${kb} KB); not published: ${notLinked} unreachable${heldText}${gaps}`;
}
