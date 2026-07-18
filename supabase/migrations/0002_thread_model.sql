-- Single-channel thread model: each PR is a root message in the shared channel,
-- and all its events are replies under root_ts. Add the thread-parent ts.
alter table pr_channels add column if not exists root_ts text;

-- Look up a PR by its root (thread-parent) message for two-way sync.
create index if not exists idx_pr_channels_root_ts on pr_channels (root_ts);
