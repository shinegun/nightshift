// The night office: an isometric room where each desk is one agent. Everything that moves here
// is driven by replay state (see tape.ts): a desk lights up while its bot is mid-task, a card
// crosses the floor when work is handed over, a sheet goes to the wall when a document is filed.
import { AnimatePresence, motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';
import { toolVerb, type Bubble, type OfficeState, type Packet, type TapeBot, type Who } from './tape.ts';

// 2:1 isometric grid. gx runs down-right, gy runs down-left; heights are in drawing units.
const HW = 40;
const HH = 20;
/** Furniture and faces were drawn against a 34px tile; S carries them to the tile in use. */
const S = HW / 34;
const Z = (units: number) => units * S;
const FLOOR = { w: 10.8, d: 9.8 };
const WALL = Z(150);
const VB = { x: -FLOOR.d * HW - 12, y: -WALL - 20, w: (FLOOR.w + FLOOR.d) * HW + 24, h: WALL + (FLOOR.w + FLOOR.d) * HH + 40 };

const X = (gx: number, gy: number) => (gx - gy) * HW;
const Y = (gx: number, gy: number, gz = 0) => (gx + gy) * HH - gz;
const P = (gx: number, gy: number, gz = 0) => `${X(gx, gy).toFixed(1)},${Y(gx, gy, gz).toFixed(1)}`;
const at = (gx: number, gy: number, gz = 0) => `translate(${X(gx, gy).toFixed(1)} ${Y(gx, gy, gz).toFixed(1)}) scale(${S.toFixed(3)})`;
/** A flat surface facing down-left (a plane of constant gy): local x runs along gx. */
const onLeftFace = (gx: number, gy: number, gz: number) => `matrix(${S} ${S / 2} 0 ${S} ${X(gx, gy).toFixed(1)} ${Y(gx, gy, gz).toFixed(1)})`;
/** A flat surface facing down-right (a plane of constant gx): local x runs toward the back corner. */
const onRightFace = (gx: number, gy: number, gz: number) => `matrix(${S} ${-S / 2} 0 ${S} ${X(gx, gy).toFixed(1)} ${Y(gx, gy, gz).toFixed(1)})`;

function Box({ x, y, z = 0, w, d, h, className }: { x: number; y: number; z?: number; w: number; d: number; h: number; className?: string }) {
  return (
    <g className={className}>
      <polygon className="face-r" points={`${P(x + w, y, z + h)} ${P(x + w, y + d, z + h)} ${P(x + w, y + d, z)} ${P(x + w, y, z)}`} />
      <polygon className="face-l" points={`${P(x, y + d, z + h)} ${P(x + w, y + d, z + h)} ${P(x + w, y + d, z)} ${P(x, y + d, z)}`} />
      <polygon className="face-t" points={`${P(x, y, z + h)} ${P(x + w, y, z + h)} ${P(x + w, y + d, z + h)} ${P(x, y + d, z + h)}`} />
    </g>
  );
}

// ── Where everything stands ──────────────────────────────────────────────────

const DESK = { w: 2.4, d: 1, h: Z(22) };
const SEATS: Record<string, [number, number]> = {
  ceo: [4.2, 1.3],
  research: [0.9, 3.9], engineer: [4.2, 3.9], marketing: [7.5, 3.9],
  outreach: [0.9, 6.9], support: [4.2, 6.9], ops: [7.5, 6.9],
};
/** A bot the tape brings that has no desk of its own takes the spare one by the CEO. */
const SPARE: [number, number][] = [[7.5, 1.3]];
const TRAY = { x: 6.5, y: 8.6, w: 1.2, d: 0.8, h: Z(16) };

const PLACES: Record<string, [number, number]> = {
  '@docs': [X(8.4, 0), Y(8.4, 0, Z(92))],
  '@done': [X(0, 7.8), Y(0, 7.8, Z(92))],
  '@outbox': [X(TRAY.x + 0.6, TRAY.y + 0.4), Y(TRAY.x + 0.6, TRAY.y + 0.4, Z(30))],
  '@model': [X(0.8, 0.8), Y(0.8, 0.8, Z(78))],
};

export function seatsFor(bots: TapeBot[]): { who: Who; name: string; color: string; gx: number; gy: number }[] {
  let spare = 0;
  const seats = [{ who: 'ceo', name: 'CEO', color: 'moon', gx: SEATS.ceo[0], gy: SEATS.ceo[1] }];
  for (const b of bots) {
    const seat = SEATS[b.key] ?? SPARE[spare++];
    if (seat) seats.push({ who: b.key, name: b.name, color: b.color, gx: seat[0], gy: seat[1] });
  }
  // Painter's order: whatever is nearer the viewer is drawn later.
  return seats.sort((a, b) => a.gx + a.gy - (b.gx + b.gy));
}

const headOf = (gx: number, gy: number): [number, number] => [X(gx + 0.5, gy - 0.3), Y(gx + 0.5, gy - 0.3, Z(52))];

// ── A desk and whoever sits at it ────────────────────────────────────────────

function Face({ mood }: { mood: 'idle' | 'working' }) {
  return (
    <g className="bot-face">
      {mood === 'working'
        ? <g className="eyes"><rect x="-6.5" y="-2" width="5" height="2.6" rx="1.3" /><rect x="2.5" y="-2" width="5" height="2.6" rx="1.3" /></g>
        : <g className="eyes"><circle cx="-4" cy="-1" r="1.9" /><circle cx="4.5" cy="-1" r="1.9" /></g>}
      <path className="mouth" d={mood === 'working' ? 'M-2.5 5.2 q3 1.6 6 0' : 'M-3.5 4.6 q4 3.4 8 0'} />
    </g>
  );
}

function Station({ name, color, gx, gy, working, pulses }: { name: string; color: string; gx: number; gy: number; working: boolean; pulses: number }) {
  const [hx, hy] = headOf(gx, gy);
  const top = DESK.h;
  const mon = { x: gx + 1.1, y: gy + 0.3, w: 1.2, h: Z(31), z: top + Z(7) };
  return (
    <g className={`station c-${color}${working ? ' is-working' : ''}`}>
      <polygon className="station-tile" points={`${P(gx - 0.25, gy - 0.85)} ${P(gx + DESK.w + 0.25, gy - 0.85)} ${P(gx + DESK.w + 0.25, gy + DESK.d + 0.25)} ${P(gx - 0.25, gy + DESK.d + 0.25)}`} />

      {/* The bot: a moon for a head, shoulders in its own colour. It sits behind the desk. */}
      <g transform={`translate(${hx.toFixed(1)} ${hy.toFixed(1)}) scale(${S.toFixed(3)})`}>
        <g className="bot-bob">
          <path className="bot-body" d="M-14 36 v-13 q0 -12 14 -12 q14 0 14 12 v13 z" />
          <circle className="bot-head" r="14.5" />
          <circle className="bot-crater" cx="7.5" cy="-7.5" r="2.3" />
          <Face mood={working ? 'working' : 'idle'} />
        </g>
      </g>

      <Box className="desk" x={gx} y={gy} w={DESK.w} d={DESK.d} h={top} />
      <g transform={onLeftFace(gx + 0.12, gy + DESK.d, top - Z(5))}>
        <rect className="plate" width={name.length * 5.6 + 12} height="12" rx="2" />
        <text className="plate-text" x="6" y="9">{name.toUpperCase()}</text>
      </g>

      {/* Hands on the desk, which is the only part of typing you can see from here. */}
      <g className="hands" transform={at(gx + 0.5, gy + 0.3, top)}>
        <ellipse className="hand hand-a" cx="-7" cy="0" rx="3.4" ry="2.4" />
        <ellipse className="hand hand-b" cx="6" cy="3" rx="3.4" ry="2.4" />
      </g>

      {/* The monitor faces the room so you can tell from across it who is busy. */}
      <Box className="mon-stand" x={mon.x + mon.w / 2 - 0.1} y={mon.y - 0.05} z={top} w={0.2} d={0.14} h={Z(8)} />
      <Box className="mon" x={mon.x} y={mon.y - 0.07} z={mon.z} w={mon.w} d={0.07} h={mon.h} />
      <g className="screen" transform={onLeftFace(mon.x, mon.y, mon.z + mon.h)}>
        <rect className="screen-glass" x="2" y="2" width={mon.w * 34 - 4} height="27" rx="1.5" />
        {/* Remounted on each tool call, so the lines redraw: a new page on the screen. */}
        <g key={pulses} className="screen-lines">
          <rect x="6" y="6.5" width="18" height="2.4" rx="1.2" />
          <rect x="6" y="11.5" width="28" height="2.4" rx="1.2" />
          <rect x="6" y="16.5" width="13" height="2.4" rx="1.2" />
          <rect x="6" y="21.5" width="23" height="2.4" rx="1.2" />
        </g>
      </g>
      <ellipse className="lamp" cx={X(gx + 1.2, gy + 0.5)} cy={Y(gx + 1.2, gy + 0.5, top)} rx={Z(46)} ry={Z(23)} />
    </g>
  );
}

// ── The room ─────────────────────────────────────────────────────────────────

const STARS: [number, number, number][] = [[14, 12, 1.2], [38, 30, 0.9], [61, 9, 1.1], [83, 26, 0.8], [104, 14, 1.3], [118, 40, 0.9], [27, 52, 0.8], [72, 48, 1], [96, 58, 0.8]];

function Room({ state }: { state: OfficeState }) {
  const lines = [];
  for (let i = 1; i < FLOOR.w; i++) lines.push(<line key={`a${i}`} x1={X(i, 0)} y1={Y(i, 0)} x2={X(i, FLOOR.d)} y2={Y(i, FLOOR.d)} />);
  for (let j = 1; j < FLOOR.d; j++) lines.push(<line key={`b${j}`} x1={X(0, j)} y1={Y(0, j)} x2={X(FLOOR.w, j)} y2={Y(FLOOR.w, j)} />);
  const papers = state.docs.slice(-6);
  const done = state.tasks.filter((t) => t.status === 'done').length;
  return (
    <g className="room">
      <polygon className="wall wall-l" points={`${P(0, 0)} ${P(0, FLOOR.d)} ${P(0, FLOOR.d, WALL)} ${P(0, 0, WALL)}`} />
      <polygon className="wall wall-r" points={`${P(0, 0)} ${P(FLOOR.w, 0)} ${P(FLOOR.w, 0, WALL)} ${P(0, 0, WALL)}`} />
      <polygon className="floor" points={`${P(0, 0)} ${P(FLOOR.w, 0)} ${P(FLOOR.w, FLOOR.d)} ${P(0, FLOOR.d)}`} />
      <g className="floor-lines">{lines}</g>

      {/* Left wall: the window (it is night), then the tally of finished work. */}
      <g transform={onRightFace(0, 5.5, Z(128))}>
        <rect className="window" width="136" height="78" rx="3" />
        {STARS.map(([x, y, r], i) => <circle key={i} className="star" cx={x} cy={y} r={r} style={{ animationDelay: `${(i * 0.7) % 4}s` }} />)}
        <circle className="sky-moon" cx="104" cy="30" r="13" />
        <circle className="sky-moon-bite" cx="98" cy="26" r="11" />
        <line className="window-bar" x1="68" y1="0" x2="68" y2="78" />
      </g>
      <g transform={onRightFace(0, 9.4, Z(122))}>
        <rect className="board" width="112" height="66" rx="3" />
        <text className="board-title" x="9" y="16">DONE</text>
        {state.tasks.length > 0 && (
          <text key={done} className="board-count" x="9" y="54">
            {done}<tspan className="board-of" dx="5">of {state.tasks.length}</tspan>
          </text>
        )}
      </g>

      {/* Right wall: every document the team files gets pinned up. */}
      <g transform={onLeftFace(6.1, 0, Z(128))}>
        <rect className="board" width="150" height="76" rx="3" />
        <text className="board-title" x="9" y="16">DOCUMENTS</text>
        {papers.map((d, i) => (
          <g key={`${d.kind}${d.title}`} transform={`translate(${10 + (i % 3) * 46} ${23 + Math.floor(i / 3) * 26})`}>
            <g className="paper">
              <rect width="40" height="21" rx="1.5" />
              <text x="4" y="9">{d.kind.slice(0, 8).toUpperCase()}</text>
              <line x1="4" y1="13" x2="30" y2="13" /><line x1="4" y1="17" x2="22" y2="17" />
            </g>
          </g>
        ))}
      </g>
      <g transform={onLeftFace(1.5, 0, Z(108))}>
        <text className="wall-sign" x="0" y="0">NIGHTSHIFT</text>
      </g>

      {/* The model, in the corner. Its lights run whenever anyone calls it. */}
      <Box className="rack" x={0.3} y={0.3} w={1} d={1} h={Z(72)} />
      <g key={state.llmCalls} className={`rack-leds${state.llmCalls ? ' is-hot' : ''}`} transform={onLeftFace(0.3, 1.3, Z(72))}>
        {[0, 1, 2, 3, 4].map((r) => (
          <g key={r} transform={`translate(5 ${8 + r * 11})`}>
            <rect className="rack-slot" width="24" height="6" rx="1" />
            <circle className="led" cx="4" cy="3" r="1.4" style={{ animationDelay: `${r * 60}ms` }} />
            <circle className="led" cx="9" cy="3" r="1.4" style={{ animationDelay: `${r * 60 + 90}ms` }} />
          </g>
        ))}
      </g>
      <g transform={onRightFace(1.3, 1.3, Z(64))}><text className="rack-label" x="5" y="0">MODEL</text></g>
    </g>
  );
}

function Plant({ gx, gy }: { gx: number; gy: number }) {
  return (
    <g className="plant" transform={at(gx, gy)}>
      <ellipse className="shadow" cx="0" cy="2" rx="13" ry="6" />
      <path className="leaf" d="M0 -14 q-16 -10 -13 -30 q12 8 13 30z" />
      <path className="leaf leaf-b" d="M0 -14 q16 -12 15 -34 q-13 10 -15 34z" />
      <path className="leaf" d="M0 -14 q-2 -22 3 -40 q6 18 -3 40z" />
      <path className="pot" d="M-9 -14 h18 l-3 15 h-12z" />
    </g>
  );
}

/** The owner's tray. Anything meant for the outside world stops here until a human says yes. */
function Outbox({ waiting }: { waiting: number }) {
  const cx = TRAY.x + TRAY.w / 2, cy = TRAY.y + TRAY.d / 2;
  return (
    <g className={`outbox${waiting ? ' has-mail' : ''}`}>
      <Box className="tray-table" x={TRAY.x} y={TRAY.y} w={TRAY.w} d={TRAY.d} h={TRAY.h} />
      <g transform={at(cx, cy, TRAY.h)}>
        {Array.from({ length: Math.min(waiting, 4) }, (_, i) => (
          <g key={i} className="envelope" transform={`translate(-11 ${-7 - i * 3.2})`}>
            <path d="M0 5.5 l11 -5.5 l11 5.5 l-11 5.5z" /><path className="flap" d="M0 5.5 l11 3 l11 -3" />
          </g>
        ))}
        <rect className="tray-pill" x="-56" y="24" width="112" height="19" rx="9.5" />
        <text className="tray-text" y="37.5" textAnchor="middle">{waiting ? `${waiting} waiting for a yes` : 'Needs your yes'}</text>
      </g>
    </g>
  );
}

// ── Things that travel ───────────────────────────────────────────────────────

function PacketShape({ kind }: { kind: Packet['kind'] }) {
  switch (kind) {
    case 'model': return <circle className="pk-spark" r="2.6" />;
    case 'done': return <g className="pk-done"><circle r="7.5" /><path d="M-3.4 0.2 l2.4 2.6 l4.6 -5.4" /></g>;
    case 'draft': return <g className="pk-mail"><rect x="-9" y="-6" width="18" height="12" rx="1.5" /><path d="M-9 -5 l9 6.5 l9 -6.5" /></g>;
    case 'ask': return <g className="pk-ask"><rect x="-8" y="-8" width="16" height="16" rx="3" /><text y="4.4" textAnchor="middle">?</text></g>;
    case 'doc': return <g className="pk-doc"><rect x="-7" y="-9" width="14" height="18" rx="1.5" /><line x1="-4" y1="-4" x2="4" y2="-4" /><line x1="-4" y1="0" x2="4" y2="0" /><line x1="-4" y1="4" x2="1" y2="4" /></g>;
    default: return <g className="pk-task"><rect x="-10" y="-7" width="20" height="14" rx="2" /><rect className="pk-stripe" x="-10" y="-7" width="4" height="14" rx="2" /><line x1="-3" y1="-2" x2="6" y2="-2" /><line x1="-3" y1="2" x2="3" y2="2" /></g>;
  }
}

function Flight({ packet, anchors, speed, onDone }: { packet: Packet; anchors: Record<string, [number, number]>; speed: number; onDone: (key: number) => void }) {
  const a = anchors[packet.from] ?? anchors.ceo;
  const b = anchors[packet.to] ?? PLACES[packet.to] ?? a;
  const quick = packet.kind === 'model';
  const lift = Z(quick ? 14 : 46);
  const duration = (quick ? 0.42 : 0.95) / Math.max(1, speed * 0.7);
  return (
    <motion.g
      className={`flight${packet.to.startsWith('@') ? '' : ` to-${packet.to}`}`}
      initial={{ x: a[0], y: a[1] - 14, opacity: 0, scale: 0.6 }}
      animate={{ x: [a[0], (a[0] + b[0]) / 2, b[0]], y: [a[1] - 14, Math.min(a[1], b[1]) - lift, b[1] - (quick ? 0 : 10)], opacity: [0, 1, 1, 0], scale: [0.6, 1, 0.9] }}
      transition={{ duration, ease: 'easeInOut', times: [0, 0.5, 1], opacity: { duration, times: [0, 0.12, 0.85, 1] } }}
      onAnimationComplete={() => onDone(packet.key)}
    >
      <g transform={`scale(${(S * 1.15).toFixed(3)})`}><PacketShape kind={packet.kind} /></g>
    </motion.g>
  );
}

// ── Speech bubbles (HTML, so the text stays readable at any size) ────────────

function BubbleBody({ b }: { b: Bubble }): ReactNode {
  if (b.kind === 'call') return <><b>{toolVerb(b.tool ?? '')}</b>{b.text ? ` ${b.text}` : ''}</>;
  if (b.kind === 'thinking') return <i>{b.text}</i>;
  return b.text;
}

export function Office({ bots, state, packets, speed, onPacketDone }: {
  bots: TapeBot[]; state: OfficeState; packets: Packet[]; speed: number; onPacketDone: (key: number) => void;
}) {
  const seats = seatsFor(bots);
  const anchors: Record<string, [number, number]> = Object.fromEntries(seats.map((s) => [s.who, headOf(s.gx, s.gy)]));
  const pct = (x: number, y: number): CSSProperties => ({ left: `${((x - VB.x) / VB.w) * 100}%`, top: `${((y - VB.y) / VB.h) * 100}%` });

  return (
    <div className="office" style={{ aspectRatio: `${VB.w} / ${VB.h}` }}>
      <svg viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`} role="img" aria-label="An isometric office at night. Seven agents sit at desks; work travels between them as it is handed over.">
        <defs>
          <radialGradient id="lampGlow"><stop offset="0" stopColor="var(--lamp)" stopOpacity="0.5" /><stop offset="1" stopColor="var(--lamp)" stopOpacity="0" /></radialGradient>
          <linearGradient id="skyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#141a33" /><stop offset="1" stopColor="#2a3158" /></linearGradient>
        </defs>
        <Room state={state} />
        <Plant gx={10} gy={0.9} />
        {seats.map((s) => (
          <Station key={s.who} name={s.name} color={s.color} gx={s.gx} gy={s.gy} working={state.desks[s.who]?.working ?? false} pulses={state.desks[s.who]?.pulses ?? 0} />
        ))}
        <Outbox waiting={state.drafts.length + state.asks.length} />
        <Plant gx={0.8} gy={8.9} />
        <g className="flights">
          {packets.map((p) => <Flight key={p.key} packet={p} anchors={anchors} speed={speed} onDone={onPacketDone} />)}
        </g>
      </svg>

      <div className="bubbles" aria-hidden="true">
        <AnimatePresence>
          {seats.map((s) => {
            const b = state.desks[s.who]?.bubble;
            if (!b || (!b.text && b.kind !== 'call')) return null;
            const [x, y] = headOf(s.gx, s.gy);
            return (
              <motion.div
                key={s.who}
                className={`bubble c-${s.color} k-${b.kind}`}
                style={pct(x, y - Z(22))}
                initial={{ opacity: 0, y: 6, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.96 }}
                transition={{ type: 'spring', stiffness: 320, damping: 26 }}
              >
                <span className="bubble-who">{s.name}</span>
                <span className="bubble-text"><BubbleBody b={b} /></span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
