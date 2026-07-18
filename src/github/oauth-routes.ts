import { Router, type Request, type Response } from 'express';
import { logger } from '../logger.js';
import { oauthConfigured } from '../config.js';
import { completeOAuth, verifyState } from './oauth.js';
import { slack } from '../slack/client.js';

/** Express router for the GitHub user-authorization callback. */
export function oauthRouter(): Router {
  const router = Router();

  router.get('/oauth/github/callback', async (req: Request, res: Response) => {
    if (!oauthConfigured()) {
      return res.status(503).send(page('GitHub linking isn’t configured on this server yet.'));
    }

    const code = String(req.query.code ?? '');
    const state = String(req.query.state ?? '');
    const slackUserId = verifyState(state);

    if (!code || !slackUserId) {
      return res.status(400).send(page('This link is invalid or expired. Run `/pullpod connect` again in Slack.'));
    }

    try {
      const { login } = await completeOAuth(slackUserId, code);
      // Best-effort Slack confirmation DM.
      void slack.chat
        .postMessage({
          channel: slackUserId,
          text: `✅ GitHub connected as \`${login}\`. Your approvals and comments will now be submitted as you.`,
        })
        .catch(() => {});
      return res
        .status(200)
        .send(page(`✅ Connected as <b>${escapeHtml(login)}</b>. You can close this tab and return to Slack.`));
    } catch (err: any) {
      logger.error({ err: err?.message, slackUserId }, 'oauth callback failed');
      return res.status(500).send(page('Something went wrong connecting your GitHub account. Please try again.'));
    }
  });

  return router;
}

function page(msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PullPod</title></head><body style="font-family:system-ui,-apple-system,sans-serif;background:#12151a;color:#e6edf3;display:flex;min-height:90vh;align-items:center;justify-content:center"><div style="max-width:520px;padding:32px;text-align:center"><div style="font-size:40px">🫛</div><h2 style="margin:8px 0 12px">PullPod</h2><p style="line-height:1.5;color:#c9d1d9">${msg}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
