import { now, run } from './db.ts';
import { currentActor } from './users.ts';

export interface ServerEvent { type: string; companyId?: number; data?: unknown }
type Listener = (e: ServerEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emit(type: string, companyId?: number, data?: unknown) {
  for (const l of listeners) {
    try { l({ type, companyId, data }); } catch { /* a broken SSE client must not break the emitter */ }
  }
}

/**
 * A line in the company's terminal-style activity feed. The actor is whoever's request caused it,
 * and null when the agents did it unprompted — which is the difference you want to see once more
 * than one person has a login.
 */
export function activity(companyId: number | null, text: string) {
  const actor = currentActor()?.name ?? null;
  run('INSERT INTO activity (company_id, ts, text, actor) VALUES (?, ?, ?, ?)', companyId, now(), text, actor);
  emit('activity', companyId ?? undefined, { text, actor });
}
