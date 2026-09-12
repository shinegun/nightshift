import { all, now, run, type Company } from '../db.ts';
import { companyConfig, companySetting, setting } from '../settings.ts';
import { activity, emit } from '../events.ts';
import { clearIssue, isAccountProblem, reportIssue } from '../health.ts';

function form(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(key: string, method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}) {
  if (!key) throw new Error('No Stripe secret key — add one in Settings → Stripe');
  const qs = form(params).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && qs ? `?${qs}` : ''}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? qs : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    const hint = res.status === 401 ? 'Stripe rejected the secret key — check Settings → Stripe'
      : res.status === 403 ? "This Stripe key isn't allowed to do that (restricted key missing a permission?)"
      : `Stripe ${res.status}`;
    throw Object.assign(new Error(`${hint}: ${data.error?.message ?? 'request failed'}`), { status: res.status });
  }
  return data;
}

export interface PaymentLinkSpec { name: string; amountCents: number; currency: string; interval?: 'month' | 'year' | null }

/** Product + price + hosted payment link, tagged with the company so revenue can be attributed. */
export async function createPaymentLink(c: Company, spec: PaymentLinkSpec) {
  try {
    const link = await createPaymentLinkOnce(c, spec);
    clearIssue('stripe', c);
    return link;
  } catch (e) {
    if (isAccountProblem(e)) reportIssue('stripe', e, c);
    throw e;
  }
}

async function createPaymentLinkOnce(c: Company, spec: PaymentLinkSpec) {
  const key = companySetting(c, 'stripe_secret_key');
  const currency = spec.currency.toLowerCase();
  const product = await stripe(key, 'POST', '/products', { name: spec.name, metadata: { nightshift_company: c.slug } });
  const price = await stripe(key, 'POST', '/prices', {
    product: product.id, unit_amount: Math.round(spec.amountCents), currency,
    ...(spec.interval ? { recurring: { interval: spec.interval } } : {}),
  });
  const link = await stripe(key, 'POST', '/payment_links', {
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: { nightshift_company: c.slug },
  });
  run(
    'INSERT INTO payment_links (company_id, name, amount_cents, currency, url, external_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    c.id, spec.name, Math.round(spec.amountCents), currency, link.url, link.id, now(),
  );
  return { url: link.url as string, id: link.id as string };
}

/**
 * Pull completed Checkout Sessions and attribute them: by payment link for the
 * shared account, or wholesale for companies that use their own Stripe key.
 */
export async function syncRevenue(): Promise<number> {
  const companies = all<Company>('SELECT * FROM companies');
  const links = all<{ company_id: number; external_id: string }>('SELECT company_id, external_id FROM payment_links WHERE external_id IS NOT NULL');
  const byLink = new Map(links.map((l) => [l.external_id, l.company_id]));
  const accounts = new Map<string, number | null>(); // key → owning company (null = shared)
  if (setting('stripe_secret_key')) accounts.set(setting('stripe_secret_key'), null);
  for (const c of companies) {
    const own = companyConfig(c).stripe_secret_key;
    if (own) accounts.set(own, c.id);
  }

  let added = 0;
  for (const [key, owner] of accounts) {
    const data = await stripe(key, 'GET', '/checkout/sessions', { limit: 100, status: 'complete' });
    for (const s of data.data ?? []) {
      if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') continue;
      const companyId = owner ?? byLink.get(s.payment_link) ?? null;
      if (!companyId) continue;
      const r = run(
        'INSERT OR IGNORE INTO revenue (company_id, amount_cents, currency, external_id, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        companyId, s.amount_total ?? 0, s.currency ?? 'usd', s.id, s.customer_details?.email ?? '',
        new Date((s.created ?? Date.now() / 1000) * 1000).toISOString(),
      );
      if (r.changes) {
        added++;
        activity(companyId, `> 💰 New payment: ${((s.amount_total ?? 0) / 100).toFixed(2)} ${String(s.currency).toUpperCase()}`);
        emit('revenue', companyId);
      }
    }
  }
  return added;
}

export async function testStripe(key = setting('stripe_secret_key')) {
  const b = await stripe(key, 'GET', '/balance');
  return { livemode: b.livemode, available: (b.available ?? []).map((a: any) => `${(a.amount / 100).toFixed(2)} ${a.currency.toUpperCase()}`) };
}
