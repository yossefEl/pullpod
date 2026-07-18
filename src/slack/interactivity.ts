import type bolt from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';
import { github, splitRepo } from '../github/client.js';
import { authorizeUrl, userOctokit } from '../github/oauth.js';
import { mergeRestrictions, oauthConfigured } from '../config.js';
import { getGithubIdentityBySlack, getUserPrefs, updateUserPrefs } from '../db/repo.js';
import { publishHome } from './home.js';

type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/**
 * Repo-specific merge policy (by short repo name), configured via the
 * MERGE_RESTRICTIONS env var. An entry restricts merging to the listed GitHub
 * logins. Every repo also requires at least one approval (below).
 */
const MERGE_RESTRICTIONS: Record<string, string[]> = mergeRestrictions();

export function registerInteractivity(app: bolt.App): void {
  // URL buttons (Open PR, Connect GitHub) still fire an action; ack to silence the toast.
  app.action(/^open_pr/, async ({ ack }) => ack());
  app.action('connect_github', async ({ ack }) => ack());

  // --- PR review actions from the pinned card ---
  app.action('approve_pr', async ({ ack, body, client }) => {
    await ack();
    await openReviewModal(client, body, 'APPROVE');
  });
  app.action('request_changes_pr', async ({ ack, body, client }) => {
    await ack();
    await openReviewModal(client, body, 'REQUEST_CHANGES');
  });
  app.action('comment_pr', async ({ ack, body, client }) => {
    await ack();
    await openReviewModal(client, body, 'COMMENT');
  });

  app.view('review_modal', async ({ ack, body, view, client }) => {
    const meta = JSON.parse(view.private_metadata) as { repo: string; number: number; event: ReviewEvent };
    const slackUserId = body.user.id;
    const bodyText = view.state.values.body?.body_input?.value ?? '';

    // Reviews are submitted with the user's OWN GitHub token, so GitHub enforces
    // that they actually have access — and the review is attributed to them.
    const okit = await userOctokit(slackUserId);
    if (!okit) {
      await ack({
        response_action: 'errors',
        errors: { body: 'Connect your GitHub account first — run `/pullpod connect` in Slack.' },
      });
      return;
    }
    await ack();

    try {
      const { owner, repo } = splitRepo(meta.repo);
      await okit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: meta.number,
        event: meta.event,
        body: meta.event === 'APPROVE' && !bodyText ? undefined : bodyText || undefined,
      });
      await client.chat.postMessage({
        channel: slackUserId,
        text: `✅ Your *${meta.event.toLowerCase().replace('_', ' ')}* was submitted on ${meta.repo}#${meta.number} as yourself.`,
      });
    } catch (err: any) {
      const denied = err?.status === 403 || err?.status === 404;
      const msg = denied
        ? `GitHub says you don't have permission to review \`${meta.repo}\`#${meta.number}. You can only review repos you have access to.`
        : err?.message ?? 'unknown error';
      logger.error({ err: err?.message, status: err?.status, meta }, 'createReview failed');
      await client.chat.postMessage({
        channel: slackUserId,
        text: `⚠️ Couldn't submit your review on ${meta.repo}#${meta.number}: ${msg}`,
      });
    }
  });

  // --- Merge from the card ---
  app.action('merge_pr', async ({ ack, body, client }) => {
    await ack();
    const value: string = (body as any).actions?.[0]?.value ?? '';
    const [repoFullName, numStr] = value.split('#');
    const number = Number(numStr);
    const slackUserId = body.user.id;
    const dm = (text: string) => client.chat.postMessage({ channel: slackUserId, text });
    if (!repoFullName || !Number.isFinite(number)) return;

    // Must be connected — the merge is performed as the real user.
    const okit = await userOctokit(slackUserId);
    if (!okit) {
      await dm('Connect your GitHub account first — run `/pullpod connect` in Slack.');
      return;
    }

    // Repo-specific merge restriction from MERGE_RESTRICTIONS (e.g. {"web":["alice"]}).
    const shortRepo = repoFullName.split('/')[1] ?? repoFullName;
    const allowed = MERGE_RESTRICTIONS[shortRepo];
    const identity = await getGithubIdentityBySlack(slackUserId);
    if (allowed && !allowed.some((l: string) => l.toLowerCase() === (identity?.github_login ?? '').toLowerCase())) {
      await dm(`Only ${allowed.map((l: string) => `\`${l}\``).join(', ')} can merge PRs in \`${shortRepo}\`.`);
      return;
    }

    const { owner, repo } = splitRepo(repoFullName);

    // Require at least one approval and no outstanding "changes requested".
    try {
      const { data: reviews } = await github().rest.pulls.listReviews({
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      const latest = new Map<string, string>();
      for (const r of reviews) {
        const lg = r.user?.login;
        if (!lg) continue;
        const st = String(r.state ?? '').toLowerCase();
        if (st === 'dismissed') latest.delete(lg);
        else if (st === 'approved' || st === 'changes_requested' || st === 'commented') latest.set(lg, st);
      }
      const states = [...latest.values()];
      if (states.filter((s) => s === 'approved').length < 1) {
        await dm(`\`${repoFullName}\`#${number} needs at least one approval before it can be merged.`);
        return;
      }
      if (states.some((s) => s === 'changes_requested')) {
        await dm(`\`${repoFullName}\`#${number} has requested changes outstanding — resolve them first.`);
        return;
      }
    } catch (err: any) {
      logger.error({ err: err?.message, repoFullName, number }, 'merge: review check failed');
      await dm(`Couldn't check reviews for ${repoFullName}#${number}. Try again.`);
      return;
    }

    try {
      await okit.rest.pulls.merge({ owner, repo, pull_number: number });
      await dm(`🔀 Merged \`${repoFullName}\`#${number}.`);
    } catch (err: any) {
      const denied = err?.status === 403 || err?.status === 404 || err?.status === 405;
      const msg = denied
        ? `GitHub blocked the merge (your permissions or branch protection): ${err?.message ?? ''}`
        : err?.message ?? 'unknown error';
      logger.error({ err: err?.message, status: err?.status, repoFullName, number }, 'merge failed');
      await dm(`⚠️ Couldn't merge ${repoFullName}#${number}: ${msg}`);
    }
  });

  // --- App Home settings buttons ---
  app.action('home_refresh', async ({ ack, body, client }) => {
    await ack();
    await publishHome(client, body.user.id);
  });

  app.action('home_toggle_pause', async ({ ack, body, client }) => {
    await ack();
    const prefs = await getUserPrefs(body.user.id);
    await updateUserPrefs(body.user.id, { paused: !prefs.paused });
    await publishHome(client, body.user.id);
  });

  app.action('home_toggle_ci', async ({ ack, body, client }) => {
    await ack();
    const prefs = await getUserPrefs(body.user.id);
    await updateUserPrefs(body.user.id, { notify_ci: !prefs.notify_ci });
    await publishHome(client, body.user.id);
  });

  app.action('home_relink', async ({ ack, body, client }) => {
    await ack();
    const slackUserId = body.user.id;
    if (!oauthConfigured()) {
      await client.chat.postMessage({
        channel: slackUserId,
        text: '⚠️ GitHub linking isn’t configured yet. Ask an admin to set up GitHub OAuth.',
      });
      return;
    }
    await client.chat.postMessage({
      channel: slackUserId,
      text: 'Connect your GitHub account:',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '🔗 *Connect your GitHub account* so your approvals and comments post as you.' },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Connect GitHub' },
              url: authorizeUrl(slackUserId),
              action_id: 'connect_github',
            },
          ],
        },
      ],
    });
  });

  app.action('home_edit_timeslot', async ({ ack, body, client }) => {
    await ack();
    await openTimeslotModal(client, (body as any).trigger_id, body.user.id);
  });

  app.view('timeslot_modal', async ({ ack, body, view, client }) => {
    const start = view.state.values.start?.start_input?.selected_time ?? null;
    const end = view.state.values.end?.end_input?.selected_time ?? null;
    const tz = view.state.values.tz?.tz_input?.value?.trim() || 'UTC';
    await ack();
    await updateUserPrefs(body.user.id, {
      timeslot_start: start,
      timeslot_end: end,
      timezone: tz,
    });
    await publishHome(client, body.user.id);
  });
}

