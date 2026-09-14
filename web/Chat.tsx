import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, patch, post } from './api.ts';
import { Markdown, timeAgo, toast, useLive } from './lib.tsx';
import { AnimatePresence, EASE, motion } from './motion.tsx';

interface Message { id: number; role: 'user' | 'assistant'; content: string; image: string | null; created_at: string }
interface Thread { id: number; title: string; created_at: string; updated_at: string; messages: number; last: string | null }

const STARTERS = ['What should we focus on this week?', 'Review our landing page honestly', 'Plan 3 tasks to get our first 50 signups'];

/** Must match MAX_BYTES in server/uploads.ts, so the error arrives before the upload does. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Inline rather than an icon package: five glyphs do not justify a dependency, and these inherit
// currentColor so they follow the theme without a second palette.
const Icon = ({ d, filled = false }: { d: string; filled?: boolean }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden
    fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'}
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
const PAPERCLIP = 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48';
const SPARK = 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z';
const ARROW_UP = 'M12 19V5M5 12l7-7 7 7';
const CLOSE = 'M18 6L6 18M6 6l12 12';

interface Draft { dataUrl: string; name: string; bytes: number }

/**
 * Grows with what you type and stops at a height that still leaves the conversation visible.
 * Enter sends, shift+Enter is a newline. Every control here does something: the clip attaches an
 * image the model actually reads, and Think turns on reasoning mode for this one message.
 */
function Composer({ value, onChange, onSend, onStop, sending, image, setImage, think, setThink }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; sending: boolean;
  image: Draft | null; setImage: (d: Draft | null) => void; think: boolean; setThink: (v: boolean) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const take = useCallback((file: File | null | undefined) => {
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) { toast('Images only — PNG, JPEG, WebP or GIF.', 'error'); return; }
    if (file.size > MAX_IMAGE_BYTES) { toast(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 4 MB.`, 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => setImage({ dataUrl: String(reader.result), name: file.name, bytes: file.size });
    reader.onerror = () => toast('Could not read that file.', 'error');
    reader.readAsDataURL(file);
  }, [setImage]);

  // Pasting a screenshot is the whole point of this; it should not need the clip.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      take(item.getAsFile());
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [take]);

  return (
    <div
      className={`composer ${sending ? 'busy' : ''} ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files[0]); }}
    >
      {image && (
        <div className="attach">
          <img src={image.dataUrl} alt={image.name} />
          <div className="grow">
            <div className="clamp-1">{image.name}</div>
            <div className="muted small">{(image.bytes / 1024).toFixed(0)} KB</div>
          </div>
          <button type="button" className="icon-btn" onClick={() => setImage(null)} aria-label="Remove image"><Icon d={CLOSE} /></button>
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={sending}
        placeholder={image ? 'Say what to look for… (optional)' : 'Message your co-founder…'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
      />
      <div className="composer-actions">
        <button type="button" className="icon-btn" disabled={sending} title="Attach an image" aria-label="Attach an image"
          onClick={() => fileInput.current?.click()}>
          <Icon d={PAPERCLIP} />
        </button>
        <input ref={fileInput} type="file" hidden accept={IMAGE_TYPES.join(',')}
          onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }} />
        <button type="button" className={`toggle-pill ${think ? 'on' : ''}`} disabled={sending}
          onClick={() => setThink(!think)} aria-pressed={think}
          title="Reasoning mode for this message — slower and costs more, for questions worth it">
          <Icon d={SPARK} filled={think} /> Think
        </button>
        <span className="composer-hint">{sending ? 'Thinking…' : 'Enter to send'}</span>
        <button
          type="button"
          className={`round-btn ${sending ? 'stop' : ''}`}
          disabled={!sending && !value.trim() && !image}
          onClick={() => (sending ? onStop() : onSend())}
          title={sending ? 'Stop' : 'Send'}
          aria-label={sending ? 'Stop' : 'Send'}
        >
          {sending ? <span className="stop-square" aria-hidden /> : <Icon d={ARROW_UP} />}
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
  const [image, setImage] = useState<Draft | null>(null);
  const [think, setThink] = useState(false);
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
    if ((!msg.trim() && !image) || sending) return;
    const sentImage = image;
    setSending(true);
    setText('');
    setImage(null);
    setMessages((m) => [...m, { id: -Date.now(), role: 'user', content: msg, image: sentImage ? 'pending' : null, created_at: new Date().toISOString() }]);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      const r = await api<{ reply: string; threadId: number }>(base + '/messages', {
        method: 'POST',
        body: { text: msg, thread_id: active ?? undefined, think, image: sentImage?.dataUrl },
        signal: ctrl.signal,
      });
      setThink(false);
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
        setImage(sentImage);
        await loadMessages(active);
      }
    } finally {
      abort.current = null;
      setSending(false);
    }
  };

  const startNew = () => { setActive(null); setMessages([]); setListOpen(false); setText(''); setImage(null); };

  const rename = async (t: Thread) => {
    const title = prompt('Name this conversation', t.title)?.trim();
    if (!title || title === t.title) return;
    await patch(`/threads/${t.id}`, { title }).then(loadThreads).catch((e) => toast(String(e), 'error'));
  };

  const remove = async (t: Thread) => {
    if (!confirm(`Delete “${t.title}” and its ${t.messages} message${t.messages === 1 ? '' : 's'}?`)) return;
    await del(`/threads/${t.id}`);
    const list = await loadThreads();
    if (active === t.id) setActive(list[0]?.id ?? null);
  };

  const current = threads.find((t) => t.id === active);

  // The drawer slides in from the edge it lives on; anything else would misrepresent where it
  // came from. No exit animation — it is unmounted by the parent the moment you close it.
  return (
    <motion.aside className="drawer" aria-label="Co-founder chat"
      initial={{ x: 32, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ duration: 0.3, ease: EASE }}>
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
                <p className="muted">Ask for advice, push back on the plan, or hand over work — your co-founder turns requests into tasks for the team. Paste or drop a screenshot and it will look at it.</p>
                {STARTERS.map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}
              </div>
            )}
            {/* Messages rise in from the side they belong to, so a reply arriving reads the same
                way it does in every chat app you already use. */}
            <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div key={m.id} layout className={`msg ${m.role}`}
                initial={{ opacity: 0, y: 10, x: m.role === 'user' ? 12 : -12 }}
                animate={{ opacity: 1, y: 0, x: 0 }}
                transition={{ duration: 0.28, ease: EASE }}>
                {m.image && m.id > 0 && <img className="msg-image" src={`/api/messages/${m.id}/image`} alt="Attached" loading="lazy" />}
                {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
              </motion.div>
            ))}
            </AnimatePresence>
            {sending && <div className="msg assistant typing"><span /><span /><span /></div>}
            <div ref={end} />
          </div>
          <Composer
            value={text}
            onChange={setText}
            sending={sending}
            image={image}
            setImage={setImage}
            think={think}
            setThink={setThink}
            onSend={() => void send(text)}
            onStop={() => abort.current?.abort()}
          />
        </>
      )}
    </motion.aside>
  );
}
