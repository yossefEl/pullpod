import PgBoss from 'pg-boss';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface GithubEventJob {
  deliveryId: string;
  name: string;
  payload: any;
}

export const EVENTS_QUEUE = 'github-events';

// pg-boss runs the job queue inside the same Postgres we already use — no Redis.
// It manages its own `pgboss` schema. A small pool is plenty at our volume.
const isLocal = config.DATABASE_URL.includes('localhost');
export const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  max: 4,
  schema: 'pgboss',
});

boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));

let started = false;

export async function startBoss(): Promise<void> {
  if (started) return;
  await boss.start();
  await boss.createQueue(EVENTS_QUEUE);
  started = true;
  logger.info('pg-boss started');
}

export async function stopBoss(): Promise<void> {
  if (!started) return;
  await boss.stop();
  started = false;
}

export async function enqueueGithubEvent(job: GithubEventJob): Promise<void> {
  await boss.send(EVENTS_QUEUE, job, {
    // Transient Slack/GitHub errors retry with exponential backoff.
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 2,
    // Drop jobs that somehow linger far past relevance.
    expireInSeconds: 3600,
  });
}
