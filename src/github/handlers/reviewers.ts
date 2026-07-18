import { getPrChannel } from '../../db/repo.js';
import { slackAsForGithubLogin, slackUserForGithubLogin } from '../../sync/user-mapping.js';
import { inviteUsers, postToPr } from '../../slack/channels.js';
import { getUserPrefs } from '../../db/repo.js';
import { refreshRootCard } from './card.js';

/** pull_request.review_requested -> invite the newly-added reviewer to the pod. */
export async function handleReviewRequested(payload: any): Promise<void> {
  const repoFullName: string = payload.repository.full_name;
  const prNumber: number = payload.pull_request.number;
  const reviewer = payload.requested_reviewer;
  if (!reviewer?.login) return; // team requests handled elsewhere

  const pr = await getPrChannel(repoFullName, prNumber);
  if (!pr || pr.state !== 'open') return;

  // Post the notice as whoever requested the review.
  const by = payload.sender;
  const asRequester = by?.login ? { as: await slackAsForGithubLogin(by.login, by.avatar_url) } : {};

  const slackId = await slackUserForGithubLogin(reviewer.login);
  if (!slackId) {
    await postToPr(
      pr.id,
      [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `👀 \`${reviewer.login}\` was requested as a reviewer.` },
        },
      ],
      `${reviewer.login} requested as reviewer`,
      asRequester,
    );
    await refreshRootCard(pr);
    return;
  }

  // Respect pause: don't drag paused users into channels.
  const prefs = await getUserPrefs(slackId);
  if (!prefs.paused) await inviteUsers(pr.channel_id, [slackId]);

  await postToPr(
    pr.id,
    [{ type: 'section', text: { type: 'mrkdwn', text: `👀 <@${slackId}> was requested as a reviewer.` } }],
    'Reviewer requested',
    asRequester,
  );
  await refreshRootCard(pr);
}
