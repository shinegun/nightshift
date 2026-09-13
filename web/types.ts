export type CompanyStatus = 'bootstrapping' | 'live' | 'paused' | 'error';
export type TaskType = 'fix' | 'feature' | 'research' | 'marketing' | 'outreach' | 'support' | 'ops';
export type TaskStatus = 'todo' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';

export interface OwnerRequest {
  id: number; title: string; why: string; steps: string; unblocks: string;
  status: 'open' | 'done' | 'dismissed'; blocked_task_id: number | null; created_at: string;
}
export type Integration = 'email' | 'vercel' | 'stripe' | 'x' | 'meta';
export type HealthKey = 'ai' | 'search' | 'email' | 'inbox' | 'vercel' | 'publicUrl' | 'stripe' | 'x' | 'meta';
/** ready = usable · off = not set up / misconfigured · error = set up, but the last real attempt failed */
export interface Health { state: 'ready' | 'off' | 'error'; message: string; at?: string }
export interface Issue { key: string; label: string; message: string; at: string }

export interface Company {
  id: number; slug: string; name: string; idea: string; tagline: string; status: CompanyStatus; mood: string;
  auto_mode: number; night_mode: number; email: string; site_url: string; vercel_project: string;
  created_at: string; updated_at: string;
}

export interface Metrics {
  visitors_total: number; visitors_7d: number; pageviews_7d: number; waitlist: number; revenue: string[];
  tasks_open: number; tasks_done: number; emails_unread: number;
}

export interface Task {
  id: number; company_id: number; title: string; description: string; type: TaskType; status: TaskStatus;
  priority: number; position: number | null; source: string; result: string | null; error: string | null; steps: number; cost_usd: number;
  created_at: string; started_at: string | null; finished_at: string | null;
}

export interface TaskLog { id: number; ts: string; kind: string; content: string }
export interface DocMeta { id: number; kind: string; title: string; created_at: string; updated_at: string }
export interface Doc extends DocMeta { content: string }

export interface Email {
  id: number; direction: 'in' | 'out'; status: 'received' | 'sent' | 'sending' | 'pending_approval' | 'failed' | 'rejected';
  kind: string; from_addr: string; to_addr: string; subject: string; body: string; error: string | null; read: number; created_at: string;
}

export interface Tweet { id: number; text: string; status: 'pending_approval' | 'posting' | 'posted' | 'failed' | 'rejected'; external_id: string | null; error: string | null; created_at: string; posted_at: string | null }

export interface AdCampaign {
  id: number; name: string; headline: string; body: string; link: string; countries: string; daily_budget_cents: number;
  status: 'draft' | 'paused' | 'active' | 'failed'; insights: string | null; error: string | null; created_at: string;
}

export interface PaymentLink { id: number; name: string; amount_cents: number; currency: string; url: string; created_at: string }
export interface Report { id: number; day: string; content: string; created_at: string }
export interface Activity { id: number; ts: string; text: string; actor: string | null }
export interface Version { id: string; label: string; ts: string }
export interface SiteFile { path: string; size: number }
export interface PublishEntry { path: string; size: number; reason: string }
/** What a deploy would upload, what it leaves behind, and anything that must stop it. */
export interface PublishPlan {
  files: PublishEntry[];
  skipped: PublishEntry[];
  missing: string[];
  bytes: number;
  blocked: string[];
  warnings: string[];
}
export interface Secret { set: boolean; hint: string; fromEnv?: boolean }

export interface DashboardData {
  company: Company;
  overrides: Record<string, Secret & { value?: string }>;
  metrics: Metrics;
  integrations: Record<Integration, boolean>;
  health: Record<HealthKey, Health>;
  activity: Activity[];
  requests: OwnerRequest[];
  tasks: Task[];
  docs: DocMeta[];
  emails: Email[];
  tweets: Tweet[];
  ads: AdCampaign[];
  paymentLinks: PaymentLink[];
  revenueTotal: string[];
  reports: Report[];
  waitlist: { email: string; created_at: string }[];
  versions: Version[];
  files: SiteFile[];
  publish: PublishPlan;
  previewUrl: string;
  publicBaseUrl: string;
  running: boolean;
  spendTotal: number;
  night: boolean;
}

/** Someone who can sign in. The password hash never leaves the server. */
export interface PublicUser {
  id: number; username: string; name: string; created_at: string; last_seen_at: string | null;
}

export interface AppState {
  companies: (Company & { metrics: Metrics })[];
  spentToday: number; budget: number; llmConfigured: boolean; model: string;
  /** Month-to-date AI spend and the monthly cap that stops work. 0 = no monthly cap. */
  spentThisMonth: number; monthlyBudget: number;
  /** Everything so far today and month-to-date, against the owner's monthly ceiling. */
  opex: { today: number; month: number; perDay: number; cap: number };
  schedulerPaused: boolean; night: boolean; issues: Issue[]; syncedAt: string;
}

export interface SettingsPayload { values: Record<string, string>; secrets: Record<string, Secret>; health: Record<HealthKey, Health> }
