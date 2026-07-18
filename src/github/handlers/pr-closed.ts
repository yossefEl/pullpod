import { logger } from '../../logger.js';
import { getPrChannel, updatePrChannel } from '../../db/repo.js';
import { postToPr, prLock } from '../../slack/channels.js';
import { outcomeBlocks } from '../../slack/blocks/events.js';
import { refreshRootCard } from './card.js';
import { slackAsForGithubLogin } from '../../sync/user-mapping.js';

/** Handles pull_request closed (merged or not) -> threaded outcome + root card update. */
export async function handlePrClosed(payload: any): Promise<void> {
  const pr = payload.pull_request;
  const repoFullName: string = payload.repository.full_name;
  const prNumber: number = pr.number;

  await prLock(repoFullName, prNumber, async () => {
    const row = await getPrChannel(repoFullName, prNumber);
    if (!row || row.state !== 'open') return;

    const merged = !!pr.merged;
    const actorUser = merged ? pr.merged_by : payload.sender;
    const actor = actorUser?.login ?? 'someone';

    // Threaded outcome note (posted as whoever merged/closed), then re-render the
    // root card from live state so its Status flips to Merged/Closed and buttons drop.
    const actorAs = actorUser?.login
      ? await slackAsForGithubLogin(actorUser.login, actorUser.avatar_url)
      : undefined;
    await postToPr(row.id, outcomeBlocks(merged, actor), merged ? 'PR merged' : 'PR closed', { as: actorAs });
    await refreshRootCard(row);

    await updatePrChannel(row.id, {
      state: 'archived',
      merged,
      closed_at: pr.closed_at ?? new Date().toISOString(),
    });

    logger.info({ repoFullName, prNumber, merged }, 'PR closed: outcome + card updated');
  });
}
