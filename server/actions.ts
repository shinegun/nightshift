import { get, now, run, type AdCampaign, type Commit, type Company, type Email, type Tweet, companyById } from './db.ts';
import { flag, num, setting } from './settings.ts';
import { activity, emit } from './events.ts';
import { sendEmail, senderFor } from './integrations/email.ts';
import { postTweet, explainXFailure } from './integrations/x.ts';
import { createPausedCampaign, setCampaignStatus, type MetaIds } from './integrations/meta.ts';
import { errMsg, localNow } from './util.ts';
import { clearIssue, reportIssue } from './health.ts';
import { commitAndPush, diffSummary, status as gitStatus } from './git.ts';
import { reportHtml } from './report-html.ts';

/**
 * Which day's report this body is, so the email is dated by the report rather than by whenever it
 * happened to be delivered. Matched on content because that is exactly what was queued; a resend
 * weeks later still carries its original date.
 */
const reportDay = (companyId: number, body: string) =>
  get<{ day: string }>('SELECT day FROM reports WHERE company_id = ? AND content = ? ORDER BY day DESC LIMIT 1', companyId, body)?.day
  ?? localNow().day;

// Every outward-facing action goes through here, so the approval gate and the
// audit trail (emails / tweets / ad_campaigns tables) live in one place.

const mustCompany = (id: number) => {
  const c = companyById(id);
  if (!c) throw new Error('Company not found');
  return c;
};

// ── Email ──────────────────────────────────────────────────────────────────

/** `force` = the owner wrote or approved it, so skip the approval gate. */
export interface EmailDraft { to: string; subject: string; body: string; kind?: string; inReplyTo?: string | null; force?: boolean }

