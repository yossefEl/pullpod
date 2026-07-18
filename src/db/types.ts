export interface UserLink {
  id: number;
  github_login: string;
  slack_user_id: string;
  matched_by: 'email' | 'manual' | 'oauth';
  created_at: string;
}

/** A verified GitHub identity (via OAuth) plus the encrypted token to act as them. */
export interface GithubIdentity {
  slack_user_id: string;
  github_login: string;
  github_user_id: number;
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserPrefs {
  slack_user_id: string;
  paused: boolean;
  timeslot_start: string | null;
  timeslot_end: string | null;
  timezone: string;
  notify_ci: boolean;
  updated_at: string;
}

export interface RepoConfig {
  id: number;
  repo_full_name: string;
  enabled: boolean;
  team_channel_id: string | null;
  channel_prefix: string;
  skip_draft: boolean;
  bot_pr_strategy: 'pool' | 'skip' | 'channel';
  ci_notify_level: 'all' | 'failures' | 'none';
}

export interface PrChannel {
  id: number;
  repo_full_name: string;
  pr_number: number;
  /** The shared pr-approve channel (same for every PR). */
  channel_id: string;
  channel_name: string;
  /** ts of this PR's root message in the shared channel — the thread parent. */
  root_ts: string | null;
  state: 'open' | 'archived';
  pr_title: string;
  pr_author_login: string;
  pr_url: string;
  is_draft: boolean;
  opened_at: string;
  first_review_at: string | null;
  closed_at: string | null;
  merged: boolean | null;
}

export type GithubKind = 'issue_comment' | 'review_comment' | 'review' | 'ci' | 'system';

export interface MessageLink {
  id: number;
  pr_channel_id: number;
  github_kind: GithubKind;
  github_id: number | null;
  slack_ts: string;
  slack_thread_ts: string | null;
}
