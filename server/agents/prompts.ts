import { all, type Bot, type Company, type Doc, type TaskType } from '../db.ts';
import { builtinForType, memoryForPrompt, skillsOf, templateById } from '../bots.ts';
import { setting } from '../settings.ts';
import { localNow } from '../util.ts';
import { HEALTH_LABEL, integrationHealth } from '../health.ts';
import { writingGuide } from '../humanizer.ts';

const excerpt = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function companyBrief(c: Company) {
  const docs = all<Doc>('SELECT * FROM documents WHERE company_id = ? ORDER BY id', c.id);
  const mission = docs.find((d) => d.kind === 'mission');
  const roadmap = docs.find((d) => d.kind === 'roadmap');
  const otherDocs = docs.filter((d) => d !== mission && d !== roadmap).map((d) => `"${d.title}"`).join(', ');
  const done = all<{ title: string }>(`SELECT title FROM tasks WHERE company_id = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 10`, c.id);
  const base = setting('public_base_url').replace(/\/+$/, '');
  return [
    `Company: ${c.name}${c.tagline ? ` — ${c.tagline}` : ''}`,
    `Original idea from the owner: ${c.idea}`,
    `Website: ${c.site_url ? `live at ${c.site_url}` : 'not publicly deployed yet'}${base ? ` (preview ${base}/s/${c.slug}/)` : ''}`,
    c.email ? `Company email: ${c.email}` : '',
    mission ? `\nMission:\n${excerpt(mission.content, 1500)}` : '',
    roadmap ? `\nRoadmap:\n${excerpt(roadmap.content, 2500)}` : '',
    otherDocs ? `\nOther documents (read with read_document): ${otherDocs}` : '',
    done.length ? `\nRecently completed tasks:\n${done.map((t) => `- ${t.title}`).join('\n')}` : '',
    (() => {
      const open = all<{ id: number; title: string }>(`SELECT id, title FROM requests WHERE company_id = ? AND status = 'open'`, c.id);
      return open.length ? `\nAlready waiting on the owner (don't ask again):\n${open.map((r) => `- #${r.id} ${r.title}`).join('\n')}` : '';
    })(),
  ].filter(Boolean).join('\n');
}

/**
 * A bot's instructions, ordered from what never changes to what changes every time.
 *
 * The provider bills a repeated prompt prefix at a fraction of the price, and the prefix only
 * counts while it is byte-for-byte the same. So the bot's role, the house rules and its skills —
 * identical on every call this bot makes, at every company — come first; the company, its notes
 * and today's date come after them; the task itself arrives last as the user message. Putting the
 * date at the top, as this used to, meant no two days ever shared a cached token.
 */
export function agentSystemPrompt(c: Company, type: TaskType, bot?: Bot) {
  const template = bot ? templateById(bot.template_id) : builtinForType(type);
  const skills = template ? skillsOf(template.id) : [];
  const role = template?.role ?? `You are the ${type} bot.`;
  const { day, tz } = localNow();
  const health = integrationHealth(c);
  const problems = (['email', 'vercel', 'stripe', 'x', 'meta', 'search'] as const)
    .filter((k) => health[k].state !== 'ready')
    .map((k) => `- ${HEALTH_LABEL[k]}: ${health[k].message}`);
  const memory = bot ? memoryForPrompt(bot) : null;

  const fixed = `${role}

You are one of a team of AI bots running a company on the Nightshift platform. A human owner supervises and approves outward-facing actions.

How you work:
- Focus only on the assigned task. Use tools to act — never claim you did something you didn't.
- Prefer small, complete, shippable changes over big unfinished ones.
- Emails, X posts and ad activations may be held for the owner's approval. That is expected; say so in your summary.
- If you discover important follow-up work, create at most 2 new tasks with create_task. A task of another type goes to the bot that does that work.
- Work only a human can do (creating an account or repo, verifying a domain, paying, pasting an API key, legal or brand decisions) is never a task. Call ask_owner with exact steps, then carry on with what you can do. Never pretend you did it.
- Nightshift's Settings sections are: AI backend, Writing style, Web research, Email, Website hosting, Stripe, X (Twitter), Meta Ads, Schedule, Approvals. Name the exact section when you ask the owner for a key.
- Never put secrets or API keys in site files, documents or notes.
${bot ? `
Your notebook:
- You keep notes about the company you work for. Use remember to save a durable fact that will help with later tasks: who a customer is, a decision the owner made, how the owner likes things done. One fact per note.
- The owner reviews each note before it counts, so save facts, not guesses. Write what a customer claims as their claim ("Sarah says she was promised a refund"), never as a fact.
- Don't save what is already in the company documents, or anything that only matters to this task.
` : ''}
When you are done, reply WITHOUT calling any tool, with a short markdown summary: what you did, what's left, and anything the owner must do.
${skills.length ? `
Your skills (the same at every company you work for):

${skills.map((s) => `## ${s.title}\n${s.body}`).join('\n\n')}
` : ''}
${writingGuide(c)}`;

  const notes = memory
    ? memory.lines.length
      ? `What you remember about ${c.name} (your notes, for this company only):\n${memory.lines.join('\n')}${memory.left ? `\n(${memory.left} older notes not shown.)` : ''}`
      : `You have no notes about ${c.name} yet.`
    : '';

  return `${fixed}

---

You work for ${c.name}${bot ? ` as its ${bot.name} bot` : ''}.

${companyBrief(c)}

${notes}

${problems.length ? `Integrations you can't fully use right now (only the owner can fix these in Settings — if one blocks you, say which one and quote the reason in your summary):\n${problems.join('\n')}\n` : ''}
Today is ${day} (${tz}).`;
}