export async function queueEmail(c: Company, d: EmailDraft) {
  const toOwner = Boolean(setting('owner_email')) && d.to.trim().toLowerCase() === setting('owner_email').toLowerCase();
  const needsApproval = !d.force && !toOwner && flag('approve_emails');
  const r = run(
    `INSERT INTO emails (company_id, direction, status, kind, from_addr, to_addr, subject, body, in_reply_to, created_at, read)
     VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    c.id, needsApproval ? 'pending_approval' : 'sending', d.kind ?? 'other', senderFor(c), d.to.trim(), d.subject, d.body, d.inReplyTo ?? null, now(),
  );
  emit('email', c.id);
  if (needsApproval) {
    activity(c.id, `> Drafted an email to ${d.to} — waiting for your approval`);
    return { id: r.id, status: 'pending_approval' as const };
  }
  return deliverEmail(r.id);
}

export async function deliverEmail(id: number) {
  const e = get<Email>('SELECT * FROM emails WHERE id = ?', id);
  if (!e) throw new Error('Email not found');
  const c = mustCompany(e.company_id);
  try {
    // The report is the one mail worth laying out: it arrives every morning and is meant to be
    // kept. Rendered here rather than stored, so the row keeps the plain text the dashboard reads.
    const html = e.kind === 'report' ? reportHtml(c, e.body, reportDay(c.id, e.body)) : undefined;
    const { messageId } = await sendEmail({ from: e.from_addr || senderFor(c), to: e.to_addr, subject: e.subject, text: e.body, html, inReplyTo: e.in_reply_to });
    run(`UPDATE emails SET status = 'sent', message_id = ?, error = NULL WHERE id = ?`, messageId, id);
    clearIssue('email', c);
    activity(c.id, `> Sent email to ${e.to_addr}: "${e.subject}"`);
    emit('email', c.id);
    return { id, status: 'sent' as const };
  } catch (err) {
    run(`UPDATE emails SET status = 'failed', error = ? WHERE id = ?`, errMsg(err), id);
    reportIssue('email', err, c);
    activity(c.id, `> Email to ${e.to_addr} failed: ${errMsg(err)}`);
    emit('email', c.id);
    throw err;
  }
}

// ── X ──────────────────────────────────────────────────────────────────────

export async function queueTweet(c: Company, text: string, force = false) {
  const t = text.trim();
  if (!t) throw new Error('Tweet text is empty');
  if (t.length > 280) throw new Error(`Tweet is ${t.length} characters (max 280) — shorten it`);
  const needsApproval = !force && flag('approve_tweets');
  const r = run('INSERT INTO tweets (company_id, text, status, created_at) VALUES (?, ?, ?, ?)', c.id, t, needsApproval ? 'pending_approval' : 'posting', now());
  emit('tweet', c.id);
  if (needsApproval) {
    activity(c.id, '> Drafted a post for X — waiting for your approval');
    return { id: r.id, status: 'pending_approval' as const };
  }
  return deliverTweet(r.id);
}

export async function deliverTweet(id: number) {
  const t = get<Tweet>('SELECT * FROM tweets WHERE id = ?', id);
  if (!t) throw new Error('Post not found');
  const c = mustCompany(t.company_id);
  try {
    const { id: extId } = await postTweet(c, t.text);
    run(`UPDATE tweets SET status = 'posted', external_id = ?, posted_at = ?, posted_day = ?, error = NULL WHERE id = ?`, extId, now(), localNow().day, id);
    clearIssue('x', c);
    activity(c.id, '> Posted to X');
    emit('tweet', c.id);
    return { id, status: 'posted' as const };
  } catch (err) {
    run(`UPDATE tweets SET status = 'failed', error = ? WHERE id = ?`, explainXFailure(errMsg(err)), id);
    reportIssue('x', err, c);
    emit('tweet', c.id);
    throw err;
  }
}

// ── Meta Ads ───────────────────────────────────────────────────────────────

export interface AdDraft { name: string; headline: string; body: string; link: string; countries: string; dailyBudget: number }

export async function queueAd(c: Company, d: AdDraft) {
  const cap = num('ads_max_daily_budget');
  const budget = Math.min(Math.max(d.dailyBudget, 1), cap);
  const r = run(
    `INSERT INTO ad_campaigns (company_id, name, headline, body, link, countries, daily_budget_cents, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    c.id, d.name, d.headline, d.body, d.link, d.countries, Math.round(budget * 100), now(), now(),
  );
  const ad = get<AdCampaign>('SELECT * FROM ad_campaigns WHERE id = ?', r.id)!;
  try {
    const ids = await createPausedCampaign(c, ad);
    run(`UPDATE ad_campaigns SET status = 'paused', external = ?, updated_at = ? WHERE id = ?`, JSON.stringify(ids), now(), r.id);
    clearIssue('meta', c);
  } catch (err) {
    run(`UPDATE ad_campaigns SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, errMsg(err), now(), r.id);
    reportIssue('meta', err, c);
    emit('ads', c.id);
    throw err;
  }
  emit('ads', c.id);
  if (flag('approve_ads')) {
    activity(c.id, `> Created Meta campaign "${d.name}" (paused) — activate it when you're happy`);
    return { id: r.id, status: 'paused' as const, dailyBudget: budget };
  }
  await setAdStatus(r.id, 'active');
  return { id: r.id, status: 'active' as const, dailyBudget: budget };
}

export async function setAdStatus(id: number, status: 'active' | 'paused') {
  const ad = get<AdCampaign>('SELECT * FROM ad_campaigns WHERE id = ?', id);
  if (!ad) throw new Error('Campaign not found');
  const c = mustCompany(ad.company_id);
  const ids = JSON.parse(ad.external || '{}') as MetaIds;
  if (!ids.campaign_id) throw new Error('This campaign was never created on Meta');
  try {
    await setCampaignStatus(c, ids, status === 'active' ? 'ACTIVE' : 'PAUSED');
    clearIssue('meta', c);
  } catch (err) {
    reportIssue('meta', err, c);
    throw err;
  }
  run('UPDATE ad_campaigns SET status = ?, error = NULL, updated_at = ? WHERE id = ?', status, now(), id);
  activity(c.id, `> Meta campaign "${ad.name}" ${status === 'active' ? 'is now running' : 'paused'}`);
  emit('ads', c.id);
}

// ── Git ────────────────────────────────────────────────────────────────────

/**
 * A commit an agent wants to make. Pushing is visible to everyone with access to the repository,
 * so it waits behind the same gate as an email, unless the owner has turned that gate off.
 */
export async function queueCommit(c: Company, d: { message: string; branch?: string; force?: boolean }) {
  const st = await gitStatus(c.slug);
  if (!st.repo) throw new Error(`${c.name} has no git repository yet. Run "git init" in its site folder and add a remote.`);
  if (!st.changedCount) throw new Error('Nothing to commit: the site folder matches the last commit.');

  const branch = d.branch?.trim() || `agent/${localNow().day}`;
  const summary = await diffSummary(c.slug);
  const needsApproval = !d.force && flag('approve_git');
  const r = run(
    `INSERT INTO commits (company_id, status, branch, message, summary, remote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    c.id, needsApproval ? 'pending_approval' : 'pushing', branch, d.message.trim(), summary, st.remote, now(),
  );
  emit('commits', c.id);
  if (needsApproval) {
    activity(c.id, `> Wants to commit ${st.changedCount} changed file${st.changedCount === 1 ? '' : 's'} to ${branch} — waiting for your approval`);
    return { id: r.id, status: 'pending_approval' as const, branch, files: st.changedCount };
  }
  return pushCommit(r.id);
}

export async function pushCommit(id: number) {
  const row = get<Commit>('SELECT * FROM commits WHERE id = ?', id);
  if (!row) throw new Error('Commit not found');
  const c = mustCompany(row.company_id);
  try {
    const res = await commitAndPush(c.slug, { message: row.message, branch: row.branch, author: `${c.name} agent` });
    run(`UPDATE commits SET status = 'pushed', sha = ?, remote = ?, error = NULL, pushed_at = ? WHERE id = ?`, res.sha, res.remote, now(), id);
    activity(c.id, `> Pushed ${res.sha.slice(0, 8)} to ${res.branch}: "${row.message}"`);
    emit('commits', c.id);
    return { id, status: 'pushed' as const, sha: res.sha, branch: res.branch };
  } catch (err) {
    run(`UPDATE commits SET status = 'failed', error = ? WHERE id = ?`, errMsg(err), id);
    activity(c.id, `> Push to ${row.branch} failed: ${errMsg(err)}`);
    emit('commits', c.id);
    throw err;
  }
}
