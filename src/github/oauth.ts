import crypto from 'node:crypto';
import { Octokit } from 'octokit';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getGithubIdentityBySlack,
  setVerifiedLink,
  upsertGithubIdentity,
} from '../db/repo.js';
import { encryptSecret, decryptSecret } from '../util/crypto.js';

const CALLBACK_PATH = '/oauth/github/callback';
const STATE_TTL_MS = 10 * 60 * 1000;

function callbackUrl(): string {
  return `${config.PUBLIC_URL}${CALLBACK_PATH}`;
}

// --- signed state (binds the OAuth round-trip to the initiating Slack user) ---

export function signState(slackUserId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ u: slackUserId, n: crypto.randomBytes(8).toString('hex'), e: Date.now() + STATE_TTL_MS }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', config.SLACK_SIGNING_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyState(state: string): string | null {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', config.SLACK_SIGNING_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof e !== 'number' || Date.now() > e) return null;
    return typeof u === 'string' ? u : null;
  } catch {
    return null;
  }
}

/** The GitHub authorize URL a user clicks to connect their account. */
export function authorizeUrl(slackUserId: string): string {
  const params = new URLSearchParams({
    client_id: config.GITHUB_CLIENT_ID!,
    redirect_uri: callbackUrl(),
    state: signState(slackUserId),
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

// --- token exchange / refresh ---

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as TokenResponse;
  if (data.error || !data.access_token) {
    throw new Error(`github oauth: ${data.error ?? 'no token'} ${data.error_description ?? ''}`.trim());
  }
  return data;
}

async function identityFromToken(token: string): Promise<{ login: string; id: number }> {
  const okit = new Octokit({ auth: token });
  const { data } = await okit.rest.users.getAuthenticated();
  return { login: data.login, id: data.id };
}

function expiresAtFrom(tok: TokenResponse): string | null {
  return tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000).toISOString() : null;
}

/** Exchange the callback code, resolve the verified identity, and store it. */
export async function completeOAuth(slackUserId: string, code: string): Promise<{ login: string }> {
  const tok = await tokenRequest({
    client_id: config.GITHUB_CLIENT_ID!,
    client_secret: config.GITHUB_CLIENT_SECRET!,
    code,
    redirect_uri: callbackUrl(),
  });
  const ident = await identityFromToken(tok.access_token);

  await upsertGithubIdentity({
    slack_user_id: slackUserId,
    github_login: ident.login,
    github_user_id: ident.id,
    access_token_enc: encryptSecret(tok.access_token),
    refresh_token_enc: tok.refresh_token ? encryptSecret(tok.refresh_token) : null,
    expires_at: expiresAtFrom(tok),
  });
  // Verified identity also drives mentions/invites.
  await setVerifiedLink(ident.login, slackUserId);

  logger.info({ slackUserId, login: ident.login }, 'github account connected via oauth');
  return { login: ident.login };
}

/**
 * An Octokit authenticated as the Slack user (their real GitHub identity),
 * refreshing the token if it's expiring. Returns null if they haven't connected
 * their account — callers must treat that as "not authorized".
 */
export async function userOctokit(slackUserId: string): Promise<Octokit | null> {
  const id = await getGithubIdentityBySlack(slackUserId);
  if (!id) return null;

  let accessToken = decryptSecret(id.access_token_enc);
  const expiring = id.expires_at ? Date.parse(id.expires_at) < Date.now() + 60_000 : false;

  if (expiring && id.refresh_token_enc) {
    try {
      const tok = await tokenRequest({
        client_id: config.GITHUB_CLIENT_ID!,
        client_secret: config.GITHUB_CLIENT_SECRET!,
        grant_type: 'refresh_token',
        refresh_token: decryptSecret(id.refresh_token_enc),
      });
      accessToken = tok.access_token;
      await upsertGithubIdentity({
        slack_user_id: slackUserId,
        github_login: id.github_login,
        github_user_id: id.github_user_id,
        access_token_enc: encryptSecret(tok.access_token),
        refresh_token_enc: tok.refresh_token ? encryptSecret(tok.refresh_token) : id.refresh_token_enc,
        expires_at: expiresAtFrom(tok),
      });
    } catch (err) {
      logger.warn({ err, slackUserId }, 'github token refresh failed; user must re-link');
      return null;
    }
  }

  return new Octokit({ auth: accessToken });
}
