import { boss, EVENTS_QUEUE, type GithubEventJob } from './queue.js';
import { logger } from '../logger.js';
import { handlePrOpened } from '../github/handlers/pr-opened.js';
import { handlePrClosed } from '../github/handlers/pr-closed.js';
import { handleReviewRequested } from '../github/handlers/reviewers.js';
import { handleComment } from '../github/handlers/comment.js';
import { handleReview } from '../github/handlers/review.js';
import { handleCheck, handleStatus } from '../github/handlers/checks.js';
import { handlePush } from '../github/handlers/push.js';

/** Routes a GitHub webhook event to the right handler based on name + action. */
async function route(job: GithubEventJob): Promise<void> {
  const { name, payload } = job;
  const action: string | undefined = payload.action;

  switch (name) {
    case 'pull_request':
      if (action === 'opened' || action === 'reopened' || action === 'ready_for_review') {
        return handlePrOpened(payload);
      }
      if (action === 'closed') return handlePrClosed(payload);
      if (action === 'review_requested') return handleReviewRequested(payload);
      return;
    case 'pull_request_review':
      return handleReview(payload);
    case 'pull_request_review_comment':
      return handleComment(payload, 'review_comment');
    case 'issue_comment':
      return handleComment(payload, 'issue_comment');
    case 'check_suite':
    case 'check_run':
      return handleCheck(payload);
    case 'status':
      return handleStatus(payload);
    case 'push':
      return handlePush(payload);
    default:
      logger.debug({ name }, 'no handler for event');
  }
}

/**
 * Start the pg-boss worker. batchSize 1 gives each event independent retry
 * semantics (a throw retries only that job) and strict FIFO processing —
 * more than enough at our volume, and per-PR ordering is additionally
 * guaranteed by the keyed mutex in the Slack channel layer.
 */
export async function startWorker(): Promise<void> {
  await boss.work<GithubEventJob>(
    EVENTS_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (!job) return;
      logger.debug({ name: job.data.name, deliveryId: job.data.deliveryId }, 'processing event');
      await route(job.data); // throw => pg-boss retries with backoff
    },
  );
  logger.info('worker started');
}
