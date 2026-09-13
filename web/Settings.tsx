import { useEffect, useState } from 'react';
import { api, post } from './api.ts';
import type { HealthKey, SettingsPayload } from './types.ts';
import { HealthNote, toast, useAction, usd } from './lib.tsx';
import { OpexPanel } from './Opex.tsx';
import { PeoplePanel } from './People.tsx';

interface Field {
  key: string; label: string; secret?: boolean; help?: string; type?: 'text' | 'number' | 'email' | 'url';
  options?: [string, string][]; placeholder?: string; showIf?: (v: Record<string, string>) => boolean; datalist?: boolean;
}
interface Section { id: string; title: string; intro?: string; test?: string; tests?: [string, string][]; fields: Field[]; panel?: 'opex' | 'people' }

const BOOL: [string, string][] = [['true', 'Ask me first'], ['false', 'Let agents act on their own']];
const HOURS = Array.from({ length: 24 }, (_, h) => [String(h), `${String(h).padStart(2, '0')}:00`] as [string, string]);

const SECTIONS: Section[] = [
  {
    id: 'ai', title: 'AI backend', test: 'llm',
    intro: 'Any OpenAI-compatible chat API. Defaults are for DeepSeek — paste your key from platform.deepseek.com → API keys.',
    fields: [
      { key: 'llm_api_key', label: 'API key', secret: true },
      { key: 'llm_base_url', label: 'Base URL', type: 'url', help: 'DeepSeek: https://api.deepseek.com · OpenRouter: https://openrouter.ai/api/v1 · OpenAI: https://api.openai.com/v1' },
      { key: 'llm_model', label: 'Model', datalist: true, help: 'Press “Load models” to list what your key can use.' },
      { key: 'llm_thinking', label: 'Thinking mode', options: [['default', 'Provider default'], ['enabled', 'On (smarter, slower)'], ['disabled', 'Off (faster, cheaper)']], help: 'DeepSeek-only parameter. Leave on “Provider default” for other providers.' },
      { key: 'daily_budget_usd', label: 'Daily budget (USD)', type: 'number', help: 'Agents stop for the day once estimated spend reaches this. 0 = no cap.' },
      { key: 'monthly_budget_usd', label: 'Monthly budget (USD)', type: 'number', help: 'The ceiling that matches how you buy the API key. A $2 daily cap is $60 over a month, so set this too. 0 = no cap.' },
      { key: 'night_budget_share', label: 'Share of the day Night Task may spend', type: 'number', help: 'Night runs tasks back to back. 0.8 keeps a fifth of the daily budget back for the morning report and Auto Mode. 1 = no reserve.' },
      { key: 'agent_max_steps', label: 'Max steps per task', type: 'number' },
      { key: 'price_input_miss', label: 'Price · input (per 1M tokens, USD)', type: 'number' },
      { key: 'price_input_hit', label: 'Price · cached input', type: 'number' },
      { key: 'price_output', label: 'Price · output', type: 'number' },
    ],
  },
  {
    id: 'writing', title: 'Writing style',
    intro: 'The humanizer. Agents follow a plain-writing guide, and a built-in checker catches AI tells (em dashes, "delve", "not just X but Y" and more) and makes them rewrite before pages, emails, posts or ads are saved or sent. Emails and posts you write yourself are never touched.',
    fields: [
      { key: 'humanizer', label: 'Humanizer', options: [['true', 'On'], ['false', 'Off']] },
      { key: 'writing_spelling', label: 'Spelling', options: [['american', 'American (color, organize)'], ['british', 'British / Malaysian (colour, organise)'], ['auto', "Match each company's audience"]] },
      { key: 'writing_voice', label: 'Default voice', placeholder: 'Clean and natural (default)', help: 'Optional, e.g. "warm and direct, like a founder writing to a customer". Each company can override this in Company settings.' },
    ],
  },
  {
    id: 'search', title: 'Web research', test: 'search',
    intro: 'DuckDuckGo works without a key but can rate-limit. Tavily or Brave are more reliable for nightly research.',
    fields: [
      { key: 'search_provider', label: 'Provider', options: [['duckduckgo', 'DuckDuckGo (no key)'], ['tavily', 'Tavily'], ['brave', 'Brave Search']] },
      { key: 'tavily_api_key', label: 'Tavily API key', secret: true, showIf: (v) => v.search_provider === 'tavily' },
      { key: 'brave_api_key', label: 'Brave Search API key', secret: true, showIf: (v) => v.search_provider === 'brave' },
    ],
  },
  {
    id: 'email', title: 'Email', tests: [['email', 'Send test email'], ['imap', 'Test inbox']],
    intro: 'Each company gets its own address via plus-addressing (hello+company@yourdomain.com). Replies are read over IMAP and turned into support tasks.',
    fields: [
      { key: 'email_provider', label: 'Send with', options: [['none', 'Off'], ['resend', 'Resend'], ['smtp', 'SMTP (Gmail, Zoho, …)']] },
      { key: 'email_from', label: 'Send from', type: 'email', placeholder: 'hello@yourdomain.com' },
      { key: 'owner_email', label: 'Your email (reports go here)', type: 'email' },
      { key: 'resend_api_key', label: 'Resend API key', secret: true, showIf: (v) => v.email_provider === 'resend' },
      { key: 'smtp_host', label: 'SMTP host', placeholder: 'smtp.gmail.com', showIf: (v) => v.email_provider === 'smtp' },
      { key: 'smtp_port', label: 'SMTP port', type: 'number', showIf: (v) => v.email_provider === 'smtp' },
      { key: 'smtp_user', label: 'SMTP username', showIf: (v) => v.email_provider === 'smtp' },
      { key: 'smtp_pass', label: 'SMTP password / app password', secret: true, showIf: (v) => v.email_provider === 'smtp' },
      { key: 'imap_host', label: 'IMAP host (inbox)', placeholder: 'auto for Gmail/Outlook/Yahoo/iCloud', help: 'Leave empty for those providers — it’s worked out from the username. Otherwise e.g. imap.zoho.com.' },
      { key: 'imap_port', label: 'IMAP port', type: 'number' },
      { key: 'imap_user', label: 'IMAP username' },
      { key: 'imap_pass', label: 'IMAP password / app password', secret: true },
    ],
  },
  {
    id: 'vercel', title: 'Website hosting', test: 'vercel',
    intro: 'Sites are previewed locally. With a Vercel token, agents can publish them to production.',
    fields: [
      { key: 'vercel_token', label: 'Vercel token', secret: true, help: 'vercel.com/account/tokens' },
      { key: 'vercel_team_id', label: 'Team ID (optional)' },
      { key: 'public_base_url', label: 'Public URL of this Nightshift', type: 'url', placeholder: 'https://nightshift.example.com', help: 'Where deployed sites send visits and waitlist signups. Point a tunnel at the public port (see README) — it serves only the tracker, never the dashboard.' },
    ],
  },
  { id: 'stripe', title: 'Stripe', test: 'stripe', intro: 'Agents create products and payment links; completed checkouts show up as revenue.', fields: [{ key: 'stripe_secret_key', label: 'Secret key', secret: true, help: 'Use a restricted key or sk_test_… while trying it out.' }] },
  {
    id: 'x', title: 'X (Twitter)', test: 'x',
    intro: 'Optional for the whole workspace — a company can post as its own X account instead (Company → X), and then these four values can stay empty. Posting needs all four OAuth 1.0a values: an app at developer.x.com with Read and write permission, its consumer key and secret (the portal labels this pair "API Key" and "API Key Secret", under Consumer Keys), and your own access token and access token secret. Generate the tokens after setting the permission — a token made while the app was read-only stays read-only. The bearer token is app-only: it reads public data but can never post as you.',
    fields: [
      { key: 'x_api_key', label: 'Consumer key', secret: true, help: 'Keys and tokens → Consumer Keys → the value the portal calls "API Key".' },
      { key: 'x_api_secret', label: 'Consumer secret', secret: true, help: 'Same section — the portal calls it "API Key Secret".' },
      { key: 'x_access_token', label: 'Access token', secret: true, help: 'Keys and tokens → Access Token and Secret. Generate it after App permissions are set to Read and write.' },
      { key: 'x_access_secret', label: 'Access token secret', secret: true, help: 'Same section — copy it together with the access token.' },
      { key: 'x_bearer_token', label: 'Bearer token (optional)', secret: true, help: 'App-only. Fine to keep for read-only lookups; posting works without it and it cannot post on its own.' },
    ],
  },
  {
    id: 'meta', title: 'Meta Ads', test: 'meta',
    intro: 'A system-user or long-lived token with ads_management, your ad account and the Facebook Page ads run from.',
    fields: [
      { key: 'meta_access_token', label: 'Access token', secret: true },
      { key: 'meta_ad_account_id', label: 'Ad account ID', placeholder: 'act_1234… or 1234…' },
      { key: 'meta_page_id', label: 'Page ID' },
      { key: 'ads_max_daily_budget', label: 'Max daily budget per campaign', type: 'number', help: "Hard cap in your ad account's currency. Agents can't exceed it." },
      { key: 'meta_api_version', label: 'Graph API version' },
    ],
  },
  {
    id: 'people', title: 'People', panel: 'people',
    intro: 'Everyone here can do everything: approve email, post as the company, spend, change keys. Separate accounts are what let the activity log say who did what, and let one person be removed without changing anyone else\'s password.',
    fields: [],
  },
  {
    id: 'opex', title: 'OpEx', panel: 'opex',
    intro: 'What this costs to run: model tokens and X posts are counted automatically, and you add everything else you pay for. One monthly number, so spend creep shows up early.',
    fields: [
      { key: 'opex_cap_usd', label: 'Monthly ceiling (USD)', type: 'number', help: 'Your own limit for everything above — the meter turns red past it. 0 = no ceiling.' },
      { key: 'x_cost_per_post_usd', label: 'X cost per post (USD)', type: 'number', help: 'What X charges you for one published post. Check your plan — it varies.' },
    ],
  },
  {
    id: 'schedule', title: 'Schedule',
    fields: [
      { key: 'timezone', label: 'Timezone', placeholder: 'Asia/Kuala_Lumpur' },
      { key: 'night_start_hour', label: 'Night shift starts', options: HOURS },
      { key: 'night_end_hour', label: 'Night shift ends', options: HOURS },
      { key: 'report_hour', label: 'Morning report at', options: HOURS },
      { key: 'auto_mode_gap_min', label: 'Auto Mode: minutes between tasks', type: 'number' },
      { key: 'night_max_new_tasks', label: 'Tasks planned per night', type: 'number' },
      { key: 'scheduler_paused', label: 'Scheduler', options: [['false', 'Running'], ['true', 'Paused (nothing runs automatically)']] },
    ],
  },
  {
    id: 'safety', title: 'Approvals',
    intro: 'Outward-facing actions wait on your dashboard under “Needs you” until you approve them. Emails to you and morning reports always send.',
    fields: [
      { key: 'approve_tweets', label: 'X posts', options: BOOL },
      { key: 'approve_emails', label: 'Emails to other people', options: BOOL },
      { key: 'approve_ads', label: 'Starting ad spend', options: BOOL },
      { key: 'approve_git', label: 'Pushing to git', options: BOOL },
    ],
  },
];

