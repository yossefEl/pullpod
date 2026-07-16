import { github, splitRepo } from '../github/client.js';

export type MergeState = 'mergeable' | 'conflicts' | 'unknown';

/**
 * GitHub computes `mergeable` lazily: right after a push it returns null, then
 * flips to true/false within a second or two. Poll with backoff instead of
 * trusting the first read.
 */
export async function fetchMergeState(
  repoFullName: string,
  prNumber: number,
  attempts = 4,
): Promise<MergeState> {
  const { owner, repo } = splitRepo(repoFullName);
  for (let i = 0; i < attempts; i++) {
    const { data } = await github().rest.pulls.get({ owner, repo, pull_number: prNumber });
    if (data.mergeable === true) return 'mergeable';
    if (data.mergeable === false) return 'conflicts';
    // mergeable === null -> still computing; back off (200ms, 400ms, 800ms...).
    await sleep(200 * 2 ** i);
  }
  return 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
