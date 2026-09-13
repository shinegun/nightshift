import { useCallback, useEffect, useState } from 'react';
import { api, del } from './api.ts';
import type { PublicUser } from './types.ts';
import { timeAgo, useAction } from './lib.tsx';

/**
 * Who can sign in. Adding someone means choosing a password, and a password belongs in a terminal
 * rather than a browser tab, so that stays in `npm run user -- add`. Revoking is the urgent one, so
 * that is here.
 */
export function PeoplePanel() {
  const [data, setData] = useState<{ users: PublicUser[]; me: PublicUser | null } | null>(null);
  const [error, setError] = useState('');
  const { busy, run } = useAction();
  const load = useCallback(
    () => api<{ users: PublicUser[]; me: PublicUser | null }>('/users')
      // Never let a bad payload throw during render: a panel that cannot load itself must not
      // take the rest of the Settings page down with it.
      .then((r) => { setData({ users: r?.users ?? [], me: r?.me ?? null }); setError(''); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e))),
    [],
  );
  useEffect(() => { void load(); }, [load]);

  if (error) return <p className="error small">{error}</p>;
  if (!data) return <p className="muted small">Loading…</p>;
  if (!data.users.length) {
    return <p className="muted small">Nobody has an account yet, so the dashboard is open to anyone who can reach it. Add yourself with <code>npm run user -- add</code>.</p>;
  }

  return (
    <>
      <ul className="list compact">
        {data.users.map((u) => {
          const isMe = data.me?.id === u.id;
          return (
            <li key={u.id} className="list-item">
              <div className="grow">
                <strong>{u.name}</strong> <span className="mono small muted">{u.username}</span>
                {isMe && <span className="badge">you</span>}
                <div className="muted small">
                  {u.last_seen_at ? `last seen ${timeAgo(u.last_seen_at)}` : 'has not signed in yet'}
                </div>
              </div>
              {!isMe && (
                <button
                  className="btn small ghost danger"
                  disabled={busy !== null || data.users.length <= 1}
                  onClick={() => confirm(`Remove ${u.name}? They lose access immediately. Nobody else's password changes.`)
                    && run(`rm${u.id}`, async () => { await del(`/users/${u.username}`); await load(); }, `${u.name} removed`)}
                >Remove</button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        Add someone: <code>npm run user -- add ilham "Ilham"</code>. Change a password:{' '}
        <code>npm run user -- password &lt;username&gt;</code>.
      </p>
    </>
  );
}
