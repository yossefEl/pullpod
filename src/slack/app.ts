import bolt from '@slack/bolt';
import { config } from '../config.js';
import { registerHome } from './home.js';
import { registerInteractivity } from './interactivity.js';
import { registerCommands } from './commands.js';
import { registerTwoWaySync } from './two-way.js';

const { App, ExpressReceiver } = bolt;

export function createSlackApp(): { app: bolt.App; receiver: bolt.ExpressReceiver } {
  const receiver = new ExpressReceiver({
    signingSecret: config.SLACK_SIGNING_SECRET,
    endpoints: '/slack/events',
    processBeforeResponse: true,
  });

  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    receiver,
  });

  registerHome(app);
  registerInteractivity(app);
  registerCommands(app);
  registerTwoWaySync(app);

  return { app, receiver };
}
