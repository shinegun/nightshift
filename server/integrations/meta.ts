import type { AdCampaign, Company } from '../db.ts';
import { companySetting, setting } from '../settings.ts';

// Meta Marketing API. Campaigns are always created PAUSED; turning one on is a
// separate call so it can sit behind the approval gate.

function cfg(c: Company) {
  const token = companySetting(c, 'meta_access_token');
  const account = companySetting(c, 'meta_ad_account_id').replace(/^act_/, '');
  const page = companySetting(c, 'meta_page_id');
  if (!token || !account) throw new Error('Meta Ads not connected — add an access token and ad account ID in Settings');
  return { token, account, page, base: `https://graph.facebook.com/${setting('meta_api_version')}` };
}

async function graph(c: Company, method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}) {
  const { token, base } = cfg(c);
  const qs = new URLSearchParams({ access_token: token });
  for (const [k, v] of Object.entries(params)) qs.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  const res = await fetch(method === 'GET' ? `${base}${path}?${qs}` : `${base}${path}`, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
    body: method === 'POST' ? qs : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || data.error) {
    const e = data.error ?? {};
    throw new Error(`Meta ${res.status}: ${e.error_user_msg ?? e.message ?? 'request failed'}`);
  }
  return data;
}

export interface MetaIds { campaign_id: string; adset_id: string; creative_id: string; ad_id: string }

export async function createPausedCampaign(c: Company, ad: AdCampaign): Promise<MetaIds> {
  const { account, page } = cfg(c);
  if (!page) throw new Error('Meta Page ID is required to run link ads — add it in Settings');
  const act = `/act_${account}`;
  const countries = ad.countries.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

  const campaign = await graph(c, 'POST', `${act}/campaigns`, {
    name: ad.name, objective: 'OUTCOME_TRAFFIC', status: 'PAUSED',
    special_ad_categories: [], is_adset_budget_sharing_enabled: 'false',
  });
  const adset = await graph(c, 'POST', `${act}/adsets`, {
    name: `${ad.name} — ad set`, campaign_id: campaign.id, status: 'PAUSED',
    daily_budget: String(ad.daily_budget_cents), billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS', bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: { geo_locations: { countries: countries.length ? countries : ['MY'] }, age_min: 18, targeting_automation: { advantage_audience: 0 } },
  });
  const creative = await graph(c, 'POST', `${act}/adcreatives`, {
    name: `${ad.name} — creative`,
    object_story_spec: {
      page_id: page,
      link_data: { link: ad.link, message: ad.body, name: ad.headline, call_to_action: { type: 'LEARN_MORE', value: { link: ad.link } } },
    },
  });
  const created = await graph(c, 'POST', `${act}/ads`, {
    name: `${ad.name} — ad`, adset_id: adset.id, creative: { creative_id: creative.id }, status: 'PAUSED',
  });
  return { campaign_id: campaign.id, adset_id: adset.id, creative_id: creative.id, ad_id: created.id };
}

export async function setCampaignStatus(c: Company, ids: MetaIds, status: 'ACTIVE' | 'PAUSED') {
  // All three levels must be ACTIVE for delivery; pausing the campaign alone is enough to stop it.
  const order = status === 'ACTIVE' ? [ids.ad_id, ids.adset_id, ids.campaign_id] : [ids.campaign_id];
  for (const id of order) await graph(c, 'POST', `/${id}`, { status });
}

export async function fetchInsights(c: Company, ids: MetaIds) {
  const data = await graph(c, 'GET', `/${ids.campaign_id}/insights`, { fields: 'impressions,clicks,spend,ctr,cpc', date_preset: 'maximum' });
  return data.data?.[0] ?? { impressions: '0', clicks: '0', spend: '0' };
}

export async function testMeta(c: Company) {
  const { account } = cfg(c);
  const data = await graph(c, 'GET', `/act_${account}`, { fields: 'name,currency,account_status' });
  return { name: data.name, currency: data.currency, status: data.account_status };
}
