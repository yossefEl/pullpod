import { github, splitRepo } from './client.js';
import { logger } from '../logger.js';

/**
 * PullPod only tracks a PR when its base (target) branch actually requires an
 * approval — i.e. the branch is protected to require pull-request reviews. This
 * follows each repo's own GitHub settings, so there's nothing to configure:
 * `main` (protected) is tracked, `dev`/feature branches (unprotected) are not.
 *
 * Two sources are consulted: modern repository rulesets (readable with plain
 * repo read) and classic branch protection (needs the App's "Administration:
 * Read" permission). If we genuinely can't tell — e.g. that permission isn't
 * granted — we FAIL OPEN and track the PR, so the tool never goes silently
 * blind; a warning is logged pointing at the missing permission.
 */

interface CacheEntry {
  value: boolean;
  expires: number;
}
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export async function baseRequiresReview(repoFullName: string, baseRef: string): Promise<boolean> {
  if (!baseRef) return true; // unknown target → don't drop it
  const key = `${repoFullName}#${baseRef}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = await resolve(repoFullName, baseRef);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

async function resolve(repoFullName: string, baseRef: string): Promise<boolean> {
  const { owner, repo } = splitRepo(repoFullName);
  const gh = github();

  // 1) Repository rulesets — a `pull_request` rule on the branch requires a PR
  //    (and typically an approval). Readable with ordinary repo read access.
  try {
    const res = await gh.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner,
      repo,
      branch: baseRef,
    });
    if (Array.isArray(res.data) && res.data.some((r: any) => r.type === 'pull_request')) {
      return true;
    }
  } catch (err) {
    logger.debug({ err, repoFullName, baseRef }, 'branch rules lookup failed');
  }

  // 2) Classic branch protection — the canonical "requires review" flag.
  try {
    const res = await gh.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch: baseRef,
    });
    return !!(res.data as any)?.required_pull_request_reviews;
  } catch (err: any) {
    const status = err?.status;
    if (status === 404) return false; // no classic protection, no ruleset → not required
    // 403 = missing "Administration: Read"; anything else = transient. Fail open.
    logger.warn(
      { status, repoFullName, baseRef },
      'could not read branch protection; tracking PR anyway (grant the GitHub App "Administration: Read" for precise filtering)',
    );
    return true;
  }
}
