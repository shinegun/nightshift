import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { all, now, run, type Company } from '../db.ts';
import { companySetting, num, setSetting, setting } from '../settings.ts';
import { activity, emit } from '../events.ts';
import { errMsg } from '../util.ts';

export const emailConfigured = () => setting('email_provider') !== 'none' && Boolean(setting('email_from'));

/**
 * Per-company address via plus-addressing on the configured sender, e.g.
 * hello@yourdomain.com → hello+matabuku@yourdomain.com. Replies land in the
 * same mailbox and get routed back to the company by the inbox poller.
 */
export function companyAddress(slug: string, from = setting('email_from')) {
  const m = from.match(/([^<>\s@]+)@([^<>\s@]+)>?\s*$/);
  if (!m) return '';
  return `${m[1].split('+')[0]}+${slug}@${m[2]}`;
}

export function senderFor(c: Company) {
  const addr = c.email || companyAddress(c.slug, companySetting(c, 'email_from'));
  return addr ? `${c.name} <${addr}>` : '';
}

export interface OutgoingEmail { from: string; to: string; subject: string; text: string; inReplyTo?: string | null }

export async function sendEmail(mail: OutgoingEmail): Promise<{ messageId: string }> {
  const provider = setting('email_provider');
  if (!mail.from) throw new Error('No sender address — set "Send from" in Settings → Email');
  if (provider === 'resend') {
    const key = setting('resend_api_key');
    if (!key) throw new Error('Resend selected but no Resend API key set');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: mail.from, to: [mail.to], subject: mail.subject, text: mail.text,
        ...(mail.inReplyTo ? { headers: { 'In-Reply-To': mail.inReplyTo, References: mail.inReplyTo } } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message ?? JSON.stringify(data).slice(0, 200)}`);
    return { messageId: `resend-${data.id}` };
  }
  if (provider === 'smtp') {
    const port = num('smtp_port');
    const transport = nodemailer.createTransport({
      host: setting('smtp_host'), port, secure: port === 465,
      auth: { user: setting('smtp_user'), pass: setting('smtp_pass') },
    });
    const info = await transport.sendMail({
      from: mail.from, to: mail.to, subject: mail.subject, text: mail.text,
      ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo, references: mail.inReplyTo } : {}),
    });
    return { messageId: info.messageId };
  }
  throw new Error('Email is not configured — pick Resend or SMTP in Settings → Email');
}

const addresses = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((o) => o.value.map((v) => (v.address ?? '').toLowerCase()));

const KNOWN_IMAP: Record<string, string> = {
  'gmail.com': 'imap.gmail.com', 'googlemail.com': 'imap.gmail.com',
  'outlook.com': 'outlook.office365.com', 'hotmail.com': 'outlook.office365.com', 'live.com': 'outlook.office365.com',
  'yahoo.com': 'imap.mail.yahoo.com', 'icloud.com': 'imap.mail.me.com', 'me.com': 'imap.mail.me.com',
};

/** IMAP server from Settings, or inferred from the username for well-known providers. */
export function imapHost() {
  const saved = setting('imap_host').trim();
  if (saved) return saved;
  return KNOWN_IMAP[setting('imap_user').split('@')[1]?.toLowerCase() ?? ''] ?? '';
}

export interface InboxPoll { filed: number; unrouted: { to: string; from: string; subject: string; at: string }[] }

/**
 * Which company an inbound message belongs to: its own configured address, or the
 * derived +slug form on the send-from domain. Companies' own addresses win, so a
 * clean alias (support@…) works as well as plus-addressing.
 */
export function companyForRecipients<T extends { slug: string; email: string }>(rcpts: string[], companies: T[]): T | undefined {
  const list = rcpts.map((r) => r.toLowerCase());
  return companies.find((c) => {
    const addr = (c.email || companyAddress(c.slug)).toLowerCase();
    return (addr && list.includes(addr)) || list.some((r) => r.includes(`+${c.slug}@`));
  });
}

/**
 * Pull new mail over IMAP and file it under the company it was addressed to.
 * Mail to our domain that no company claims is returned as `unrouted` so it can be
 * reported — never dropped silently. Other mail in the mailbox is left alone.
 */
export async function pollInbox(): Promise<InboxPoll> {
  const host = imapHost(), user = setting('imap_user'), pass = setting('imap_pass');
  if (!user || !pass) return { filed: 0, unrouted: [] };
  if (!host) throw new Error('IMAP server is missing — fill in "IMAP host" in Settings → Email');
  const companies = all<Company>('SELECT * FROM companies');
  const domain = (setting('email_from').match(/@([^<>\s@]+)>?\s*$/)?.[1] ?? '').toLowerCase();
  if (!domain) return { filed: 0, unrouted: [] }; // health check reports: "Send from" is empty

  const port = num('imap_port');
  const client = new ImapFlow({ host, port, secure: port === 993, auth: { user, pass }, logger: false });
  await client.connect();
  let count = 0;
  const unrouted: InboxPoll['unrouted'] = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const mailbox = client.mailbox;
    const validity = mailbox ? String(mailbox.uidValidity) : '';
    const top = mailbox ? Number(mailbox.uidNext) - 1 : 0;
    let lastUid = setting('imap_uidvalidity') === validity ? Number(setting('imap_last_uid') || 0) : 0;
    // Only ever download mail addressed to our domain — this is often someone's personal mailbox.
    const ours = { or: [{ to: domain }, { cc: domain }] };
    const found = lastUid
      ? await client.search({ uid: `${lastUid + 1}:*`, ...ours }, { uid: true })
      : await client.search({ since: new Date(Date.now() - 2 * 86_400_000), ...ours }, { uid: true });
    const uids = (found || []).filter((u) => u > lastUid);
    if (uids.length) {
      for await (const msg of client.fetch(uids, { source: true, uid: true }, { uid: true })) {
        lastUid = Math.max(lastUid, msg.uid);
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const rcpts = [...addresses(parsed.to), ...addresses(parsed.cc)];
        const delivered = parsed.headers.get('delivered-to');
        if (typeof delivered === 'string') rcpts.push(delivered.toLowerCase());
        const company = companyForRecipients(rcpts, companies);
        const from = parsed.from?.value[0]?.address ?? '';
        const subject = parsed.subject ?? '(no subject)';
        if (!company) {
          const ours = domain ? rcpts.find((r) => r.endsWith(`@${domain}`)) : undefined;
          if (ours) unrouted.push({ to: ours, from, subject, at: (parsed.date ?? new Date()).toISOString() });
          continue;
        }
        const r = run(
          `INSERT OR IGNORE INTO emails (company_id, direction, status, kind, from_addr, to_addr, subject, body, message_id, in_reply_to, created_at)
           VALUES (?, 'in', 'received', 'inbound', ?, ?, ?, ?, ?, ?, ?)`,
          company.id, from, rcpts[0] ?? '', subject, (parsed.text ?? '').slice(0, 20_000),
          parsed.messageId ?? `imap-${validity}-${msg.uid}`, parsed.inReplyTo ?? null, now(),
        );
        if (!r.changes) continue;
        count++;
        activity(company.id, `> New email from ${from}: "${subject}"`);
        // Nothing to answer in an automated sender or a transactional code, so filing it is
        // enough — don't queue work that can only end in a pointless approval request.
        const noReply = /(^|[._-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notifications?)([._+-]|@)/i.test(from)
          || /(verification code|security code|one[- ]time (code|password)|\botp\b|sign[- ]?in code|confirm your e-?mail|password reset)/i.test(subject);
        if (noReply) {
          activity(company.id, '> (automated mail — filed, nothing to answer)');
        } else {
          run(
            `INSERT INTO tasks (company_id, title, description, type, priority, source, created_at) VALUES (?, ?, ?, 'support', 1, 'inbox', ?)`,
            company.id, `Reply to ${from}: ${subject}`.slice(0, 140),
            `A new email arrived (email id ${r.id}). Read it with read_inbox, decide whether it needs a reply, and reply helpfully with reply_email. If it is spam, do nothing.`,
            now(),
          );
        }
        emit('email', company.id);
      }
    }
    lastUid = Math.max(lastUid, top); // skip past everything we deliberately didn't download
    setSetting('imap_last_uid', String(lastUid));
    setSetting('imap_uidvalidity', validity);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return { filed: count, unrouted };
}

export async function testEmail(to: string) {
  if (!to) throw new Error('Set your own email ("Owner email") first');
  return sendEmail({ from: setting('email_from'), to, subject: 'Nightshift test email', text: 'Email sending works. 🌙' });
}

export async function testImap() {
  const host = imapHost(), user = setting('imap_user'), pass = setting('imap_pass');
  if (!user || !pass) throw new Error('Fill in the IMAP username and password (Gmail: an app password from myaccount.google.com/apppasswords)');
  if (!host) throw new Error("IMAP host is empty — enter your provider's IMAP server");
  const port = num('imap_port');
  const client = new ImapFlow({ host, port, secure: port === 993, auth: { user, pass }, logger: false });
  try {
    await client.connect();
  } catch (e) {
    const detail = (e as { responseText?: string }).responseText ?? errMsg(e);
    throw new Error(`${host}:${port} refused the login — ${detail}`);
  }
  const status = await client.status('INBOX', { messages: true });
  await client.logout();
  return { host, inboxMessages: status.messages };
}
