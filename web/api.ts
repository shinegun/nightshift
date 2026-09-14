/** JSON API helper. Mutations always send JSON so the server's CSRF guard can require it. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(`/api${path}`, {
    method,
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
    signal: opts.signal,
  });
  // A body that isn't JSON is never a usable answer, even with a 200. An unknown /api path falls
  // through to the SPA catch-all and comes back as index.html; swallowing that into {} hands the
  // caller an object with every field missing, which then throws somewhere far from the cause.
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  if (data === null) throw new Error(`${path} did not return JSON (${res.status}). The server may be running older code than this page.`);
  return data as T;
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });
