/**
 * Settings → Slack: whether the connection is up, which channels each company uses, and the app
 * manifest to create the Slack app from. Setting up a Slack app is the fiddly part, so the steps
 * are spelled out rather than linked.
 */
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { SlackStatus } from './types.ts';
import { timeAgo, toast } from './lib.tsx';

export function SlackPanel() {
  const [s, setS] = useState<SlackStatus | null>(null);
  useEffect(() => {
    const load = () => api<SlackStatus>('/slack').then(setS).catch(() => {});
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  if (!s) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(s.manifest, null, 2));
      toast('Manifest copied', 'success');
    } catch {
      toast("Couldn't copy. Open the manifest below and copy it by hand.", 'error');
    }
  };
  return (
    <div className="stack slack-panel">
      {/* The health line above already explains a missing setup; this only adds what it can't know. */}
      {s.connected && <p className="health ready">✓ Live in {s.team}{s.since ? `, connected ${timeAgo(s.since)}` : ''}</p>}
      <details>
        <summary>How to set it up (about 5 minutes)</summary>
        <ol className="small setup-steps">
          <li>Go to <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noreferrer">api.slack.com/apps</a> → <em>Create New App</em> → <em>From a manifest</em>, pick your workspace, and paste the manifest. <button type="button" className="btn small" onClick={copy}>Copy manifest</button></li>
          <li><em>Basic Information → App-Level Tokens</em>: generate a token with the <code>connections:write</code> scope. That's the <strong>app token</strong> (<code>xapp-…</code>).</li>
          <li><em>Install App</em> → install to your workspace, then copy the <strong>Bot User OAuth Token</strong> (<code>xoxb-…</code>).</li>
          <li>Paste both below, press <em>Save changes</em>, then <em>Test connection</em>.</li>
          <li>Invite the app to two channels (<code>/invite @Nightshift</code>): one for the team, one for feedback. Copy each channel's ID (channel name → <em>View channel details</em> → bottom of the About tab) into the company's dashboard under <em>More ▾ → Company settings</em>.</li>
        </ol>
        <details>
          <summary className="small">Show the manifest</summary>
          <pre className="ci-log">{JSON.stringify(s.manifest, null, 2)}</pre>
        </details>
      </details>
      {s.companies.length > 0 && (
        <table className="opex-table slack-table">
          <thead><tr><th>Company</th><th>Team channel</th><th>Feedback channel</th></tr></thead>
          <tbody>
            {s.companies.map((c) => (
              <tr key={c.slug}>
                <td><a href={`#/c/${encodeURIComponent(c.slug)}`}>{c.name}</a></td>
                <td className="mono">{c.team || <span className="muted">not set</span>}</td>
                <td className="mono">{c.feedback || <span className="muted">not set</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        In the team channel: <code>@Nightshift support status</code>, <code>@Nightshift engineer do …</code>, <code>@Nightshift support teach …</code>, or just ask. You can also DM the app.
        Every new message in the feedback channel becomes a Support task.
      </p>
    </div>
  );
}
