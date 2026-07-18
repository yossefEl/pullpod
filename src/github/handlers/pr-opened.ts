import { logger } from '../../logger.js';
import { config } from '../../config.js';
import {
  getPrChannel,
  getRepoConfig,
  reservePrChannel,
  updatePrChannel,
  upsertRepoConfig,
} from '../../db/repo.js';
import { resolveGithubLogins, slackAsForGithubLogin, slackUserForGithubLogin } from '../../sync/user-mapping.js';
import {
  ensureApproveChannel,
  inviteUsers,
  postMessage,
  postRootCard,
  postToPr,
  prLock,
} from '../../slack/channels.js';
import { prCard } from '../../slack/blocks/pr-card.js';
import { isBotAuthor } from './bots.js';
import { baseRequiresReview } from '../repo-rules.js';

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

    // Already tracked: reopen or clear draft flag on the existing thread.
    const existing = await getPrChannel(repoFullName, prNumber);
    if (existing) {
      if (action === 'reopened' && existing.state !== 'open') {
        await updatePrChannel(existing.id, { state: 'open', closed_at: null, merged: null });
        await postToPr(
          existing.id,
          [{ type: 'section', text: { type: 'mrkdwn', text: '♻️ *PR reopened.*' } }],
          'PR reopened',
        );
      }
      if (action === 'ready_for_review') {
        await updatePrChannel(existing.id, { is_draft: false });
      }
      return;
    }

    // Only track PRs whose base (target) branch actually requires an approval
    // (protected to require PR reviews). Unprotected branches like `dev` or
    // feature branches are skipped — following each repo's own GitHub settings.
    const baseRef: string = pr.base?.ref ?? '';
    if (!(await baseRequiresReview(repoFullName, baseRef))) {
      logger.info({ repoFullName, prNumber, baseRef }, 'base branch does not require review, skipping');
      return;
    }

    // Draft PRs: wait for ready_for_review before posting.
    if (pr.draft && repoConfig.skip_draft && action !== 'ready_for_review') {
      logger.info({ repoFullName, prNumber }, 'draft PR, deferring root message');
      return;
    }

    // Bot PRs (Dependabot/Renovate): 'skip' drops them; otherwise post like any PR.
    if (isBotAuthor(pr.user) && repoConfig.bot_pr_strategy === 'skip') return;

    await postPrRoot(payload);
  });
}

/** Post a PR's root message into the shared channel and record it as a thread parent. */
async function postPrRoot(payload: any): Promise<void> {
  const pr = payload.pull_request;
  const repoFullName: string = payload.repository.full_name;
  const prNumber: number = pr.number;

  const channelId = await ensureApproveChannel();

  // Reserve the row BEFORE posting. If another delivery/retry already reserved it,
  // this returns null and we skip — so we never post a duplicate root message.
  const row = await reservePrChannel({
    repo_full_name: repoFullName,
    pr_number: prNumber,
    channel_id: channelId,
    channel_name: config.PR_CHANNEL_NAME,
    pr_title: pr.title,
    pr_author_login: pr.user.login,
    pr_url: pr.html_url,
    is_draft: !!pr.draft,
    opened_at: pr.created_at,
  });
  if (!row) {
    logger.info({ repoFullName, prNumber }, 'PR thread already reserved; skipping duplicate');
    return;
  }

  const authorSlackId = await slackUserForGithubLogin(pr.user.login);
  const requestedReviewers: string[] = (pr.requested_reviewers ?? []).map((r: any) => r.login);
  const { slackIds: reviewerSlackIds, unmapped: unmappedReviewers } =
    await resolveGithubLogins(requestedReviewers);

  // Pull mapped people into the shared channel so the thread shows up for them.
  await inviteUsers(channelId, [authorSlackId, ...reviewerSlackIds].filter(Boolean) as string[]);

  const card = prCard({
    title: pr.title,
    url: pr.html_url,
    number: prNumber,
    repoFullName,
    authorLogin: pr.user.login,
    authorSlackId,
    authorAvatarUrl: pr.user?.avatar_url,
    reviewerSlackIds,
    unmappedReviewers,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    labels: (pr.labels ?? []).map((l: any) => l.name),
    isDraft: !!pr.draft,
    body: pr.body,
  });

  const authorAs = await slackAsForGithubLogin(pr.user.login, pr.user?.avatar_url);
  const rootTs = await postRootCard(channelId, card, `PR #${prNumber}: ${pr.title}`, { as: authorAs });
  if (!rootTs) {
    logger.warn({ repoFullName, prNumber }, 'root message post returned no ts');
    return;
  }
  await updatePrChannel(row.id, { root_ts: rootTs });

  // Unmapped author: leave a self-serve nudge in the thread so the channel isn't a mystery.
  if (!authorSlackId) {
    await postMessage(
      channelId,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⚠️ Couldn't match GitHub user \`${pr.user.login}\` to a Slack account. Run \`/pullpod connect\` to be added automatically to your PR threads.`,
          },
        },
      ],
      'Link your GitHub account',
      { thread_ts: rootTs },
    );
  }

  logger.info({ repoFullName, prNumber, channelId, rootTs }, 'posted PR root message');
}
