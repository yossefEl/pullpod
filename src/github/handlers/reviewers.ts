import { getPrChannel } from '../../db/repo.js';
import { slackUserForGithubLogin } from '../../sync/user-mapping.js';
import { inviteUsers, postIfOpen } from '../../slack/channels.js';
import { getUserPrefs } from '../../db/repo.js';

/** pull_request.review_requested -> invite the newly-added reviewer to the pod. */
export async function handleReviewRequested(payload: any): Promise<void> {
  const repoFullName: string = payload.repository.full_name;
  const prNumber: number = payload.pull_request.number;
  const reviewer = payload.requested_reviewer;
  if (!reviewer?.login) return; // team requests handled elsewhere

  const pr = await getPrChannel(repoFullName, prNumber);
  if (!pr || pr.state !== 'open') return;

  const slackId = await slackUserForGithubLogin(reviewer.login);
  if (!slackId) {
    await postIfOpen(
      pr.id,
      [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `👀 \`${reviewer.login}\` was requested as a reviewer.` },
        },
      ],
      `${reviewer.login} requested as reviewer`,
    );
    return;
  }

  // Respect pause: don't drag paused users into channels.
  const prefs = await getUserPrefs(slackId);
  if (!prefs.paused) await inviteUsers(pr.channel_id, [slackId]);

  await postIfOpen(
    pr.id,
    [{ type: 'section', text: { type: 'mrkdwn', text: `👀 <@${slackId}> was requested as a reviewer.` } }],
    'Reviewer requested',
  );
}
