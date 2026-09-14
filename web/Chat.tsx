import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, patch, post } from './api.ts';
import { Markdown, timeAgo, toast, useLive } from './lib.tsx';

interface Message { id: number; role: 'user' | 'assistant'; content: string; created_at: string }
interface Thread { id: number; title: string; created_at: string; updated_at: string; messages: number; last: string | null }

const STARTERS = ['What should we focus on this week?', 'Review our landing page honestly', 'Plan 3 tasks to get our first 50 signups'];

/**
 * Grows with what you type and stops at a height that still leaves the conversation visible.
 * Enter sends, shift+Enter is a newline — the convention every chat box has, and the one the
 * muscle memory expects.
 */
function Composer({ value, onChange, onSend, onStop, sending }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; sending: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div className={`composer ${sending ? 'busy' : ''}`}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={sending}
        placeholder="Message your co-founder…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
      />
      <div className="composer-actions">
        <span className="composer-hint">{sending ? 'Thinking…' : 'Enter to send · Shift+Enter for a new line'}</span>
        <button
          type="button"
          className={`round-btn ${sending ? 'stop' : ''}`}
          disabled={!sending && !value.trim()}
          onClick={() => (sending ? onStop() : onSend())}
          title={sending ? 'Stop' : 'Send'}
          aria-label={sending ? 'Stop' : 'Send'}
        >
          {sending ? <span className="stop-square" aria-hidden /> : <span aria-hidden>↑</span>}
        </button>
      </div>
    </div>
  );
}

export function Chat({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const base = `/companies/${encodeURIComponent(slug)}`;

  const loadThreads = useCallback(async () => {
    const list = await api<Thread[]>(`${base}/threads`).catch(() => [] as Thread[]);
    setThreads(list);
    return list;
  }, [base]);

  const loadMessages = useCallback(async (id: number | null) => {
    if (!id) { setMessages([]); return; }
    setMessages(await api<Message[]>(`${base}/messages?thread=${id}`).catch(() => [] as Message[]));
  }, [base]);

  // Open the most recent conversation, so reopening the drawer resumes where you were.
  useEffect(() => { void loadThreads().then((list) => setActive((cur) => cur ?? list[0]?.id ?? null)); }, [loadThreads]);
  useEffect(() => { void loadMessages(active); }, [active, loadMessages]);
  useLive(slug, () => { void loadThreads(); void loadMessages(active); });
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages.length, sending]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') (listOpen ? setListOpen(false) : onClose()); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose, listOpen]);
  // A drawer that closes mid-reply should not leave a model call running.
  useEffect(() => () => abort.current?.abort(), []);

  const send = async (msg: string) => {
    if (!msg.trim() || sending) return;
    setSending(true);
    setText('');
    setMessages((m) => [...m, { id: -Date.now(), role: 'user', content: msg, created_at: new Date().toISOString() }]);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const r = await post<{ reply: string; threadId: number }>(base + '/messages', { text: msg, thread_id: active ?? undefined });
      await loadThreads();
      setActive(r.threadId);
      await loadMessages(r.threadId);
    } catch (e) {
      if (ctrl.signal.aborted) {
        toast('Stopped.', 'info');
        await loadMessages(active);
      } else {
        toast(e instanceof Error ? e.message : String(e), 'error');
        setText(msg);
        await loadMessages(active);
      }
    } finally {
      abort.current = null;
      setSending(false);
    }
  };

  const startNew = () => { setActive(null); setMessages([]); setListOpen(false); setText(''); };

  const rename = async (t: Thread) => {
    const title = prompt('Name this conversation', t.title)?.trim();
    if (!title || title === t.title) return;
    await patch(`/threads/${t.id}`, { title }).then(loadThreads).catch((e) => toast(String(e), 'error'));
  };

  const remove = async (t: Thread) => {
    if (!confirm(`Delete “${t.title}” and its ${t.messages} message${t.messages === 1 ? '' : 's'}?`)) return;
    await del(`/threads/${t.id}`);
    const list = await loadThreads();
    if (active === t.id) { setActive(list[0]?.id ?? null); }
  };

  const current = threads.find((t) => t.id === active);

  return (
    <aside className="drawer" aria-label="Co-founder chat">
      <header className="drawer-head">
        <div className="grow">
          <div className="eyebrow">Co-founder</div>
          <strong>{name}</strong>
        </div>
        <button className="btn ghost small" onClick={() => setListOpen(!listOpen)} aria-expanded={listOpen}>
          {listOpen ? 'Close list' : `Conversations${threads.length ? ` · ${threads.length}` : ''}`}
        </button>
        <button className="btn ghost small" onClick={onClose} aria-label="Close chat">✕</button>
      </header>

      {listOpen ? (
        <div className="thread-list">
          <button className="btn small primary new-thread" onClick={startNew}>+ New conversation</button>
          {threads.length === 0 ? <p className="muted small">No conversations yet.</p> : threads.map((t) => (
            <div key={t.id} className={`thread-row ${t.id === active ? 'active' : ''}`}>
              <button className="thread-open" onClick={() => { setActive(t.id); setListOpen(false); }}>
                <strong className="clamp-1">{t.title}</strong>
                <span className="muted small clamp-1">{t.messages} message{t.messages === 1 ? '' : 's'} · {timeAgo(t.updated_at)}</span>
              </button>
              <div className="row-actions">
                <button className="btn small ghost" onClick={() => void rename(t)}>Rename</button>
                <button className="btn small ghost danger" onClick={() => void remove(t)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="thread-bar">
            <span className="clamp-1">{current ? current.title : 'New conversation'}</span>
            {current && <button className="btn small ghost" onClick={startNew}>+ New</button>}
          </div>
          <div className="chat-log">
            {messages.length === 0 && !sending && (
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
          <Composer
            value={text}
            onChange={setText}
            sending={sending}
            onSend={() => void send(text)}
            onStop={() => abort.current?.abort()}
          />
        </>
      )}
    </aside>
  );
}
