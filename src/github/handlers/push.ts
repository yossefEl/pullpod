import { logger } from '../../logger.js';
import { getPrChannel } from '../../db/repo.js';
import { github, splitRepo } from '../client.js';
import { fetchMergeState } from '../../sync/mergeability.js';
import { postIfOpen } from '../../slack/channels.js';
import { conflictBlocks } from '../../slack/blocks/events.js';

// Remember the last conflict state we announced per PR so we don't re-post on
// every push. Cleared implicitly when the process restarts (harmless).
const announcedConflict = new Set<string>();

/**
 * On push to a branch that has an open PR, recompute mergeability and announce
 * conflicts exactly once (until resolved).
 */
export async function handlePush(payload: any): Promise<void> {
  const ref: string = payload.ref ?? '';
  if (!ref.startsWith('refs/heads/')) return;
  const branch = ref.slice('refs/heads/'.length);
  const repoFullName: string = payload.repository.full_name;

  const { owner, repo } = splitRepo(repoFullName);
  let prNumbers: number[] = [];
  try {
    const { data } = await github().rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: 'open',
    });
    prNumbers = data.map((p) => p.number);
  } catch (err) {
    logger.debug({ err, branch }, 'push->PR lookup failed');
    return;
  }

  for (const prNumber of prNumbers) {
    const pr = await getPrChannel(repoFullName, prNumber);
    if (!pr || pr.state !== 'open') continue;

    const key = `${repoFullName}#${prNumber}`;
    const mergeState = await fetchMergeState(repoFullName, prNumber);

    if (mergeState === 'conflicts') {
      if (!announcedConflict.has(key)) {
        announcedConflict.add(key);
        await postIfOpen(pr.id, conflictBlocks(), 'This branch has merge conflicts');
      }
    } else if (mergeState === 'mergeable') {
      announcedConflict.delete(key);
    }
  }
}
