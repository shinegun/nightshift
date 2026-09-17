/**
 * Slack, as a pipe: the Web API for posting, and a Socket Mode connection for hearing.
 *
 * Socket Mode is the reason this works on a dashboard that only listens on a tailnet. Nightshift
 * dials out to Slack and keeps a WebSocket open; Slack pushes events and button presses down it.
 * Nothing on this machine has to be reachable from the internet.
 *
 * What the events mean is decided in ../slack.ts. This file only moves bytes and keeps the
 * connection alive.
 */
import { setting } from '../settings.ts';
import { clearIssue, reportIssue } from '../health.ts';
import { errMsg } from '../util.ts';

const API = 'https://slack.com/api';

export class SlackError extends Error {
  constructor(public code: string, method: string) {
    super(`Slack ${method}: ${code}${HINTS[code] ? ` — ${HINTS[code]}` : ''}`);
  }
}

const HINTS: Record<string, string> = {
  invalid_auth: 'the token was rejected. Check it in Settings → Slack.',
  not_authed: 'no token is saved.',
  missing_scope: 'the app is missing a permission. Reinstall it from the manifest in Settings → Slack.',
  not_in_channel: 'invite the Nightshift app to that channel first (/invite @Nightshift).',
  channel_not_found: 'that channel ID is wrong, or the app can\'t see the channel.',
  not_allowed_token_type: 'that token is the wrong kind. The bot token starts with xoxb-, the app token with xapp-.',
};

type Params = Record<string, unknown>;

/** Replaceable in tests, so the bridge can be exercised without a workspace. */
export let slackCall = async (method: string, params: Params = {}, token = setting('slack_bot_token')): Promise<any> => {
  if (!token) throw new SlackError('not_authed', method);
  // Form-encoded works for every Web API method; JSON bodies are refused by some read methods.
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 429) throw new SlackError('ratelimited', method);
  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new SlackError(data.error ?? `http_${res.status}`, method);
  return data;
};

export function setSlackCall(fn: typeof slackCall) { slackCall = fn; }

export const slackConfigured = () => Boolean(setting('slack_bot_token') && setting('slack_app_token'));

export async function testSlack() {
  const auth = await slackCall('auth.test');
  // Opening a connection is the only way to prove the app token works; the URL is thrown away.
  await slackCall('apps.connections.open', {}, setting('slack_app_token'));
  return { message: `Connected to ${auth.team} as @${auth.user}. Socket Mode is working.` };
}

// ── Socket Mode ────────────────────────────────────────────────────────────

export interface SlackEnvelope { type: string; payload: any }
type Handler = (e: SlackEnvelope) => Promise<void> | void;

let socket: WebSocket | null = null;
let handler: Handler | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let generation = 0;
export const slackState = { connected: false, since: '', botUserId: '', team: '' };

function schedule(ms: number) {
  if (retry) clearTimeout(retry);
  retry = setTimeout(() => void connect(), ms);
}

async function connect() {
  retry = null;
  const gen = ++generation;
  if (!handler || !slackConfigured()) {
    slackState.connected = false;
    schedule(60_000); // tokens may be added later; Settings also restarts us directly
    return;
  }
  try {
    const auth = await slackCall('auth.test');
    slackState.botUserId = auth.user_id;
    slackState.team = auth.team;
    const { url } = await slackCall('apps.connections.open', {}, setting('slack_app_token'));
    if (gen !== generation) return;
    const ws = new WebSocket(url);
    socket = ws;
    ws.onmessage = (m) => {
      let msg: any;
      try { msg = JSON.parse(String(m.data)); } catch { return; }
      if (msg.type === 'hello') {
        attempt = 0;
        slackState.connected = true;
        slackState.since = new Date().toISOString();
        clearIssue('slack');
        return;
      }
      if (msg.type === 'disconnect') { ws.close(); return; } // Slack rotates connections; reconnect below
      // Acknowledge first: Slack retries anything not acked within three seconds, and the work
      // behind an event (a model call) takes longer than that.
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.retry_attempt) return; // already handled the first time
      if (msg.payload && handler) {
        Promise.resolve(handler({ type: msg.type, payload: msg.payload }))
          .catch((e) => console.error('[slack]', errMsg(e)));
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      slackState.connected = false;
      schedule(1_000);
    };
    ws.onerror = () => { /* onclose follows */ };
  } catch (e) {
    slackState.connected = false;
    reportIssue('slack', e);
    attempt++;
    schedule(Math.min(300_000, 5_000 * 2 ** Math.min(attempt, 6)));
  }
}

export function startSocket(h: Handler) {
  handler = h;
  restartSocket();
}

/** After the tokens change: drop the connection and dial again with the new ones. */
export function restartSocket() {
  generation++;
  attempt = 0;
  const old = socket;
  socket = null;
  slackState.connected = false;
  try { old?.close(); } catch { /* already closed */ }
  schedule(500);
}

/** A ready-to-paste app manifest with exactly the permissions the bridge uses. */
export const SLACK_MANIFEST = {
  display_information: { name: 'Nightshift', description: 'Your AI company team', background_color: '#15161b' },
  features: {
    bot_user: { display_name: 'Nightshift', always_online: true },
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
  },
  oauth_config: {
    scopes: {
      bot: [
        'app_mentions:read', 'channels:history', 'groups:history', 'im:history',
        'chat:write', 'chat:write.customize', 'reactions:write', 'users:read',
      ],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im'] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};
