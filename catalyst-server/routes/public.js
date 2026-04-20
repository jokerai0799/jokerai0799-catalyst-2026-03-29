async function handlePublicRoutes(req, res, url, ctx) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/public-config') {
    ctx.sendJson(res, 200, {
      billing: {
        personalCheckoutLink: ctx.config.STRIPE_PERSONAL_PAYMENT_LINK || '',
        businessCheckoutLink: ctx.config.STRIPE_BUSINESS_PAYMENT_LINK || '',
        customerPortalUrl: ctx.config.STRIPE_CUSTOMER_PORTAL_URL || '',
        configured: ctx.config.BILLING_CONFIG_ERRORS.length === 0,
      },
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/app/bootstrap') {
    const store = await ctx.loadAuthenticatedStore(req, res);
    if (!store) return true;
    const user = await ctx.getSessionUser(req, store);
    if (!user) {
      ctx.unauthorized(res);
      return true;
    }
    await ctx.refreshLastSeen(store, user);
    ctx.sendJson(res, 200, ctx.buildBootstrap(store, user));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const userId = await ctx.getSessionUserId(req);
    if (!userId) {
      ctx.sendJson(res, 200, { user: null });
      return true;
    }
    const store = await ctx.loadStore({ userId });
    const user = await ctx.getSessionUser(req, store);
    await ctx.refreshLastSeen(store, user);
    ctx.sendJson(res, 200, { user: user ? ctx.sanitizeUser(user) : null });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/activity/ping') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true });
    if (!auth) return true;
    await ctx.refreshLastSeen(auth.store, auth.user);
    ctx.sendJson(res, 200, { ok: true, lastSeenAt: auth.user.lastSeenAt || new Date().toISOString() });
    return true;
  }

  return false;
}

module.exports = {
  handlePublicRoutes,
};
