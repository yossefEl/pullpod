import { describe, it, expect } from 'vitest';
import { isBotAuthor } from '../src/github/handlers/bots.js';

describe('isBotAuthor', () => {
  it('detects Bot account type', () => {
    expect(isBotAuthor({ login: 'anything', type: 'Bot' })).toBe(true);
  });
  it('detects [bot] suffix', () => {
    expect(isBotAuthor({ login: 'my-app[bot]', type: 'User' })).toBe(true);
  });
  it('detects known bots by name', () => {
    expect(isBotAuthor({ login: 'dependabot', type: 'User' })).toBe(true);
    expect(isBotAuthor({ login: 'Renovate', type: 'User' })).toBe(true);
  });
  it('treats humans as non-bots', () => {
    expect(isBotAuthor({ login: 'yossefEl', type: 'User' })).toBe(false);
  });
  it('handles missing user', () => {
    expect(isBotAuthor(undefined)).toBe(false);
  });
});
