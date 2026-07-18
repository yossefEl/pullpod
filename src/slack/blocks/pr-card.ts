import type { KnownBlock } from '@slack/types';

export interface PrCardInput {
  title: string;
  url: string;
  number: number;
  repoFullName: string;
  authorLogin: string;
  authorSlackId: string | null;
  authorAvatarUrl?: string | null;
  reviewerSlackIds: string[];
  unmappedReviewers: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  isDraft: boolean;
  body?: string | null;
  /** Latest review verdict per reviewer who has acted (drives the *Reviews* row). */
  reviewStates?: ReviewState[];
  /** Set once the PR is resolved — changes the header + color and drops the buttons. */
  status?: 'merged' | 'closed';
}

export interface ReviewState {
  login: string;
  slackId: string | null;
  avatarUrl?: string | null;
  state: 'approved' | 'changes_requested' | 'commented';
}

/** A message attachment: the `color` renders as the left accent bar behind `blocks`. */
export interface PrCard {
  color: string;
  blocks: KnownBlock[];
}

// One unique accent-bar color per PR state.
const COLOR = {
  draft: '#9aa0a6', // gray
  open: '#1264a3', // blue
  mergeable: '#2eb67d', // green
  merged: '#7b3fe4', // purple
  closed: '#e01e5a', // red
};
const STATUS_LABEL: Record<keyof typeof COLOR, string> = {
  draft: 'Draft',
  open: 'Open',
  mergeable: 'Mergeable',
  merged: 'Merged',
  closed: 'Closed',
};
// Square badge that matches the accent-bar color for each state.
const STATUS_TAG: Record<keyof typeof COLOR, string> = {
  draft: '⬜',
  open: '🟦',
  mergeable: '🟩',
  merged: '🟪',
  closed: '🟥',
};

function mark(state: ReviewState['state']): string {
  return state === 'approved' ? '✅' : state === 'changes_requested' ? '🛑' : '💬';
}

function mention(slackId: string | null, fallback: string): string {
  return slackId ? `<@${slackId}>` : `\`${fallback}\``;
}

/** The root message for a PR: a colored attachment with a header, a field grid,
 *  avatar-backed reviews, the description, and (while open) action buttons. */
export function prCard(input: PrCardInput): PrCard {
  // A PR becomes "Mergeable" once it has an approval and no outstanding changes.
  const approved = !!input.reviewStates?.some((r) => r.state === 'approved');
  const changesReq = !!input.reviewStates?.some((r) => r.state === 'changes_requested');
  const state: keyof typeof COLOR =
    input.status === 'merged'
      ? 'merged'
      : input.status === 'closed'
        ? 'closed'
        : input.isDraft
          ? 'draft'
          : approved && !changesReq
            ? 'mergeable'
            : 'open';
  const color = COLOR[state];
  const statusLabel = STATUS_LABEL[state];

  // Title is a bold link so the PR is reachable even after merge/close (no buttons).
  const heading = `*<${input.url}|${escapeLink(`PR #${input.number}: ${trim(input.title, 150)}`)}>*`;

  // Inline "Label: value" rows, in a context block so the emoji render small.
  const rows = [
    `${STATUS_TAG[state]} *${statusLabel}*`,
    `📁 *Repo:* \`${input.repoFullName}\``,
    `👤 *Author:* ${mention(input.authorSlackId, input.authorLogin)}`,
    `✏️ *Changes:* \`+${input.additions}\` \`−${input.deletions}\` · ${input.changedFiles} file${input.changedFiles === 1 ? '' : 's'}`,
  ];
  if (input.labels.length) rows.push(`🏷️ *Labels:* ${input.labels.map((l) => `\`${l}\``).join(' ')}`);

  // Reviews + still-pending reviewers go in the SAME block so line spacing is uniform.
  if (input.reviewStates?.length) {
    const line = input.reviewStates
      .map((r) => `${mark(r.state)} ${r.slackId ? `<@${r.slackId}>` : `\`${r.login}\``}`)
      .join('   ');
    rows.push(`🔎 *Reviews:* ${line}`);
  }
  const pending = input.reviewerSlackIds
    .map((id) => `<@${id}>`)
    .concat(input.unmappedReviewers.map((l) => `\`${l}\``));
  if (pending.length) rows.push(`⏳ *Awaiting review:* ${pending.join(', ')}`);

  const grid: KnownBlock = {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: rows.join('\n') }],
  };

  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: heading } },
    grid,
  ];

  if (input.body) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: trim(githubMarkdownToSlack(input.body), 700) } });
  }

  if (!input.status) {
    const val = `${input.repoFullName}#${input.number}`;
    const elements: any[] = [
      { type: 'button', text: { type: 'plain_text', text: 'Open PR' }, url: input.url, action_id: 'open_pr' },
      { type: 'button', text: { type: 'plain_text', text: 'Approve' }, action_id: 'approve_pr', value: val },
      { type: 'button', text: { type: 'plain_text', text: 'Comment' }, action_id: 'comment_pr', value: val },
    ];
    // Merge only surfaces once the PR is Mergeable (approved, no changes requested).
    if (state === 'mergeable') {
      elements.push({
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: 'Merge' },
        action_id: 'merge_pr',
        value: val,
      });
    }
    blocks.push({ type: 'actions', block_id: `pr_actions:${input.repoFullName}:${input.number}`, elements });
  }

  return { color, blocks };
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Escape a Slack link's display text (`|` breaks the `<url|text>` syntax). */
function escapeLink(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '∣');
}

/**
 * Convert GitHub-Flavored Markdown to Slack mrkdwn for the common cases in PR
 * bodies (Slack uses `*bold*`, `<url|text>`, `_italic_`).
 */
function githubMarkdownToSlack(md: string): string {
  let s = md.replace(/\r\n/g, '\n');
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
  s = s.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, '*$1*');
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/g, '*$2*');
  s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '~$1~');
  s = s.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
  return s.trim();
}
