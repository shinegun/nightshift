import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.ts';

// Each company's website is a folder of static files. Agents edit it through
// tools; the platform serves it at /s/<slug>/ and can deploy it to Vercel.

export const SITES_DIR = path.join(DATA_DIR, 'sites');
const VERSIONS_DIR = path.join(DATA_DIR, 'site-versions');
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md', '.xml', '.webmanifest']);
const MAX_FILE_BYTES = 400_000;
const MAX_VERSIONS = 20;

export const siteDir = (slug: string) => path.join(SITES_DIR, slug);

export function safePath(slug: string, rel: string) {
  const base = siteDir(slug);
  const p = path.resolve(base, rel.replace(/^\/+/, ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`Path "${rel}" is outside the site folder`);
  return p;
}

function walk(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
}

export function listFiles(slug: string) {
  return walk(siteDir(slug)).map((p) => ({ path: p, size: fs.statSync(safePath(slug, p)).size }));
}

export function readSiteFile(slug: string, rel: string) {
  const p = safePath(slug, rel);
  if (!fs.existsSync(p)) throw new Error(`File not found: ${rel}`);
  return fs.readFileSync(p, 'utf8');
}

export function writeSiteFile(slug: string, rel: string, content: string) {
  const p = safePath(slug, rel);
  if (!TEXT_EXT.has(path.extname(p).toLowerCase())) {
    throw new Error(`Only text web files are allowed (${[...TEXT_EXT].join(', ')})`);
  }
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('File too large (max 400 KB)');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function deleteSiteFile(slug: string, rel: string) {
  const p = safePath(slug, rel);
  if (p === siteDir(slug)) throw new Error('Refusing to delete the whole site');
  fs.rmSync(p, { force: true });
}

// ── Versions ───────────────────────────────────────────────────────────────

export function snapshot(slug: string, label: string) {
  const src = siteDir(slug);
  if (!fs.existsSync(src)) return null;
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(VERSIONS_DIR, slug, id);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, path.join(dest, 'files'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'meta.json'), JSON.stringify({ id, label, ts: new Date().toISOString() }));
  const all = listVersions(slug);
  for (const old of all.slice(MAX_VERSIONS)) fs.rmSync(path.join(VERSIONS_DIR, slug, old.id), { recursive: true, force: true });
  return id;
}

export function listVersions(slug: string): { id: string; label: string; ts: string }[] {
  const dir = path.join(VERSIONS_DIR, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((id) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

export function restoreVersion(slug: string, id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Bad version id');
  const src = path.join(VERSIONS_DIR, slug, id, 'files');
  if (!fs.existsSync(src)) throw new Error('Version not found');
  snapshot(slug, `Before restoring ${id}`);
  fs.rmSync(siteDir(slug), { recursive: true, force: true });
  fs.cpSync(src, siteDir(slug), { recursive: true });
}

// ── Tracking + waitlist ────────────────────────────────────────────────────

/** Injected into every HTML page. Counts visits and wires up <form data-waitlist>. */
export const TRACKER_JS = `(function(){
  var s=document.currentScript; if(!s) return;
  var site=s.getAttribute('data-site'); var preview=s.hasAttribute('data-preview'); var base=s.src.replace(/\\/t\\.js.*$/,'');
  function post(p,b){return fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),keepalive:true});}
  var v=''; try{v=localStorage.getItem('ns_v')||Math.random().toString(36).slice(2);localStorage.setItem('ns_v',v);}catch(e){}
  if(!preview){try{post('/public/track',{site:site,path:location.pathname,ref:document.referrer,v:v});}catch(e){}}
  document.addEventListener('submit',function(e){
    var f=e.target; if(!f||!f.matches||!f.matches('form[data-waitlist]')) return;
    e.preventDefault(); var i=f.querySelector('input[type=email]'); if(!i||!i.value) return;
    var b=f.querySelector('button'); if(b) b.disabled=true;
    post('/public/waitlist',{site:site,email:i.value}).then(function(r){if(!r.ok) throw 0;
      f.innerHTML='<p class="waitlist-thanks">'+(f.getAttribute('data-success')||"You're on the list. We'll be in touch.")+'</p>';
    }).catch(function(){ if(b) b.disabled=false; alert('Something went wrong. Please try again.'); });
  });
})();`;

export function injectTracker(html: string, slug: string, base: string) {
  if (html.includes('/t.js"') || html.includes("/t.js'")) return html;
  const tag = `<script defer src="${base.replace(/\/+$/, '')}/t.js" data-site="${slug}"></script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}\n</body>`) : `${html}\n${tag}`;
}

/** All files base64-encoded for the Vercel API, with the tracker pointed at the public platform URL. */
export function filesForDeploy(slug: string, publicBase: string) {
  return listFiles(slug).map(({ path: rel }) => {
    let buf = fs.readFileSync(safePath(slug, rel));
    if (publicBase && /\.html?$/i.test(rel)) buf = Buffer.from(injectTracker(buf.toString('utf8'), slug, publicBase));
    return { file: rel, data: buf.toString('base64'), encoding: 'base64' as const };
  });
}

export function ensureStarterSite(slug: string, name: string, tagline: string) {
  if (fs.existsSync(safePath(slug, 'index.html'))) return;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  writeSiteFile(slug, 'index.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#faf8f3;color:#1c1b19}
main{max-width:34rem;padding:2rem;text-align:center}h1{font-size:2.4rem;margin:0 0 .5rem}p{color:#5b5850}
form{display:flex;gap:.5rem;margin-top:1.5rem}input{flex:1;padding:.7rem;border:1px solid #ccc;border-radius:6px}
button{padding:.7rem 1.1rem;border:0;border-radius:6px;background:#1c1b19;color:#fff;cursor:pointer}</style></head>
<body><main><h1>${esc(name)}</h1><p>${esc(tagline || 'Something new is on the way.')}</p>
<form data-waitlist><input type="email" placeholder="you@example.com" required><button>Join the waitlist</button></form>
</main></body></html>
`);
}
