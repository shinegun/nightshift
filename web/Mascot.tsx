// The moon: Nightshift's mascot. Its face follows the company's mood.
import { AnimatePresence, SPRING, motion } from './motion.tsx';

export const MOODS: Record<string, { label: string; line: string }> = {
  booting: { label: 'Waking up', line: 'Setting up your company…' },
  working: { label: 'On shift', line: 'Working through the queue.' },
  triumphant: { label: 'Triumphant', line: 'Your company is live!' },
  idle: { label: 'Standing by', line: 'Ready for the next task.' },
  night: { label: 'Night shift', line: "Working while you sleep." },
  confused: { label: 'Stuck', line: 'Something needs your attention.' },
};

/** Moods whose eyes are already shut or are not eyes at all have nothing to blink with. */
const BLINKS = new Set(['idle', 'working', 'night', 'confused']);

function Eyes({ mood }: { mood: string }) {
  switch (mood) {
    case 'booting':
      return <g className="stroke"><path d="M36 46 q6 4 12 0" /><path d="M60 46 q6 4 12 0" /></g>;
    case 'triumphant':
      return <g className="fill"><path d="M42 38l2.4 5 5.4.6-4 3.7 1.1 5.3-4.9-2.7-4.9 2.7 1.1-5.3-4-3.7 5.4-.6z" /><path d="M66 38l2.4 5 5.4.6-4 3.7 1.1 5.3-4.9-2.7-4.9 2.7 1.1-5.3-4-3.7 5.4-.6z" /></g>;
    case 'working':
      return <g className="fill"><rect x="37" y="43" width="11" height="5" rx="2.5" /><rect x="61" y="43" width="11" height="5" rx="2.5" /></g>;
    case 'confused':
      return <g className="fill"><circle cx="42" cy="45" r="3.5" /><circle cx="67" cy="45" r="6" className="hollow" /></g>;
    default:
      return <g className="fill"><circle cx="42" cy="45" r="4" /><circle cx="67" cy="45" r="4" /></g>;
  }
}

function Mouth({ mood }: { mood: string }) {
  if (mood === 'triumphant') return <path className="fill" d="M40 60 q14 16 28 0 z" />;
  if (mood === 'confused') return <path className="stroke" d="M44 64 q5 -4 10 0 q5 4 10 0" />;
  if (mood === 'booting') return <ellipse className="fill" cx="54" cy="63" rx="3.5" ry="4.5" />;
  return <path className="stroke" d="M44 61 q10 8 20 0" />;
}

/**
 * The moon is the only thing on the page that moves when nothing is happening, which is the
 * point — it is how you tell at a glance that the app is running and not a screenshot. Three
 * layers of that, deliberately separate so they can overlap:
 *
 *  - the whole moon breathes on a slow loop, faster while the agents are actually working;
 *  - the eyes blink every few seconds, on their own clock, so the loop never looks like a loop;
 *  - the face springs when the mood changes, because that one *is* news.
 *
 * `MotionProvider` turns all of it off under `prefers-reduced-motion`.
 */
export function Mascot({ mood, size = 120 }: { mood: string; size?: number }) {
  const working = mood === 'working' || mood === 'booting';
  return (
    <svg className={`mascot mood-${mood}`} width={size} height={size} viewBox="0 0 110 110" role="img" aria-label={`Mascot: ${MOODS[mood]?.label ?? mood}`}>
      <motion.g
        animate={{ y: [0, -2.5, 0] }}
        transition={{ duration: working ? 2.4 : 6, repeat: Infinity, ease: 'easeInOut' }}
      >
        <circle className="halo" cx="55" cy="55" r="52" />
        <circle className="face" cx="55" cy="55" r="40" />
        <circle className="crater" cx="80" cy="36" r="5" />
        <circle className="crater" cx="30" cy="70" r="3.5" />

        {/* mode="wait" so one face is gone before the next arrives — two sets of eyes
            cross-fading through each other looks like a glitch, not a change of mood. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.g
            key={mood}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={SPRING}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            {BLINKS.has(mood) ? (
              <motion.g
                className="eyes"
                animate={{ scaleY: [1, 1, 0.08, 1] }}
                transition={{ duration: 0.3, times: [0, 0.55, 0.75, 1], repeat: Infinity, repeatDelay: 4.4, ease: 'easeInOut' }}
              >
                <Eyes mood={mood} />
              </motion.g>
            ) : <Eyes mood={mood} />}
            <Mouth mood={mood} />
          </motion.g>
        </AnimatePresence>

        {/* One 'z' that keeps drifting off the top of the moon, rather than a static letter. */}
        {mood === 'night' && (
          <motion.text
            x="84" y="22" className="zzz"
            animate={{ y: [0, -4, -9], opacity: [0, 1, 0] }}
            transition={{ duration: 2.8, repeat: Infinity, ease: 'easeOut', times: [0, 0.35, 1] }}
          >z</motion.text>
        )}
      </motion.g>
    </svg>
  );
}
