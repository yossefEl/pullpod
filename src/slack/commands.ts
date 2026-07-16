import type bolt from '@slack/bolt';
import {
  getUserLinkBySlack,
  getUserPrefs,
  listRepoConfigs,
  updateUserPrefs,
  upsertRepoConfig,
  upsertUserLink,
} from '../db/repo.js';

const HELP = [
  '*PullPod commands*',
  '`/pullpod link <github-username>` — connect your GitHub account',
  '`/pullpod pause` / `resume` — stop/start being added to PR channels',
  '`/pullpod timeslot 09:00 18:00 [tz]` — set your review notification window',
  '`/pullpod status` — show your current settings',
  '`/pullpod repos` — list repos PullPod is watching (admin)',
  '`/pullpod repo <owner/name> on|off` — enable/disable a repo (admin)',
  '`/pullpod repo <owner/name> team <#channel-id>` — set a repo team channel (admin)',
  '`/pullpod help` — this message',
].join('\n');

export function registerCommands(app: bolt.App): void {
  app.command('/pullpod', async ({ ack, command, respond }) => {
    await ack();
    const [sub, ...rest] = command.text.trim().split(/\s+/);
    const userId = command.user_id;

    switch ((sub ?? '').toLowerCase()) {
      case '':
      case 'help':
        return respond({ text: HELP });

      case 'link': {
        const username = rest[0]?.replace(/^@/, '');
        if (!username) return respond({ text: 'Usage: `/pullpod link <github-username>`' });
        await upsertUserLink(username, userId, 'manual');
        return respond({ text: `✅ Linked you to GitHub as \`${username}\`.` });
      }

      case 'pause':
        await updateUserPrefs(userId, { paused: true });
        return respond({ text: '⏸️ Paused. You won’t be added to new PR channels.' });

      case 'resume':
        await updateUserPrefs(userId, { paused: false });
        return respond({ text: '▶️ Resumed. Welcome back.' });

      case 'timeslot': {
        const [start, end, tz] = rest;
        if (!start || !end || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
          return respond({ text: 'Usage: `/pullpod timeslot 09:00 18:00 [Europe/Budapest]`' });
        }
        await updateUserPrefs(userId, {
          timeslot_start: start,
          timeslot_end: end,
          ...(tz ? { timezone: tz } : {}),
        });
        return respond({ text: `🕑 Review time slot set to ${start}–${end}${tz ? ` (${tz})` : ''}.` });
      }

      case 'status': {
        const link = await getUserLinkBySlack(userId);
        const prefs = await getUserPrefs(userId);
        const slot =
          prefs.timeslot_start && prefs.timeslot_end
            ? `${prefs.timeslot_start}–${prefs.timeslot_end} (${prefs.timezone})`
            : 'anytime';
        return respond({
          text: [
            `*GitHub:* ${link ? `\`${link.github_login}\`` : '_not linked_'}`,
            `*Status:* ${prefs.paused ? 'paused' : 'active'}`,
            `*Time slot:* ${slot}`,
            `*CI notifications:* ${prefs.notify_ci ? 'on' : 'off'}`,
          ].join('\n'),
        });
      }

      case 'repos': {
        const repos = await listRepoConfigs();
        if (repos.length === 0) return respond({ text: 'No repos configured yet.' });
        const lines = repos.map(
          (r) =>
            `${r.enabled ? '🟢' : '⚪️'} \`${r.repo_full_name}\` — CI: ${r.ci_notify_level}, drafts: ${r.skip_draft ? 'skipped' : 'included'}, bots: ${r.bot_pr_strategy}${r.team_channel_id ? `, team <#${r.team_channel_id}>` : ''}`,
        );
        return respond({ text: `*Watched repos*\n${lines.join('\n')}` });
      }

      case 'repo': {
        const [fullName, op, arg] = rest;
        if (!fullName || !op) {
          return respond({ text: 'Usage: `/pullpod repo <owner/name> on|off|team <#channel>`' });
        }
        if (op === 'on' || op === 'off') {
          await upsertRepoConfig(fullName, { enabled: op === 'on' });
          return respond({ text: `\`${fullName}\` is now ${op === 'on' ? 'enabled 🟢' : 'disabled ⚪️'}.` });
        }
        if (op === 'team' && arg) {
          const channelId = arg.replace(/[<#>]/g, '').split('|')[0];
          await upsertRepoConfig(fullName, { team_channel_id: channelId });
          return respond({ text: `Team channel for \`${fullName}\` set to <#${channelId}>.` });
        }
        return respond({ text: 'Usage: `/pullpod repo <owner/name> on|off|team <#channel>`' });
      }

      default:
        return respond({ text: `Unknown subcommand \`${sub}\`.\n${HELP}` });
    }
  });
}
