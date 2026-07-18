# PullPod 🫛

**A pod for every pull request.** A self-hosted Slack ↔ GitHub app that brings pull-request
collaboration into one shared Slack channel: every PR becomes a threaded card that syncs
comments, reviews, and CI both ways — and lets reviewers approve, comment, and merge without
leaving Slack.

📋 See [plan.md](plan.md) for the original technical design and [docs/scaling.md](docs/scaling.md)
for the architecture decisions and how to scale up. This README is the source of truth for how
the app works today.

## What it does

- **One shared channel, one thread per PR** — each PR posts a single root **card** into a shared
  channel (default `#pr-approve`); every comment, review, CI result, and reviewer request threads
  underneath it. The card stays live and updates in place through merge/close.
- **Only PRs that need a review** — a PR is tracked only when its base branch actually requires an
  approval (protected via branch protection or a ruleset). PRs into unprotected branches like
  `dev` are ignored automatically — no per-repo config, it follows each repo's own settings.
- **GitHub → Slack sync** — PR comments, inline review comments (with code hunks), review verdicts,
  CI results, and merge-conflict alerts, each posted **as the actual person** (their Slack name and
  avatar), not a generic bot.
- **Slack → GitHub actions** — Approve, Comment, and Merge straight from the card; thread replies
  mirror back to the PR conversation (with an echo guard so nothing double-posts).
- **Verified identity** — `/pullpod connect` runs a real GitHub OAuth flow, so a Slack user is
  provably a specific GitHub user. Reviews and merges are submitted **as that user**, and GitHub
  enforces its own repo permissions. Stored tokens are encrypted at rest.
- **Merge policy** — the Merge button appears once a PR is *Mergeable* (at least one approval, no
  outstanding change requests). An optional per-repo allowlist can restrict who may merge.
- **State at a glance** — a colored card and status tag per state (draft / open / mergeable /
  merged / closed); the PR title is a link, so a PR stays reachable even after the buttons are gone.
- **App Home, reminders & digests** — your open PRs and review queue, pause/resume, review time
  slots, plus cron-driven stale-PR nudges and team digests.

## Architecture

Node 22 + TypeScript. A single always-on process runs an Express server that hosts both Slack (via
Bolt's `ExpressReceiver`) and the GitHub webhook endpoint. Webhooks are verified, deduped, and
pushed onto a **pg-boss** queue backed by the same Postgres (no Redis); a worker drains them with
per-PR ordering and a Slack Tier-2 throttle. All state lives in Postgres. Cron jobs handle
reminders and digests.

```
src/
  index.ts            Express + Bolt bootstrap, /healthz
  config.ts           zod-validated env
  db/                 pg pool, typed repo layer, SQL migrations
  github/
    webhooks.ts       signature verify → dedupe → enqueue
    client.ts         Octokit app-auth
    oauth.ts          per-user OAuth (verified identity)
    repo-rules.ts     "does this base branch require review?" detection
    handlers/         pr-opened, pr-closed, review, comment, checks, push, reviewers, card, bots
  slack/
    app.ts            Bolt setup
    channels.ts       shared-channel + threading ops, posting as the actor
    home.ts           App Home view
    interactivity.ts  card buttons + modals (approve / comment / merge)
    commands.ts       /pullpod
    blocks/           Block Kit builders (pr-card, events)
  sync/               user-mapping, channel-naming, mergeability
  jobs/               queue, worker, throttle, cron
```

## Setup

PullPod is a shared team service: it runs deployed with a stable public URL, and both the Slack
app and GitHub App point at that URL. There is no tunnel in the normal flow.

**Prerequisites:** Node 22+ and a Postgres database (which also backs the job queue).

1. **Install & configure**
   ```bash
   npm install
   cp .env.example .env   # fill in the values (see .env.example for every key)
   ```

2. **Create the Slack app** from [`slack-manifest.yml`](slack-manifest.yml). Install it, copy the
   bot token + signing secret into `.env`, and invite the bot to your shared channel
   (`/invite @PullPod`). Set the three request URLs (Events, Interactivity, `/pullpod`) to
   `https://<service-url>/slack/events` *after* the first deploy — Slack re-verifies the Events
   URL on save.

3. **Create the GitHub App** for your org with the permissions & webhook events in
   [plan.md](plan.md) §4.2. Point the webhook at `https://<service-url>/webhooks/github` with a
   secret, and install it on the repos you want watched. Put the App ID, base64-encoded private key
   (`base64 -i key.pem`), webhook secret, and installation ID into `.env`.

   > For precise review-required detection on repos using **classic branch protection**, grant the
   > App **Administration: Read**. Repos that enforce reviews via **rulesets** don't need it.

4. **(Optional) Enable verified identity** — create an OAuth-capable GitHub App (or add a callback
   to the same one) and set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `TOKEN_ENC_KEY` (32 bytes),
   and `PUBLIC_URL`. Users then run `/pullpod connect`.

5. **Migrate the database**
   ```bash
   npm run db:migrate
   ```

6. **Deploy** — see [`deploy/cloudrun.md`](deploy/cloudrun.md), then wire the URLs from steps 2–3.

## `/pullpod` commands

| Command | What it does |
|---|---|
| `/pullpod connect` | Link your GitHub account via OAuth (verified identity) |
| `/pullpod status` | Show your link status and preferences |
| `/pullpod pause` / `resume` | Stop / resume being pulled into PR threads |
| `/pullpod timeslot ...` | Set your review time slots |
| `/pullpod repos` | List watched repos |
| `/pullpod repo <name> on\|off` | Enable/disable a repo |
| `/pullpod refresh-cards` | Re-render existing PR cards |
| `/pullpod help` | Usage |

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch-mode dev server (tsx) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest |
| `npm run db:migrate` | Apply SQL migrations in `supabase/migrations` |

## Deployment

PullPod is a **shared team service**, so it runs as an always-on deployment with a stable HTTPS URL
that Slack and the GitHub webhooks point at — not a laptop tunnel.

[`deploy/cloudrun.md`](deploy/cloudrun.md) documents Google Cloud Run (Dockerfile build, Secret
Manager, and the `--min-instances=1 --no-cpu-throttling` flags that keep the worker + cron
running). Any always-on host works the same way (Railway / Fly / Render + a Postgres). Set `TZ` to
your timezone to control cron scheduling.

> Iterating locally? `npm run dev` runs the server on `localhost`. A solo dev who needs live
> webhooks can tunnel temporarily — see [docs/scaling.md](docs/scaling.md) — but that's a dev-loop
> convenience, never how the team runs it.
