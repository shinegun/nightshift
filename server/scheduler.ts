import { all, get, type AdCampaign, type Company, type Task, companyById, now, run } from './db.ts';
import { flag, num, setSetting, setting } from './settings.ts';
import { emit } from './events.ts';
import { budgetStop, spentToday } from './llm.ts';
import { pollInbox } from './integrations/email.ts';
import { syncRevenue } from './integrations/stripe.ts';
import { checkCompanyWorkflows } from './integrations/github.ts';
import { fetchInsights, type MetaIds } from './integrations/meta.ts';
import { recoverStaleTasks, runTask, runningTasks } from './agents/runner.ts';
import { morningReport, planNight } from './agents/night.ts';
import { errMsg, localNow } from './util.ts';
import { clearIssue, noteUnroutedMail, reportIssue } from './health.ts';

export function isNight(hour: number) {
  const start = num('night_start_hour'), end = num('night_end_hour');
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

const budgetLeft = () => budgetStop() === null;

/**
 * Night work runs tasks back to back with no gap, so on a tight cap it empties the whole day's
 * budget in its first hour: the morning report then has nothing to write with, and Auto Mode has
 * nothing left to work with. Keep a slice of the day back for them.
 */
const nightBudgetLeft = () => {
  const cap = num('daily_budget_usd');
  const share = Math.min(Math.max(num('night_budget_share'), 0), 1);
  return budgetLeft() && (cap <= 0 || share >= 1 || spentToday() < cap * share);
};

let ticking = false;

async function tick() {
  if (ticking || runningTasks.size) return;
  ticking = true;
  try {
    const { day, hour } = localNow();
    const companies = all<Company>(`SELECT * FROM companies WHERE status = 'live'`);
    const night = isNight(hour);

    // Morning reports (once per day, after report_hour, skipping companies born in the last 12h).
    // Deliberately NOT gated on budgetLeft(): the report is how the owner learns the day stopped,
    // and morningReport() falls back to a facts-only summary when the AI call is refused.
    if (hour >= num('report_hour') && !night) {
      for (const c of companies) {
        if (Date.now() - Date.parse(c.created_at) < 12 * 3_600_000) continue;
        if (get('SELECT id FROM reports WHERE company_id = ? AND day = ?', c.id, day)) continue;
        await morningReport(c).catch((e) => console.error(`[report] ${c.slug}: ${errMsg(e)}`));
      }
    }

    // Night planning, once per night per company
    if (night && budgetLeft()) {
      for (const c of companies.filter((x) => x.night_mode)) {
        const key = `night_planned:${c.id}`;
        if (setting(key) === day) continue;
        setSetting(key, day);
        await planNight(c).catch((e) => console.error(`[night] ${c.slug}: ${errMsg(e)}`));
      }
    }

    // Work the queue: one task per tick, round-robin by least recently worked company
    if (night ? !nightBudgetLeft() : !budgetLeft()) return;
    const gapMs = num('auto_mode_gap_min') * 60_000;
    const eligible = companies
      .filter((c) => (night && c.night_mode) || c.auto_mode)
      .map((c) => ({ c, last: get<{ t: string | null }>('SELECT MAX(finished_at) AS t FROM tasks WHERE company_id = ?', c.id)?.t ?? '' }))
      .filter(({ c, last }) => night && c.night_mode ? true : !last || Date.now() - Date.parse(last) >= gapMs)
      .sort((a, b) => (a.last < b.last ? -1 : 1));
    for (const { c } of eligible) {
      const next = get<Task>(`SELECT * FROM tasks WHERE company_id = ? AND status = 'todo' ORDER BY position, id LIMIT 1`, c.id);
      if (next) { await runTask(next.id); break; }
    }
  } catch (e) {
    console.error('[scheduler]', errMsg(e));
  } finally {
    ticking = false;
  }
}

/** Background syncs. Each failure is recorded against its integration so the UI can say exactly what broke. */
async function syncIntegrations() {
  if (setting('imap_user') || setting('imap_pass')) {
    await pollInbox().then((r) => { clearIssue('inbox'); noteUnroutedMail(r.unrouted); }, (e) => reportIssue('inbox', e));
  }
  const anyStripe = setting('stripe_secret_key') || all<Company>('SELECT config FROM companies').some((c) => c.config.includes('stripe_secret_key'));
  if (anyStripe) await syncRevenue().then(() => clearIssue('stripe'), (e) => reportIssue('stripe', e));
  // Meta insights, hourly
  if (Date.now() - Date.parse(setting('meta_synced_at') || '1970-01-01') > 3_600_000) {
    setSetting('meta_synced_at', now());
    for (const ad of all<AdCampaign>(`SELECT * FROM ad_campaigns WHERE status IN ('active','paused')`)) {
      const c = companyById(ad.company_id);
      if (!c) continue;
      try {
        const ins = await fetchInsights(c, JSON.parse(ad.external) as MetaIds);
        run('UPDATE ad_campaigns SET insights = ?, updated_at = ? WHERE id = ?', JSON.stringify(ins), now(), ad.id);
        clearIssue('meta', c);
        emit('ads', c.id);
      } catch (e) { reportIssue('meta', e, c); }
    }
  }
  // CI for each company's site repo. Read-only, and quiet for a company whose site folder has no
  // GitHub remote: checkCompanyWorkflows returns null rather than reporting anything.
  if (setting('github_token')) {
    for (const c of all<Company>('SELECT * FROM companies')) {
      await checkCompanyWorkflows(c).catch(() => {}); // already reported against this company
    }
  }
  setSetting('synced_at', now());
}

export function startScheduler() {
  recoverStaleTasks();
  if (flag('scheduler_paused')) console.log('[scheduler] paused in Settings');
  setInterval(() => { if (!flag('scheduler_paused')) void tick(); }, 30_000);
  setInterval(() => void syncIntegrations(), 5 * 60_000);
  setTimeout(() => { void syncIntegrations(); if (!flag('scheduler_paused')) void tick(); }, 5_000);
}
