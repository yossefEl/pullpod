import type bolt from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/types';
import { logger } from '../logger.js';
import { github } from '../github/client.js';
import { getPrChannel, getUserLinkBySlack, getUserPrefs } from '../db/repo.js';
import { config } from '../config.js';

interface PrItem {
  title: string;
  url: string;
  repo: string;
  number: number;
  author: string;
  reviewers: string[];
  updatedAt: string;
  createdAt: string;
}

export function registerHome(app: bolt.App): void {
  app.event('app_home_opened', async ({ event, client }) => {
    await publishHome(client, event.user);
  });
}

export async function publishHome(client: WebClient, slackUserId: string): Promise<void> {
  try {
    const view = await buildHomeView(slackUserId);
    await client.views.publish({ user_id: slackUserId, view });
  } catch (err) {
    logger.error({ err, slackUserId }, 'failed to publish home');
  }
}

async function buildHomeView(slackUserId: string): Promise<any> {
  const link = await getUserLinkBySlack(slackUserId);
  const prefs = await getUserPrefs(slackUserId);

  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: '🫛 PullPod' } },
    { type: 'section', text: { type: 'mrkdwn', text: '*⚙️ Settings*' } },
  ];

  // GitHub link status.
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: link
        ? `✅ Linked to GitHub as \`${link.github_login}\``
        : '⚠️ *Not linked to GitHub.* Run `/pullpod link <your-github-username>` so I can invite you to PR channels.',
    },
    accessory: link
      ? {
          type: 'button',
          text: { type: 'plain_text', text: 'Re-link GitHub' },
          action_id: 'home_relink',
        }
      : undefined,
  });

  // Pause / resume + time slots + CI toggle.
  const timeslot =
    prefs.timeslot_start && prefs.timeslot_end
      ? `${prefs.timeslot_start}–${prefs.timeslot_end} (${prefs.timezone})`
      : 'not set (notified anytime)';
  blocks.push(
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Status:* ${prefs.paused ? '⏸️ Paused' : '▶️ Active'}\n*Review time slot:* ${timeslot}\n*CI notifications:* ${prefs.notify_ci ? 'on' : 'off'}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: prefs.paused ? '▶️ Resume' : '⏸️ Pause' },
          action_id: 'home_toggle_pause',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🕑 Update time slot' },
          action_id: 'home_edit_timeslot',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: prefs.notify_ci ? '🔕 Mute CI' : '🔔 Unmute CI' },
          action_id: 'home_toggle_ci',
        },
        { type: 'button', text: { type: 'plain_text', text: '🔄 Refresh' }, action_id: 'home_refresh' },
      ],
    },
    { type: 'divider' },
  );

  if (!link) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Link your GitHub account to see your pull requests here.' }],
    });
    return { type: 'home', blocks };
  }

  // PR lists.
  const [awaitingReview, mine] = await Promise.all([
    searchPrs(`is:open is:pr review-requested:${link.github_login} org:${config.GITHUB_ORG}`),
    searchPrs(`is:open is:pr author:${link.github_login} org:${config.GITHUB_ORG}`),
  ]);

  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*🧐 PRs awaiting your review*' } });
  await appendPrList(blocks, awaitingReview);
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*📤 Your open PRs*' } });
  await appendPrList(blocks, mine);

  return { type: 'home', blocks };
}

async function appendPrList(blocks: KnownBlock[], items: PrItem[]): Promise<void> {
  if (items.length === 0) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_Nothing here right now 🎉_' }] });
    return;
  }
  for (const it of items.slice(0, 15)) {
    const pod = await getPrChannel(it.repo, it.number);
    const channelRef = pod && pod.state === 'open' ? ` · <#${pod.channel_id}>` : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<${it.url}|${escape(it.title)}>${channelRef}\n\`${it.repo}\` · author \`${it.author}\` · updated ${ago(it.updatedAt)}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Open' },
        url: it.url,
        action_id: `open_pr_${it.number}`,
      },
    });
  }
}

async function searchPrs(q: string): Promise<PrItem[]> {
  try {
    const { data } = await github().rest.search.issuesAndPullRequests({ q, per_page: 20 });
    return data.items.map((i: any) => ({
      title: i.title,
      url: i.html_url,
      repo: i.repository_url.split('/repos/')[1],
      number: i.number,
      author: i.user?.login ?? '?',
      reviewers: [],
      updatedAt: i.updated_at,
      createdAt: i.created_at,
    }));
  } catch (err) {
    logger.debug({ err, q }, 'PR search failed');
    return [];
  }
}

function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86_400_000);
  if (d > 0) return `${d}d ago`;
  const h = Math.floor(diff / 3_600_000);
  if (h > 0) return `${h}h ago`;
  const m = Math.floor(diff / 60_000);
  return `${m}m ago`;
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
