import type bolt from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';
import { github, splitRepo } from '../github/client.js';
import { getUserLinkBySlack, getUserPrefs, updateUserPrefs, upsertUserLink } from '../db/repo.js';
import { publishHome } from './home.js';

type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export function registerInteractivity(app: bolt.App): void {
  // Link buttons are pure URLs; ack to silence the "action failed" toast.
  app.action(/^open_pr/, async ({ ack }) => ack());

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

    const link = await getUserLinkBySlack(slackUserId);
    if (!link) {
      await ack({
        response_action: 'errors',
        errors: { body: 'Link your GitHub account first with /pullpod link <username>.' },
      });
      return;
    }
    await ack();

    try {
      const { owner, repo } = splitRepo(meta.repo);
      const attributed = `${bodyText}\n\n_— submitted by @${link.github_login} via PullPod_`.trim();
      await github().rest.pulls.createReview({
        owner,
        repo,
        pull_number: meta.number,
        event: meta.event,
        body: meta.event === 'APPROVE' && !bodyText ? undefined : attributed,
      });
      await client.chat.postEphemeral({
        channel: (body as any).channel?.id ?? slackUserId,
        user: slackUserId,
        text: `Done — your *${meta.event.toLowerCase().replace('_', ' ')}* was submitted on ${meta.repo}#${meta.number}.`,
      });
    } catch (err: any) {
      logger.error({ err: err?.message, meta }, 'createReview failed');
      await client.chat.postMessage({
        channel: slackUserId,
        text: `⚠️ Couldn't submit your review on ${meta.repo}#${meta.number}: ${err?.message ?? 'unknown error'}`,
      });
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
    await openLinkModal(client, (body as any).trigger_id);
  });

  app.view('link_modal', async ({ ack, body, view, client }) => {
    const username = view.state.values.gh?.gh_input?.value?.trim();
    if (!username) {
      await ack({ response_action: 'errors', errors: { gh: 'Enter your GitHub username.' } });
      return;
    }
    await ack();
    await upsertUserLink(username, body.user.id, 'manual');
    await publishHome(client, body.user.id);
  });

  app.action('home_edit_timeslot', async ({ ack, body, client }) => {
    await ack();
    await openTimeslotModal(client, (body as any).trigger_id, body.user.id);
  });

  app.view('timeslot_modal', async ({ ack, body, view, client }) => {
    const start = view.state.values.start?.start_input?.selected_time ?? null;
    const end = view.state.values.end?.end_input?.selected_time ?? null;
    const tz = view.state.values.tz?.tz_input?.value?.trim() || 'Europe/Budapest';
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

async function openLinkModal(client: WebClient, triggerId: string): Promise<void> {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'link_modal',
      title: { type: 'plain_text', text: 'Link GitHub' },
      submit: { type: 'plain_text', text: 'Save' },
      blocks: [
        {
          type: 'input',
          block_id: 'gh',
          label: { type: 'plain_text', text: 'Your GitHub username' },
          element: { type: 'plain_text_input', action_id: 'gh_input', placeholder: { type: 'plain_text', text: 'e.g. yossefEl' } },
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
