const { SUPABASE_BASE_URL, SUPABASE_SERVICE_KEY } = require('./config');

const buckets = new Map();
const SUPABASE_ENABLED = Boolean(SUPABASE_BASE_URL && SUPABASE_SERVICE_KEY);
let supabaseRateLimitAvailable = SUPABASE_ENABLED;

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function fallbackRateLimit(req, key, { windowMs, max }) {
  const bucketKey = `${key}:${clientIp(req)}`;
  const now = Date.now();
  const existing = buckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1, resetAt: new Date(now + windowMs).toISOString(), source: 'memory' };
  }
  if (existing.count >= max) {
    return { allowed: false, remaining: 0, resetAt: new Date(existing.resetAt).toISOString(), source: 'memory' };
  }
  existing.count += 1;
  return { allowed: true, remaining: Math.max(0, max - existing.count), resetAt: new Date(existing.resetAt).toISOString(), source: 'memory' };
}

async function supabaseRateLimit(req, key, { windowMs, max }) {
  const bucketKey = `${key}:${clientIp(req)}`;
  const response = await fetch(`${SUPABASE_BASE_URL}/rest/v1/rpc/consume_rate_limit`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      bucket_key: bucketKey,
      window_ms: windowMs,
      max_hits: max,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Supabase rate limit RPC failed (${response.status})`);
    error.status = response.status;
    error.body = text;
    throw error;
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return {
    allowed: Boolean(data.allowed),
    remaining: Math.max(0, Number(data.remaining || 0)),
    resetAt: data.reset_at || null,
    source: 'supabase',
  };
}

async function checkRateLimit(req, key, policy) {
  if (!supabaseRateLimitAvailable) return fallbackRateLimit(req, key, policy);
  try {
    return await supabaseRateLimit(req, key, policy);
  } catch (error) {
    const body = String(error?.body || '');
    if (
      error?.status === 404
      || body.includes('consume_rate_limit')
      || body.includes('rate_limit_events')
      || body.includes('auth_rate_limit_events')
    ) {
      supabaseRateLimitAvailable = false;
      return fallbackRateLimit(req, key, policy);
    }
    throw error;
  }
}

module.exports = {
  checkRateLimit,
  clientIp,
};
