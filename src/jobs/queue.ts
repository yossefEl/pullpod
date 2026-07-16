import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export interface GithubEventJob {
  deliveryId: string;
  name: string;
  payload: any;
}

export const EVENTS_QUEUE = 'pullpod:github-events';

export const eventsQueue = new Queue<GithubEventJob>(EVENTS_QUEUE, { connection });

export async function enqueueGithubEvent(job: GithubEventJob): Promise<void> {
  await eventsQueue.add(job.name, job, {
    // Order-preserving-ish: jobs for the same PR share a jobId prefix isn't
    // enough on its own (BullMQ groups are Pro), so the worker also uses a
    // keyed mutex. Retries with backoff cover transient Slack/GitHub errors.
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
}
