import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Health } from './types.ts';
import { AnimatePresence, EASE, motion, rise } from './motion.tsx';

// ── Routing (hash-based: #/, #/c/<slug>, #/settings) ──

export function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export const go = (path: string) => { location.hash = path; };

// ── Live updates over SSE; any event triggers a debounced reload ──

export function useLive(slug: string | null, onChange: () => void) {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const es = new EventSource(`/api/events${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`);
    let t: number | undefined;
    es.onmessage = () => { clearTimeout(t); t = window.setTimeout(() => ref.current(), 300); };
    return () => { es.close(); clearTimeout(t); };
  }, [slug]);
}

// ── Toasts ──

type ToastKind = 'info' | 'error' | 'success';
export function toast(message: string, kind: ToastKind = 'info') {
  window.dispatchEvent(new CustomEvent('ns-toast', { detail: { message, kind } }));
}

export function Toaster() {
  const [items, setItems] = useState<{ id: number; message: string; kind: ToastKind }[]>([]);
  useEffect(() => {
    const onToast = (e: Event) => {
      const d = (e as CustomEvent).detail as { message: string; kind: ToastKind };
      const id = Date.now() + Math.random();
      setItems((x) => [...x.slice(-3), { id, ...d }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), d.kind === 'error' ? 8000 : 3500);
    };
    addEventListener('ns-toast', onToast);
    return () => removeEventListener('ns-toast', onToast);
  }, []);
  // `layout` is what makes a stack of toasts behave: when the top one expires the ones below it
  // slide up into the gap instead of teleporting.
  return (
    <div className="toasts" role="status">
      <AnimatePresence initial={false}>
        {items.map((i) => (
          <motion.div
            key={i.id} layout className={`toast ${i.kind}`}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.18 } }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            {i.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/** Run an async action with a busy flag and error toasts. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      if (success) toast(success, 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, run };
}

// ── Markdown (AI-written, may quote the web — always sanitized) ──

// Raw HTML in agent markdown (e.g. a brief mentioning `<form data-waitlist>`) is shown as text, not rendered.
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
marked.use({ renderer: { html: ({ text }) => escapeHtml(text) } });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});

export function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text ?? '', { async: false }) as string);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── Formatting ──

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
export const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;

// ── Small UI pieces ──

/**
 * A card is a `motion.section` rather than a plain one so it can take its entrance from whatever
 * `Stagger` it happens to sit in — which lets the views stagger their cards without a wrapper div
 * in between, and a wrapper div in between would become the grid cell and break `.span-2`.
 * With no animating parent above it, the variants go unused and this renders exactly as before.
 */
export function Card({ title, action, children, className = '' }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <motion.section className={`card ${className}`} variants={rise}>
      <header className="card-head"><h2>{title}</h2>{action}</header>
      {children}
    </motion.section>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

/**
 * Whether HealthNote would render nothing for this integration — i.e. it is fine, or it is off
 * and has nothing to say about it. Cards use it to decide they have no reason to exist at all.
 */
export const healthIsQuiet = (h?: Health) => !h || h.state === 'ready' || (h.state === 'off' && !h.message);

/** Says exactly why a feature can't be used (or that its last attempt failed). Renders nothing when healthy. */
export function HealthNote({ h, label, link = true, showReady = false }: { h?: Health; label: string; link?: boolean; showReady?: boolean }) {
  if (!h) return null;
  if (h.state === 'ready') return showReady ? <p className="health ready">✓ {label}: ready</p> : null;
  // 'off' with no message means nothing is set up and nothing needs to be — stay quiet rather
  // than warning about an integration the app isn't relying on.
  if (h.state === 'off' && !h.message) return null;
  return (
    <p className={`health ${h.state}`} role={h.state === 'error' ? 'alert' : undefined}>
      <span aria-hidden>{h.state === 'error' ? '✗ ' : '⚠ '}</span>
      <strong>{label}{h.state === 'error' ? ' — last attempt failed' : " can't be used"}:</strong> {h.message}
      {h.at && <span className="muted"> · {timeAgo(h.at)}</span>}
      {link && <> <a href="#/settings">Fix in Settings →</a></>}
    </p>
  );
}

export function Pill({ status }: { status: string }) {
  return <span className={`pill pill-${status}`}>{status.replace(/_/g, ' ')}</span>;
}

export function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`toggle ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="knob" />{label}
    </button>
  );
}

/**
 * Keeps one broken panel from taking a whole page with it.
 *
 * React unmounts the entire tree when a render throws, which is how a single bad field turns into
 * a blank screen that flashed once. A boundary around each panel turns that into a line of text in
 * the place the panel would have been, and leaves the rest of the page usable.
 */
export class Boundary extends Component<{ name: string; children: ReactNode }, { message: string }> {
  state = { message: '' };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[${this.props.name}]`, error, info.componentStack);
  }

  render() {
    if (!this.state.message) return this.props.children;
    return (
      <p className="error small">
        {this.props.name} could not be shown: {this.state.message}
      </p>
    );
  }
}
