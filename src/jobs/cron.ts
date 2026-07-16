import cron from 'node-cron';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { slack } from '../slack/client.js';
import { github } from '../github/client.js';
import { query } from '../db/pool.js';
import { listRepoConfigs } from '../db/repo.js';
import type { UserLink, UserPrefs } from '../db/types.js';

/** Is `now` inside the user's review time slot? No slot set => always true. */
function isWithinSlot(prefs: UserPrefs, now = new Date()): boolean {
  if (!prefs.timeslot_start || !prefs.timeslot_end) return true;
  try {
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: prefs.timezone,
    }).format(now);
    return hhmm >= prefs.timeslot_start.slice(0, 5) && hhmm <= prefs.timeslot_end.slice(0, 5);
  } catch {
    return true;
  }
}

async function linkedUsers(): Promise<Array<UserLink & UserPrefs>> {
  const res = await query<UserLink & UserPrefs>(
    `select ul.github_login, ul.slack_user_id,
            coalesce(up.paused, false) as paused,
            up.timeslot_start, up.timeslot_end,
            coalesce(up.timezone, $1) as timezone,
            coalesce(up.notify_ci, true) as notify_ci
       from user_links ul
       left join user_prefs up on up.slack_user_id = ul.slack_user_id`,
    [config.TZ],
  );
  return res.rows as any;
}

async function dm(slackUserId: string, text: string): Promise<void> {
  try {
    await slack.chat.postMessage({ channel: slackUserId, text });
  } catch (err) {
    logger.debug({ err, slackUserId }, 'DM failed');
  }
}

/** Stale-PR reminders: DM each reviewer the PRs actually awaiting their review. */
export async function runStaleReminders(): Promise<void> {
  const users = await linkedUsers();
  for (const u of users) {
    if (u.paused || !isWithinSlot(u)) continue;
    try {
      const { data } = await github().rest.search.issuesAndPullRequests({
        q: `is:open is:pr review-requested:${u.github_login} org:${config.GITHUB_ORG}`,
        per_page: 20,
      });
      const stale = data.items.filter(
        (i: any) => Date.now() - new Date(i.created_at).getTime() > 24 * 3_600_000,
      );
      if (stale.length === 0) continue;
      const lines = stale
        .slice(0, 15)
        .map((i: any) => `• <${i.html_url}|${i.title}> (\`${i.repository_url.split('/repos/')[1]}\`)`);
      await dm(
        u.slack_user_id,
        `👋 You have *${stale.length}* PR(s) waiting on your review:\n${lines.join('\n')}`,
      );
    } catch (err) {
      logger.debug({ err, login: u.github_login }, 'stale reminder failed');
    }
  }
}

/** Per-repo team digest to the configured team channel. */
export async function runTeamDigest(): Promise<void> {
  const repos = (await listRepoConfigs()).filter((r) => r.enabled && r.team_channel_id);
  for (const r of repos) {
    try {
      const { data: open } = await github().rest.search.issuesAndPullRequests({
        q: `is:open is:pr repo:${r.repo_full_name}`,
        per_page: 30,
      });
      const awaiting = open.items.filter((i: any) => (i.requested_reviewers?.length ?? 0) > 0);
      const lines = open.items
        .slice(0, 20)
        .map((i: any) => `• <${i.html_url}|#${i.number} ${i.title}> — \`${i.user?.login}\``);
      const text = [
        `*🗒️ Daily PR digest — \`${r.repo_full_name}\`*`,
        `${open.total_count} open PR(s), ${awaiting.length} awaiting review.`,
        ...lines,
      ].join('\n');
      await slack.chat.postMessage({ channel: r.team_channel_id!, text });
    } catch (err) {
      logger.debug({ err, repo: r.repo_full_name }, 'team digest failed');
    }
  }
}

/** Standup recap: yesterday's merged/opened per repo team channel. */
export async function runStandupRecap(): Promise<void> {
  const repos = (await listRepoConfigs()).filter((r) => r.enabled && r.team_channel_id);
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
  for (const r of repos) {
    try {
      const { data: merged } = await github().rest.search.issuesAndPullRequests({
        q: `is:pr is:merged repo:${r.repo_full_name} merged:>=${since}`,
        per_page: 30,
      });
      const { data: opened } = await github().rest.search.issuesAndPullRequests({
        q: `is:pr repo:${r.repo_full_name} created:>=${since}`,
        per_page: 30,
      });
      const text = [
        `*☀️ Standup recap — \`${r.repo_full_name}\`*`,
        `Merged since ${since}: *${merged.total_count}* · Opened: *${opened.total_count}*`,
        ...merged.items.slice(0, 10).map((i: any) => `✅ <${i.html_url}|${i.title}>`),
      ].join('\n');
      await slack.chat.postMessage({ channel: r.team_channel_id!, text });
    } catch (err) {
      logger.debug({ err, repo: r.repo_full_name }, 'standup recap failed');
    }
  }
}

/** Weekly analytics from our own pr_channels timestamps. */
export async function runWeeklyAnalytics(): Promise<void> {
  const res = await query<{ cycle_h: number; first_review_h: number | null }>(
    `select
        extract(epoch from (closed_at - opened_at)) / 3600.0 as cycle_h,
        extract(epoch from (first_review_at - opened_at)) / 3600.0 as first_review_h
      from pr_channels
      where merged = true and closed_at >= now() - interval '7 days' and pr_number >= 0`,
  );
  if (res.rows.length === 0) return;
  const cycle = median(res.rows.map((r) => r.cycle_h).filter((n) => n != null));
  const firstReview = median(
    res.rows.map((r) => r.first_review_h).filter((n): n is number => n != null),
  );
  const text = [
    '*📊 Weekly PullPod analytics*',
    `Merged PRs (7d): *${res.rows.length}*`,
    `Median cycle time: *${cycle.toFixed(1)}h*`,
    firstReview != null ? `Median time-to-first-review: *${firstReview.toFixed(1)}h*` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const channel = config.OPS_CHANNEL_ID;
  if (channel) await slack.chat.postMessage({ channel, text });
  else logger.info({ text }, 'weekly analytics (no OPS_CHANNEL_ID set)');
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function startCron(): void {
  const tz = config.TZ;
  // weekdays only (1-5)
  cron.schedule('30 9 * * 1-5', () => void runStaleReminders(), { timezone: tz });
  cron.schedule('0 9 * * 1-5', () => void runTeamDigest(), { timezone: tz });
  cron.schedule('55 9 * * 1-5', () => void runStandupRecap(), { timezone: tz });
  cron.schedule('0 10 * * 1', () => void runWeeklyAnalytics(), { timezone: tz });
  logger.info({ tz }, 'cron scheduled');
}
