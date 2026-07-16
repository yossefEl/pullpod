import { config } from './config.js';
import { logger } from './logger.js';
import { createSlackApp } from './slack/app.js';
import { githubWebhookRouter } from './github/webhooks.js';
import { startWorker } from './jobs/worker.js';
import { startCron } from './jobs/cron.js';
import { pool } from './db/pool.js';

async function main(): Promise<void> {
  const { receiver } = createSlackApp();

  // Bolt's ExpressReceiver exposes the underlying Express app; mount our own
  // routes (GitHub webhooks + health) alongside /slack/events.
  const app = receiver.app;
  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));
  app.use(githubWebhookRouter());

  const worker = startWorker();
  startCron();

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, '🫛 PullPod is running');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await worker.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
