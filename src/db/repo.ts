import { query } from './pool.js';
import type {
  GithubKind,
  MessageLink,
  PrChannel,
  RepoConfig,
  UserLink,
  UserPrefs,
} from './types.js';

// --- processed_events (idempotency) ---

/** Returns true if this delivery is new (and records it); false if already seen. */
export async function markEventProcessed(
  deliveryId: string,
  source: 'github' | 'slack',
): Promise<boolean> {
  const res = await query(
    `insert into processed_events (delivery_id, source) values ($1, $2)
     on conflict (delivery_id) do nothing returning delivery_id`,
    [deliveryId, source],
  );
  return (res.rowCount ?? 0) > 0;
}

// --- user_links ---

export async function getUserLinkByGithub(login: string): Promise<UserLink | null> {
  const res = await query<UserLink>(`select * from user_links where github_login = $1`, [login]);
  return res.rows[0] ?? null;
}

export async function getUserLinkBySlack(slackUserId: string): Promise<UserLink | null> {
  const res = await query<UserLink>(`select * from user_links where slack_user_id = $1`, [
    slackUserId,
  ]);
  return res.rows[0] ?? null;
}

export async function upsertUserLink(
  githubLogin: string,
  slackUserId: string,
  matchedBy: 'email' | 'manual',
): Promise<UserLink> {
  const res = await query<UserLink>(
    `insert into user_links (github_login, slack_user_id, matched_by)
     values ($1, $2, $3)
     on conflict (github_login) do update
       set slack_user_id = excluded.slack_user_id, matched_by = excluded.matched_by
     returning *`,
    [githubLogin, slackUserId, matchedBy],
  );
  return res.rows[0]!;
}

export async function githubLoginsForSlackUsers(
  slackUserIds: string[],
): Promise<Map<string, string>> {
  if (slackUserIds.length === 0) return new Map();
  const res = await query<UserLink>(
    `select * from user_links where slack_user_id = any($1)`,
    [slackUserIds],
  );
  return new Map(res.rows.map((r) => [r.slack_user_id, r.github_login]));
}

// --- user_prefs ---

export async function getUserPrefs(slackUserId: string): Promise<UserPrefs> {
  const res = await query<UserPrefs>(`select * from user_prefs where slack_user_id = $1`, [
    slackUserId,
  ]);
  if (res.rows[0]) return res.rows[0];
  const created = await query<UserPrefs>(
    `insert into user_prefs (slack_user_id) values ($1)
     on conflict (slack_user_id) do update set slack_user_id = excluded.slack_user_id
     returning *`,
    [slackUserId],
  );
  return created.rows[0]!;
}

export async function updateUserPrefs(
  slackUserId: string,
  patch: Partial<Omit<UserPrefs, 'slack_user_id' | 'updated_at'>>,
): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await query(
    `insert into user_prefs (slack_user_id) values ($1)
       on conflict (slack_user_id) do nothing`,
    [slackUserId],
  );
  await query(
    `update user_prefs set ${sets.join(', ')}, updated_at = now() where slack_user_id = $1`,
    [slackUserId, ...keys.map((k) => (patch as any)[k])],
  );
}

// --- repo_configs ---

export async function getRepoConfig(repoFullName: string): Promise<RepoConfig | null> {
  const res = await query<RepoConfig>(`select * from repo_configs where repo_full_name = $1`, [
    repoFullName,
  ]);
  return res.rows[0] ?? null;
}

export async function upsertRepoConfig(
  repoFullName: string,
  patch: Partial<Omit<RepoConfig, 'id' | 'repo_full_name'>> = {},
): Promise<RepoConfig> {
  const res = await query<RepoConfig>(
    `insert into repo_configs (repo_full_name) values ($1)
       on conflict (repo_full_name) do nothing`,
    [repoFullName],
  );
  void res;
  const keys = Object.keys(patch);
  if (keys.length > 0) {
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    await query(`update repo_configs set ${sets.join(', ')} where repo_full_name = $1`, [
      repoFullName,
      ...keys.map((k) => (patch as any)[k]),
    ]);
  }
  const out = await getRepoConfig(repoFullName);
  return out!;
}

