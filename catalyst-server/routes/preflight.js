const crypto = require('crypto');
const { URL } = require('url');

const GOOGLE_RETURN_COOKIE = 'catalyst_google_return';

function normalizeGoogleCheckoutFlow(url) {
  const next = String(url.searchParams.get('next') || '').trim().toLowerCase();
  if (next !== 'checkout') return '';
  const plan = String(url.searchParams.get('plan') || '').trim().toLowerCase() === 'business' ? 'business' : 'personal';
  return `checkout:${plan}`;
}

async function handlePreflightRoutes(req, res, url, ctx) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    ctx.sendJson(res, 200, { ok: true, storage: (await ctx.isSupabaseReady()) ? 'supabase' : 'unavailable' });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/project-metrics') {
    if (!ctx.canReadProjectMetrics(req)) {
      ctx.notFound(res);
      return true;
    }
    ctx.sendJson(res, 200, await ctx.getProjectMetrics());
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/auth/google/start') {
    if (!ctx.config.GOOGLE_CLIENT_ID || !ctx.config.GOOGLE_CLIENT_SECRET) {
      ctx.badRequest(res, 'Google auth is not configured yet.');
      return true;
    }
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = ctx.getGoogleRedirectUri(req);
    const secure = ctx.requestIsSecure(req);
    const postAuthFlow = normalizeGoogleCheckoutFlow(url);
    const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    googleUrl.searchParams.set('client_id', ctx.config.GOOGLE_CLIENT_ID);
    googleUrl.searchParams.set('redirect_uri', redirectUri);
    googleUrl.searchParams.set('response_type', 'code');
    googleUrl.searchParams.set('scope', 'openid email profile');
    googleUrl.searchParams.set('prompt', 'select_account');
    googleUrl.searchParams.set('state', state);
    ctx.setCookie(res, ctx.GOOGLE_STATE_COOKIE, state, { secure, path: '/api/auth/google' });
    if (postAuthFlow) {
      ctx.setCookie(res, GOOGLE_RETURN_COOKIE, postAuthFlow, { secure, path: '/api/auth/google' });
    } else {
      ctx.clearCookie(res, GOOGLE_RETURN_COOKIE, { secure, path: '/api/auth/google' });
    }
    res.writeHead(302, { Location: googleUrl.toString() });
    res.end();
    return true;
  }

  return false;
}

module.exports = {
  handlePreflightRoutes,
};
