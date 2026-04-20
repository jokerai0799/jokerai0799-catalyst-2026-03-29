const crypto = require('crypto');
const { URL } = require('url');

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
    const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    googleUrl.searchParams.set('client_id', ctx.config.GOOGLE_CLIENT_ID);
    googleUrl.searchParams.set('redirect_uri', redirectUri);
    googleUrl.searchParams.set('response_type', 'code');
    googleUrl.searchParams.set('scope', 'openid email profile');
    googleUrl.searchParams.set('prompt', 'select_account');
    googleUrl.searchParams.set('state', state);
    ctx.setCookie(res, ctx.GOOGLE_STATE_COOKIE, state, { secure, path: '/api/auth/google' });
    res.writeHead(302, { Location: googleUrl.toString() });
    res.end();
    return true;
  }

  return false;
}

module.exports = {
  handlePreflightRoutes,
};
