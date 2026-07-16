import crypto from 'node:crypto';
import { Router, raw, type Request, type Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { markEventProcessed } from '../db/repo.js';
import { enqueueGithubEvent } from '../jobs/queue.js';

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', config.GITHUB_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Express router for POST /webhooks/github.
 * - Verifies X-Hub-Signature-256 against the raw body.
 * - ACKs fast (< 3s) then does all work asynchronously via the queue.
 * - Dedupes by X-GitHub-Delivery (GitHub redelivers on timeout).
 */
export function githubWebhookRouter(): Router {
  const router = Router();

  router.post('/webhooks/github', raw({ type: '*/*' }), async (req: Request, res: Response) => {
    const rawBody = req.body as Buffer;
    const signature = req.header('x-hub-signature-256');

    if (!verifySignature(rawBody, signature)) {
      logger.warn('rejected webhook: bad signature');
      return res.status(401).send('invalid signature');
    }

    const deliveryId = req.header('x-github-delivery') ?? '';
    const eventName = req.header('x-github-event') ?? 'unknown';

    // ACK immediately; process out of band.
    res.status(202).send('accepted');

    try {
      if (eventName === 'ping') return;
      const isNew = await markEventProcessed(deliveryId, 'github');
      if (!isNew) {
        logger.debug({ deliveryId }, 'duplicate delivery, skipping');
        return;
      }
      const payload = JSON.parse(rawBody.toString('utf8'));
      await enqueueGithubEvent({ deliveryId, name: eventName, payload });
    } catch (err) {
      logger.error({ err, deliveryId, eventName }, 'failed to enqueue webhook');
    }
  });

  return router;
}
