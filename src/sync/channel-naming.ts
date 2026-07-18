import { channelNameExists } from '../db/repo.js';

const SLACK_MAX = 80;

/** Slugify to Slack's channel charset: lowercase, digits, hyphen/underscore. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

/** Repo short name = the part after the org, e.g. example-org/web -> web. */
export function repoShort(repoFullName: string): string {
  const parts = repoFullName.split('/');
  return parts[parts.length - 1] ?? repoFullName;
}

/**
 * Build the base channel name: `<prefix>_<repo-short>_<pr#>_<title-slug>` truncated to 80.
 * e.g. _pr_web_660_fix_offering_use_canonical_url
 */
export function buildChannelName(
  prefix: string,
  repoFullName: string,
  prNumber: number,
  title: string,
): string {
  const head = `${prefix}_${slugify(repoShort(repoFullName))}_${prNumber}_`;
  const room = Math.max(0, SLACK_MAX - head.length);
  const titleSlug = slugify(title).slice(0, room).replace(/-+$/g, '');
  return `${head}${titleSlug}`.slice(0, SLACK_MAX).replace(/[-_]+$/g, '');
}

/**
 * Slack channel names are globally unique forever (archived channels keep them),
 * so on collision we append -2, -3, ... within the 80-char budget.
 */
export async function uniqueChannelName(base: string): Promise<string> {
  if (!(await channelNameExists(base))) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLACK_MAX - suffix.length)}${suffix}`;
    if (!(await channelNameExists(candidate))) return candidate;
  }
  // Extremely unlikely fallback.
  return `${base.slice(0, SLACK_MAX - 6)}-${Date.now().toString().slice(-4)}`;
}
