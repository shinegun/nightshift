import type { Company } from './db.ts';
import { companySetting, flag, setting } from './settings.ts';
import { chat } from './llm.ts';
import { htmlToText } from './util.ts';

// The humanizer: everything agents write for people should read like a person wrote it.
// 1. A writing guide in every prompt (free).
// 2. A detector for the strongest AI tells (free, no AI call).
// 3. When the detector fires: outward-facing tool writes bounce back once for a rewrite;
//    chat replies, reports and summaries get one rewrite pass. Owner-written text is never touched.

export interface Tell { name: string; match: string }

const PHRASES: [string, RegExp][] = [
  ['"delve"', /\bdelv(e|es|ed|ing)\b/i],
  ['"tapestry"', /\btapestr(y|ies)\b/i],
  ['"testament to"', /\btestament to\b/i],
  ['"pivotal"', /\bpivotal\b/i],
  ['"meticulous"', /\bmeticulous(ly)?\b/i],
  ['"intricate"', /\bintricate\b/i],
  ['"vibrant"', /\bvibrant\b/i],
  ['"bustling"', /\bbustling\b/i],
  ['"seamless"', /\bseamless(ly)?\b/i],
  ['"cutting-edge"', /\bcutting[- ]edge\b/i],
  ['"game-changer"', /\bgame[- ]chang(er|ing)\b/i],
  ['"unleash"', /\bunleash(es|ed|ing)?\b/i],
  ['"unlock your potential"', /\bunlock(s|ing)? (the |your |its |their )?(full |true )?potential\b/i],
  ['"elevate your"', /\belevate (your|our)\b/i],
  ['"embark"', /\bembark(s|ed|ing)?\b/i],
  ['"realm"', /\brealm\b/i],
  ['"in today\'s world"', /\bin today['’]s [\w\s-]{0,30}\b(world|landscape|age|era)\b/i],
  ['"it\'s worth noting"', /\b(it['’]s|it is) worth noting\b/i],
  ['"it\'s important to note"', /\b(it['’]s|it is) important to note\b/i],
  ['"at the end of the day"', /\bat the end of the day\b/i],
  ['"look no further"', /\blook no further\b/i],
  ['"rest assured"', /\brest assured\b/i],
  ['"hope this email finds you well"', /\bhope this (e-?mail|message|note) finds you well\b/i],
  ['"not just X, but Y"', /\bnot (just|only|merely)\b[^.!?\n]{1,60}\bbut( also)?\b/i],
  ['"in conclusion"', /(^|[.!?]\s+)(in conclusion|in summary|to sum up)\b/im],
  ['"dive in"', /\b(let['’]s dive|dive (in|into)|deep dive)\b/i],
];

/** Strong, low-false-positive signs of machine-written text. */
export function findAITells(text: string): Tell[] {
  const tells: Tell[] = [];
  for (const [name, re] of PHRASES) {
    const m = text.match(re);
    if (m) tells.push({ name, match: m[0].trim() });
  }
  const dashes = (text.match(/—|\s–\s/g) ?? []).length;
  if (dashes) tells.push({ name: 'em dashes', match: `${dashes}x` });
  const emojiLines = text.split('\n').filter((l) => /^\s*(?:[-*•]\s*)?\p{Extended_Pictographic}/u.test(l)).length;
  if (emojiLines >= 2) tells.push({ name: 'emoji bullets', match: `${emojiLines} lines` });
  const bangs = (text.match(/!(?!\[)/g) ?? []).length;
  if (bangs >= 3) tells.push({ name: 'exclamation marks', match: `${bangs}x` });
  return tells;
}

export const describeTells = (tells: Tell[]) => tells.map((t) => `${t.name} (${t.match})`).join(', ');

/** The words a visitor would read: visible text for HTML, raw text for md/txt, nothing for code. */
export function readableText(path: string, content: string) {
  if (/\.html?$/i.test(path)) return htmlToText(content.replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, ' '));
  if (/\.(md|txt)$/i.test(path)) return content;
  return '';
}

const SPELLING: Record<string, string> = {
  auto: "Use the spelling the audience expects: British/Commonwealth (colour, organise, licence) for Malaysia, the UK and the Gulf; American (color, organize, license) for a US-only audience.",
  british: 'Use British spelling (colour, organise, licence).',
  american: 'Use American spelling (color, organize, license).',
};

/** Writing guide injected into every agent prompt. Empty when the humanizer is off. */
export function writingGuide(c?: Pick<Company, 'config'>) {
  if (!flag('humanizer')) return '';
  const pick = (k: string) => (c ? companySetting(c, k) : setting(k)).trim();
  const voice = pick('writing_voice') || 'Clean and natural: professional but warm, like a competent founder writing to a customer.';
  return `How to write (for anything people will read: web pages, emails, posts, ads, documents, reports, summaries, chat. Not for code, CSS or JSON, and never alter text the owner gave you word for word, such as disclaimers):
- Sound like a thoughtful person. Plain words. Mix short and longer sentences. Use contractions (it's, we're, don't).
- Be specific. A concrete fact you actually have beats an adjective. Cut filler and say each thing once.
- No em dashes. Use a comma, a full stop, a colon or brackets instead.
- Avoid AI vocabulary: delve, tapestry, testament, pivotal, meticulous, intricate, vibrant, bustling, seamless, cutting-edge, game-changer, unleash, unlock your potential, elevate, embark, realm, "in today's fast-paced world", "it's worth noting", "at the end of the day", "look no further", "rest assured".
- Avoid AI patterns: "not just X, but Y"; lists of three just for rhythm; opening with a rhetorical question; ending with a recap ("In conclusion", "Overall"); "Whether you're X or Y"; emoji bullets; bold or headings sprinkled through short text; exclamation marks; "I hope this email finds you well"; flattery.
- Spelling: ${SPELLING[pick('writing_spelling')] ?? SPELLING.auto}
- Voice: ${voice}`;
}

export const BOUNCE = 'Not saved. This reads like AI writing';

/**
 * For outward-facing tool writes (site pages, emails, posts, ads): bounce the first
 * AI-sounding attempt so the agent rewrites it. After `maxBounces` it lets the work through.
 */
export function gateWriting(ctx: { rejected?: Map<string, number> }, key: string, text: string, tool: string, maxBounces = 1): string | null {
  if (!flag('humanizer') || !text.trim()) return null;
  const tells = findAITells(text);
  if (!tells.length) return null;
  ctx.rejected ??= new Map();
  const bounced = ctx.rejected.get(key) ?? 0;
  if (bounced >= maxBounces) return null;
  ctx.rejected.set(key, bounced + 1);
  return `${BOUNCE}: ${describeTells(tells)}. Rewrite it the way a person would (follow "How to write" in your instructions) and call ${tool} again.`;
}

/** Documents are saved either way; this asks the agent to fix its own wording (owner-supplied text stays as is). */
export function writingNote(text: string) {
  if (!flag('humanizer')) return '';
  const tells = findAITells(text);
  if (!tells.length) return '';
  return ` Note: it reads like AI writing (${describeTells(tells)}). If you wrote it, fix that with another write_document call. If the owner gave you this text word for word, leave it.`;
}

const EDITOR = 'You are an editor who makes text read like a person wrote it. Keep the meaning, facts, numbers, names, links and formatting (markdown stays markdown), and keep the length about the same. Change only what sounds machine-written. Reply with the revised text only, no preamble.';

/** One rewrite pass, only when the detector finds tells. Falls back to the original on any failure. */
export async function humanize(text: string, purpose: string, c?: Company): Promise<string> {
  if (!flag('humanizer') || !text.trim()) return text;
  const tells = findAITells(text);
  if (!tells.length) return text;
  try {
    const reply = await chat({
      companyId: c?.id,
      messages: [
        { role: 'system', content: `${EDITOR}\n\n${writingGuide(c)}` },
        { role: 'user', content: `This is ${purpose}. Problems found: ${describeTells(tells)}.\n\nText:\n${text}` },
      ],
    });
    const out = (reply.content ?? '').trim();
    return out && findAITells(out).length < tells.length ? out : text;
  } catch {
    return text;
  }
}
