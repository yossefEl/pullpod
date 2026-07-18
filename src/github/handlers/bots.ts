const KNOWN_BOTS = new Set(['dependabot', 'dependabot[bot]', 'renovate', 'renovate[bot]']);

export function isBotAuthor(user: any): boolean {
  if (!user) return false;
  if (user.type === 'Bot') return true;
  const login = String(user.login ?? '').toLowerCase();
  return login.endsWith('[bot]') || KNOWN_BOTS.has(login);
}
