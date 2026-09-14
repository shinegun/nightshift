import { useState } from 'react';
import { post } from './api.ts';
import type { AppState } from './types.ts';
import { Pill, go, useAction } from './lib.tsx';
import { Mascot } from './Mascot.tsx';
import { AnimatePresence, EASE, Item, Reveal, Stagger, motion } from './motion.tsx';

const EXAMPLES = [
  'A bookkeeping assistant for Malaysian Shopee and TikTok Shop sellers that reconciles payouts and sends a morning P&L on WhatsApp',
  'A directory of halal-certified cafés in Kuala Lumpur with opening hours and prayer-room info',
  'A tiny SaaS that turns a restaurant menu photo into a clean mobile menu page',
];

export function Home({ state }: { state: AppState | null }) {
  const [idea, setIdea] = useState('');
  const [name, setName] = useState('');
  const { busy, run } = useAction();
  const ready = Boolean(state?.llmConfigured);

  const start = () => run('create', async () => {
    const r = await post<{ slug: string }>('/companies', { idea, name });
    go(`/c/${r.slug}`);
  });

  return (
    <div className="container home">
      {/* The one place in the app with a fold to cross, so the one place that gets an entrance.
          Each piece arrives 90ms after the last: moon, headline, form, examples. */}
      <Stagger className="start" gap={0.09}>
        <Item className="start-copy">
          <Mascot mood="idle" size={88} />
          <div>
            <h1>What should your AI team build?</h1>
            <p className="lede">Describe an idea. Your agents write the mission, research the market, plan the roadmap, build the website — then keep working every night while you sleep.</p>
          </div>
        </Item>
        <motion.form variants={{ hidden: { opacity: 0, y: 24 }, shown: { opacity: 1, y: 0 } }} className="start-form" onSubmit={(e) => { e.preventDefault(); if (idea.trim().length >= 10) void start(); }}>
          <textarea
            value={idea} onChange={(e) => setIdea(e.target.value)} rows={4} maxLength={2000}
            placeholder={`e.g. ${EXAMPLES[0]}`} aria-label="Your idea"
          />
          <div className="start-row">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name (optional)" maxLength={60} aria-label="Company name" />
            <button className="btn primary" disabled={!ready || idea.trim().length < 10 || busy === 'create'}>
              {busy === 'create' ? 'Starting…' : 'Start company'}
            </button>
          </div>
          {!ready && state && <p className="hint">Add your AI API key in <a href="#/settings">Settings</a> first.</p>}
          <div className="examples">
            {EXAMPLES.slice(1).map((ex) => (
              <motion.button type="button" key={ex} className="chip" onClick={() => setIdea(ex)}
                whileHover={{ y: -2 }} whileTap={{ scale: 0.97 }} transition={{ duration: 0.2, ease: EASE }}>
                {ex}
              </motion.button>
            ))}
          </div>
        </motion.form>
      </Stagger>

      <Reveal>
        <h2 className="section-title">Your companies</h2>
      </Reveal>
      <section>
        {!state ? <p className="muted">Loading…</p> : state.companies.length === 0 ? (
          <p className="empty">No companies yet. Start one above.</p>
        ) : (
          <Stagger className="company-grid" gap={0.05} delay={0.1}>
            <AnimatePresence initial={false}>
            {state.companies.map((c) => (
              <motion.a key={c.slug} layout variants={{ hidden: { opacity: 0, y: 24 }, shown: { opacity: 1, y: 0 } }}
                exit={{ opacity: 0, scale: 0.96 }}
                whileHover={{ y: -3 }} transition={{ duration: 0.25, ease: EASE }}
                className="company-card" href={`#/c/${c.slug}`}>
                <div className="company-card-top">
                  <h3>{c.name}</h3>
                  <Pill status={c.status} />
                </div>
                <p className="muted clamp">{c.tagline || c.idea}</p>
                <dl className="mini-stats">
                  <div><dt>Visitors</dt><dd>{c.metrics.visitors_total}</dd></div>
                  <div><dt>Waitlist</dt><dd>{c.metrics.waitlist}</dd></div>
                  <div><dt>Revenue</dt><dd>{c.metrics.revenue[0] ?? '0'}</dd></div>
                  <div><dt>Open tasks</dt><dd>{c.metrics.tasks_open}</dd></div>
                </dl>
                <div className="mode-flags mono">
                  <span className={c.auto_mode ? 'on' : ''}>⚡ Auto</span>
                  <span className={c.night_mode ? 'on' : ''}>☾ Night</span>
                </div>
              </motion.a>
            ))}
            </AnimatePresence>
          </Stagger>
        )}
      </section>
    </div>
  );
}
