import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_SIGNING_SECRET: z.string().min(1),

  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_INSTALLATION_ID: z.coerce.number().int().positive(),
  GITHUB_ORG: z.string().min(1),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().int().positive().default(3000),
  TZ: z.string().default('Europe/Budapest'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  SENTRY_DSN: z.string().optional(),
  OPS_CHANNEL_ID: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

/** GitHub App private key is stored base64-encoded to survive env-var newline mangling. */
export function githubPrivateKey(): string {
  const raw = config.GITHUB_APP_PRIVATE_KEY;
  // Support both raw PEM and base64-encoded PEM.
  if (raw.includes('BEGIN')) return raw;
  return Buffer.from(raw, 'base64').toString('utf8');
}