async function openReviewModal(
  client: WebClient,
  body: any,
  event: ReviewEvent,
): Promise<void> {
  const value: string = body.actions?.[0]?.value ?? '';
  const [repo, numStr] = value.split('#');
  const number = Number(numStr);
  const titles: Record<ReviewEvent, string> = {
    APPROVE: 'Approve PR',
    REQUEST_CHANGES: 'Request changes',
    COMMENT: 'Comment on PR',
  };
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'review_modal',
      private_metadata: JSON.stringify({ repo, number, event }),
      title: { type: 'plain_text', text: titles[event] },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${repo}#${number}*` } },
        {
          type: 'input',
          block_id: 'body',
          optional: event === 'APPROVE',
          label: { type: 'plain_text', text: event === 'APPROVE' ? 'Comment (optional)' : 'Comment' },
          element: { type: 'plain_text_input', action_id: 'body_input', multiline: true },
        },
      ],
    },
  });
}

async function openTimeslotModal(
  client: WebClient,
  triggerId: string,
  slackUserId: string,
): Promise<void> {
  const prefs = await getUserPrefs(slackUserId);
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'timeslot_modal',
      title: { type: 'plain_text', text: 'Review time slot' },
      submit: { type: 'plain_text', text: 'Save' },
      blocks: [
        {
          type: 'input',
          block_id: 'start',
          optional: true,
          label: { type: 'plain_text', text: 'Start' },
          element: {
            type: 'timepicker',
            action_id: 'start_input',
            initial_time: prefs.timeslot_start?.slice(0, 5) ?? '09:00',
          },
        },
        {
          type: 'input',
          block_id: 'end',
          optional: true,
          label: { type: 'plain_text', text: 'End' },
          element: {
            type: 'timepicker',
            action_id: 'end_input',
            initial_time: prefs.timeslot_end?.slice(0, 5) ?? '18:00',
          },
        },
        {
          type: 'input',
          block_id: 'tz',
          optional: true,
          label: { type: 'plain_text', text: 'Timezone (IANA)' },
          element: {
            type: 'plain_text_input',
            action_id: 'tz_input',
            initial_value: prefs.timezone,
          },
        },
      ],
    },
  });
}
