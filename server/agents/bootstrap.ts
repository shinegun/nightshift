import { companyById, get, now, run, type Company, type Doc } from '../db.ts';
import { setSetting, setting } from '../settings.ts';
import { activity, emit } from '../events.ts';
import { chatJSON } from '../llm.ts';
import { companyAddress, emailConfigured } from '../integrations/email.ts';
import { deploySite } from '../integrations/vercel.ts';
import { queueEmail, queueTweet } from '../actions.ts';
import { ensureStarterSite } from '../sites.ts';
import { errMsg, slugify } from '../util.ts';
import { runTask } from './runner.ts';
import { insertTask, saveDocument } from './tools.ts';
import { humanize, writingGuide } from '../humanizer.ts';

// Idea → identity + mission (synchronous, so the dashboard URL is final and a
// bad API key fails right away) → market research → roadmap + tasks → first
// website → launch comms. Research and the website run as ordinary tasks so
// their work logs are inspectable like any other.

interface Profile { name: string; tagline: string; target_customer: string; mission_markdown: string; launch_post: string }
interface RoadmapPlan {
  roadmap_markdown: string;
  tasks: { title: string; description: string; type: string; priority: number }[];
}

function uniqueSlug(base: string) {
  const root = slugify(base);
  let slug = root;
  for (let i = 2; get<{ id: number }>('SELECT id FROM companies WHERE slug = ?', slug); i++) slug = `${root.slice(0, 36)}-${i}`;
  return slug;
}

function generateProfile(idea: string, name?: string, companyId?: number) {
  return chatJSON<Profile>(
    `You are a sharp, honest startup co-founder. Turn a raw idea into a company identity.
Return JSON: {"name": short brandable name (keep the owner's name if they gave one), "tagline": ≤12 words,
"target_customer": one sentence, "mission_markdown": markdown with sections "## Mission" (1-2 sentences), "## What we're building" (1 concrete paragraph), "## Who it's for", "## Where we're headed" (a short vivid paragraph),
"launch_post": a ≤260-character X post announcing the product honestly (no hype words, no fake numbers)}.

${writingGuide()}`,
    `Idea: ${idea}${name ? `\nCompany name (keep it): ${name}` : ''}`,
    { companyId },
  );
}

async function saveProfile(c: Company, p: Profile) {
  saveDocument(c, `${c.name} Mission`, await humanize(p.mission_markdown ?? '', 'the company mission document', c), 'mission');
  if (p.launch_post) setSetting(`launch_post:${c.id}`, await humanize(p.launch_post, 'a launch post for X (under 280 characters)', c));
}

export async function createCompany(idea: string, name?: string): Promise<Company> {
  const given = name?.trim() || undefined;
  const p = await generateProfile(idea, given);
  const finalName = (given ?? (p.name?.trim() || idea.split(/\s+/).slice(0, 3).join(' '))).slice(0, 60);
  const r = run(
    `INSERT INTO companies (slug, name, idea, tagline, status, mood, auto_mode, night_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'bootstrapping', 'booting', 0, 1, ?, ?)`,
    uniqueSlug(finalName), finalName, idea.trim(), (p.tagline ?? '').slice(0, 140), now(), now(),
  );
  const c = companyById(r.id)!;
  await saveProfile(c, p);
  activity(c.id, '> Waking up your AI team…');
  activity(c.id, '> Wrote the mission');
  void bootstrap(c.id);
  return c;
}

