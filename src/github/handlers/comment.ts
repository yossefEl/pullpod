import { logger } from '../../logger.js';
import { getPrChannel, getMessageLink, insertMessageLink } from '../../db/repo.js';
import { postIfOpen } from '../../slack/channels.js';
import { slack } from '../../slack/client.js';
import type { KnownBlock } from '@slack/types';

/**
 * Handles issue_comment (PR conversation) and pull_request_review_comment
 * (inline code comments) — mirrors GitHub -> Slack, impersonating the author.
 */
export async function handleComment(payload: any, kind: 'issue_comment' | 'review_comment'): Promise<void> {
  const action: string = payload.action;
  const comment = payload.comment;
  const repoFullName: string = payload.repository.full_name;

  // issue_comment fires for plain issues too; ignore those.
  const prNumber: number | undefined =
    kind === 'issue_comment' ? payload.issue?.pull_request && payload.issue.number : payload.pull_request?.number;
  if (!prNumber) return;

  const pr = await getPrChannel(repoFullName, prNumber);
  if (!pr || pr.state !== 'open') return;

  const existing = await getMessageLink(kind, comment.id);

  // Echo guard: if this comment id is already linked and the action is 'created',
  // it originated from Slack (two-way sync pre-recorded it). Don't re-post.
  if (action === 'created' && existing) return;

  if (action === 'deleted') {
    if (existing) await slack.chat.delete({ channel: pr.channel_id, ts: existing.slack_ts }).catch(() => {});
    return;
  }

  const blocks = commentBlocks(kind, comment);
  const text = `${comment.user.login}: ${String(comment.body ?? '').slice(0, 120)}`;
  const as = { username: comment.user.login, icon_url: comment.user.avatar_url };

  if (action === 'edited' && existing) {
    await slack.chat
      .update({ channel: pr.channel_id, ts: existing.slack_ts, text, blocks })
      .catch((err) => logger.debug({ err }, 'comment edit update failed'));
    return;
  }

  // For review-comment thread replies, thread under the parent comment's Slack ts.
  let threadTs: string | undefined;
  if (kind === 'review_comment' && comment.in_reply_to_id) {
    const parent = await getMessageLink('review_comment', comment.in_reply_to_id);
    threadTs = parent?.slack_ts;
  }

  const ts = await postIfOpen(pr.id, blocks, text, { as, thread_ts: threadTs });
  if (ts) {
    await insertMessageLink({
      pr_channel_id: pr.id,
      github_kind: kind,
      github_id: comment.id,
      slack_ts: ts,
      slack_thread_ts: threadTs ?? null,
    });
  }
}

function commentBlocks(kind: 'issue_comment' | 'review_comment', comment: any): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  if (kind === 'review_comment' && comment.path) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `📄 \`${comment.path}\`${comment.line ? `:${comment.line}` : ''}` }],
    });
    if (comment.diff_hunk) {
      const hunk = String(comment.diff_hunk).split('\n').slice(-6).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + hunk.slice(0, 900) + '```' } });
    }
  }
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: String(comment.body ?? '_(empty)_').slice(0, 2900) },
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `<${comment.html_url}|View on GitHub>` }],
  });
  return blocks;
}
