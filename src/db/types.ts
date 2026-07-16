export interface UserLink {
  id: number;
  github_login: string;
  slack_user_id: string;
  matched_by: 'email' | 'manual';
  created_at: string;
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
  channel_id: string;
  channel_name: string;
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
