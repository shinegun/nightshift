/**
 * Prints a company's morning brief without writing a report row or emailing the owner.
 *
 *   npx tsx scripts/preview-report.mts safastack
 *
 * The brief is deterministic, so this shows exactly what would be sent.
 */
import { get } from '../server/db.ts';
import { briefText, decisions, lastNight } from '../server/decisions.ts';
import type { Company } from '../server/db.ts';

const slug = process.argv[2] ?? 'safastack';
const c = get<Company>('SELECT * FROM companies WHERE slug = ?', slug);
if (!c) throw new Error(`no company with slug "${slug}"`);

const since = new Date(Date.now() - 86_400_000).toISOString();
const list = decisions(c);
process.stdout.write(`subject: ${c.name} — ${list.length ? `${list.length} decision${list.length === 1 ? '' : 's'}` : 'nothing needs you'}\n\n`);
process.stdout.write(briefText(c, list, lastNight(c, since)) + '\n');
