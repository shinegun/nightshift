// Playing a tape: the clock, the controls under the office, and the panel beside it.
import { AnimatePresence, motion, useMotionValue, useMotionValueEvent, useReducedMotion, type MotionValue } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cursorAt, fmtClock, fmtCost, fmtTokens, initialState, packetFor, stateAt, timeline,
  type OfficeState, type Packet, type Tape, type TapeBot,
} from './tape.ts';

const MAX_PACKETS = 14;
/** Past this many events in one frame it was a jump, not playback, and nothing should fly. */
const JUMP = 10;
const TAIL_MS = 1800;

export interface Replay {
  state: OfficeState;
  packets: Packet[];
  playing: boolean;
  ended: boolean;
  speed: number;
  progress: MotionValue<number>;
  totalMs: number;
  play: () => void;
  pause: () => void;
  restart: () => void;
  seek: (fraction: number) => void;
  setSpeed: (n: number) => void;
  dropPacket: (key: number) => void;
}

export function useReplay(tape: Tape | null): Replay {
  const at = useMemo(() => (tape ? timeline(tape.events) : []), [tape]);
  const totalMs = at.length ? at[at.length - 1] + TAIL_MS : 0;
  const reduce = useReducedMotion();

  const [state, setState] = useState<OfficeState>(() => initialState({ bots: tape?.bots ?? [] }));
  const [packets, setPackets] = useState<Packet[]>([]);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [speed, setSpeed] = useState(1);
  const progress = useMotionValue(0);
  const clock = useRef(0);
  const live = useRef(state);

  const jumpTo = useCallback((ms: number) => {
    if (!tape) return;
    clock.current = Math.max(0, Math.min(totalMs, ms));
    progress.set(totalMs ? clock.current / totalMs : 0);
    live.current = stateAt(tape, cursorAt(at, clock.current), live.current);
    setState(live.current);
    setPackets([]);
    setEnded(clock.current >= totalMs);
  }, [tape, at, totalMs, progress]);

  useEffect(() => {
    live.current = initialState({ bots: tape?.bots ?? [] });
    clock.current = 0;
    progress.set(0);
    setState(live.current);
    setPackets([]);
    setPlaying(false);
    setEnded(false);
  }, [tape, progress]);

  useEffect(() => {
    if (!playing || !tape) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // Capped, so a tab that was in the background resumes where it was instead of leaping ahead.
      const dt = Math.min(100, now - last);
      last = now;
      clock.current = Math.min(totalMs, clock.current + dt * speed);
      progress.set(clock.current / totalMs);
      const cursor = cursorAt(at, clock.current);
      const from = live.current.cursor;
      if (cursor > from) {
        const flying: Packet[] = [];
        let s = live.current;
        for (let i = from; i < cursor; i++) {
          s = stateAt(tape, i + 1, s);
          if (!reduce && cursor - from <= JUMP) { const p = packetFor(tape.events[i], i, s); if (p) flying.push(p); }
        }
        live.current = s;
        setState(s);
        if (flying.length) setPackets((prev) => [...prev, ...flying].slice(-MAX_PACKETS));
      }
      if (clock.current >= totalMs) { setPlaying(false); setEnded(true); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, tape, at, totalMs, progress, reduce]);

  return {
    state, packets, playing, ended, speed, progress, totalMs,
    play: () => { if (clock.current >= totalMs) jumpTo(0); setEnded(false); setPlaying(true); },
    pause: () => setPlaying(false),
    restart: () => { live.current = initialState({ bots: tape?.bots ?? [] }); jumpTo(0); setPlaying(true); },
    seek: (f) => jumpTo(f * totalMs),
    setSpeed,
    dropPacket: useCallback((key: number) => setPackets((prev) => prev.filter((p) => p.key !== key)), []),
  };
}

/**
 * The office before anyone presses play: desks take turns looking busy and a card goes round.
 * It is there to say "this moves" at a glance. It claims nothing; the replay is the real thing.
 */
export function useAmbient(bots: TapeBot[], active: boolean): { state: OfficeState; packets: Packet[]; dropPacket: (key: number) => void } {
  const reduce = useReducedMotion();
  const order = useMemo(() => ['ceo', ...bots.map((b) => b.key)], [bots]);
  const [turn, setTurn] = useState(0);
  const [packets, setPackets] = useState<Packet[]>([]);

  useEffect(() => {
    if (!active || reduce || order.length < 2) return;
    const id = setInterval(() => {
      setTurn((n) => {
        const from = order[(n * 3) % order.length], to = order[((n + 1) * 3) % order.length];
        setPackets((prev) => [...prev, { key: n, kind: 'task' as const, from, to }].slice(-3));
        return n + 1;
      });
    }, 2600);
    return () => clearInterval(id);
  }, [active, reduce, order]);
  useEffect(() => { if (!active) setPackets([]); }, [active]);

  const state = useMemo(() => {
    const s = initialState({ bots });
    const who = order[(turn * 3) % order.length];
    if (active && !reduce && s.desks[who]) s.desks[who] = { ...s.desks[who], working: true, pulses: turn };
    return s;
  }, [bots, order, turn, active, reduce]);

  return { state, packets, dropPacket: useCallback((key: number) => setPackets((prev) => prev.filter((p) => p.key !== key)), []) };
}

// ── Controls ─────────────────────────────────────────────────────────────────

const SPEEDS = [1, 2, 4];

export function Controls({ replay, onExit }: { replay: Replay; onExit: () => void }) {
  const range = useRef<HTMLInputElement>(null);
  const [clock, setClock] = useState('0:00');
  // The scrubber follows the clock without re-rendering anything: it is written to directly.
  useMotionValueEvent(replay.progress, 'change', (v) => {
    if (range.current && document.activeElement !== range.current) range.current.value = String(Math.round(v * 1000));
    range.current?.style.setProperty('--fill', `${(v * 100).toFixed(2)}%`);
    const next = fmtClock(v * replay.totalMs);
    setClock((prev) => (prev === next ? prev : next));
  });
  return (
    <div className="controls">
      <button type="button" className="btn btn-quiet ctl-play" onClick={replay.playing ? replay.pause : replay.play}>
        {replay.playing ? 'Pause' : replay.ended ? 'Replay' : 'Play'}
      </button>
      <label className="scrub">
        <span className="sr-only">Position in the replay</span>
        <input
          ref={range} type="range" min="0" max="1000" defaultValue="0"
          onChange={(e) => replay.seek(Number(e.target.value) / 1000)}
        />
      </label>
      <span className="ctl-time">{clock} / {fmtClock(replay.totalMs)}</span>
      <div className="speeds" role="group" aria-label="Playback speed">
        {SPEEDS.map((n) => (
          <button key={n} type="button" className={replay.speed === n ? 'is-on' : ''} aria-pressed={replay.speed === n} onClick={() => replay.setSpeed(n)}>{n}×</button>
        ))}
      </div>
      <button type="button" className="btn btn-quiet" onClick={onExit}>Close</button>
    </div>
  );
}

// ── The panel beside the office ──────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = { todo: 'Queued', running: 'Working', done: 'Done', failed: 'Stopped', blocked: 'Needs owner', cancelled: 'Cancelled' };

export function Panel({ tape, replay, onSeeOutput }: { tape: Tape; replay: Replay; onSeeOutput: () => void }) {
  const { state } = replay;
  const feed = useRef<HTMLOListElement>(null);
  useEffect(() => { feed.current?.scrollTo({ top: feed.current.scrollHeight }); }, [state.feed.length]);
  // Keep whichever task is being worked in view, without moving the page itself.
  const queue = useRef<HTMLUListElement>(null);
  const runningId = state.tasks.find((t) => t.status === 'running')?.id;
  useEffect(() => {
    const list = queue.current;
    const row = list?.querySelector<HTMLElement>('.s-running');
    if (list && row) list.scrollTo({ top: row.offsetTop - list.offsetTop - 44, behavior: 'smooth' });
  }, [runningId]);
  const colorOf = (who: string) => tape.bots.find((b) => b.key === who)?.color ?? 'moon';
  const nameOf = (who: string) => tape.bots.find((b) => b.key === who)?.name ?? 'CEO';
  const done = state.tasks.filter((t) => t.status === 'done').length;
  const recorded = new Date(tape.recordedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="panel">
      <p className="panel-idea"><span>The idea</span>{tape.idea}</p>

      <div className="panel-company" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {state.named ? (
            <motion.div key="named" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
              <h2>{tape.company.name}</h2>
              <p>{tape.company.tagline}</p>
            </motion.div>
          ) : (
            <motion.div key="unnamed" className="panel-waiting" exit={{ opacity: 0 }}>
              <h2>Naming the company</h2>
              <p>The CEO agent is writing the mission.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <dl className="stats">
        <div><dt>Real time</dt><dd>{fmtClock(state.realMs)}</dd></div>
        <div><dt>Tasks done</dt><dd>{done}<small> of {state.tasks.length}</small></dd></div>
        <div><dt>Tokens</dt><dd>{fmtTokens(state.tokens)}</dd></div>
        <div><dt>Spent</dt><dd>{fmtCost(state.cost)}</dd></div>
      </dl>

      <ol className="feed" ref={feed} aria-label="Activity">
        {state.feed.length === 0 && <li className="feed-empty">Waiting for the first line.</li>}
        {state.feed.map((f) => <li key={f.seq}>{f.text}</li>)}
      </ol>

      <ul className="queue" ref={queue} aria-label="Task queue">
        {state.tasks.map((t) => (
          <li key={t.id} className={`c-${colorOf(t.bot)} s-${t.status}`}>
            <span className="q-bot">{nameOf(t.bot)}</span>
            <span className="q-title">{t.title}</span>
            <span className="q-status">{STATUS_LABEL[t.status] ?? t.status}</span>
          </li>
        ))}
      </ul>

      <p className="panel-note">
        {replay.ended
          ? <button type="button" className="btn btn-primary" onClick={onSeeOutput}>See what they made</button>
          : <>Replay of a real run recorded on {recorded}. {fmtClock(tape.durationMs)} of work, shortened to {fmtClock(replay.totalMs)}.</>}
      </p>
    </div>
  );
}
