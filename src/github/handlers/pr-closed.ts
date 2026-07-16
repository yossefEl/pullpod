import { logger } from '../../logger.js';
import { getPrChannel, updatePrChannel } from '../../db/repo.js';
import { archiveChannel, postMessage, prLock } from '../../slack/channels.js';
import { outcomeBlocks } from '../../slack/blocks/events.js';

/** Handles pull_request closed (merged or not) -> outcome message + archive. */
export async function handlePrClosed(payload: any): Promise<void> {
  const pr = payload.pull_request;
  const repoFullName: string = payload.repository.full_name;
  const prNumber: number = pr.number;

  await prLock(repoFullName, prNumber, async () => {
    const row = await getPrChannel(repoFullName, prNumber);
    if (!row || row.state !== 'open') return;

    const merged = !!pr.merged;
    const actor = merged ? pr.merged_by?.login ?? 'someone' : payload.sender?.login ?? 'someone';

    await postMessage(
      row.channel_id,
      outcomeBlocks(merged, actor),
      merged ? 'PR merged' : 'PR closed',
    );

    await updatePrChannel(row.id, {
      state: 'archived',
      merged,
      closed_at: pr.closed_at ?? new Date().toISOString(),
    });

    await archiveChannel(row.channel_id);
    logger.info({ repoFullName, prNumber, merged }, 'archived PR pod channel');
  });
}
