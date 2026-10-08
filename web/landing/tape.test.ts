import assert from 'node:assert/strict';
import test from 'node:test';
import { cursorAt, fmtTokens, initialState, packetFor, stateAt, timeline, type Tape, type TapeEvent } from './tape.ts';

const events: TapeEvent[] = [
  { t: 0, k: 'doc', kind: 'mission', title: 'Acorn Mission', by: 'ceo' },
  { t: 10, k: 'say', text: 'Wrote the mission' },
  { t: 20, k: 'task_new', id: 1, title: 'Market research', type: 'research', bot: 'research', from: 'ceo' },
  { t: 30, k: 'task_start', id: 1 },
  { t: 40_000, k: 'llm', who: 'research', tok: 1200, cost: 0.002 },
  { t: 40_010, k: 'step', id: 1, kind: 'call', tool: 'web_search', arg: 'oak nurseries pricing' },
  { t: 41_000, k: 'step', id: 1, kind: 'result', text: '5 results' },
  { t: 41_500, k: 'task_new', id: 2, title: 'Build the pricing page', type: 'feature', bot: 'engineer', from: 'research' },
  { t: 300_000, k: 'task_end', id: 1, status: 'done', steps: 3, result: 'Filed.' },
  { t: 300_010, k: 'draft', i: 0, what: 'post', by: 'ceo' },
  { t: 300_020, k: 'say', text: 'Drafted an email to •••@oak.example — waiting for your approval 🎉' },
];
const tape = {
  bots: [{ key: 'research', name: 'Research', color: 'green' }, { key: 'engineer', name: 'Engineer', color: 'blue' }],
  events,
} as Tape;

test('timeline keeps order, squeezes the waiting and lands on the target length', () => {
  const at = timeline(events, 10_000);
  assert.equal(at.length, events.length);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `event ${i} is not after event ${i - 1}`);
  assert.ok(Math.abs(at.at(-1)! - 10_000) < 1);
  // A 40-second model call and a 4-minute one are both capped: neither may take over the replay.
  assert.ok(at[4] - at[3] === at[8] - at[7]);
});

test('cursorAt counts the events that have happened by a moment', () => {
  const at = [100, 200, 200, 300];
  assert.equal(cursorAt(at, 0), 0);
  assert.equal(cursorAt(at, 100), 1);
  assert.equal(cursorAt(at, 250), 3);
  assert.equal(cursorAt(at, 9999), 4);
});

test('a task lights its bot desk, counts its tool calls and clears when it ends', () => {
  const mid = stateAt(tape, 7);
  assert.equal(mid.named, true);
  assert.equal(mid.desks.research.working, true);
  assert.equal(mid.desks.research.bubble?.tool, 'web_search');
  assert.equal(mid.desks.ceo.working, false);
  assert.deepEqual([mid.toolCalls, mid.llmCalls, mid.tokens], [1, 1, 1200]);
  assert.equal(mid.tasks[0].status, 'running');

  const end = stateAt(tape, events.length);
  assert.equal(end.desks.research.working, false);
  assert.equal(end.desks.research.done, 1);
  assert.deepEqual(end.tasks.map((t) => t.status), ['done', 'todo']);
  assert.deepEqual(end.drafts, [0]);
  assert.equal(end.feed.at(-1)?.text, 'Drafted an email to •••@oak.example: waiting for your approval');
});

test('the CEO speaks while planning, not for a bot that finished, and goes quiet once the company is live', () => {
  const say = (t: number, text: string): TapeEvent => ({ t, k: 'say', text });
  const run = { bots: tape.bots, events: [say(0, 'Sketching your product roadmap…'), say(1, 'Finished: Market research'), say(2, 'Your company is live!'), say(3, 'Finished: Build the landing page')] } as Tape;
  assert.equal(stateAt(run, 1).desks.ceo.bubble?.text, 'Sketching your product roadmap…');
  assert.equal(stateAt(run, 2).desks.ceo.bubble?.text, 'Sketching your product roadmap…');
  assert.deepEqual([stateAt(run, 3).desks.ceo.bubble, stateAt(run, 4).desks.ceo.working], [null, false]);
});

test('scrubbing forward from a state gives the same result as replaying from the start', () => {
  const resumed = stateAt(tape, 9, stateAt(tape, 4));
  assert.deepEqual(resumed, stateAt(tape, 9));
  // Backwards cannot be undone event by event, so it starts over.
  assert.deepEqual(stateAt(tape, 2, stateAt(tape, 9)), stateAt(tape, 2));
});

test('handoffs, documents and drafts travel; a bot giving itself a task does not', () => {
  const s = stateAt(tape, events.length);
  assert.deepEqual(packetFor(events[7], 7, s), { key: 7, kind: 'task', from: 'research', to: 'engineer' });
  assert.deepEqual(packetFor(events[0], 0, s), { key: 0, kind: 'doc', from: 'ceo', to: '@docs' });
  assert.deepEqual(packetFor(events[8], 8, s), { key: 8, kind: 'done', from: 'research', to: '@done' });
  assert.equal(packetFor({ t: 0, k: 'task_new', id: 9, title: '', type: 'research', bot: 'research', from: 'research' }, 1, s), null);
  assert.equal(packetFor(events[1], 1, initialState(tape)), null);
});

test('token counts read at a glance', () => {
  assert.deepEqual([900, 1500, 756_000, 3_467_000].map(fmtTokens), ['900', '1.5k', '756k', '3.47M']);
});
