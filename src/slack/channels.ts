import type { KnownBlock } from '@slack/types';
import { slack } from './client.js';
import { logger } from '../logger.js';
import { slackTier2, withKeyLock } from '../jobs/throttle.js';
import { getPrChannelById } from '../db/repo.js';

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
 * Post only if the PR pod is still open. Late CI/comment webhooks arriving after
 * a merge would otherwise throw is_archived.
 */
export async function postIfOpen(
  prChannelId: number,
  blocks: KnownBlock[],
  text: string,
  opts: { as?: AsUser; thread_ts?: string } = {},
): Promise<string | undefined> {
  const pr = await getPrChannelById(prChannelId);
  if (!pr || pr.state !== 'open') {
    logger.debug({ prChannelId }, 'skip post: pr channel not open');
    return undefined;
  }
  return postMessage(pr.channel_id, blocks, text, opts);
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
