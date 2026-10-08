import '@fontsource-variable/inter';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LINKS } from './config.ts';
import { Office } from './Office.tsx';
import { Controls, Panel, useAmbient, useReplay } from './Replay.tsx';
import { How, Inside, Output, Stack } from './sections.tsx';
import type { Tape, TapeBot, TapeIndexEntry } from './tape.ts';
import './landing.css';

/** The team as it is hired by default, for drawing the office before a tape has loaded. */
const DEFAULT_TEAM: TapeBot[] = [
  { key: 'engineer', name: 'Engineer', color: 'blue' }, { key: 'research', name: 'Research', color: 'green' },
  { key: 'marketing', name: 'Marketing', color: 'coral' }, { key: 'outreach', name: 'Outreach', color: 'amber' },
  { key: 'support', name: 'Support', color: 'violet' }, { key: 'ops', name: 'Ops', color: 'teal' },
];

type Load = { status: 'loading' } | { status: 'none' } | { status: 'ready'; tape: Tape; others: TapeIndexEntry[] };

async function fetchJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

function useTape(): [Load, (id: string) => void] {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [want, setWant] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const index = await fetchJSON<TapeIndexEntry[]>('demo/index.json');
        const pick = index.find((e) => e.id === want) ?? index.at(-1);
        if (!pick) throw new Error('no recordings');
        const tape = await fetchJSON<Tape>(`demo/${pick.id}.json`);
        if (!stale) setLoad({ status: 'ready', tape, others: index });
      } catch {
        if (!stale) setLoad({ status: 'none' });
      }
    })();
    return () => { stale = true; };
  }, [want]);
  return [load, setWant];
}

function Moon() {
  return (
    <svg className="brand-moon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><circle className="crater" cx="16.5" cy="8" r="1.8" /><circle className="crater" cx="8" cy="15" r="1.3" />
    </svg>
  );
}

function App() {
  const [load, pickTape] = useTape();
  const tape = load.status === 'ready' ? load.tape : null;
  const bots = tape?.bots ?? DEFAULT_TEAM;
  const [watching, setWatching] = useState(false);
  const replay = useReplay(tape);
  const ambient = useAmbient(bots, !watching);

  const start = () => { setWatching(true); replay.restart(); document.getElementById('stage')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  const exit = () => { replay.pause(); setWatching(false); };
  const seeOutput = () => document.getElementById('output')?.scrollIntoView({ behavior: 'smooth' });

  return (
    <MotionConfig reducedMotion="user">
      <header className="nav">
        <a className="brand" href="#top"><Moon />Nightshift</a>
        <nav aria-label="Sections">
          <a href="#output">Output</a>
          <a href="#how">How it works</a>
          <a href="#inside">Decisions</a>
        </nav>
        <a className="btn btn-quiet" href={LINKS.source} target="_blank" rel="noopener noreferrer">View source</a>
      </header>

      <main id="top">
        <section id="stage" className={`hero${watching ? ' is-watching' : ''}`}>
          <div className="hero-side">
            <AnimatePresence mode="wait" initial={false}>
              {watching && tape ? (
                <motion.div key="panel" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3 }}>
                  <Panel tape={tape} replay={replay} onSeeOutput={seeOutput} />
                </motion.div>
              ) : (
                <motion.div key="copy" className="hero-copy" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3 }}>
                  <h1>An AI team on the night shift.</h1>
                  <p>Give it one idea. A CEO agent and six bots write the mission, research the market and build the website.</p>
                  <div className="hero-cta">
                    {load.status === 'loading' && <span className="btn btn-primary is-loading" aria-busy="true">Loading the recording</span>}
                    {load.status === 'ready' && <button type="button" className="btn btn-primary" onClick={start}>Watch a real run</button>}
                    {load.status === 'none' && <span className="hero-none">No recording is published yet.</span>}
                    <a className="btn btn-ghost" href="#how">How it works</a>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="hero-stage">
            <Office
              bots={bots}
              state={watching ? replay.state : ambient.state}
              packets={watching ? replay.packets : ambient.packets}
              speed={watching ? replay.speed : 1}
              onPacketDone={watching ? replay.dropPacket : ambient.dropPacket}
            />
            {watching && tape
              ? <Controls replay={replay} onExit={exit} />
              : <p className="stage-caption">Each desk is one agent. Press play and the room replays a recorded run, event by event.</p>}
          </div>
        </section>

        {load.status === 'ready' && load.others.length > 1 && (
          <div className="tape-picker" role="group" aria-label="Choose a recording">
            {load.others.map((e) => (
              <button key={e.id} type="button" className={e.id === load.tape.id ? 'is-on' : ''} onClick={() => { exit(); pickTape(e.id); }}>{e.name}</button>
            ))}
          </div>
        )}

        {tape && <Output tape={tape} />}
        <How />
        {tape && <Inside tape={tape} />}
        <Stack tape={tape} />
      </main>

      <footer className="foot">
        <span className="brand"><Moon />Nightshift</span>
        <span>Designed and built by {LINKS.author}.</span>
      </footer>
    </MotionConfig>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
