const buckets = new Map();

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(req, key, { windowMs, max }) {
  const bucketKey = `${key}:${clientIp(req)}`;
  const now = Date.now();
  const existing = buckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, resetAt: now + windowMs };
  }
  if (existing.count >= max) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }
  existing.count += 1;
  return { allowed: true, remaining: Math.max(0, max - existing.count), resetAt: existing.resetAt };
}

module.exports = {
  checkRateLimit,
  clientIp,
};
