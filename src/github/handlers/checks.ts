import { logger } from '../../logger.js';
import { getPrChannel, getRepoConfig } from '../../db/repo.js';
import { addReaction, postIfOpen } from '../../slack/channels.js';
import { slack } from '../../slack/client.js';
import { ciBlocks } from '../../slack/blocks/events.js';
import type { PrChannel } from '../../db/types.js';

/**
 * Handles check_suite.completed / check_run.completed. Respects repo ci_notify_level:
 * - 'none'     -> nothing
 * - 'failures' -> post only on failure; green just adds a ✅ reaction to the PR card
 * - 'all'      -> post every conclusion
 */
export async function handleCheck(payload: any): Promise<void> {
  const suite = payload.check_suite ?? payload.check_run;
  if (!suite || payload.action !== 'completed') return;

  const repoFullName: string = payload.repository.full_name;
  const conclusion: string = suite.conclusion ?? 'neutral';
  const name: string = payload.check_run?.name ?? suite.app?.name ?? 'CI';

  // Map suite -> PR(s) via head branch.
  const prNumbers = await prNumbersForHead(payload, repoFullName);
  for (const prNumber of prNumbers) {
    const pr = await getPrChannel(repoFullName, prNumber);
    if (!pr || pr.state !== 'open') continue;

    const cfg = await getRepoConfig(repoFullName);
    const level = cfg?.ci_notify_level ?? 'failures';
    if (level === 'none') continue;

    const isFailure = conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled';
    if (level === 'failures' && !isFailure) {
      await reactOnCard(pr, conclusion === 'success' ? 'white_check_mark' : 'warning');
      continue;
    }

    const url = payload.check_run?.html_url ?? suite.html_url ?? null;
    await postIfOpen(pr.id, ciBlocks(conclusion, name, url), `CI ${name}: ${conclusion}`);
  }
}

/** Handles the legacy commit `status` event similarly. */
export async function handleStatus(payload: any): Promise<void> {
  const repoFullName: string = payload.repository.full_name;
  const state: string = payload.state; // success | failure | error | pending
  if (state === 'pending') return;

  const cfg = await getRepoConfig(repoFullName);
  const level = cfg?.ci_notify_level ?? 'failures';
  if (level === 'none') return;

  const branches: string[] = (payload.branches ?? []).map((b: any) => b.name);
  const prNumbers = await prNumbersForBranches(repoFullName, branches);
  const isFailure = state === 'failure' || state === 'error';

  for (const prNumber of prNumbers) {
    const pr = await getPrChannel(repoFullName, prNumber);
    if (!pr || pr.state !== 'open') continue;
    if (level === 'failures' && !isFailure) {
      await reactOnCard(pr, state === 'success' ? 'white_check_mark' : 'warning');
      continue;
    }
    await postIfOpen(pr.id, ciBlocks(state, payload.context ?? 'status', payload.target_url ?? null),
      `Status ${payload.context}: ${state}`);
  }
}

async function reactOnCard(pr: PrChannel, emoji: string): Promise<void> {
  // The pinned card is the first message; react to the pin if present.
  try {
    const pins = await slack.pins.list({ channel: pr.channel_id });
    const first = (pins.items as any[])?.find((i) => i.message)?.message;
    if (first?.ts) await addReaction(pr.channel_id, first.ts, emoji);
  } catch (err) {
    logger.debug({ err }, 'react on card failed');
  }
}

async function prNumbersForHead(payload: any, repoFullName: string): Promise<number[]> {
  const prs = payload.check_suite?.pull_requests ?? payload.check_run?.pull_requests ?? [];
  if (prs.length) return prs.map((p: any) => p.number);
  const branch = payload.check_suite?.head_branch ?? payload.check_run?.check_suite?.head_branch;
  return branch ? prNumbersForBranches(repoFullName, [branch]) : [];
}

async function prNumbersForBranches(repoFullName: string, branches: string[]): Promise<number[]> {
  if (branches.length === 0) return [];
  const { github, splitRepo } = await import('../client.js');
  const { owner, repo } = splitRepo(repoFullName);
  const out: number[] = [];
  for (const branch of branches) {
    try {
      const { data } = await github().rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: 'open' });
      out.push(...data.map((p) => p.number));
    } catch (err) {
      logger.debug({ err, branch }, 'branch->PR lookup failed');
    }
  }
  return [...new Set(out)];
}
