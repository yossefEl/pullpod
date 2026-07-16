import { getPrChannel, insertMessageLink, setFirstReviewIfUnset } from '../../db/repo.js';
import { postIfOpen } from '../../slack/channels.js';
import { reviewBlocks } from '../../slack/blocks/events.js';

/** Handles pull_request_review submitted (approved / changes_requested / commented). */
export async function handleReview(payload: any): Promise<void> {
  if (payload.action !== 'submitted') return;
  const review = payload.review;
  const repoFullName: string = payload.repository.full_name;
  const prNumber: number = payload.pull_request.number;

  const pr = await getPrChannel(repoFullName, prNumber);
  if (!pr || pr.state !== 'open') return;

  const rawState = String(review.state ?? '').toLowerCase();
  // GitHub uses 'approved' | 'changes_requested' | 'commented' | 'dismissed'.
  if (rawState === 'dismissed') return;
  const state =
    rawState === 'approved'
      ? 'approved'
      : rawState === 'changes_requested'
        ? 'changes_requested'
        : 'commented';

  // A bare "commented" review with no body is just a container for inline
  // comments we already posted; skip to avoid noise.
  if (state === 'commented' && !review.body) return;

  await setFirstReviewIfUnset(pr.id, review.submitted_at ?? new Date().toISOString());

  const blocks = reviewBlocks(state, review.user.login, review.body ?? null, review.html_url);
  const ts = await postIfOpen(pr.id, blocks, `${review.user.login} ${state}`, {
    as: { username: review.user.login, icon_url: review.user.avatar_url },
  });
  if (ts) {
    await insertMessageLink({
      pr_channel_id: pr.id,
      github_kind: 'review',
      github_id: review.id,
      slack_ts: ts,
      slack_thread_ts: null,
    });
  }
}
