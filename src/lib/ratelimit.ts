import type { Bindings, RateLimiter } from "../env";

export type Bucket = "auth" | "write" | "ai" | "public" | "webhook";

/** Must match the `ratelimits` entries in wrangler.jsonc; the numbers also drive the in-memory fallback. */
const BUCKETS: Record<Bucket, { binding: keyof Bindings; limit: number; windowMs: number }> = {
  auth: { binding: "RL_AUTH", limit: 20, windowMs: 60_000 },
  write: { binding: "RL_WRITE", limit: 60, windowMs: 60_000 },
  ai: { binding: "RL_AI", limit: 12, windowMs: 60_000 },
  public: { binding: "RL_PUBLIC", limit: 120, windowMs: 60_000 },
  webhook: { binding: "RL_WEBHOOK", limit: 60, windowMs: 60_000 },
};

const MAX_TRACKED_KEYS = 10_000;
const hits = new Map<string, number[]>();

/**
 * Sliding-window limiter for one Worker instance. Only a fallback: it can't see requests
 * handled by other instances, so the Cloudflare binding is used whenever it's available.
 */
export function memoryAllow(bucket: Bucket, key: string, now = Date.now()): boolean {
  const { limit, windowMs } = BUCKETS[bucket];
  const id = `${bucket}:${key}`;
  const recent = (hits.get(id) ?? []).filter((time) => now - time < windowMs);
  const allowed = recent.length < limit;
  if (allowed) recent.push(now);
  hits.delete(id);
  hits.set(id, recent);
  if (hits.size > MAX_TRACKED_KEYS) hits.delete(hits.keys().next().value as string);
  return allowed;
}

export async function allowRequest(env: Bindings, bucket: Bucket, key: string): Promise<boolean> {
  const limiter = env[BUCKETS[bucket].binding] as RateLimiter | undefined;
  if (limiter && typeof limiter.limit === "function") {
    try {
      return (await limiter.limit({ key: `${bucket}:${key}` })).success;
    } catch (error) {
      console.warn(`rate limiter ${bucket} failed, using in-memory fallback:`, error instanceof Error ? error.message : error);
    }
  }
  return memoryAllow(bucket, key);
}
