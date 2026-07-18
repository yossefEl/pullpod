import type bolt from '@slack/bolt';
import { logger } from '../logger.js';
import { github, splitRepo } from '../github/client.js';
import {
  getPrChannelByRootTs,
  getUserLinkBySlack,
  insertMessageLink,
} from '../db/repo.js';

/**
 * Two-way sync: a human reply inside a PR's thread mirrors back to the PR as a
 * GitHub issue comment. (The PR conversation now lives in one thread per PR in
 * the shared channel, so the thread reply — not a top-level post — is the signal.)
 *
 * Echo-loop prevention:
 *  - Skip anything with a subtype or bot_id (that's PullPod's own output, or
 *    channel-join noise), so our GitHub->Slack posts never bounce back.
 *  - Only act on replies whose thread parent is a known PR root message.
 *  - Record the created GitHub comment id in message_links; the GitHub webhook
 *    handler sees the existing link on the 'created' event and drops it.
 */
export function registerTwoWaySync(app: bolt.App): void {
  app.message(async ({ message }) => {
    const m = message as any;
    if (m.subtype || m.bot_id || !m.user || !m.text) return; // only real human posts
    if (!m.thread_ts || m.thread_ts === m.ts) return; // only replies inside a thread

    const pr = await getPrChannelByRootTs(m.thread_ts);
    if (!pr || pr.pr_number < 0) return;

    const link = await getUserLinkBySlack(m.user);
    const attribution = link ? `@${link.github_login}` : `a teammate`;

    try {
      const { owner, repo } = splitRepo(pr.repo_full_name);
      const { data } = await github().rest.issues.createComment({
        owner,
        repo,
        issue_number: pr.pr_number,
        body: `${m.text}\n\n_— ${attribution} via Slack (PullPod)_`,
      });
      // Pre-record so the inbound issue_comment.created webhook is treated as ours.
      await insertMessageLink({
        pr_channel_id: pr.id,
        github_kind: 'issue_comment',
        github_id: data.id,
        slack_ts: m.ts,
        slack_thread_ts: m.thread_ts,
      });
    } catch (err) {
      logger.warn({ err, repo: pr.repo_full_name, pr: pr.pr_number }, 'slack->github mirror failed');
    }
  });
}