export async function bootstrap(companyId: number) {
  let c = companyById(companyId);
  if (!c) return;
  const say = (text: string) => activity(companyId, `> ${text}`);
  const refresh = () => { c = companyById(companyId)!; emit('company', companyId); return c; };
  run(`UPDATE companies SET status = 'bootstrapping', mood = 'booting', updated_at = ? WHERE id = ?`, now(), companyId);
  emit('company', companyId);

  try {
    // 1. Mission (normally written at creation; this covers retries)
    if (!get<Doc>(`SELECT id FROM documents WHERE company_id = ? AND kind = 'mission'`, companyId)) {
      say('Writing the mission…');
      await saveProfile(c, await generateProfile(c.idea, c.name, companyId));
    }
    const address = companyAddress(c.slug);
    if (address && !c.email) run('UPDATE companies SET email = ? WHERE id = ?', address, companyId);
    ensureStarterSite(c.slug, c.name, c.tagline);
    refresh();

    // 2. Market research
    if (!get<Doc>(`SELECT id FROM documents WHERE company_id = ? AND kind = 'research'`, companyId)) {
      say('Researching the market and competitors…');
      const existing = get<{ id: number }>(`SELECT id FROM tasks WHERE company_id = ? AND source = 'bootstrap' AND type = 'research' AND status != 'done'`, companyId);
      const id = existing?.id ?? insertTask(c, {
        title: `${c.name} market research`, type: 'research', priority: 1, source: 'bootstrap',
        description: `Research the market for this idea: target customers, 5-10 real competitors (with pricing where findable), market signals, and pricing expectations.
Save it with write_document titled "${c.name} Market Research" (kind "research") using sections: Summary, Market signals, Competitors, Pricing signals, Risks, Sources (URLs).`,
      });
      const t = await runTask(id);
      if (!get(`SELECT id FROM documents WHERE company_id = ? AND kind = 'research'`, companyId)) {
        throw new Error(`Market research didn't produce a document${t?.error ? `: ${t.error}` : ''}`);
      }
    }

    // 3. Roadmap + first tasks
    if (!get<Doc>(`SELECT id FROM documents WHERE company_id = ? AND kind = 'roadmap'`, companyId)) {
      say('Sketching your product roadmap…');
      const research = get<Doc>(`SELECT content FROM documents WHERE company_id = ? AND kind = 'research'`, companyId)?.content ?? '';
      const mission = get<Doc>(`SELECT content FROM documents WHERE company_id = ? AND kind = 'mission'`, companyId)?.content ?? '';
      const plan = await chatJSON<RoadmapPlan>(
        `You are the CEO agent planning a company that a team of AI agents will build. The product must be buildable as a static website (HTML/CSS/JS, no backend) plus marketing, outreach and research work — plan within that.
Return JSON: {"roadmap_markdown": markdown with "## Now", "## Next", "## Later" (3-5 concrete bullets each) and "## Owner to-dos" (things only the human can do, like connecting accounts),
"tasks": 4-6 first tasks, each {"title": imperative ≤70 chars, "description": specific steps and a definition of done, "type": one of fix|feature|research|marketing|outreach|ops, "priority": 1|2|3}}.
Do NOT include a task to build the initial landing page — that is already being done.

${writingGuide(c)}`,
        `Company: ${c.name} — ${c.tagline}\n\nMission:\n${mission}\n\nMarket research:\n${research.slice(0, 12_000)}`,
        { companyId },
      );
      saveDocument(c, 'Product Roadmap', await humanize(plan.roadmap_markdown ?? '', 'the product roadmap document', c), 'roadmap');
      for (const t of (plan.tasks ?? []).slice(0, 6)) insertTask(c, { ...t, source: 'bootstrap' });
    }

    // 4. First website
    const siteTask = get<{ id: number; status: string }>(`SELECT id, status FROM tasks WHERE company_id = ? AND source = 'bootstrap' AND title = 'Build the landing page'`, companyId);
    if (!siteTask || siteTask.status !== 'done') {
      say('Building your website…');
      const id = siteTask?.id ?? insertTask(c, {
        title: 'Build the landing page', type: 'feature', priority: 1, source: 'bootstrap',
        description: `Replace the placeholder index.html with a real landing page for ${c.name}: hero with a clear promise, the problem, 3 key features, how it works, a FAQ, and a waitlist form (<form data-waitlist>) in the hero and at the bottom. Put styles in styles.css. Base the copy on the mission and research documents. Mobile-first, fast, honest (no fake testimonials or numbers).`,
      });
      const t = await runTask(id);
      if (t?.status !== 'done') say(`The website task didn't finish (${t?.error ?? 'see its log'}) — it stays in the queue.`);
    }

    // 5. Ship + tell people
    refresh();
    if (setting('vercel_token')) {
      say('Deploying to Vercel…');
      try { const { url } = await deploySite(c); say(`Website live at ${url}`); } catch (e) { say(`Deploy failed: ${errMsg(e)}`); }
    }
    refresh();
    const launch = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', `launch_post:${companyId}`)?.value;
    if (launch && !get('SELECT id FROM tweets WHERE company_id = ?', companyId)) {
      // Always a draft: the launch post is the owner's call even with approvals off.
      run(`INSERT INTO tweets (company_id, text, status, created_at) VALUES (?, ?, 'pending_approval', ?)`, companyId, launch.slice(0, 280), now());
      emit('tweet', companyId);
      say('Drafted your launch post for X');
    }
    const owner = setting('owner_email');
    if (emailConfigured() && owner && !get(`SELECT id FROM emails WHERE company_id = ? AND kind = 'welcome'`, companyId)) {
      say('Sending you a welcome email…');
      await queueEmail(c, {
        to: owner, kind: 'welcome', subject: `${c.name} is live`,
        body: `Your AI team has set up ${c.name}.\n\n${c.tagline}\n\nMission, market research and roadmap are in your dashboard, the first tasks are queued, and the website is ${c.site_url ? `live at ${c.site_url}` : 'ready to preview'}.\n\nNight Task is on: the team keeps working while you sleep and you'll get a report every morning.\n\nNightshift`,
      }).catch((e) => say(`Welcome email failed: ${errMsg(e)}`));
    }

    run(`UPDATE companies SET status = 'live', mood = 'triumphant', updated_at = ? WHERE id = ?`, now(), companyId);
    say('Your company is live! 🎉');
  } catch (e) {
    run(`UPDATE companies SET status = 'error', mood = 'confused', updated_at = ? WHERE id = ?`, now(), companyId);
    say(`Setup stopped: ${errMsg(e)}`);
  } finally {
    emit('company', companyId);
  }
}
