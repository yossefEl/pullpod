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
  /** Single shared channel that holds one threaded message per PR. */
  PR_CHANNEL_NAME: z.string().min(1).default('pr-approve'),
  PORT: z.coerce.number().int().positive().default(3000),
  TZ: z.string().default('UTC'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  SENTRY_DSN: z.string().optional(),
  OPS_CHANNEL_ID: z.string().optional(),

  // GitHub OAuth — per-user identity so linking is *verified* and reviews are
  // submitted as the actual person (GitHub then enforces repo permissions).
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  /** 32-byte key (hex or base64) used to encrypt stored user tokens at rest. */
  TOKEN_ENC_KEY: z.string().optional(),
  /** Public base URL of this service, e.g. https://pullpod-xxx.run.app (for OAuth callback). */
  PUBLIC_URL: z.string().url().optional(),

  /**
   * Optional per-repo merge allowlist as JSON, keyed by short repo name:
   * `{"web":["alice"]}` means only GitHub user `alice` may merge PRs in `web`.
   * Repos not listed have no extra restriction (still require an approval).
   * Kept in env, not source, so private org/user names stay out of the repo.
   */
  MERGE_RESTRICTIONS: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

/** True only when every piece needed for per-user GitHub OAuth is present. */
export function oauthConfigured(): boolean {
  return Boolean(
    config.GITHUB_CLIENT_ID &&
      config.GITHUB_CLIENT_SECRET &&
      config.TOKEN_ENC_KEY &&
      config.PUBLIC_URL,
  );
}

/**
 * Per-repo merge allowlist parsed from the MERGE_RESTRICTIONS env var. Returns
 * an empty map when unset or malformed (fail-open to "no extra restriction").
 */
export function mergeRestrictions(): Record<string, string[]> {
  if (!config.MERGE_RESTRICTIONS) return {};
  try {
    const parsedMap = JSON.parse(config.MERGE_RESTRICTIONS);
    return parsedMap && typeof parsedMap === 'object' ? parsedMap : {};
  } catch {
    return {};
  }
}

/** GitHub App private key is stored base64-encoded to survive env-var newline mangling. */
export function githubPrivateKey(): string {
  const raw = config.GITHUB_APP_PRIVATE_KEY;
  // Support both raw PEM and base64-encoded PEM.
  if (raw.includes('BEGIN')) return raw;
  return Buffer.from(raw, 'base64').toString('utf8');
}
