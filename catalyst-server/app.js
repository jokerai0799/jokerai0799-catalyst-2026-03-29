const { URL } = require('url');
const { IS_PRODUCTION, IS_VERCEL } = require('./config');
const { sendJson, serveStatic } = require('./http');
const { createAppContext } = require('./app-context');
const { handlePreflightRoutes } = require('./routes/preflight');
const { handlePublicRoutes } = require('./routes/public');
const { handleAuthRoutes } = require('./routes/auth');
const { handleBillingRoutes } = require('./routes/billing');
const { handleWorkspaceRoutes } = require('./routes/workspace');
const { handleQuoteRoutes } = require('./routes/quotes');

function createRequestHandler(overrides = {}) {
  const ctx = createAppContext(overrides);

  async function handleApi(req, res, url) {
    if (await handlePreflightRoutes(req, res, url, ctx)) return;

    if (!(await ctx.isSupabaseReady())) {
      ctx.sendJson(res, 503, { error: 'Supabase is not configured or not ready.' });
      return;
    }

    const handlers = [
      handlePublicRoutes,
      handleBillingRoutes,
      handleAuthRoutes,
      handleWorkspaceRoutes,
      handleQuoteRoutes,
    ];

    for (const handler of handlers) {
      if (await handler(req, res, url, ctx)) return;
    }

    ctx.notFound(res);
  }

  return async function requestHandler(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
      return serveStatic(req, res, url.pathname);
    } catch (error) {
      const status = error.status || 500;
      const message = status >= 500 && (IS_VERCEL || IS_PRODUCTION || process.env.NODE_ENV === 'production')
        ? 'Server error'
        : (error.message || 'Server error');
      sendJson(res, status, { error: message });
    }
  };
}

const requestHandler = createRequestHandler();

module.exports = {
  createRequestHandler,
  requestHandler,
};