export async function listRepoConfigs(): Promise<RepoConfig[]> {
  const res = await query<RepoConfig>(`select * from repo_configs order by repo_full_name`);
  return res.rows;
}

// --- pr_channels ---

export async function getPrChannel(
  repoFullName: string,
  prNumber: number,
): Promise<PrChannel | null> {
  const res = await query<PrChannel>(
    `select * from pr_channels where repo_full_name = $1 and pr_number = $2`,
    [repoFullName, prNumber],
  );
  return res.rows[0] ?? null;
}

export async function getPrChannelById(id: number): Promise<PrChannel | null> {
  const res = await query<PrChannel>(`select * from pr_channels where id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function getPrChannelByChannelId(channelId: string): Promise<PrChannel | null> {
  const res = await query<PrChannel>(`select * from pr_channels where channel_id = $1`, [channelId]);
  return res.rows[0] ?? null;
}

export async function insertPrChannel(
  row: Omit<PrChannel, 'id' | 'first_review_at' | 'closed_at' | 'merged' | 'state'> & {
    state?: PrChannel['state'];
  },
): Promise<PrChannel> {
  const res = await query<PrChannel>(
    `insert into pr_channels
       (repo_full_name, pr_number, channel_id, channel_name, state, pr_title,
        pr_author_login, pr_url, is_draft, opened_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning *`,
    [
      row.repo_full_name,
      row.pr_number,
      row.channel_id,
      row.channel_name,
      row.state ?? 'open',
      row.pr_title,
      row.pr_author_login,
      row.pr_url,
      row.is_draft,
      row.opened_at,
    ],
  );
  return res.rows[0]!;
}

export async function updatePrChannel(
  id: number,
  patch: Partial<Omit<PrChannel, 'id'>>,
): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  await query(`update pr_channels set ${sets.join(', ')} where id = $1`, [
    id,
    ...keys.map((k) => (patch as any)[k]),
  ]);
}

export async function setFirstReviewIfUnset(id: number, at: string): Promise<void> {
  await query(`update pr_channels set first_review_at = $2 where id = $1 and first_review_at is null`, [
    id,
    at,
  ]);
}

export async function listOpenPrChannels(): Promise<PrChannel[]> {
  const res = await query<PrChannel>(`select * from pr_channels where state = 'open'`);
  return res.rows;
}

/** Channel names must be globally unique forever (archived ones included). */
export async function channelNameExists(name: string): Promise<boolean> {
  const res = await query(`select 1 from pr_channels where channel_name = $1`, [name]);
  return (res.rowCount ?? 0) > 0;
}

// --- message_links ---

export async function getMessageLink(
  kind: GithubKind,
  githubId: number,
): Promise<MessageLink | null> {
  const res = await query<MessageLink>(
    `select * from message_links where github_kind = $1 and github_id = $2`,
    [kind, githubId],
  );
  return res.rows[0] ?? null;
}

export async function insertMessageLink(
  row: Omit<MessageLink, 'id'>,
): Promise<MessageLink> {
  const res = await query<MessageLink>(
    `insert into message_links (pr_channel_id, github_kind, github_id, slack_ts, slack_thread_ts)
     values ($1,$2,$3,$4,$5)
     on conflict (github_kind, github_id) do update set slack_ts = excluded.slack_ts
     returning *`,
    [row.pr_channel_id, row.github_kind, row.github_id, row.slack_ts, row.slack_thread_ts],
  );
  return res.rows[0]!;
}

/** Used by two-way sync to break echo loops: is this Slack ts one we posted? */
export async function slackTsIsOurs(prChannelId: number, slackTs: string): Promise<boolean> {
  const res = await query(
    `select 1 from message_links where pr_channel_id = $1 and slack_ts = $2`,
    [prChannelId, slackTs],
  );
  return (res.rowCount ?? 0) > 0;
}
