/**
 * Prints a company's morning brief without writing a report row or emailing the owner.
 *
 *   npx tsx scripts/preview-report.mts safastack
 *   npx tsx scripts/preview-report.mts safastack --html out.html   # the email, as it will look
 *   npx tsx scripts/preview-report.mts safastack --html out.html --day 2026-09-13
 *
 * The brief is deterministic, so this shows exactly what would be sent. With --day it renders a
 * report already in the database instead of building today's, which is how you check the layout
 * against a real morning rather than a quiet one.
 */
import fs from 'node:fs';
import { get } from '../server/db.ts';
import { briefText, decisions, lastNight } from '../server/decisions.ts';
import { reportHtml } from '../server/report-html.ts';
import { localNow } from '../server/util.ts';
import type { Company } from '../server/db.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const slug = args[0]?.startsWith('--') ? 'safastack' : args[0] ?? 'safastack';
const htmlOut = flag('--html');
const day = flag('--day');

const c = get<Company>('SELECT * FROM companies WHERE slug = ?', slug);
if (!c) throw new Error(`no company with slug "${slug}"`);

let text: string;
let reportDay: string;
if (day) {
  const row = get<{ day: string; content: string }>('SELECT day, content FROM reports WHERE company_id = ? AND day = ?', c.id, day);
  if (!row) throw new Error(`no report for ${slug} on ${day}`);
  text = row.content;
  reportDay = row.day;
} else {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  text = briefText(c, decisions(c), lastNight(c, since));
  reportDay = localNow().day;
}

const list = decisions(c);
process.stdout.write(`subject: ${c.name} — ${list.length ? `${list.length} decision${list.length === 1 ? '' : 's'}` : 'nothing needs you'}\n\n`);
process.stdout.write(text + '\n');

if (htmlOut) {
  fs.writeFileSync(htmlOut, reportHtml(c, text, reportDay));
  process.stdout.write(`\nhtml written to ${htmlOut}\n`);
}
