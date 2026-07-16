/**
 * Token-bucket limiter for Slack Tier-2 calls (conversations.create / .invite are
 * ~20/min). We cap at 18/min to leave headroom, and serialize per-PR work so
 * out-of-order webhooks don't race (e.g. "closed" processed before "opened").
 * Single-instance internal tool => in-process state is sufficient.
 */

class TokenBucket {
  private tokens: number;
  private readonly max: number;
  private readonly refillMs: number;
  private queue: Array<() => void> = [];

  constructor(max: number, perMs: number) {
    this.max = max;
    this.tokens = max;
    this.refillMs = perMs / max;
    setInterval(() => this.refill(), this.refillMs).unref?.();
  }

  private refill(): void {
    if (this.tokens < this.max) this.tokens++;
    const next = this.queue.shift();
    if (next && this.tokens > 0) {
      this.tokens--;
      next();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tokens > 0) {
      this.tokens--;
      return fn();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    return fn();
  }
}

export const slackTier2 = new TokenBucket(18, 60_000);

/** Keyed mutex so events for the same PR are handled strictly in arrival order. */
const chains = new Map<string, Promise<unknown>>();

export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    key,
    next.catch(() => undefined).finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    }),
  );
  return next;
}