/** Status lines shown under each section's title. */
const SECTION_HEALTH: Record<string, [HealthKey, string][]> = {
  ai: [['ai', 'AI']],
  search: [['search', 'Web search']],
  email: [['email', 'Sending'], ['inbox', 'Inbox']],
  vercel: [['vercel', 'Publishing'], ['publicUrl', 'Visitor tracking on deployed sites']],
  stripe: [['stripe', 'Stripe']],
  x: [['x', 'X']],
  meta: [['meta', 'Meta Ads']],
};

interface Usage { days: { day: string; cost: number; calls: number; tokens: number }[]; byCompany: { name: string; cost: number }[] }

export function Settings({ onSaved }: { onSaved: () => void }) {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [models, setModels] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [usage, setUsage] = useState<Usage | null>(null);
  const { busy, run } = useAction();

  const load = async () => {
    const s = await api<SettingsPayload>('/settings');
    setData(s); setValues(s.values); setSecrets({});
  };
  useEffect(() => { void load(); void api<Usage>('/usage').then(setUsage).catch(() => {}); }, []);
  if (!data) return <div className="container"><p className="muted">Loading…</p></div>;

  const dirty = Object.keys(secrets).length > 0 || Object.entries(values).some(([k, v]) => v !== data.values[k]);
  const save = async () => {
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== data.values[k]));
    await api('/settings', { method: 'PUT', body: { ...changed, ...secrets } });
    await load();
    onSaved();
  };
  const test = (what: string) => run(`test-${what}`, async () => {
    if (dirty) await save();
    const r = await post<{ ok: boolean; result?: unknown; error?: string }>(`/settings/test/${what}`);
    const friendly = r.result && typeof r.result === 'object' && 'message' in (r.result as Record<string, unknown>)
      ? String((r.result as { message: unknown }).message)
      : JSON.stringify(r.result);
    setResults((x) => ({ ...x, [what]: { ok: r.ok, text: r.ok ? friendly : r.error ?? 'failed' } }));
    await load(); // refresh the status lines with what the test just learned
  });
  const loadModels = () => run('models', async () => {
    if (dirty) await save();
    const r = await api<{ models: string[] }>('/settings/models');
    setModels(r.models);
    toast(`${r.models.length} models available`, 'success');
  });

  return (
    <div className="container settings">
      <div className="settings-head">
        <div><h1>Settings</h1><p className="muted">Keys are stored in <code>data/nightshift.db</code> on this machine and never sent to the browser — only whether they're set.</p></div>
        <button className="btn primary sticky-save" disabled={!dirty || busy === 'save'} onClick={() => run('save', save, 'Settings saved')}>{busy === 'save' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
      </div>

      <nav className="settings-nav">{SECTIONS.map((s) => <a key={s.id} href={`#/settings`} onClick={(e) => { e.preventDefault(); document.getElementById(`sec-${s.id}`)?.scrollIntoView({ behavior: 'smooth' }); }}>{s.title}</a>)}</nav>

      {SECTIONS.map((s) => (
        <section key={s.id} id={`sec-${s.id}`} className="card settings-section">
          <header className="card-head">
            <h2>{s.title}</h2>
            <div className="row-actions">
              {s.id === 'ai' && <button className="btn small ghost" disabled={busy !== null} onClick={loadModels}>Load models</button>}
              {(s.tests ?? (s.test ? [[s.test, 'Test connection']] : [])).map(([what, label]) => (
                <button key={what} className="btn small" disabled={busy !== null} onClick={() => test(what)}>{busy === `test-${what}` ? 'Testing…' : label}</button>
              ))}
            </div>
          </header>
          {s.intro && <p className="muted small">{s.intro}</p>}
          {(SECTION_HEALTH[s.id] ?? []).map(([k, label]) => <HealthNote key={k} h={data.health[k]} label={label} link={false} showReady />)}
          {s.panel === 'opex' && <OpexPanel />}
          {s.panel === 'people' && <PeoplePanel />}
          {(s.tests ?? (s.test ? [[s.test, '']] : [])).map(([what]) => results[what] && (
            <p key={what} className={results[what].ok ? 'ok small' : 'error small'}>{results[what].ok ? '✓ ' : '✗ '}{results[what].text}</p>
          ))}
          <div className="field-grid">
            {s.fields.filter((f) => !f.showIf || f.showIf(values)).map((f) => {
              const sec = data.secrets[f.key];
              return (
                <label key={f.key} className="field">
                  <span>{f.label}{f.secret && sec?.set && <em className="saved"> · saved {sec.hint}{sec.fromEnv ? ' (from .env)' : ''}</em>}</span>
                  {f.secret ? (
                    <div className="row">
                      <input type="password" autoComplete="off" placeholder={sec?.set ? 'unchanged — type to replace' : 'not set'}
                        value={secrets[f.key] ?? ''} onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })} />
                      {sec?.set && !sec.fromEnv && <button type="button" className="btn small ghost" onClick={() => setSecrets({ ...secrets, [f.key]: null })}>{secrets[f.key] === null ? 'will clear' : 'Clear'}</button>}
                    </div>
                  ) : f.options ? (
                    <select value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                      {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  ) : (
                    <input type={f.type ?? 'text'} step="any" placeholder={f.placeholder} list={f.datalist ? 'model-list' : undefined}
                      value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
                  )}
                  {f.help && <small className="muted">{f.help}</small>}
                </label>
              );
            })}
          </div>
        </section>
      ))}
      <datalist id="model-list">{models.map((m) => <option key={m} value={m} />)}</datalist>

      <section className="card settings-section">
        <header className="card-head"><h2>AI usage · last 14 days</h2></header>
        {!usage || usage.days.length === 0 ? <p className="empty">No AI calls yet.</p> : (
          <div className="usage">
            <table>
              <thead><tr><th>Day</th><th>Calls</th><th>Tokens</th><th>Est. cost</th></tr></thead>
              <tbody>{usage.days.map((u) => <tr key={u.day}><td className="mono">{u.day}</td><td>{u.calls}</td><td>{u.tokens.toLocaleString()}</td><td>{usd(u.cost)}</td></tr>)}</tbody>
            </table>
            <table>
              <thead><tr><th>Company</th><th>Est. cost</th></tr></thead>
              <tbody>{usage.byCompany.map((u) => <tr key={u.name}><td>{u.name}</td><td>{usd(u.cost)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
