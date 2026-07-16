# PullPod — Technical Plan

> **PullPod** — a pod for every pull request. An internal Slack ↔ GitHub app for the Voovo team,
> modeled on [Axolo](https://axolo.co): every PR gets its own ephemeral Slack channel that syncs
> comments, reviews, and CI status, then archives itself on merge.
>
> Reference screenshot of Axolo's App Home (the UX bar we're aiming at):
> [`docs/reference/axolo-app-home.png`](docs/reference/axolo-app-home.png)

---

## 1. Scope

### Goals (Phases 1–3)

- **1 PR = 1 channel**: auto-create a Slack channel per PR, invite author + reviewers, archive on close/merge.
- **GitHub → Slack sync**: PR comments, code review comments, review verdicts, CI checks, merge conflicts.
- **Slack → GitHub actions**: approve / request changes / comment / open from Slack.
- **Reminders & digests**: stale-PR nudges, team channel digest, standup recap.
- **App Home**: personal dashboard — your PRs, PRs awaiting your review, settings (pause, time slots, GitHub account link).
- **Analytics (lightweight)**: PR cycle time, time-to-first-review, posted as a weekly digest.

### Non-goals (dropped Phase 4)

- ❌ Multi-workspace Slack OAuth distribution / Slack App Directory listing
- ❌ Billing, marketing site, admin dashboard
- ❌ GitLab support
- ❌ Multi-tenancy — **single Slack workspace (Voovostudy), single GitHub org installation**

Being internal-only simplifies a lot: bot token and GitHub App installation ID live in env/config,
no OAuth install flow, no tenant isolation. We still keep an `installations` row so the schema
doesn't need surgery if this ever goes multi-tenant.

> **Scaling & alternatives:** every simplification here (single-tenant, pg-boss instead of
> Redis, single Cloud Run instance, in-process cron/locks) is recorded in
> [`docs/scaling.md`](docs/scaling.md) along with the signal that means "revisit this" and the
> migration path back to the heavier option. Read it before running more than one instance —
> the per-PR mutex, Slack throttle, and cron all assume a single process.

---

## 2. Architecture

```
                    ┌────────────────────────────────────────────┐
 GitHub App         │              PullPod backend               │        Slack App
 (org install)      │        Node 22 + TypeScript                │     (Voovostudy)
                    │                                            │
 webhooks ─────────▶│  Express: /webhooks/github  ── verify sig  │◀───── Events API /slack/events
                    │  Bolt JS:  /slack/events, interactivity,   │◀───── Interactivity (buttons,
                    │            slash commands, App Home        │        modals, App Home)
                    │                  │                         │
                    │                  ▼                         │
                    │       pg-boss queue (in Postgres)          │
                    │   - per-PR ordering (keyed mutex)          │
                    │   - retries, idempotency by delivery_id    │
                    │   - throttling for Slack tier-2 calls      │
                    │                  │                         │
                    │                  ▼                         │
                    │   Handlers ──▶ Slack Web API (chat.post…)  │
                    │            ──▶ Octokit (GitHub REST)       │
                    │            ──▶ Postgres (Supabase)         │
                    │                                            │
                    │   node-cron: reminders, digests, standup   │
                    └────────────────────────────────────────────┘
```

### Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 + TypeScript | Best SDK support on both sides |
| Slack SDK | `@slack/bolt` (ExpressReceiver) | Events, interactivity, App Home, slash commands in one framework |
| GitHub | GitHub App + `octokit` + `@octokit/webhooks` | Org install, app identity, signature verification built in |
| HTTP | Express (shared with Bolt's receiver) | One process, one port |
| Queue | pg-boss (Postgres-backed) | Durable ACK-fast/process-later + retries, reusing the DB — no Redis to run |
| DB | Postgres (Supabase project) | Already in our toolchain; also backs the queue |
| Scheduler | `node-cron` in-process | Internal scale doesn't need a distributed scheduler |
| Deploy | Cloud Run (min-instances=1) or Railway/Fly — one service | Always-on public HTTPS, managed TLS |
| Local dev | `ngrok` tunnel + a dev Slack app + a dev GitHub App | Both platforms need public URLs |
| Lint/format/test | ESLint + Prettier + Vitest | Standard |

### Why not serverless

Slack requires a 3-second ACK and retries aggressively; GitHub redelivers on timeout. A persistent
process with a Bolt receiver + a pg-boss queue is dramatically simpler than wiring cold-start-safe
functions, and an internal tool doesn't need scale-to-zero.

---

## 3. Data model (Postgres / Supabase)

```sql
-- Single row for now; keeps the door open for multi-tenant later.
create table installations (
  id                 bigint generated always as identity primary key,
  slack_team_id      text not null unique,
  github_org         text not null,
  github_install_id  bigint not null,
  created_at         timestamptz not null default now()
);

-- github_login <-> slack_user_id. Auto-matched by email, manual fallback via /pullpod link.
create table user_links (
  id             bigint generated always as identity primary key,
  github_login   text not null unique,
  slack_user_id  text not null unique,
  matched_by     text not null check (matched_by in ('email','manual')),
  created_at     timestamptz not null default now()
);

-- Per-user notification preferences (App Home settings).
create table user_prefs (
  slack_user_id     text primary key,
  paused            boolean not null default false,        -- "Pause PullPod"
  timeslot_start    time,                                  -- review notification window
  timeslot_end      time,
  timezone          text not null default 'Europe/Budapest',
  notify_ci         boolean not null default true,
  updated_at        timestamptz not null default now()
);

-- Which repos are active and how they behave.
create table repo_configs (
  id                  bigint generated always as identity primary key,
  repo_full_name      text not null unique,                -- e.g. 'voovostudy/voovo-mobile'
  enabled             boolean not null default true,
  team_channel_id     text,                                -- digest / announcements channel
  channel_prefix      text not null default '_pr',
  skip_draft          boolean not null default true,       -- wait for ready_for_review
  bot_pr_strategy     text not null default 'pool'         -- 'pool' | 'skip' | 'channel'
                        check (bot_pr_strategy in ('pool','skip','channel')),
  ci_notify_level     text not null default 'failures'     -- 'all' | 'failures' | 'none'
                        check (ci_notify_level in ('all','failures','none'))
);

-- The core mapping: PR <-> channel.
create table pr_channels (
  id                bigint generated always as identity primary key,
  repo_full_name    text not null,
  pr_number         int  not null,
  channel_id        text not null unique,
  channel_name      text not null,
  state             text not null default 'open'           -- 'open' | 'archived'
                      check (state in ('open','archived')),
  pr_title          text not null,
  pr_author_login   text not null,
  pr_url            text not null,
  is_draft          boolean not null default false,
  opened_at         timestamptz not null,
  first_review_at   timestamptz,                           -- analytics
  closed_at         timestamptz,
  merged            boolean,
  unique (repo_full_name, pr_number)
);

-- GitHub comment/review <-> Slack message. Enables threading, edit/delete sync, dedup.
create table message_links (
  id               bigint generated always as identity primary key,
  pr_channel_id    bigint not null references pr_channels(id) on delete cascade,
  github_kind      text not null check (github_kind in
                     ('issue_comment','review_comment','review','ci','system')),
  github_id        bigint,                                 -- comment/review id (null for ci/system)
  slack_ts         text not null,
  slack_thread_ts  text,                                   -- set when it's a threaded reply
  unique (github_kind, github_id)
);

-- Webhook idempotency (GitHub redelivers; Slack retries).
create table processed_events (
  delivery_id  text primary key,                           -- X-GitHub-Delivery / Slack event_id
  source       text not null check (source in ('github','slack')),
  received_at  timestamptz not null default now()
);
```

---

## 4. Platform configuration

### 4.1 Slack app (created via app manifest, checked into repo as `slack-manifest.yml`)

- **Bot scopes**: `channels:manage`, `channels:read`, `channels:join`, `chat:write`,
  `chat:write.customize` (post as GitHub author's name + avatar), `users:read`,
  `users:read.email`, `commands`, `im:write`, `pins:write`, `bookmarks:write`, `reactions:write`
- **Event subscriptions**: `app_home_opened`, `member_joined_channel`; (Phase 3 two-way sync
  adds `message.channels`)
- **Interactivity**: enabled → `POST /slack/events`
- **Slash command**: `/pullpod` → subcommands `link`, `pause`, `resume`, `timeslot`, `status`, `help`
- **App Home**: Home tab enabled

### 4.2 GitHub App (org: `voovostudy`, installed on selected repos)

- **Permissions**: Pull requests (R/W), Checks (Read), Commit statuses (Read), Contents (Read),
  Members (Read), Deployments (Read), Metadata (Read)
- **Webhook events**: `pull_request`, `pull_request_review`, `pull_request_review_comment`,
  `issue_comment`, `check_run`, `check_suite`, `status`, `deployment_status`, `push`
- **Webhook URL**: `POST /webhooks/github`, secret verified via `X-Hub-Signature-256`
- Comments posted from Slack go through the app identity with an attribution line
  (`— @slackuser via PullPod`), since GitHub Apps can't impersonate users.

### 4.3 Channel naming

`_pr_<repo-short>_<pr-number>_<slugified-title>` truncated to Slack's 80-char limit, e.g.
`_pr_voovo-mobile_660_fix_cu-869dy77d0-offering` (mirrors the Axolo pattern in the screenshot —
the leading `_` keeps PR pods sorted together and out of the way in the sidebar).
On `name_taken` (archived channels hold their names forever): append `-2`, `-3`, …

---

## 5. Event flows

### PR opened (`pull_request.opened` / `.ready_for_review`)

1. Webhook ACKed, job enqueued (idempotency: delivery id).
2. Skip if repo disabled, PR is draft (and `skip_draft`), or author is a bot with `bot_pr_strategy != 'channel'`
   (Dependabot/Renovate PRs pool into one `#_pr_bots` channel or are skipped).
3. `conversations.create` → invite mapped author + requested reviewers → post **PR card**
   (Block Kit: title, author, branch, +/- diff stats, labels, `Open PR` / `Approve` /
   `Request changes` / `Comment` buttons) → pin it, add PR URL as channel bookmark.
4. Insert `pr_channels` row; unmapped GitHub users get a DM-able mention fallback in the card.

### Comments & reviews (GitHub → Slack)

- `issue_comment` / `pull_request_review_comment` → post in channel via `chat:write.customize`
  (GitHub author's name/avatar). Review comments include a code-hunk snippet + file/line link.
  Replies to a review-comment thread → Slack thread via `message_links`.
- `pull_request_review` → ✅ approved / 🔴 changes requested / 💬 commented banner message.
- Edited/deleted GitHub comments → `chat.update` / `chat.delete` via `message_links`.
- First review recorded → set `first_review_at` (analytics).

### CI & mergeability

- `check_suite.completed` / `status` → post per `ci_notify_level` (default: **failures only**;
  a green run just updates a ✅ reaction on the PR card).
- `push` to the PR branch → recompute mergeability (GitHub's `mergeable` needs a poll after push);
  on conflict, post a ⚠️ "branch has conflicts" message once (not on every push).

### PR closed / merged

1. Post outcome message (🎉 merged by X / ❌ closed without merge).
2. Update `pr_channels` (state, `closed_at`, `merged`), then `conversations.archive`.
3. **Guard everywhere**: any handler that posts must check `state = 'open'` first — late CI
   webhooks after archive would otherwise throw `is_archived`.
4. `pull_request.reopened` → unarchive the same channel if it exists, else recreate.

### Slack → GitHub (interactivity)

- **Approve / Request changes / Comment** buttons → modal for optional body → Octokit
  `pulls.createReview`. Requires the clicker to be in `user_links`; otherwise the modal
  prompts them to run `/pullpod link <github-username>`.
- Phase 3 two-way sync: top-level (non-threaded) human messages in a pod channel are mirrored
  as PR issue comments with attribution; PullPod's own messages and threads are ignored to
  prevent echo loops (`message_links` breaks cycles in both directions).

---

## 6. App Home (modeled on the screenshot)

**Settings section**
- Pause / Resume PullPod (won't be invited to new pod channels)
- Update reviewing time slots (modal: start/end + timezone; reminders and channel invites
  respect the window — messages still queue, invites defer)
- GitHub link status: "✅ Signed in with GitHub as `<login>`" / `Link GitHub` button
- CI notification toggle

**"Your Pull Requests" section** (`Refresh` button, on `app_home_opened` auto-refresh)
- **PRs you're assigned as reviewer** — channel link, status word + emoji
  (`mergeable 👍` / `reviewable 🙏` / `changes requested 🔴` / `conflicts ⚠️`),
  "Opened X ago · last update Y ago", repo | author | reviewers line, `Open` button
- **Your open PRs** — same card shape

Status derivation: `mergeable` = approved + checks green + no conflicts; `reviewable` = awaiting
review; plus `changes_requested`, `conflicts`, `ci_failed`.

---

## 7. Reminders, digests, standup (cron)

| Job | Schedule | Behavior |
|---|---|---|
| Stale-PR reminder | weekdays 09:30 (per-user tz, inside time slot) | DM each reviewer a list of PRs **actually awaiting their review** ≥ 24h; nothing pending → no message |
| Team digest | weekdays 09:00 → `repo_configs.team_channel_id` | Open PR count, awaiting-review list, merged-yesterday list |
| Standup recap | weekdays 09:55 | Per-member one-liner: PRs opened / merged / reviewed yesterday |
| Weekly analytics | Mon 10:00 | Median cycle time (open→merge), time-to-first-review, review load per person, from `pr_channels` timestamps |

All sends respect `user_prefs.paused` and time slots. **Noise discipline is a feature**: default
to failures-only CI, no bot comments, reminders only when action is genuinely pending.

---

## 8. Project structure

```
pullpod/
├── plan.md
├── slack-manifest.yml
├── docs/reference/axolo-app-home.png
├── supabase/migrations/         # SQL from §3
├── src/
│   ├── index.ts                 # Express + Bolt bootstrap, health check
│   ├── config.ts                # env parsing (zod)
│   ├── github/
│   │   ├── webhooks.ts          # signature verify → enqueue
│   │   ├── client.ts            # Octokit app-auth factory
│   │   └── handlers/            # pr-opened.ts, review.ts, comment.ts, checks.ts, closed.ts
│   ├── slack/
│   │   ├── app.ts               # Bolt setup
│   │   ├── home.ts              # App Home view builder + refresh
│   │   ├── interactivity.ts     # buttons, modals
│   │   ├── commands.ts          # /pullpod subcommands
│   │   └── blocks/              # Block Kit builders (pr-card.ts, review.ts, digest.ts …)
│   ├── sync/
│   │   ├── user-mapping.ts      # email match + manual link
│   │   ├── channel-naming.ts
│   │   └── mergeability.ts
│   ├── jobs/
│   │   ├── queue.ts             # pg-boss setup + enqueue
│   │   └── cron.ts              # reminders, digests, standup, analytics
│   └── db/                      # typed query layer
└── test/                        # Vitest: naming, mapping, block builders, handler logic (nock'd)
```

---

## 9. Phased delivery

### Phase 1 — Core loop (target: ~1 week)

| # | Task | Done when |
|---|---|---|
| 1.1 | Repo scaffold: TS, ESLint, Vitest, Express+Bolt boot, `/healthz` | App runs locally |
| 1.2 | Slack app from manifest (dev + prod), GitHub App created & installed on `voovo-mobile` | Webhooks arrive via ngrok |
| 1.3 | Supabase migrations (§3) + typed db layer | Migration applies cleanly |
| 1.4 | GitHub webhook receiver: verify, dedupe, enqueue; pg-boss worker | Redelivered events are no-ops |
| 1.5 | PR opened → channel + invites + PR card + pin/bookmark | New PR produces a working pod |
| 1.6 | User mapping: email auto-match on boot + `/pullpod link` | Author & reviewers invited correctly |
| 1.7 | Comments/reviews → Slack (with author impersonation, threads) | GitHub conversation mirrors live |
| 1.8 | Closed/merged → outcome + archive; reopen → unarchive; archived-guard | Channel lifecycle correct |
| 1.9 | Deploy to Cloud Run (min-instances=1), point prod apps at it | Works without ngrok |

### Phase 2 — Table stakes (target: ~1 week)

| # | Task |
|---|---|
| 2.1 | CI checks + commit status → failures-only messages, ✅ reaction on green; conflict detection on push |
| 2.2 | Approve / Request changes / Comment buttons + modals → GitHub reviews |
| 2.3 | Draft handling (`skip_draft`), reviewer-added-later invites, `ready_for_review` trigger |
| 2.4 | Bot PR strategy: pool Dependabot/Renovate into `#_pr_bots` |
| 2.5 | Repo onboarding via `/pullpod repos` (enable/disable, set team channel) + roll out to `voovo-content-platform` |
| 2.6 | Slack rate-limit hardening: tier-2 throttle in queue, burst test with 20 simultaneous PRs |

### Phase 3 — Retention & polish (target: ~1–1.5 weeks)

| # | Task |
|---|---|
| 3.1 | App Home dashboard (§6): settings + PR lists + Refresh |
| 3.2 | Time slots + pause (respected by invites, DMs, reminders) |
| 3.3 | Stale-PR reminders + team digest + standup recap (cron) |
| 3.4 | Two-way sync: channel messages → PR comments with attribution + echo-loop guard |
| 3.5 | Weekly analytics digest (cycle time, time-to-first-review) |
| 3.6 | Ops polish: structured logs, Sentry, dead-letter queue alerts to a `#pullpod-ops` channel |

---

## 10. Known gotchas (encoded into the design above)

1. **Slack tier-2 limits** (`conversations.create`/`invite` ~20/min) → queue throttling + bot-PR pooling (2.4, 2.6).
2. **Webhook redelivery & out-of-order events** → `processed_events` + per-PR job ordering.
3. **Archived channel writes fail** → `state` guard before every post.
4. **Channel names are globally unique forever** (archived ones included) → suffix on `name_taken`.
5. **GitHub `mergeable` is lazily computed** → poll with backoff after `push`, don't trust the first `null`.
6. **`users.lookupByEmail` misses** (personal GitHub emails) → manual `/pullpod link` is first-class, unmapped users degrade gracefully in cards.
7. **Echo loops in two-way sync** → `message_links` consulted on both inbound paths; bot-authored content never re-mirrored.
8. **Noise kills adoption** → failures-only CI default, reminders only when action is pending, time slots respected.

---

## 11. Environment & secrets

```
SLACK_BOT_TOKEN=xoxb-…            SLACK_SIGNING_SECRET=…
GITHUB_APP_ID=…                   GITHUB_APP_PRIVATE_KEY=…  (base64)
GITHUB_WEBHOOK_SECRET=…           GITHUB_INSTALLATION_ID=…
DATABASE_URL=…  (Supabase, also backs the pg-boss queue)
SENTRY_DSN=…  (Phase 3)           TZ=Europe/Budapest
```

Secrets live in Cloud Run (Secret Manager); `.env.example` checked in, `.env` gitignored.
