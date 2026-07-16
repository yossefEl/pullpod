# PullPod 🫛

**A pod for every pull request.** Internal Slack ↔ GitHub app for the Voovo team, inspired by
[Axolo](https://axolo.co): every PR gets its own ephemeral Slack channel that syncs comments,
reviews, and CI status — then archives itself on merge.

📋 See [plan.md](plan.md) for the full technical plan (architecture, data model, event flows,
phased roadmap).

## What it does

- **1 PR = 1 channel** — opens a `_pr_<repo>_<num>_<title>` channel, invites the author +
  reviewers (mapped GitHub → Slack by email), posts a pinned card, and archives on merge/close.
- **GitHub → Slack sync** — PR comments, inline review comments (with code hunks + threading),
  review verdicts (✅/🔴/💬), CI results (failures-only by default), and merge-conflict alerts,
  each posted as the GitHub author via `chat:write.customize`.
- **Slack → GitHub actions** — Approve / Request changes / Comment straight from the pinned card.
- **Two-way comment sync** — top-level messages in a pod mirror back to the PR (with echo guard).
- **App Home** — your open PRs + PRs awaiting your review, plus pause, review time slots, and
  GitHub account linking.
- **Reminders & digests** — daily stale-PR nudges (only when a review is actually pending on you),
  per-repo team digest, standup recap, and a weekly cycle-time analytics post.

## Architecture

Node 22 + TypeScript. A single always-on process runs an Express server that hosts both Slack
(via Bolt's `ExpressReceiver`) and the GitHub webhook endpoint. Webhooks are verified, deduped,
and pushed onto a BullMQ/Redis queue; a worker drains them with per-PR ordering and a Slack
Tier-2 token-bucket throttle. State lives in Postgres (Supabase). Cron jobs handle reminders and
digests. See [plan.md](plan.md) §2 for the full diagram.

```
src/
  index.ts            Express + Bolt bootstrap, /healthz
  config.ts           zod-validated env
  db/                 pg pool, typed repo layer
  github/
    webhooks.ts       signature verify → dedupe → enqueue
    client.ts         Octokit app-auth
    handlers/         pr-opened, pr-closed, review, comment, checks, push, reviewers, bots
  slack/
    app.ts            Bolt setup
    home.ts           App Home view
    interactivity.ts  buttons + modals
    commands.ts       /pullpod
    two-way.ts        Slack → GitHub mirror
    blocks/           Block Kit builders
    channels.ts       channel ops (create/invite/pin/archive, archived-guard, impersonation)
  sync/               user-mapping, channel-naming, mergeability
  jobs/               queue, worker, throttle, cron
```

## Local setup

**Prerequisites:** Node 22+, a Redis instance, a Postgres database (Supabase), and
[ngrok](https://ngrok.com) for a public tunnel.

1. **Install & configure**
   ```bash
   npm install
   cp .env.example .env   # fill in the values (see below)
   ```

2. **Create the GitHub App** (org `voovostudy`) with the permissions & webhook events in
   [plan.md](plan.md) §4.2. Set the webhook URL to `https://<ngrok>.ngrok.app/webhooks/github`
   and a webhook secret. Install it on the repos you want watched. Put the App ID, base64-encoded
   private key (`base64 -i key.pem`), webhook secret, and installation ID in `.env`.

3. **Create the Slack app** from [`slack-manifest.yml`](slack-manifest.yml) (replace the
   `REPLACE_ME` ngrok host first). Install to the workspace and copy the bot token + signing
   secret into `.env`.

4. **Migrate the database**
   ```bash
   npm run db:migrate
   ```

5. **Run**
   ```bash
   ngrok http 3000      # in one terminal
   npm run dev          # in another
   ```

6. **Link users** — each teammate runs `/pullpod link <github-username>` (or PullPod auto-matches
   by email where GitHub exposes a public email).

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

PullPod is a **shared team service**, so it runs as an always-on deployment with a stable HTTPS
URL that everyone's Slack workspace and the GitHub org webhooks point at — not a laptop tunnel.

**Google Cloud Run** is the documented target: see [`deploy/cloudrun.md`](deploy/cloudrun.md) for
the full walkthrough (Dockerfile build, Secret Manager, the `--min-instances=1 --no-cpu-throttling`
flags that keep the worker + cron running, and wiring the Slack/GitHub apps to the service URL).
Any always-on host works the same way (Railway/Fly/Render + a Redis addon); `TZ` controls cron
scheduling (default `Europe/Budapest`).

> The local-setup steps above (with ngrok) are only for a single developer smoke-testing changes.
> Because a tunnel dies when that laptop sleeps, it's never how the team runs the app.
