import { slack } from '../slack/client.js';
import { github } from '../github/client.js';
import { getUserLinkByGithub, upsertUserLink } from '../db/repo.js';
import { logger } from '../logger.js';

/**
 * Resolve a GitHub login to a Slack user id.
 * 1. Check the user_links table (manual or previously auto-matched).
 * 2. Try to auto-match by email: GitHub public email -> Slack users.lookupByEmail.
 * Returns null if unmapped (caller degrades gracefully in the PR card).
 */
export async function slackUserForGithubLogin(login: string): Promise<string | null> {
  const existing = await getUserLinkByGithub(login);
  if (existing) return existing.slack_user_id;

  try {
    const { data: user } = await github().rest.users.getByUsername({ username: login });
    const email = user.email;
    if (!email) return null;
    const res = await slack.users.lookupByEmail({ email });
    const slackUserId = res.user?.id;
    if (!slackUserId) return null;
    await upsertUserLink(login, slackUserId, 'email');
    logger.info({ login, slackUserId }, 'auto-matched github user by email');
    return slackUserId;
  } catch (err) {
    logger.debug({ login, err }, 'email auto-match failed');
    return null;
  }
}

/**
 * Build a chat.customize identity for a GitHub login. If the login maps to a Slack
 * user, use that person's Slack display name + avatar; otherwise fall back to the
 * GitHub login and avatar.
 */
export async function slackAsForGithubLogin(
  login: string,
  fallbackAvatar?: string | null,
): Promise<{ username: string; icon_url?: string }> {
  const slackId = await slackUserForGithubLogin(login);
  if (slackId) {
    try {
      const res = await slack.users.info({ user: slackId });
      const p = res.user?.profile as any;
      const name = p?.display_name || p?.real_name || login;
      const icon = p?.image_72 || fallbackAvatar || undefined;
      return { username: name, icon_url: icon };
    } catch (err) {
      logger.debug({ err, login }, 'slack users.info failed');
    }
  }
  return { username: login, icon_url: fallbackAvatar || undefined };
}

/** Resolve many logins at once, returning [mapped, unmapped] partition. */
export async function resolveGithubLogins(
  logins: string[],
): Promise<{ slackIds: string[]; unmapped: string[] }> {
  const slackIds: string[] = [];
  const unmapped: string[] = [];
  for (const login of [...new Set(logins)]) {
    const id = await slackUserForGithubLogin(login);
    if (id) slackIds.push(id);
    else unmapped.push(login);
  }
  return { slackIds, unmapped };
}
