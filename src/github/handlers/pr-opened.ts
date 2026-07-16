import { logger } from '../../logger.js';
import {
  getPrChannel,
  getRepoConfig,
  insertPrChannel,
  updatePrChannel,
  upsertRepoConfig,
} from '../../db/repo.js';
import { resolveGithubLogins, slackUserForGithubLogin } from '../../sync/user-mapping.js';
import { buildChannelName, uniqueChannelName } from '../../sync/channel-naming.js';
import {
  createChannel,
  inviteUsers,
  pinMessage,
  postMessage,
  prLock,
  setPrBookmark,
  setTopic,
  unarchiveChannel,
} from '../../slack/channels.js';
import { prCardBlocks } from '../../slack/blocks/pr-card.js';
import { getBotPoolChannel, isBotAuthor } from './bots.js';

/** Handles pull_request opened / reopened / ready_for_review. */
export async function handlePrOpened(payload: any): Promise<void> {
  const pr = payload.pull_request;
  const repoFullName: string = payload.repository.full_name;
  const prNumber: number = pr.number;
  const action: string = payload.action;

  await prLock(repoFullName, prNumber, async () => {
    const repoConfig =
      (await getRepoConfig(repoFullName)) ?? (await upsertRepoConfig(repoFullName));
    if (!repoConfig.enabled) {
      logger.info({ repoFullName }, 'repo disabled, skipping');
      return;
    }

    // Reopen: unarchive existing channel if we still have it.
    const existing = await getPrChannel(repoFullName, prNumber);
    if (existing) {
      if (action === 'reopened' && existing.state === 'archived') {
        await unarchiveChannel(existing.channel_id);
        await updatePrChannel(existing.id, { state: 'open', closed_at: null, merged: null });
        await postMessage(
          existing.channel_id,
          [{ type: 'section', text: { type: 'mrkdwn', text: '♻️ *PR reopened.*' } }],
          'PR reopened',
        );
      }
      // ready_for_review on an already-tracked PR just clears the draft flag.
      if (action === 'ready_for_review') {
        await updatePrChannel(existing.id, { is_draft: false });
      }
      return;
    }

    // Draft PRs: wait for ready_for_review before creating a channel.
    if (pr.draft && repoConfig.skip_draft && action !== 'ready_for_review') {
      logger.info({ repoFullName, prNumber }, 'draft PR, deferring channel creation');
      return;
    }

    // Bot PRs (Dependabot/Renovate): pool or skip per config.
    if (isBotAuthor(pr.user)) {
      if (repoConfig.bot_pr_strategy === 'skip') return;
      if (repoConfig.bot_pr_strategy === 'pool') {
        await getBotPoolChannel(repoConfig, pr);
        return;
      }
      // 'channel' falls through to normal per-PR channel creation.
    }

    await createPodChannel(repoConfig, payload);
  });
}

async function createPodChannel(repoConfig: any, payload: any): Promise<void> {
  const pr = payload.pull_request;
  const repoFullName: string = payload.repository.full_name;
  const prNumber: number = pr.number;

  const base = buildChannelName(repoConfig.channel_prefix, repoFullName, prNumber, pr.title);
  const name = await uniqueChannelName(base);

  const channelId = await createChannel(name);
  if (!channelId) {
    logger.warn({ name }, 'channel creation returned null (name_taken race); aborting');
    return;
  }

  const authorSlackId = await slackUserForGithubLogin(pr.user.login);
  const requestedReviewers: string[] = (pr.requested_reviewers ?? []).map((r: any) => r.login);
  const { slackIds: reviewerSlackIds, unmapped: unmappedReviewers } =
    await resolveGithubLogins(requestedReviewers);

  await inviteUsers(channelId, [authorSlackId, ...reviewerSlackIds].filter(Boolean) as string[]);
  await setTopic(channelId, `${pr.title} — ${pr.html_url}`);
  await setPrBookmark(channelId, pr.html_url);

  const blocks = prCardBlocks({
    title: pr.title,
    url: pr.html_url,
    number: prNumber,
    repoFullName,
    authorLogin: pr.user.login,
    authorSlackId,
    reviewerSlackIds,
    unmappedReviewers,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    labels: (pr.labels ?? []).map((l: any) => l.name),
    isDraft: !!pr.draft,
    body: pr.body,
  });

  const ts = await postMessage(channelId, blocks, `PR #${prNumber}: ${pr.title}`);
  if (ts) await pinMessage(channelId, ts);

  await insertPrChannel({
    repo_full_name: repoFullName,
    pr_number: prNumber,
    channel_id: channelId,
    channel_name: name,
    pr_title: pr.title,
    pr_author_login: pr.user.login,
    pr_url: pr.html_url,
    is_draft: !!pr.draft,
    opened_at: pr.created_at,
  });

  logger.info({ repoFullName, prNumber, channelId, name }, 'created PR pod channel');
}
