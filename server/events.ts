import { now, run } from './db.ts';

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

/** A line in the company's terminal-style activity feed. */
export function activity(companyId: number | null, text: string) {
  run('INSERT INTO activity (company_id, ts, text) VALUES (?, ?, ?)', companyId, now(), text);
  emit('activity', companyId ?? undefined, { text });
}
