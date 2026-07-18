import type { KnownBlock } from '@slack/types';

export function reviewBlocks(
  state: 'approved' | 'changes_requested' | 'commented',
  reviewer: string,
  body: string | null,
  url: string,
): KnownBlock[] {
  const banner =
    state === 'approved'
      ? `✅ *${reviewer}* approved this PR`
      : state === 'changes_requested'
        ? `🛑 *${reviewer}* requested changes`
        : `💬 *${reviewer}* left a review`;
  const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text: banner } }];
  if (body) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `>${body.replace(/\n/g, '\n>')}` } });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `<${url}|View review on GitHub>` }],
  });
  return blocks;
}

export function ciBlocks(
  conclusion: string,
  name: string,
  url: string | null,
): KnownBlock[] {
  const text = `⚙️ CI *${name}*: ${conclusion}`;
  const blocks: KnownBlock[] = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (url) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${url}|View run>` }] });
  return blocks;
}

export function conflictBlocks(): KnownBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '⚠️ *This branch has merge conflicts.* Rebase or merge the base branch to resolve.',
      },
    },
  ];
}

export function outcomeBlocks(merged: boolean, actor: string): KnownBlock[] {
  const text = merged
    ? `🔀 *Merged* by ${actor}.`
    : `*Closed without merging* by ${actor}.`;
  return [{ type: 'section', text: { type: 'mrkdwn', text } }];
}
