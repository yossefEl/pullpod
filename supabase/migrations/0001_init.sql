-- PullPod initial schema
-- Single-tenant for now (one Slack workspace, one GitHub org install) but the
-- installations row keeps the door open for multi-tenant later.

create table if not exists installations (
  id                 bigint generated always as identity primary key,
  slack_team_id      text not null unique,
  github_org         text not null,
  github_install_id  bigint not null,
  created_at         timestamptz not null default now()
);

-- github_login <-> slack_user_id. Auto-matched by email, manual fallback via /pullpod link.
create table if not exists user_links (
  id             bigint generated always as identity primary key,
  github_login   text not null unique,
  slack_user_id  text not null unique,
  matched_by     text not null check (matched_by in ('email', 'manual')),
  created_at     timestamptz not null default now()
);

-- Per-user notification preferences (App Home settings).
create table if not exists user_prefs (
  slack_user_id     text primary key,
  paused            boolean not null default false,
  timeslot_start    time,
  timeslot_end      time,
  timezone          text not null default 'Europe/Budapest',
  notify_ci         boolean not null default true,
  updated_at        timestamptz not null default now()
);

-- Which repos are active and how they behave.
create table if not exists repo_configs (
  id                  bigint generated always as identity primary key,
  repo_full_name      text not null unique,
  enabled             boolean not null default true,
  team_channel_id     text,
  channel_prefix      text not null default '_pr',
  skip_draft          boolean not null default true,
  bot_pr_strategy     text not null default 'pool'
                        check (bot_pr_strategy in ('pool', 'skip', 'channel')),
  ci_notify_level     text not null default 'failures'
                        check (ci_notify_level in ('all', 'failures', 'none'))
);

-- The core mapping: PR <-> channel.
create table if not exists pr_channels (
  id                bigint generated always as identity primary key,
  repo_full_name    text not null,
  pr_number         int  not null,
  channel_id        text not null unique,
  channel_name      text not null,
  state             text not null default 'open' check (state in ('open', 'archived')),
  pr_title          text not null,
  pr_author_login   text not null,
  pr_url            text not null,
  is_draft          boolean not null default false,
  opened_at         timestamptz not null,
  first_review_at   timestamptz,
  closed_at         timestamptz,
  merged            boolean,
  unique (repo_full_name, pr_number)
);

-- GitHub comment/review <-> Slack message. Enables threading, edit/delete sync, dedup.
create table if not exists message_links (
  id               bigint generated always as identity primary key,
  pr_channel_id    bigint not null references pr_channels(id) on delete cascade,
  github_kind      text not null
                     check (github_kind in ('issue_comment', 'review_comment', 'review', 'ci', 'system')),
  github_id        bigint,
  slack_ts         text not null,
  slack_thread_ts  text,
  unique (github_kind, github_id)
);

-- Webhook idempotency (GitHub redelivers; Slack retries).
create table if not exists processed_events (
  delivery_id  text primary key,
  source       text not null check (source in ('github', 'slack')),
  received_at  timestamptz not null default now()
);

create index if not exists idx_pr_channels_state on pr_channels (state);
create index if not exists idx_pr_channels_author on pr_channels (pr_author_login);
create index if not exists idx_message_links_pr on message_links (pr_channel_id);
