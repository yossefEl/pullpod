import { github, splitRepo } from '../client.js';
import { updateRootCard } from '../../slack/channels.js';
import { logger } from '../../logger.js';
import { resolveGithubLogins, slackUserForGithubLogin } from '../../sync/user-mapping.js';
import { prCard, type ReviewState } from '../../slack/blocks/pr-card.js';
import type { PrChannel } from '../../db/types.js';

/**
 * Rebuild a PR's root message from live GitHub state (requested reviewers + each
 * reviewer's latest verdict) and update it in place. Called whenever a review is
 * submitted or a reviewer is requested, so the card never goes stale.
 */
export async function refreshRootCard(pr: PrChannel): Promise<void> {
  if (!pr.root_ts) return;
  const { owner, repo } = splitRepo(pr.repo_full_name);

  try {
    const [{ data: prData }, { data: reviews }] = await Promise.all([
      github().rest.pulls.get({ owner, repo, pull_number: pr.pr_number }),
      github().rest.pulls.listReviews({ owner, repo, pull_number: pr.pr_number, per_page: 100 }),
    ]);

    // Latest verdict per reviewer (in event order); DISMISSED clears it.
    const latest = new Map<string, { state: ReviewState['state']; avatarUrl?: string | null }>();
    for (const r of reviews) {
      const login = r.user?.login;
      if (!login) continue;
      const st = String(r.state ?? '').toLowerCase();
      if (st === 'dismissed') latest.delete(login);
      else if (st === 'approved' || st === 'changes_requested' || st === 'commented') {
        latest.set(login, { state: st, avatarUrl: r.user?.avatar_url });
      }
    }
    const reviewStates: ReviewState[] = [];
    for (const [login, v] of latest) {
      reviewStates.push({ login, slackId: await slackUserForGithubLogin(login), avatarUrl: v.avatarUrl, state: v.state });
    }

    const requested: string[] = (prData.requested_reviewers ?? []).map((r: any) => r.login);
    const { slackIds, unmapped } = await resolveGithubLogins(requested);
    const authorSlackId = await slackUserForGithubLogin(prData.user?.login ?? '');
    const status = prData.merged ? 'merged' : prData.state === 'closed' ? 'closed' : undefined;

    const card = prCard({
      title: prData.title,
      url: prData.html_url,
      number: pr.pr_number,
      repoFullName: pr.repo_full_name,
      authorLogin: prData.user?.login ?? '?',
      authorSlackId,
      authorAvatarUrl: prData.user?.avatar_url,
      reviewerSlackIds: slackIds,
      unmappedReviewers: unmapped,
      additions: prData.additions ?? 0,
      deletions: prData.deletions ?? 0,
      changedFiles: prData.changed_files ?? 0,
      labels: (prData.labels ?? []).map((l: any) => l.name),
      isDraft: !!prData.draft,
      body: prData.body,
      reviewStates,
      status,
    });

    await updateRootCard(pr.channel_id, pr.root_ts, card, `PR #${pr.pr_number}: ${prData.title}`).catch((err) =>
      logger.debug({ err }, 'root card update failed'),
    );
  } catch (err) {
    logger.debug({ err, repo: pr.repo_full_name, pr: pr.pr_number }, 'refreshRootCard failed');
  }
}
