import type { KnownBlock } from '@slack/types';
import { slack } from './client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { slackTier2, withKeyLock } from '../jobs/throttle.js';
import { getPrChannelById } from '../db/repo.js';
import type { PrCard } from './blocks/pr-card.js';

export interface AsUser {
  username: string;
  icon_url?: string;
}

/** Create a channel (Tier-2, throttled), tolerating name_taken by returning null. */
export async function createChannel(name: string): Promise<string | null> {
  try {
    const res = await slackTier2.run(() => slack.conversations.create({ name }));
    return res.channel?.id ?? null;
  } catch (err: any) {
    if (err?.data?.error === 'name_taken') return null;
    throw err;
  }
}

// Resolved once per process — the shared channel id doesn't change.
let approveChannelId: string | null = null;

interface FoundChannel {
  id: string;
  archived: boolean;
  isPrivate: boolean;
  isMember: boolean;
}

/**
 * Resolve the single shared channel (default `#pr-approve`) that holds one threaded
 * message per PR. Reuses an existing channel — public OR private — and only creates
 * one as a last resort. Note: Slack never lists a private channel to a bot that isn't
 * a member, and a bot cannot self-join a private channel — so a private #pr-approve
 * must have the bot invited (`/invite @PullPod`) once.
 */
export async function ensureApproveChannel(): Promise<string> {
  if (approveChannelId) return approveChannelId;
  const name = config.PR_CHANNEL_NAME;

  // 1. Prefer an existing channel — don't create a duplicate.
  const existing = await findChannelByName(name);
  if (existing) {
    if (existing.archived) await unarchiveChannel(existing.id);
    if (!existing.isMember && !existing.isPrivate) await joinChannel(existing.id);
    approveChannelId = existing.id;
    logger.info({ name, channelId: existing.id, private: existing.isPrivate }, 'using existing PR channel');
    return existing.id;
  }

  // 2. Not visible to us — try to create it (public).
  const created = await createChannel(name);
  if (created) {
    approveChannelId = created;
    logger.info({ name, channelId: created }, 'created shared PR channel');
    return created;
  }

  // 3. name_taken but invisible => a private channel we haven't been invited to.
  throw new Error(
    `#${name} exists but is private and PullPod isn't a member — invite the bot with \`/invite @PullPod\` in that channel, then retry.`,
  );
}

async function findChannelByName(name: string): Promise<FoundChannel | null> {
  let cursor: string | undefined;
  do {
    const res = await slack.conversations.list({
      exclude_archived: false,
      types: 'public_channel,private_channel',
      limit: 200,
      cursor,
    });
    const match = res.channels?.find((c) => c.name === name);
    if (match?.id) {
      return {
        id: match.id,
        archived: !!match.is_archived,
        isPrivate: !!match.is_private,
        isMember: !!match.is_member,
      };
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return null;
}

async function joinChannel(channelId: string): Promise<void> {
  try {
    await slack.conversations.join({ channel: channelId });
  } catch (err) {
    logger.debug({ channelId, err }, 'join channel failed');
  }
}

/** Invite users to a channel (Tier-2, throttled). Silently ignores already-in-channel. */
export async function inviteUsers(channelId: string, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return;
  try {
    await slackTier2.run(() =>
      slack.conversations.invite({ channel: channelId, users: ids.join(',') }),
    );
  } catch (err: any) {
    const code = err?.data?.error;
    if (code === 'already_in_channel' || code === 'cant_invite_self') return;
    logger.warn({ channelId, code }, 'invite failed');
  }
}

/** Post a PR root card as a colored attachment (the color = left accent bar).
 *  `as` posts it under the author's name + avatar (chat:write.customize). */
export async function postRootCard(
  channelId: string,
  card: PrCard,
  text: string,
  opts: { as?: AsUser } = {},
): Promise<string | undefined> {
  const res = await slack.chat.postMessage({
    channel: channelId,
    text,
    attachments: [{ color: card.color, blocks: card.blocks }],
    username: opts.as?.username,
    icon_url: opts.as?.icon_url,
  });
  return res.ts;
}

/** Update an existing PR root card in place (clears any legacy top-level blocks). */
export async function updateRootCard(
  channelId: string,
  ts: string,
  card: PrCard,
  text: string,
): Promise<void> {
  await slack.chat.update({
    channel: channelId,
    ts,
    text,
    blocks: [],
    attachments: [{ color: card.color, blocks: card.blocks }],
  });
}

export async function postMessage(
  channelId: string,
  blocks: KnownBlock[],
  text: string,
  opts: { as?: AsUser; thread_ts?: string } = {},
): Promise<string | undefined> {
  const res = await slack.chat.postMessage({
    channel: channelId,
    text,
    blocks,
    thread_ts: opts.thread_ts,
    username: opts.as?.username,
    icon_url: opts.as?.icon_url,
  });
  return res.ts;
}

/**
 * Post a message for a PR as a reply in that PR's thread (under its root message)
 * in the shared channel. All GitHub->Slack events for a PR land here so they stay
 * threaded. Callers that want to stop after close gate on `pr.state` themselves.
 */
export async function postToPr(
  prChannelId: number,
  blocks: KnownBlock[],
  text: string,
  opts: { as?: AsUser } = {},
): Promise<string | undefined> {
  const pr = await getPrChannelById(prChannelId);
  if (!pr) {
    logger.debug({ prChannelId }, 'skip post: pr row missing');
    return undefined;
  }
  return postMessage(pr.channel_id, blocks, text, {
    as: opts.as,
    thread_ts: pr.root_ts ?? undefined,
  });
}

export async function pinMessage(channelId: string, ts: string): Promise<void> {
  try {
    await slack.pins.add({ channel: channelId, timestamp: ts });
  } catch (err) {
    logger.debug({ channelId, err }, 'pin failed');
  }
}

export async function setPrBookmark(channelId: string, url: string): Promise<void> {
  try {
    await slack.bookmarks.add({
      channel_id: channelId,
      title: 'Pull Request',
      type: 'link',
      link: url,
      emoji: ':github:',
    });
  } catch (err) {
    logger.debug({ channelId, err }, 'bookmark failed');
  }
}

export async function setTopic(channelId: string, topic: string): Promise<void> {
  try {
    await slack.conversations.setTopic({ channel: channelId, topic: topic.slice(0, 250) });
  } catch (err) {
    logger.debug({ channelId, err }, 'set topic failed');
  }
}

export async function archiveChannel(channelId: string): Promise<void> {
  try {
    await slack.conversations.archive({ channel: channelId });
  } catch (err: any) {
    if (err?.data?.error === 'already_archived') return;
    logger.warn({ channelId, err: err?.data?.error }, 'archive failed');
  }
}

export async function unarchiveChannel(channelId: string): Promise<void> {
  try {
    await slack.conversations.unarchive({ channel: channelId });
  } catch (err: any) {
    if (err?.data?.error === 'not_archived') return;
    logger.warn({ channelId, err: err?.data?.error }, 'unarchive failed');
  }
}

export async function addReaction(channelId: string, ts: string, emoji: string): Promise<void> {
  try {
    await slack.reactions.add({ channel: channelId, timestamp: ts, name: emoji });
  } catch (err: any) {
    if (err?.data?.error === 'already_reacted') return;
    logger.debug({ channelId, err: err?.data?.error }, 'reaction failed');
  }
}

/** Serialize all mutations for one PR (create/invite/post/archive) by repo#number. */
export function prLock<T>(repoFullName: string, prNumber: number, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`${repoFullName}#${prNumber}`, fn);
}
