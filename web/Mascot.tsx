// The moon: Nightshift's mascot. Its face follows the company's mood.

export const MOODS: Record<string, { label: string; line: string }> = {
  booting: { label: 'Waking up', line: 'Setting up your company…' },
  working: { label: 'On shift', line: 'Working through the queue.' },
  triumphant: { label: 'Triumphant', line: 'Your company is live!' },
  idle: { label: 'Standing by', line: 'Ready for the next task.' },
  night: { label: 'Night shift', line: "Working while you sleep." },
  confused: { label: 'Stuck', line: 'Something needs your attention.' },
};

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

export function Mascot({ mood, size = 120 }: { mood: string; size?: number }) {
  return (
    <svg className={`mascot mood-${mood}`} width={size} height={size} viewBox="0 0 110 110" role="img" aria-label={`Mascot: ${MOODS[mood]?.label ?? mood}`}>
      <circle className="halo" cx="55" cy="55" r="52" />
      <circle className="face" cx="55" cy="55" r="40" />
      <circle className="crater" cx="80" cy="36" r="5" />
      <circle className="crater" cx="30" cy="70" r="3.5" />
      <Eyes mood={mood} />
      <Mouth mood={mood} />
      {mood === 'night' && <text x="84" y="22" className="zzz">z</text>}
    </svg>
  );
}
