import { logger } from '../../logger.js';
import { getPrChannel as _getPrChannel, insertPrChannel as _insertPrChannel } from '../../db/repo.js';
import type { RepoConfig } from '../../db/types.js';
import { repoShort } from '../../sync/channel-naming.js';
import { createChannel, postMessage } from '../../slack/channels.js';

// Sentinel pr_number for the per-repo bot pool "channel" row.
const BOT_POOL_PR = -1;

const KNOWN_BOTS = new Set(['dependabot', 'dependabot[bot]', 'renovate', 'renovate[bot]']);

export function isBotAuthor(user: any): boolean {
  if (!user) return false;
  if (user.type === 'Bot') return true;
  const login = String(user.login ?? '').toLowerCase();
  return login.endsWith('[bot]') || KNOWN_BOTS.has(login);
}

/**
 * Find-or-create the single pooled channel for bot PRs in a repo and drop a
 * one-line summary into it. Keeps Dependabot floods out of the per-PR flow and
 * off the Tier-2 channel-create budget.
 */
export async function getBotPoolChannel(repoConfig: RepoConfig, pr: any): Promise<void> {
  const repoFullName = repoConfig.repo_full_name;
  let pool = await _getPrChannel(repoFullName, BOT_POOL_PR);

  if (!pool) {
    const name = `${repoConfig.channel_prefix}_bots_${repoShort(repoFullName)}`.slice(0, 80);
    const channelId = await createChannel(name);
    if (!channelId) {
      logger.warn({ repoFullName }, 'bot pool channel creation failed');
      return;
    }
    pool = await _insertPrChannel({
      repo_full_name: repoFullName,
      pr_number: BOT_POOL_PR,
      channel_id: channelId,
      channel_name: name,
      pr_title: `Bot PRs — ${repoShort(repoFullName)}`,
      pr_author_login: 'bots',
      pr_url: `https://github.com/${repoFullName}/pulls`,
      is_draft: false,
      opened_at: pr.created_at,
    });
  }

  await postMessage(
    pool.channel_id,
    [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🤖 <${pr.html_url}|#${pr.number} ${pr.title}> by \`${pr.user.login}\``,
        },
      },
    ],
    `Bot PR #${pr.number}: ${pr.title}`,
  );
}
