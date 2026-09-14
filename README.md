# ☾ Nightshift

A self-hosted AI co-founder that builds and runs companies while you sleep.

Describe an idea. A team of AI agents writes the mission, researches the market,
plans a roadmap, builds and deploys the website, then keeps working a task queue:
by day in **Auto Mode**, and overnight with **Night Task**. A morning report
arrives when they're done. You supervise from one dashboard and approve anything
that leaves the building (emails, X posts, ad spend).

The AI backend is **your own API key**. It defaults to DeepSeek, and any
OpenAI-compatible provider works. Change the key, model, or provider any time
in **Settings**.

## Quick start

```bash
npm install
npm run build
npm start
```

Open http://localhost:4455, go to **Settings → AI backend**, paste your DeepSeek
API key (platform.deepseek.com → API keys), press **Test connection**, and
start your first company from the home page.

For development with hot reload: `npm run dev`, then open http://localhost:5173.

Requirements: Node 22.13+ (it uses the built-in `node:sqlite`).

## What the agents do

| Area | How it works |
| --- | --- |
| **Setup** | Idea → name, tagline, mission → market research (live web search) → roadmap + first 4–6 tasks → landing page → deploy → launch post drafted for X → welcome email |
| **Tasks** | Each task runs a tool-using agent loop (engineering, research, marketing, outreach, support, ops). Every step is logged, and you can open any task to see what it did and why. |
| **Auto Mode** | Works the queue during the day, one task at a time, with a gap between tasks. |
| **Night Task** | During your night window, the CEO agent plans the next tasks and the team works through them. |
| **Morning report** | Summary of the last 24 hours, shown on the dashboard and emailed to you as a laid-out HTML message worth keeping (plain text stays the fallback). Written from the database, not by a model. Preview one without sending: `npx tsx scripts/preview-report.mts <slug> --html out.html`. |
| **Co-founder chat** | Talk strategy. It pushes back and turns requests into tasks. Kept as separate conversations, so each one replays only its own history. Paste, drop or attach an image (4 MB, PNG/JPEG/WebP/GIF) and it will look at it — your model has to support vision; `deepseek-flash` does, `deepseek-v4-pro` does not. **Think** turns on reasoning mode for one message. **Stop** ends the model call in flight. |
| **Humanizer** | Every agent follows a plain-writing guide. A built-in checker catches AI tells (em dashes, "delve", "not just X but Y"…) and makes the agent rewrite pages, emails, posts and ads before they're saved or sent; chat replies, reports and summaries get one rewrite pass when needed. Your own writing is never touched. Settings → Writing style. |
| **Website** | Static HTML/CSS/JS per company, previewed at `/s/<slug>/`, with version history and one-click restore, deployable to Vercel. A deploy publishes only what the pages actually link (see *What gets published* below). Waitlist forms and visitor counts work automatically. |
| **Email** | Send through Resend or SMTP. Each company gets `you+company@yourdomain`. Replies are read over IMAP and become support tasks. |
| **Stripe** | Agents create products and payment links. Completed checkouts show up as revenue. |
| **X / Meta Ads** | Posts and campaigns. Campaigns are always created paused, with a hard daily-budget cap. |

## What gets published

A company's site folder is a working copy. Agents keep ingest scripts, notes, fixtures and
sample data in there next to the pages, so "deploy the folder" is the wrong instruction. A
deploy publishes the part a visitor can actually reach:

- **Entry points:** every `.html`/`.htm` page in the folder, so a new page ships even before anything links to it.
- **Then whatever those pages reference**, transitively: `href`/`src`/`srcset`/`poster`, markdown links, `url()` and `@import` in CSS, and quoted asset paths in JS/JSON. That last one is how a data file a page fetches but never links still goes live.
- **Never:** dotfiles (`.git`, `.env`, `.DS_Store`), `node_modules/`, tooling directories (`tools/`, `scripts/`, `fixtures/`, `test/`…), credential-shaped filenames, files over 2 MB, and JSON that declares itself `data_status: fixture | demo | sample | test`.
- **Blocked, not dropped:** if a file that would go live contains something that looks like an API key, the deploy stops and names the file. A static host serves whatever it is given, so this waits for you instead of guessing.
- **Per-company overrides** (More → Company settings → *What may go on the website*): `publish_include` forces globs in (e.g. `data/*.json`), `publish_exclude` keeps them out (e.g. `drafts/*`). The hard rules above still win: an include cannot force in a dotfile or a page holding a key.

The Website panel shows the plan before you press Deploy: how many files go live, every file
left behind with its reason, any link whose target does not exist yet, and anything blocked.
`GET /api/companies/<slug>/publish` returns the same plan as JSON. The rules live in
`server/publish.ts`.

## Keys you'll need (all optional except the AI key)

