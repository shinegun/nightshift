/**
 * The morning report, as an email you would not mind keeping.
 *
 * The report itself stays plain text: it is what the dashboard shows, what the database stores,
 * and what a mail client falls back to. This module is only the second half of the multipart
 * message — the same facts, laid out so the inbox copy is worth saving rather than skimming once.
 *
 * Everything here is inlined and table-based on purpose. Mail clients strip <style> blocks, and a
 * saved .eml or a "print to PDF" has to survive on its own with no network and no stylesheet.
 */
import type { Company } from './db.ts';

/** The palette from web/styles.css, hard-coded: an email cannot read a CSS variable. */
const C = {
  bg: '#f5f2ea', surface: '#fffdf8', surface2: '#efebe0',
  ink: '#1c1b18', ink2: '#57544b', ink3: '#8a867a',
  line: '#e0dbcd', lamp: '#c7780f', warn: '#a45d06', ok: '#2f7a4a',
};
// Single quotes inside the family names, never double: these go into style="..." attributes, and
// a double quote ends the attribute there — silently dropping every declaration after the stack.
const SERIF = "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export interface ReportParts {
  headline: string;
  decisions: string[];
  /** "…and 12 more in the dashboard." — kept verbatim rather than recomputed. */
  decisionsMore: string;
  ran: string;
  unfinished: string[];
  unfinishedMore: string;
  spend: string;
  /** Older reports were written as "Heading: body" lines. Carried so old text still renders. */
  sections: { heading: string; body: string }[];
}

/**
 * Reads the text briefText() produces. It is a fixed shape, not prose, so this is a reader and
 * not a guess — but every branch falls through to leaving a line alone, because a report that
 * renders imperfectly still has to render.
 */
export function parseReport(text: string): ReportParts {
  const out: ReportParts = {
    headline: '', decisions: [], decisionsMore: '', ran: '',
    unfinished: [], unfinishedMore: '', spend: '', sections: [],
  };
  const SECTION = /^([A-Z][^:]{2,40}):\s*(.+)$/;
  let seenHeadline = false;
  // Where an unrecognised line belongs. Reports written before decision titles were forced onto
  // one line have commit bodies wrapped into the numbered list, and those continuation lines are
  // part of the decision above them, not a new anything.
  let open: 'decision' | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (/^\d+\.\s/.test(line)) { out.decisions.push(line.replace(/^\d+\.\s*/, '')); open = 'decision'; continue; }
    if (/^\.\.\.and\s.*more/i.test(line)) {
      if (out.unfinished.length) out.unfinishedMore = line;
      else out.decisionsMore = line;
      open = null;
      continue;
    }
    if (/^unfinished:\s/i.test(line)) { out.unfinished.push(line.replace(/^unfinished:\s*/i, '')); open = null; continue; }
    if (/tasks? ran\./i.test(line) || /^No tasks ran\./i.test(line)) { out.ran = line; open = null; continue; }
    if (/^AI spend:/i.test(line)) { out.spend = line; open = null; continue; }

    const section = SECTION.exec(line);
    if (!seenHeadline) {
      seenHeadline = true;
      // The old format opened straight into "Done overnight: …", which is a section and not a
      // headline; only the newer "N decisions for you." line is really a title.
      if (!section) { out.headline = line; continue; }
      out.headline = 'Morning report';
    }
    if (section) { out.sections.push({ heading: section[1], body: section[2] }); open = null; continue; }
    if (open === 'decision' && out.decisions.length) {
      out.decisions[out.decisions.length - 1] += ` ${line}`;
      continue;
    }
    out.sections.push({ heading: '', body: line });
  }
  out.decisions = out.decisions.map((d) => (d.length > 220 ? `${d.slice(0, 219).trimEnd()}…` : d));
  return out;
}

const cell = (content: string, style = '') => `<td style="${style}">${content}</td>`;

