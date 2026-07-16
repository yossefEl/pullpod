import type { KnownBlock } from '@slack/types';

export interface PrCardInput {
  title: string;
  url: string;
  number: number;
  repoFullName: string;
  authorLogin: string;
  authorSlackId: string | null;
  reviewerSlackIds: string[];
  unmappedReviewers: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  isDraft: boolean;
  body?: string | null;
}

function mention(slackId: string | null, fallback: string): string {
  return slackId ? `<@${slackId}>` : `\`${fallback}\``;
}

/** The pinned summary card posted at the top of every PR pod channel. */
export function prCardBlocks(input: PrCardInput): KnownBlock[] {
  const statusEmoji = input.isDraft ? '📝' : '🟢';
  const reviewers =
    input.reviewerSlackIds.map((id) => `<@${id}>`).concat(input.unmappedReviewers.map((l) => `\`${l}\``));

  const meta = [
    `*Repo:* \`${input.repoFullName}\``,
    `*Author:* ${mention(input.authorSlackId, input.authorLogin)}`,
    reviewers.length ? `*Reviewers:* ${reviewers.join(', ')}` : '*Reviewers:* _none yet_',
    `*Changes:* +${input.additions} −${input.deletions} across ${input.changedFiles} file(s)`,
  ];
  if (input.labels.length) meta.push(`*Labels:* ${input.labels.map((l) => `\`${l}\``).join(' ')}`);

  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${statusEmoji} PR #${input.number}: ${trim(input.title, 140)}` },
    },
    { type: 'section', text: { type: 'mrkdwn', text: meta.join('\n') } },
  ];

  if (input.body) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `>${trim(input.body.replace(/\n/g, '\n>'), 600)}` },
    });
  }

  blocks.push({
    type: 'actions',
    block_id: `pr_actions:${input.repoFullName}:${input.number}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔗 Open PR' },
        url: input.url,
        action_id: 'open_pr',
      },
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: '✅ Approve' },
        action_id: 'approve_pr',
        value: `${input.repoFullName}#${input.number}`,
      },
      {
        type: 'button',
        style: 'danger',
        text: { type: 'plain_text', text: '🔴 Request changes' },
        action_id: 'request_changes_pr',
        value: `${input.repoFullName}#${input.number}`,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '💬 Comment' },
        action_id: 'comment_pr',
        value: `${input.repoFullName}#${input.number}`,
      },
    ],
  });

  return blocks;
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
