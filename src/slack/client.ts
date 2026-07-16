import { WebClient } from '@slack/web-api';
import { config } from '../config.js';

/** Shared bot WebClient. Bolt uses its own internally, but jobs/cron need direct access. */
export const slack = new WebClient(config.SLACK_BOT_TOKEN);