/** One decision, as a numbered row. Tables, because a list marker is the first thing clients eat. */
function decisionRow(text: string, n: number): string {
  return `<tr>
    ${cell(
      `<span style="display:inline-block;min-width:1.5em;height:1.5em;line-height:1.5em;text-align:center;`
      + `background:${C.surface2};color:${C.ink2};border-radius:999px;font:600 12px/1.5em ${MONO};">${n}</span>`,
      `padding:7px 10px 7px 0;vertical-align:top;width:34px;`,
    )}
    ${cell(esc(text), `padding:7px 0;vertical-align:top;font:15px/1.5 ${SANS};color:${C.ink};`)}
  </tr>`;
}

function block(title: string, inner: string): string {
  return `<tr><td style="padding:0 0 6px;">
    <div style="font:600 11px/1 ${MONO};letter-spacing:.09em;text-transform:uppercase;color:${C.ink3};padding:18px 0 8px;">${esc(title)}</div>
    ${inner}
  </td></tr>`;
}

/**
 * `day` is the report's own date (a company can be in any timezone, and the mail may be read in
 * another), so it is printed rather than derived from when this happens to run.
 */
export function reportHtml(c: Company, text: string, day: string): string {
  const p = parseReport(text);
  const pretty = new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  const nothing = !p.decisions.length && !p.sections.length;

  const rows: string[] = [];

  if (p.decisions.length) {
    rows.push(block('Needs a decision from you', `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${p.decisions.map((t, i) => decisionRow(t, i + 1)).join('')}
      </table>
      ${p.decisionsMore ? `<p style="margin:10px 0 0;font:14px/1.5 ${SANS};color:${C.ink3};">${esc(p.decisionsMore)}</p>` : ''}`));
  }

  if (p.ran || p.unfinished.length) {
    rows.push(block('What ran', `
      ${p.ran ? `<p style="margin:0;font:15px/1.6 ${SANS};color:${C.ink};">${esc(p.ran)}</p>` : ''}
      ${p.unfinished.length ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:8px;">${
        p.unfinished.map((t) => `<tr>
          ${cell(`<span style="color:${C.warn};font:600 12px/1.6 ${MONO};">unfinished</span>`, `padding:3px 10px 3px 0;vertical-align:top;width:78px;`)}
          ${cell(esc(t), `padding:3px 0;vertical-align:top;font:14px/1.6 ${SANS};color:${C.ink2};`)}
        </tr>`).join('')
      }</table>` : ''}
      ${p.unfinishedMore ? `<p style="margin:8px 0 0;font:14px/1.5 ${SANS};color:${C.ink3};">${esc(p.unfinishedMore)}</p>` : ''}`));
  }

  // Anything the parser did not recognise — including every line of the older report format.
  for (const s of p.sections) {
    rows.push(block(s.heading || 'Note', `<p style="margin:0;font:15px/1.6 ${SANS};color:${C.ink};">${esc(s.body)}</p>`));
  }

  const preheader = p.decisions.length
    ? `${p.headline} ${p.decisions[0].slice(0, 90)}`
    : p.headline || 'Your morning report.';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(c.name)} — ${esc(pretty)}</title>
</head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.bg};">
  <tr><td align="center" style="padding:28px 14px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;">

      <tr><td style="padding:0 4px 12px;font:600 12px/1 ${MONO};letter-spacing:.08em;color:${C.ink3};">
        <span style="color:${C.lamp};">&#9790;</span> NIGHTSHIFT &middot; ${esc(c.name.toUpperCase())}
      </td></tr>

      <tr><td style="background:${C.surface};border:1px solid ${C.line};border-radius:10px;padding:26px 28px 28px;">
        <p style="margin:0 0 4px;font:14px/1 ${SANS};color:${C.ink3};">${esc(pretty)}</p>
        <h1 style="margin:0;font:600 27px/1.22 ${SERIF};color:${C.ink};letter-spacing:-.01em;">${esc(p.headline || 'Morning report')}</h1>
        ${nothing ? `<p style="margin:14px 0 0;font:15px/1.6 ${SANS};color:${C.ink2};">Nothing is waiting on you. The agents carried on without needing a decision.</p>` : ''}
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows.join('')}</table>
        ${p.spend ? `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid ${C.line};font:13px/1.5 ${MONO};color:${C.ink3};">${esc(p.spend)}</p>` : ''}
      </td></tr>

      <tr><td style="padding:14px 4px 0;font:12px/1.6 ${SANS};color:${C.ink3};">
        Written from the company's own records — no model wrote this summary.
        Open the Nightshift dashboard to act on anything above.
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}
