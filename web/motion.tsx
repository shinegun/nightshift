/**
 * Nightshift's motion vocabulary.
 *
 * One file so every surface moves the same way. The grammar is borrowed from fora.so — things
 * arrive by rising 24px and fading in, siblings arrive in sequence rather than all at once, and
 * the curve is symmetric and unhurried. What is *not* borrowed is the reason to move: fora is a
 * marketing page, so its motion is driven by scrolling. This is a dashboard you open at
 * breakfast, so ours is driven by change — a task finishing, an approval leaving the stack, a
 * number ticking up. Motion here is a way of showing what happened while you were not looking.
 *
 * Everything degrades to nothing under `prefers-reduced-motion`. That is not a courtesy: this is
 * a page people leave open all day, and a dashboard that will not sit still is a bad dashboard.
 */
import {
  AnimatePresence, MotionConfig, animate, motion, useMotionValue, useReducedMotion,
  type Transition, type Variants,
} from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export { AnimatePresence, motion };

/** fora.so's curve, lifted from its computed styles: symmetric, no overshoot, slightly lazy. */
export const EASE = [0.44, 0, 0.56, 1] as const;

/** A spring for things the pointer or a mood change drives, where overshoot reads as life. */
export const SPRING: Transition = { type: 'spring', stiffness: 260, damping: 24, mass: 0.9 };

export const DUR = {
  /** Entrances. Long enough to read as arriving, short enough not to be waited on. */
  rise: 0.45,
  /** Entrances you trigger yourself and are waiting on, like switching a tab. */
  swap: 0.3,
  /** Hovers, colour, small state flips. */
  quick: 0.2,
  /** How long a counter takes to walk to its new value. */
  count: 0.7,
} as const;

/**
 * The house entrance: up 24px, fade in. Used by everything that appears.
 *
 * `shown` deliberately carries no transition of its own so the nearest `MotionConfig` sets the
 * pace — that is what lets one `Stagger` say "these are cards you are waiting on, be quick"
 * without every card needing to know. `gone` does pin its own, because an exit should be brisk
 * everywhere: you have already decided, and watching it leave is not information.
 */
export const rise: Variants = {
  hidden: { opacity: 0, y: 24 },
  shown: { opacity: 1, y: 0 },
  gone: { opacity: 0, y: -8, transition: { duration: 0.15, ease: EASE } },
};

/**
 * A parent that hands its children their entrances one after another. `staggerChildren` is the
 * whole trick behind fora's "alive" feel — the same 24px rise looks mechanical when eight cards
 * do it in lockstep and looks composed when they do it 60ms apart.
 */
export const stagger = (gap = 0.06, delay = 0): Variants => ({
  hidden: {},
  shown: { transition: { staggerChildren: gap, delayChildren: delay } },
  gone: { transition: { staggerChildren: 0.015, staggerDirection: -1 } },
});

/** Wraps the app so every `motion` element below honours the OS reduced-motion setting. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user" transition={{ duration: DUR.rise, ease: EASE }}>{children}</MotionConfig>;
}

/**
 * Appears when scrolled into view, once. For the marketing-shaped surfaces (the home page),
 * where there is a fold to cross and nothing is changing underneath you.
 */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, margin: '0px 0px -80px 0px' }}
      variants={{ hidden: { opacity: 0, y: 24 }, shown: { opacity: 1, y: 0, transition: { duration: DUR.rise, ease: EASE, delay } } }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Appears on mount, children in sequence. For the dashboard, where arriving *is* the event.
 *
 * `dur`/`exitDur` exist because the right length depends on who asked. A card arriving on its
 * own can take its time; a screenful of cards you are waiting on after clicking a tab cannot —
 * switching a tab on a working dashboard has to feel immediate, so those pass shorter values.
 */
export function Stagger({ children, className, gap = 0.06, delay = 0, dur = DUR.rise }: {
  children: ReactNode; className?: string; gap?: number; delay?: number; dur?: number;
}) {
  return (
    <motion.div className={className} initial="hidden" animate="shown" exit="gone" variants={stagger(gap, delay)}>
      <MotionConfig transition={{ duration: dur, ease: EASE }}>{children}</MotionConfig>
    </motion.div>
  );
}

/** One child of a Stagger (or of any parent running the `rise` variants). */
export function Item({ children, className, ...rest }: { children: ReactNode; className?: string } & Record<string, unknown>) {
  return <motion.div className={className} variants={rise} {...rest}>{children}</motion.div>;
}

/**
 * A number that walks to its new value instead of jumping.
 *
 * It only animates on *change*, never on mount. The dashboard refetches on every activity event
 * and views remount when you switch tabs, so counting up from zero each time would turn a stat
 * you glance at into a stat you have to wait for. The point is to catch your eye when something
 * actually moved.
 */
export function Rolling({ value, format = (n: number) => String(Math.round(n)), className = '' }: {
  value: number; format?: (n: number) => string; className?: string;
}) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value);
  const fmt = useRef(format);
  fmt.current = format;
  const [text, setText] = useState(() => format(value));
  const [bump, setBump] = useState(false);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current === value) return;
    const grew = value > prev.current;
    prev.current = value;
    if (reduce) { setText(fmt.current(value)); mv.set(value); return; }
    setBump(grew);
    const controls = animate(mv, value, {
      duration: DUR.count, ease: EASE, onUpdate: (v) => setText(fmt.current(v)),
    });
    const t = setTimeout(() => setBump(false), 900);
    return () => { controls.stop(); clearTimeout(t); };
  }, [value, reduce, mv]);

  return <span className={`${className} ${bump ? 'rolled' : ''}`.trim()}>{text}</span>;
}

/**
 * Opens and closes on its own height. For the banners along the top of the app, which arrive
 * and leave while you are looking at the page underneath — shoving the whole layout down with
 * no warning is the thing worth fixing here.
 */
export function Collapse({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: DUR.quick, ease: EASE }}
      style={{ overflow: 'hidden' }}
    >
      {children}
    </motion.div>
  );
}

/** A row that slides in when it appears and collapses its own height when it leaves. */
export function Row({ children, className, layout = 'position', ...rest }: {
  children: ReactNode; className?: string; layout?: boolean | 'position';
} & Record<string, unknown>) {
  return (
    <motion.li
      className={className}
      layout={layout}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24, height: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }}
      transition={{ duration: DUR.rise, ease: EASE }}
      {...rest}
    >
      {children}
    </motion.li>
  );
}
