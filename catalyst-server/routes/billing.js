async function handleBillingRoutes(req, res, url, ctx) {
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/stripe/webhook') {
    const rawBody = await ctx.readRawBody(req);
    if (!ctx.verifyStripeSignature(rawBody, req.headers['stripe-signature'])) {
      ctx.sendJson(res, 400, { error: 'Invalid Stripe signature.' });
      return true;
    }
    const event = JSON.parse(rawBody.toString('utf8') || '{}');
    const firstSeen = await ctx.recordStripeWebhookEvent(event);
    if (!firstSeen) {
      ctx.sendJson(res, 200, { received: true, duplicate: true });
      return true;
    }
    const handledEvents = new Set([
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]);
    if (handledEvents.has(event.type)) {
      await ctx.syncStripeBillingFromEvent(event);
    }
    ctx.sendJson(res, 200, { received: true });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/billing/portal-session') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true, ownerOnly: true });
    if (!auth) return true;
    const billing = auth.workspace || {};
    if (!billing.stripeCustomerId || !ctx.config.STRIPE_SECRET_KEY) {
      ctx.sendJson(res, 400, { error: 'No active billing profile is available for this workspace yet.' });
      return true;
    }

    const body = new URLSearchParams({
      customer: billing.stripeCustomerId,
      return_url: `${ctx.getAppBaseUrl(req)}/dashboard/dashboard.html#settings`,
    });

    const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.config.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const data = await response.json();
    if (!response.ok || !data?.url) {
      ctx.sendJson(res, 502, { error: 'Could not create a Stripe billing portal session right now.' });
      return true;
    }

    ctx.sendJson(res, 200, { url: data.url });
    return true;
  }

  return false;
}

module.exports = {
  handleBillingRoutes,
};
