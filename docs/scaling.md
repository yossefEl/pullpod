# PullPod — Scaling & Architecture Decisions

This is the record of the deliberate simplifications we made for an **internal, single-workspace,
team-scale (~100 PRs)** tool — and, for each one, the **signal that means "revisit this"** and the
**migration path** back to the heavier option. Nothing here is wrong to change later; it's here so
that when we need to scale up we don't have to re-derive the reasoning or rediscover the trade-offs.

> **Read this first if you're about to run more than one instance.** Three components
> (§4, §5, §6) assume a *single* process. They are correct and simple at one instance and
> silently incorrect at two. Horizontal scaling is not just "bump max-instances" — see §4.

---

## Decisions at a glance

| # | Area | What we chose (now) | What we set aside | Revisit when… |
|---|---|---|---|---|
| 1 | Job queue | **pg-boss** (in Postgres) | BullMQ + Redis | Throughput or advanced queue features exceed pg-boss |
| 2 | Tenancy | **Single** workspace + org | Multi-tenant (dropped Phase 4) | Serving another workspace/org, or productizing |
| 3 | Deploy | **Cloud Run, min-instances=1** | Multi-instance / HA | Uptime SLA or throughput needs >1 instance |
| 4 | Per-PR ordering | **In-memory keyed mutex** | Distributed lock | Running >1 instance |
| 5 | Slack rate-limit | **In-memory token bucket** | Distributed limiter | Running >1 instance |
| 6 | Scheduler | **In-process `node-cron`** | pg-boss schedules / Cloud Scheduler | Running >1 instance |
| 7 | Slack transport | **HTTP webhooks (ExpressReceiver)** | Socket Mode | Never needs public ingress / firewall constraints |
| 8 | GitHub review identity | **App identity + attribution** | Per-user OAuth tokens | Reviews must count as the actual human |
| 9 | Local dev | **Deployed (no tunnel)** | ngrok / `gh webhook forward` | Only relevant for solo dev iteration |

---

## 1. Job queue — pg-boss, not BullMQ + Redis

**Now:** `src/jobs/queue.ts` and `worker.ts` use pg-boss, which stores jobs in the same Supabase
Postgres (`pgboss` schema, auto-created). This gives durable ACK-fast/process-later semantics and
automatic retries with backoff — the two things the queue exists for — with **zero extra
infrastructure**.

**Set aside:** BullMQ + Redis. Redis is the industry-standard BullMQ backing store and is faster
under heavy load, but it's a second managed service (Upstash/Memorystore), another connection
string, and another failure domain. At ~100 PRs/day the throughput argument doesn't apply.

**Revisit when:**
- Sustained event volume climbs into the **thousands/minute** (Postgres polling starts to cost).
- You need BullMQ-only features: priority lanes, rate-limit *groups*, large-scale delayed jobs,
  flows/dependencies, or a mature dashboard (Bull Board).

**Migration path:** re-add `bullmq` + `ioredis`, restore the `connection`/`Queue`/`Worker` shape
(see git history at commit `9dee321` for the exact prior implementation), provision Redis
(Upstash is simplest on Cloud Run; Memorystore needs a Serverless VPC connector), and add
`REDIS_URL` back to config + Secret Manager. The handler routing in `worker.ts` is unchanged —
only the transport wrapper swaps.

---

## 2. Tenancy — single workspace/org, not multi-tenant

**Now:** one Slack workspace and one GitHub App installation, both from env/secrets. There is a
single `installations` row. No Slack OAuth install flow, no per-tenant token storage, no tenant
isolation on queries.

**Set aside:** the full multi-tenant SaaS shape (the dropped "Phase 4"): Slack OAuth distribution,
GitHub Marketplace listing, per-tenant encrypted token storage, billing.

**Revisit when:** you want PullPod to serve a second Slack workspace or a second GitHub org
(e.g. flufylabs **and** voovostudy at once), or to offer it outside the team.

**Migration path — the schema was built for this:**
- `installations` already exists as the tenant boundary; add its id as a FK on `pr_channels`,
  `user_links`, `repo_configs`, etc., and scope every query by it.
