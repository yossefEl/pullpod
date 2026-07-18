import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Dummy env so config.ts parses at import time (no real services touched).
    env: {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_SIGNING_SECRET: 'test-secret',
      GITHUB_APP_ID: '1',
      GITHUB_APP_PRIVATE_KEY: 'dGVzdA==',
      GITHUB_WEBHOOK_SECRET: 'whsec',
      GITHUB_INSTALLATION_ID: '1',
      GITHUB_ORG: 'example-org',
      DATABASE_URL: 'postgres://localhost:5432/test',
    },
  },
});