- **DeepSeek:** platform.deepseek.com → API keys.
- **Search:** DuckDuckGo works with no key. Tavily or Brave is more reliable for nightly research.
- **Email:** Resend API key and a verified domain, or SMTP (e.g. a Gmail app password). For the inbox, add IMAP details (Gmail: `imap.gmail.com`, port 993, app password).
- **Vercel:** a token from vercel.com/account/tokens.
- **Stripe:** a secret key. Use `sk_test_…` while trying things out.
- **X:** a developer app with *Read and write* permission, plus its **consumer key and secret** (the portal labels this pair "API Key" and "API Key Secret", under Consumer Keys) and your **access token and access token secret** (under "Access Token and Secret"). Set the permission before generating the tokens — a token made while the app was read-only stays read-only, and you'll see a 401. The **bearer token** is app-only: it can read public data but never post as you. Nightshift stores one if you paste it (Settings → X) and explains this in place, but posting needs the four OAuth keys.
- **Meta Ads:** an access token with `ads_management`, your ad account ID, and the Facebook Page ID your ads run from.

Each company can override the X, Meta, Stripe, and sender settings (**More → Company settings**), so every company can have its own accounts — including its own **posting account** on X. To point a company at a different X account without moving your developer app, run:

```bash
npx tsx scripts/x-authorize.mts --company <slug> [--clear-global]
```

It walks X's PIN-based (out-of-band) 3-legged OAuth flow, which X documents for apps that cannot embed a browser: open the URL it prints **in a private window signed in as that company's account**, approve, type the PIN, and the resulting access token is stored on that company. The consumer key/secret and bearer token (the app's) stay as they are, and your own account stops being the posting identity for that company.


## Counting visits on deployed sites

Sites deployed to Vercel report visits and waitlist signups back to Nightshift,
which means Nightshift has to be reachable from the internet. It runs a second,
**public-only** server on port 4456. That server serves just the tracker, the
waitlist endpoint, and site previews, never the dashboard or API. Point a
tunnel at it and put the tunnel URL in **Settings → Website hosting → Public URL**:

```bash
cloudflared tunnel --url http://localhost:4456
```

## Safety and cost controls

- **Approvals** (Settings → Approvals): X posts, emails to anyone but you, and starting ad spend wait under **Needs you** until you approve them. All three are on by default.
- **Daily AI budget:** agents stop for the day when estimated spend reaches your cap (default $2). Prices are editable in Settings.
- **Ad budget cap:** agents can't set a daily budget above `ads_max_daily_budget`.
- **Secrets** stay in `data/nightshift.db` on your machine (file mode 600). The browser only ever sees whether a key is set.
- **Sandboxed sites:** agent-written pages are served with a `sandbox` CSP, so their scripts can't reach the dashboard API. Markdown from agents is sanitized before rendering.
- **CSRF / DNS-rebinding guards:** API writes must be same-origin JSON, and the API only answers to localhost unless you set `ALLOWED_HOSTS` or `DASHBOARD_PASSWORD`.
- **Pause everything:** Settings → Schedule → Scheduler → Paused.
- **OpEx meter** (Settings → OpEx): what the whole thing costs. Model tokens are counted from the `usage` table and X posts from published tweets × `x_cost_per_post_usd` — nothing to enter. You add everything else you pay for (domain, hosting, API plans) as a subscription billed per month, per year or one-off; yearly costs are normalised to a monthly figure. The headline number is month-to-date against your `opex_cap_usd` ceiling, with a run rate and a month-end projection.

  Note the two meters are different things: the top-bar **daily** figure is model tokens against `daily_budget_usd`, and that is the one that pauses work. The **monthly** figure is everything, and it only warns — exceeding it will not stop the agents.

  Prepaid balances (an X credit top-up, an API credit) are counted as they are *consumed*, not when you buy them, so a top-up doesn't inflate the month you bought it in.

## Running it 24/7

Nightshift only works while it's running. On your Mac that means while the Mac
is awake. For true overnight work, run it on a small always-on machine (a VPS,
a home server, a Raspberry Pi) with `npm start` under a process manager.
`data/` holds everything, so back up that folder.

## Layout

```
server/
  index.ts          HTTP API, SSE, hosted sites, public endpoint
  db.ts             SQLite schema (node:sqlite)
  settings.ts       settings, secrets, per-company overrides
  llm.ts            OpenAI-compatible client (DeepSeek thinking-mode aware), usage + budget
  scheduler.ts      Auto Mode, Night Task, morning reports, integration sync
  actions.ts        outward-facing actions + approval gate
  sites.ts          site files, versions, tracker
  agents/           prompts, tools, agent loop, setup, chat, night planning, reports
  integrations/     search, email (SMTP/Resend/IMAP), Vercel, Stripe, X, Meta
web/                React dashboard (Vite)
```

## Known limits

- Generated websites are static. There's no per-company backend or database beyond the built-in waitlist, visits, and Stripe payment links.
- No image or video generation. DeepSeek is text-only.
- The X and Meta integrations follow the official APIs but depend on your developer accounts being approved. Meta in particular may ask for extra fields depending on your account's region and API version. Errors appear on the dashboard as-is.
