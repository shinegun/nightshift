import { all, get, run, type Company } from './db.ts';

/** Non-secret settings and their defaults. Every key here is editable in Settings. */
export const DEFAULTS: Record<string, string> = {
  // AI backend — any OpenAI-compatible chat-completions API
  llm_base_url: 'https://api.deepseek.com',
  llm_model: 'deepseek-flash',
  llm_thinking: 'default', // default | enabled | disabled (DeepSeek "thinking" param)
  llm_timeout_sec: '300',
  // USD per 1M tokens, used for the spend meter and daily cap (DeepSeek flash, peak rates)
  price_input_miss: '0.30',
  price_input_hit: '0.006',
  price_output: '1.20',
  daily_budget_usd: '2',
  // An API key is bought by the month, so the daily cap alone cannot express the real ceiling:
  // $2/day is $60 over a 30-day month. 0 turns the monthly cap off.
  monthly_budget_usd: '0',
  // How much of the daily cap night work may spend. The night window runs tasks back to back, so
  // without a reserve it empties the day's budget in its first hour and leaves nothing for the
  // morning report or for Auto Mode. 1 restores the old behaviour.
  night_budget_share: '0.8',
  agent_max_steps: '25',

  // Research
  search_provider: 'duckduckgo', // duckduckgo | tavily | brave

  // Email
  email_provider: 'none', // none | resend | smtp
  email_from: '',
  owner_email: '',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  imap_host: '',
  imap_port: '993',
  imap_user: '',

  // Deploy
  vercel_team_id: '',

  // Meta Ads
  meta_ad_account_id: '',
  meta_page_id: '',
  meta_api_version: 'v23.0',
  ads_max_daily_budget: '10', // hard cap per campaign, in the ad account's currency

  // Schedule (local time in `timezone`)
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  night_start_hour: '1',
  night_end_hour: '6',
  report_hour: '7',
  auto_mode_gap_min: '5',
  scheduler_paused: 'false',
  night_max_new_tasks: '3',

  // Sites
  public_base_url: '',

  // OpEx: what running this actually costs. Metered costs are counted from usage/tweets;
  // subscriptions live in the expenses table.
  x_cost_per_post_usd: '0.03', // what X charges per published post on your plan
  opex_cap_usd: '10', // your own monthly ceiling — the meter turns red past it

  // Safety: outward-facing actions wait for your approval unless turned off
  approve_tweets: 'true',
  approve_emails: 'true',
  approve_ads: 'true',

  // Humanizer: everything agents write should read like a person wrote it
  humanizer: 'true',
  writing_spelling: 'american', // american | british | auto (match each company's audience)
  writing_voice: '',
};

export const SECRET_KEYS = new Set([
  'llm_api_key',
  'tavily_api_key',
  'brave_api_key',
  'resend_api_key',
  'smtp_pass',
  'imap_pass',
  'vercel_token',
  'stripe_secret_key',
  'x_api_key',
  'x_api_secret',
  'x_access_token',
  'x_access_secret',
  'x_bearer_token',
  'meta_access_token',
]);

/** Keys a single company may override (e.g. each company has its own X account). */
export const COMPANY_KEYS = [
  'x_api_key', 'x_api_secret', 'x_access_token', 'x_access_secret', 'x_bearer_token',
  'meta_ad_account_id', 'meta_page_id', 'meta_access_token',
  'stripe_secret_key', 'email_from',
  'writing_voice', 'writing_spelling',
  // What a deploy may put on the public website (globs; see server/publish.ts).
  'publish_include', 'publish_exclude',
];

const KNOWN = new Set([...Object.keys(DEFAULTS), ...SECRET_KEYS]);

function envFor(key: string): string | undefined {
  if (key === 'llm_api_key' && process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  return process.env[`NIGHTSHIFT_${key.toUpperCase()}`];
}

/** Resolution order: value saved in Settings → environment variable → default. */
export function setting(key: string): string {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (row && row.value !== '') return row.value;
  return envFor(key) ?? DEFAULTS[key] ?? '';
}

export function num(key: string): number {
  const n = Number(setting(key));
  return Number.isFinite(n) ? n : Number(DEFAULTS[key] ?? 0);
}

export function flag(key: string): boolean {
  return ['true', '1', 'yes', 'on'].includes(setting(key).toLowerCase());
}

export function setSetting(key: string, value: string) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

const mask = (v: string) => (v ? `••••${v.slice(-4)}` : '');

/** Settings as sent to the browser: secrets are never returned, only whether they're set. */
export function publicSettings() {
  const values: Record<string, string> = {};
  const secrets: Record<string, { set: boolean; hint: string; fromEnv: boolean }> = {};
  for (const key of Object.keys(DEFAULTS)) values[key] = setting(key);
  for (const key of SECRET_KEYS) {
    const stored = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? '';
    const v = stored || envFor(key) || '';
    secrets[key] = { set: Boolean(v), hint: mask(v), fromEnv: !stored && Boolean(v) };
  }
  return { values, secrets };
}

/**
 * Apply a patch from the Settings page. For secrets, an empty string means
 * "leave unchanged" and null means "clear".
 */
export function updateSettings(patch: Record<string, unknown>) {
  for (const [key, raw] of Object.entries(patch)) {
    if (!KNOWN.has(key)) continue;
    if (raw === null) { run('DELETE FROM settings WHERE key = ?', key); continue; }
    const value = String(raw).trim();
    if (SECRET_KEYS.has(key) && value === '') continue;
    setSetting(key, value);
  }
}

export function companyConfig(c: Pick<Company, 'config'>): Record<string, string> {
  try { return JSON.parse(c.config || '{}'); } catch { return {}; }
}

/** A company-level override if present, else the global setting. */
export function companySetting(c: Pick<Company, 'config'>, key: string): string {
  const v = companyConfig(c)[key];
  return v ? String(v) : setting(key);
}

export function allStoredKeys() {
  return all<{ key: string }>('SELECT key FROM settings').map((r) => r.key);
}
