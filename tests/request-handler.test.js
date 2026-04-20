const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequestHandler } = require('../catalyst-server/app');
const { hashPassword } = require('../catalyst-server/utils');

async function withServer(overrides, run) {
  const server = http.createServer(createRequestHandler(overrides));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('public-config exposes billing links without Stripe price ids', async () => {
  await withServer({
    isSupabaseReady: async () => true,
    config: {
      STRIPE_PERSONAL_PAYMENT_LINK: 'https://example.com/personal',
      STRIPE_BUSINESS_PAYMENT_LINK: 'https://example.com/business',
      STRIPE_CUSTOMER_PORTAL_URL: 'https://example.com/portal',
      BILLING_CONFIG_ERRORS: [],
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/public-config`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data, {
      billing: {
        personalCheckoutLink: 'https://example.com/personal',
        businessCheckoutLink: 'https://example.com/business',
        customerPortalUrl: 'https://example.com/portal',
        configured: true,
      },
    });
    assert.equal('personalPriceId' in data.billing, false);
    assert.equal('businessPriceId' in data.billing, false);
  });
});

test('project metrics require the configured token', async () => {
  await withServer({
    config: { PROJECT_METRICS_TOKEN: 'secret-token' },
    helpers: {
      getProjectMetrics: async () => ({ ok: true, project: 'catalyst' }),
    },
  }, async (baseUrl) => {
    const hiddenResponse = await fetch(`${baseUrl}/api/project-metrics`);
    assert.equal(hiddenResponse.status, 404);

    const allowedResponse = await fetch(`${baseUrl}/api/project-metrics`, {
      headers: { 'x-project-metrics-token': 'secret-token' },
    });
    assert.equal(allowedResponse.status, 200);
    assert.deepEqual(await allowedResponse.json(), { ok: true, project: 'catalyst' });
  });
});

test('check-email stays generic for existing accounts', async () => {
  const store = {
    users: [{
      id: 'user_1',
      email: 'person@example.com',
      verified: false,
      verificationToken: 'verify_token',
      verificationTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }],
    workspaces: [],
    teamMembers: [],
    quotes: [],
    invites: [],
  };

  await withServer({
    isSupabaseReady: async () => true,
    config: { RESEND_API_KEY: '', IS_PRODUCTION: true },
    loadStore: async () => store,
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/check-email?email=person%40example.com`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.email, 'person@example.com');
    assert.equal(data.emailDeliveryAvailable, false);
    assert.equal(data.verifyUrl, null);
    assert.equal('exists' in data, false);
    assert.equal('verified' in data, false);
  });
});

test('login failures return the generic error message', async () => {
  const store = {
    users: [{
      id: 'user_1',
      email: 'person@example.com',
      passwordHash: hashPassword('correct horse battery staple'),
      verified: true,
    }],
    workspaces: [],
    teamMembers: [],
    quotes: [],
    invites: [],
  };

  await withServer({
    isSupabaseReady: async () => true,
    loadStore: async () => store,
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', password: 'wrong password' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'We could not sign you in with those details.',
    });
  });
});

test('successful login returns the sanitized user payload', async () => {
  const store = {
    users: [{
      id: 'user_1',
      email: 'person@example.com',
      name: 'Person',
      passwordHash: hashPassword('correct horse battery staple'),
      verified: true,
    }],
    workspaces: [],
    teamMembers: [],
    quotes: [],
    invites: [],
  };

  await withServer({
    isSupabaseReady: async () => true,
    loadStore: async () => store,
    saveChanges: async () => {},
    sanitizeUser: (user) => ({ id: user.id, email: user.email, name: user.name }),
    createSession: async (_req, res) => {
      res.setHeader('Set-Cookie', 'catalyst_sid=test-session; Path=/; HttpOnly');
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', password: 'correct horse battery staple' }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data, {
      ok: true,
      user: { id: 'user_1', email: 'person@example.com', name: 'Person' },
    });
    assert.match(response.headers.get('set-cookie') || '', /catalyst_sid=test-session/);
  });
});
