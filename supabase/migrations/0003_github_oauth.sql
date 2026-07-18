-- Per-user verified GitHub identity + encrypted user token, so linking is proven
-- (OAuth) and reviews are submitted as the actual person.
create table if not exists github_identities (
  slack_user_id     text primary key,
  github_login      text not null,
  github_user_id    bigint not null,
  access_token_enc  text not null,
  refresh_token_enc text,
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists idx_github_identities_login on github_identities (github_login);

-- Allow user_links rows created by a verified OAuth flow.
alter table user_links drop constraint if exists user_links_matched_by_check;
alter table user_links
  add constraint user_links_matched_by_check check (matched_by in ('email', 'manual', 'oauth'));
