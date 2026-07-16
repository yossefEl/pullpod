import { Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import { config, githubPrivateKey } from '../config.js';

let cached: Octokit | null = null;

/**
 * Octokit authenticated as the installation. Single-tenant: one installation id
 * from config. Token minting/refresh is handled internally by @octokit/auth-app.
 */
export function github(): Octokit {
  if (cached) return cached;
  cached = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.GITHUB_APP_ID,
      privateKey: githubPrivateKey(),
      installationId: config.GITHUB_INSTALLATION_ID,
    },
  });
  return cached;
}

export function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split('/');
  return { owner: owner!, repo: repo! };
}
