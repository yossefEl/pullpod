-- In the single-channel thread model every PR shares one channel_id (#pr-approve),
-- so the original UNIQUE(channel_id) constraint is wrong and makes the 2nd+ PR's
-- insert fail (which, after the root message posts, retries and double-posts).
alter table pr_channels drop constraint if exists pr_channels_channel_id_key;
drop index if exists pr_channels_channel_id_key;

-- One row per (repo, pr): lets inserts be idempotent (ON CONFLICT) and dedupes
-- retries / concurrent webhooks for the same PR.
create unique index if not exists idx_pr_channels_repo_pr on pr_channels (repo_full_name, pr_number);
