// A tape is one recorded Nightshift run (scripts/record-demo.mts). This file turns it into what
// the office shows at any moment of the replay. No React here, so it can be tested on its own.

export type Who = string; // a bot key ('engineer', 'research', …) or 'ceo'

export type TapeEvent =
  | { t: number; k: 'say'; text: string }
  | { t: number; k: 'task_new'; id: number; title: string; type: string; bot: Who; from: Who }
  | { t: number; k: 'task_start'; id: number }
  | { t: number; k: 'task_end'; id: number; status: string; steps: number; result: string }
  | { t: number; k: 'step'; id: number; kind: 'call'; tool: string; arg: string }
  | { t: number; k: 'step'; id: number; kind: 'result' | 'thinking' | 'message' | 'error'; text: string }
  | { t: number; k: 'doc'; kind: string; title: string; by: Who }
  | { t: number; k: 'draft'; i: number; what: 'email' | 'post'; by: Who }
  | { t: number; k: 'note'; bot: Who; text: string }
  | { t: number; k: 'ask'; title: string; why: string; by: Who }
  | { t: number; k: 'llm'; who: Who; tok: number; cost: number };

export interface TapeBot { key: string; name: string; color: string }
export interface TapeDoc { kind: string; title: string; content: string }
export interface TapeDraft { what: 'email' | 'post'; to: string; subject: string; body: string; status: string }

export interface Tape {
  version: 1;
  id: string;
  recordedAt: string;
  durationMs: number;
  model: string;
  idea: string;
  company: { name: string; tagline: string; status: string };
  bots: TapeBot[];
  totals: { tasks: number; done: number; steps: number; toolCalls: number; llmCalls: number; tokens: number; costUsd: number; drafts: number; asks: number };
  events: TapeEvent[];
  docs: TapeDoc[];
  outbox: TapeDraft[];
  site: string | null;
}

export interface TapeIndexEntry { id: string; idea: string; name: string; tagline: string; recordedAt: string; durationMs: number }

// ── Playback time ────────────────────────────────────────────────────────────

/** How long the whole replay runs at 1×. A real run is ten to twenty minutes of mostly waiting. */
export const TARGET_MS = 85_000;
const MIN_GAP = 45;
const MAX_GAP = 1100;

/**
 * Where each event falls on the replay clock. Real gaps are mostly a model thinking, so they are
 * squeezed hard and capped: a 40-second call and a 4-minute one both become "a beat". Order and
 * relative rhythm survive; the waiting does not.
 */
export function timeline(events: TapeEvent[], target = TARGET_MS): number[] {
  const at: number[] = [];
  let clock = 600; // a breath before the first event
  for (let i = 0; i < events.length; i++) {
    if (i > 0) clock += Math.min(MAX_GAP, Math.max(MIN_GAP, (events[i].t - events[i - 1].t) / 30));
    at.push(clock);
  }
  const scale = clock > 0 ? target / clock : 1;
  return at.map((v) => v * scale);
}

/** How many events have happened by `ms` on the replay clock. */
export function cursorAt(at: number[], ms: number): number {
  let lo = 0, hi = at.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (at[mid] <= ms) lo = mid + 1; else hi = mid; }
  return lo;
}

// ── Office state ─────────────────────────────────────────────────────────────

export type TaskStatus = 'todo' | 'running' | 'done' | 'failed' | 'blocked' | 'cancelled';
export interface TaskView { id: number; title: string; type: string; bot: Who; from: Who; status: TaskStatus; steps: number; result: string }
export interface Bubble { kind: 'call' | 'thinking' | 'message' | 'error' | 'plan'; tool?: string; text: string; seq: number }
export interface Desk { working: boolean; taskId: number | null; bubble: Bubble | null; pulses: number; done: number }

export interface OfficeState {
  /** Events applied so far. */
  cursor: number;
  /** Real seconds into the recording. */
  realMs: number;
  named: boolean;
  live: boolean;
  feed: { seq: number; text: string }[];
  tasks: TaskView[];
  desks: Record<Who, Desk>;
  docs: { kind: string; title: string; by: Who }[];
  drafts: number[];
  asks: { title: string; why: string; by: Who }[];
  notes: number;
  tokens: number;
  cost: number;
  llmCalls: number;
  toolCalls: number;
}

const FEED_MAX = 40;
const TASK_LINE = /^(working on|finished|needs you|failed|paused|resuming|ran out|cancelled|drafted an email)\b/i;
/** Activity lines are written for the dashboard's terminal feed. Here they lose the decoration. */
const tidy = (text: string) => text.replace(/\s+[\u2014\u2013]\s+/g, ': ').replace(/\s*\p{Extended_Pictographic}\uFE0F?/gu, '').trim();
const desk = (): Desk => ({ working: false, taskId: null, bubble: null, pulses: 0, done: 0 });

export function initialState(tape: Pick<Tape, 'bots'>): OfficeState {
  const desks: Record<Who, Desk> = { ceo: desk() };
  for (const b of tape.bots) desks[b.key] = desk();
  return {
    cursor: 0, realMs: 0, named: false, live: false, feed: [], tasks: [], desks, docs: [], drafts: [], asks: [],
    notes: 0, tokens: 0, cost: 0, llmCalls: 0, toolCalls: 0,
  };
}

