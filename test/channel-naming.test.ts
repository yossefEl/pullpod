import { describe, it, expect } from 'vitest';
import { slugify, repoShort, buildChannelName } from '../src/sync/channel-naming.js';

describe('slugify', () => {
  it('lowercases and replaces invalid chars with hyphens', () => {
    expect(slugify('Fix: Offering URL!')).toBe('fix-offering-url');
  });
  it('collapses repeats and trims edges', () => {
    expect(slugify('  --Hello___World--  ')).toBe('hello___world');
  });
  it('keeps underscores and digits', () => {
    expect(slugify('CU-869dy77d0_offering')).toBe('cu-869dy77d0_offering');
  });
});

describe('repoShort', () => {
  it('returns the part after the org', () => {
    expect(repoShort('voovostudy/voovo-mobile')).toBe('voovo-mobile');
  });
  it('handles names without a slash', () => {
    expect(repoShort('solo')).toBe('solo');
  });
});

describe('buildChannelName', () => {
  it('builds prefix_repo_number_title', () => {
    const name = buildChannelName('_pr', 'voovostudy/voovo-mobile', 660, 'fix offering url');
    expect(name).toBe('_pr_voovo-mobile_660_fix-offering-url');
  });

  it('never exceeds Slack’s 80-char limit', () => {
    const long = 'a'.repeat(300);
    const name = buildChannelName('_pr', 'voovostudy/voovo-content-platform', 12345, long);
    expect(name.length).toBeLessThanOrEqual(80);
  });

  it('does not end with a stray separator after truncation', () => {
    const name = buildChannelName('_pr', 'org/repo', 1, 'word '.repeat(40));
    expect(name).not.toMatch(/[-_]$/);
  });
});
