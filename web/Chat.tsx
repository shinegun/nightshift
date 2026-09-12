import { useCallback, useEffect, useRef, useState } from 'react';
import { api, post } from './api.ts';
import { Markdown, toast, useLive } from './lib.tsx';

interface Message { id: number; role: 'user' | 'assistant'; content: string; created_at: string }

const STARTERS = ['What should we focus on this week?', 'Review our landing page honestly', 'Plan 3 tasks to get our first 50 signups'];

export function Chat({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const base = `/companies/${encodeURIComponent(slug)}/messages`;

  const load = useCallback(() => api<Message[]>(base).then(setMessages).catch(() => {}), [base]);
  useEffect(() => { void load(); }, [load]);
  useLive(slug, load);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length, sending]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async (msg: string) => {
    if (!msg.trim() || sending) return;
    setSending(true);
    setText('');
    setMessages((m) => [...m, { id: -Date.now(), role: 'user', content: msg, created_at: new Date().toISOString() }]);
    try {
      await post(base, { text: msg });
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      setText(msg);
      await load();
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="drawer" aria-label="Co-founder chat">
      <header className="drawer-head">
        <div><div className="eyebrow">Co-founder</div><strong>{name}</strong></div>
        <button className="btn ghost small" onClick={onClose} aria-label="Close chat">✕</button>
      </header>
      <div className="chat-log">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p className="muted">Ask for advice, push back on the plan, or hand over work — your co-founder turns requests into tasks for the team.</p>
            {STARTERS.map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>{m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}</div>
        ))}
        {sending && <div className="msg assistant typing"><span /><span /><span /></div>}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Message your co-founder…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }}
        />
        <button className="btn primary" disabled={sending || !text.trim()}>Send</button>
      </form>
    </aside>
  );
}