/** Applies one event. Returns a new state; the old one is left alone so React can compare. */
export function apply(prev: OfficeState, e: TapeEvent): OfficeState {
  const s: OfficeState = { ...prev, cursor: prev.cursor + 1, realMs: e.t };
  const seq = s.cursor;
  const setDesk = (who: Who, patch: Partial<Desk>) => { s.desks = { ...s.desks, [who]: { ...(s.desks[who] ?? desk()), ...patch } }; };
  const setTask = (id: number, patch: Partial<TaskView>) => { s.tasks = s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)); };
  const ownerOf = (id: number) => s.tasks.find((t) => t.id === id)?.bot ?? 'ceo';

  switch (e.k) {
    case 'say':
      s.feed = [...s.feed, { seq, text: tidy(e.text) }].slice(-FEED_MAX);
      if (/^wrote the mission/i.test(e.text)) s.named = true;
      if (/is live/i.test(e.text)) s.live = true;
      // During setup the CEO is the one talking between tasks: writing the mission, planning the
      // roadmap. Lines about a task belong to the bot that worked it, and are not the CEO's to say.
      if (s.live) setDesk('ceo', { working: false, bubble: null });
      else if (!TASK_LINE.test(e.text) && !Object.values(s.desks).some((d) => d.working && d.taskId !== null)) {
        setDesk('ceo', { working: true, bubble: { kind: 'plan', text: tidy(e.text), seq } });
      }
      break;
    case 'task_new':
      s.tasks = [...s.tasks, { id: e.id, title: e.title, type: e.type, bot: e.bot, from: e.from, status: 'todo', steps: 0, result: '' }];
      break;
    case 'task_start':
      setTask(e.id, { status: 'running' });
      setDesk('ceo', { working: false, bubble: null });
      setDesk(ownerOf(e.id), { working: true, taskId: e.id, bubble: null });
      break;
    case 'step': {
      const who = ownerOf(e.id);
      if (e.kind === 'call') {
        s.toolCalls += 1;
        setTask(e.id, { steps: (s.tasks.find((t) => t.id === e.id)?.steps ?? 0) + 1 });
        setDesk(who, { bubble: { kind: 'call', tool: e.tool, text: e.arg, seq }, pulses: (s.desks[who]?.pulses ?? 0) + 1 });
      } else if (e.kind !== 'result') {
        setDesk(who, { bubble: { kind: e.kind, text: e.text, seq } });
      }
      break;
    }
    case 'task_end': {
      const who = ownerOf(e.id);
      setTask(e.id, { status: e.status as TaskStatus, steps: e.steps, result: e.result });
      setDesk(who, { working: false, taskId: null, bubble: null, done: (s.desks[who]?.done ?? 0) + (e.status === 'done' ? 1 : 0) });
      break;
    }
    case 'doc':
      s.named = true;
      s.docs = [...s.docs.filter((d) => d.kind !== e.kind || d.title !== e.title), { kind: e.kind, title: e.title, by: e.by }];
      break;
    case 'draft':
      s.drafts = [...s.drafts, e.i];
      break;
    case 'ask':
      s.asks = [...s.asks, { title: e.title, why: e.why, by: e.by }];
      break;
    case 'note':
      s.notes += 1;
      break;
    case 'llm':
      s.llmCalls += 1;
      s.tokens += e.tok;
      s.cost += e.cost;
      break;
  }
  return s;
}

/** The office as it stood after `cursor` events. Scrubbing backwards replays from the start. */
export function stateAt(tape: Tape, cursor: number, from?: OfficeState): OfficeState {
  let s = from && from.cursor <= cursor ? from : initialState(tape);
  for (let i = s.cursor; i < cursor && i < tape.events.length; i++) s = apply(s, tape.events[i]);
  return s;
}

/** Something that visibly travels across the office when an event happens. */
export interface Packet { key: number; kind: 'task' | 'doc' | 'draft' | 'done' | 'ask' | 'model'; from: Who | Place; to: Who | Place }
export type Place = '@docs' | '@outbox' | '@done' | '@model';

export function packetFor(e: TapeEvent, seq: number, s: OfficeState): Packet | null {
  switch (e.k) {
    case 'task_new': return e.from === e.bot ? null : { key: seq, kind: 'task', from: e.from, to: e.bot };
    case 'doc': return { key: seq, kind: 'doc', from: e.by, to: '@docs' };
    case 'draft': return { key: seq, kind: 'draft', from: e.by, to: '@outbox' };
    case 'ask': return { key: seq, kind: 'ask', from: e.by, to: '@outbox' };
    case 'task_end': return e.status === 'done' ? { key: seq, kind: 'done', from: s.tasks.find((t) => t.id === e.id)?.bot ?? 'ceo', to: '@done' } : null;
    case 'llm': return { key: seq, kind: 'model', from: e.who, to: '@model' };
    default: return null;
  }
}

// ── Small formatters shared by the panel and the office ──────────────────────

export const fmtClock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
export const fmtCost = (usd: number) => `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;

const TOOL_VERBS: Record<string, string> = {
  web_search: 'Searching', fetch_url: 'Reading', open_page: 'Opening', list_files: 'Listing files', read_file: 'Reading',
  write_file: 'Writing', delete_file: 'Deleting', write_document: 'Filing', read_document: 'Reading', create_task: 'Handing off',
  remember: 'Noting', list_tasks: 'Checking the queue', ask_owner: 'Asking the owner', get_metrics: 'Checking numbers',
  send_email: 'Drafting email to', reply_email: 'Drafting reply', post_to_x: 'Drafting a post', read_inbox: 'Reading the inbox',
  git_status: 'Checking git', commit_changes: 'Preparing a commit', create_payment_link: 'Creating a payment link',
};
export const toolVerb = (tool: string) => TOOL_VERBS[tool] ?? tool.replace(/_/g, ' ');
