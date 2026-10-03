/**
 * Small in-memory rate limiter.
 *
 * Written rather than installed because this is the only thing in the codebase
 * that needs it and `npm ci --only=production` runs in the Docker build — one
 * fewer dependency to keep current.
 *
 * Caveat worth knowing: the counters live in this process. With the single
 * `cal360api` container in docker-compose that is the whole picture, but if the
 * API is ever run with more than one replica each gets its own allowance, and
 * the effective limit multiplies. Move to a shared store (Redis) at that point.
 */

/** key -> { count, resetAt } */
const buckets = new Map();

/** Dropped every so often so an idle key does not sit in memory forever. */
const PRUNE_EVERY_MS = 10 * 60 * 1000;
let lastPrune = Date.now();

function prune(now) {
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Allows [max] requests per [windowMs] per caller.
 *
 * Keyed on the authenticated user when there is one, so one person on a shared
 * network cannot spend everyone else's allowance, and on the IP otherwise.
 * Mount it *after* the auth middleware for the user key to be available.
 */
export function rateLimit({ max, windowMs, name = 'request' }) {
  return (req, res, next) => {
    const now = Date.now();
    prune(now);

    const key = `${name}:${req.userId ?? req.ip ?? 'anon'}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        message: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
        retryAfter,
      });
    }

    bucket.count += 1;
    return next();
  };
}

/** Test seam — lets a suite start from a clean slate. */
export function __resetRateLimits() {
  buckets.clear();
  lastPrune = Date.now();
}