- Add Slack OAuth (`@slack/oauth` / Bolt's `InstallProvider`) and store bot tokens per install
  (encrypted at rest).
- Support multiple GitHub App installations: replace the single `GITHUB_INSTALLATION_ID` with a
  lookup keyed by the webhook's `installation.id`, minting an Octokit per installation.
- Everything user-facing (App Home, `/pullpod`) already keys off `slack_user_id`, so it mostly
  carries over.

---

## 3. Deploy — Cloud Run with one always-on instance

**Now:** `--min-instances=1 --no-cpu-throttling`, single instance. Keeps the pg-boss worker and
`node-cron` alive continuously; simplest possible topology.

**Set aside:** multi-instance / high-availability. A single instance means a Cloud Run revision
swap or crash is a brief (seconds) gap where webhooks queue at GitHub/Slack and are retried or
picked up on restart — acceptable for an internal tool, not for an SLA.

**Revisit when:** you need real uptime guarantees or throughput beyond one instance.

**Migration path:** raising `max-instances` above 1 is **not safe as-is** — see §4–§6 first. Once
those are distributed, bump max-instances and Cloud Run load-balances webhook ingress
automatically; pg-boss already coordinates job pickup across workers safely.

---

## 4. Per-PR ordering — in-memory keyed mutex ⚠️ single-instance

**Now:** `src/jobs/throttle.ts` `withKeyLock(repo#pr, fn)` serializes all work for one PR in
process memory, so out-of-order webhooks (e.g. `closed` arriving before `opened` finishes) can't
race. Correct and free — **at one instance**.

**Why it breaks at scale:** two instances have two separate in-memory maps, so the same PR could
be processed concurrently on both → duplicate channels, races on archive.

**Migration path:** replace the keyed mutex with a distributed lock:
- **Postgres advisory locks** (`pg_advisory_xact_lock(hashtext(repo#pr))`) — zero new infra,
  fits the pg-boss/Postgres stack.
- or pg-boss **singleton keys** per PR so only one job per PR runs at a time.
- or Redis-based locks if Redis is reintroduced for §1.

---

## 5. Slack rate-limit throttle — in-memory token bucket ⚠️ single-instance

**Now:** `slackTier2` in `throttle.ts` caps `conversations.create`/`.invite` at ~18/min via an
in-process token bucket, well under Slack's Tier-2 ceiling.

**Why it breaks at scale:** N instances each allow 18/min → 18·N/min total → Slack 429s.

**Migration path:** move the limiter to a shared store — a Redis token bucket, or a
Postgres-backed counter, or (simplest) route all channel-creation jobs to a **single dedicated
worker/queue** so the in-memory bucket still governs the whole system.

---

## 6. Scheduler — in-process node-cron ⚠️ single-instance

**Now:** `src/jobs/cron.ts` schedules reminders/digests/standup/analytics with `node-cron` inside
the app process.

**Why it breaks at scale:** every instance fires the cron → duplicate DMs and digests.

**Migration path:**
- **pg-boss schedules** (`boss.schedule(name, cron, …)`) — the job is stored in Postgres and
  claimed by exactly one worker; drop-in for the current stack.
- or **Cloud Scheduler** hitting an authenticated `/jobs/run/:name` endpoint.
- or leader election so only one instance runs cron.

---

## 7. Slack transport — HTTP webhooks, not Socket Mode

**Now:** Bolt `ExpressReceiver`; Slack calls our public `/slack/events`. Matches the deployed
topology and shares one port with the GitHub webhook.

**Set aside:** Socket Mode (outbound WebSocket, no public URL). It's genuinely useful when you
*can't* expose ingress (strict firewall, no public URL) and for laptop dev — but it's a different
transport than production, and a deployed team service already has a public URL.

**Revisit when:** a network policy forbids public ingress, or you want one transport for both dev
and prod. **Migration path:** add an app-level token (`xapp-`) and start Bolt with
`socketMode: true`; the listeners in `slack/` are unchanged.

---

## 8. GitHub review identity — app identity + attribution

**Now:** Approve/Request-changes/Comment from Slack submit via the **GitHub App** token, with an
`— submitted by @login via PullPod` attribution line. Simple, no per-user auth.

**Limitation:** the review shows as the app, not the human, so it won't satisfy branch-protection
rules that require a *specific person's* approval.

**Revisit when:** approvals from Slack must legally/procedurally count as the individual.
**Migration path:** add per-user GitHub OAuth, store each user's token (encrypted), and submit
reviews with the user's token instead of the app's. This is the same token infrastructure that
multi-tenancy (§2) needs, so the two tend to land together.

---

## 9. Local dev — deployed, no tunnel

**Now:** because PullPod is a shared team service, it runs deployed; there is no tunnel in the
critical path. A laptop tunnel (ngrok) or `gh webhook forward` would take everyone's PR channels
down when that laptop sleeps.

**When the set-aside options are still useful:** a *solo developer* iterating on changes before
deploying can use ngrok (Slack + GitHub via one public URL) or the no-tunnel combo of Slack
**Socket Mode** + GitHub CLI `gh webhook forward`. These are dev-loop conveniences only, never how
the team runs it.

---

## The one-line rule of thumb

**Staying at one instance keeps everything simple and correct.** The moment you want a second
instance, do §4, §5, and §6 *first* — they're the only things that are subtly wrong under
horizontal scale, and all three have low-effort Postgres-native fixes that don't reintroduce Redis.
