const crypto = require('crypto');
const { URL } = require('url');
const {
  APP_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  RESEND_API_KEY,
  STRIPE_BUSINESS_PAYMENT_LINK,
  STRIPE_BUSINESS_PRICE_ID,
  STRIPE_CUSTOMER_PORTAL_URL,
  STRIPE_PERSONAL_PAYMENT_LINK,
  STRIPE_PERSONAL_PRICE_ID,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
} = require('./config');
const { attemptEmail, sendPasswordResetEmail, sendQuoteFollowupEmail, sendVerificationEmail } = require('./email');
const { badRequest, notFound, readJsonOrReject, sendJson, serveStatic, tooManyRequests, unauthorized } = require('./http');
const { clearSession, createSession, getSessionUser, getSessionUserId, parseCookies } = require('./session');
const { checkRateLimit } = require('./rate-limit');
const { isSupabaseReady, supabaseRequest } = require('./supabase');
const {
  ALLOWED_QUOTE_ACTIONS,
  buildBootstrap,
  buildQuoteInput,
  ensureQuoteMeta,
  findUserByEmail,
  getWorkspacePlanTier,
  isTeamFeatureUnlocked,
  isWorkspaceReadOnly,
  loadStore,
  queueStoreDelete,
  recordQuoteEvent,
  sanitizeUser,
  saveStore,
  seedWorkspace,
  withUser,
  isValidEmail,
  normalizeName,
  normalizeRole,
  withWorkspaceMeta,
} = require('./store');
const {
  addDays,
  addHours,
  clampText,
  hashPassword,
  isFutureIsoDate,
  normalizeQuoteStatus,
  today,
  uid,
  verifyPassword,
} = require('./utils');

const GOOGLE_STATE_COOKIE = 'catalyst_google_state';
const VERIFY_TOKEN_HOURS = 72;
const RESET_TOKEN_HOURS = 2;
const AUTH_RATE_LIMITS = {
  signup: { windowMs: 15 * 60 * 1000, max: 10 },
  login: { windowMs: 15 * 60 * 1000, max: 20 },
  verify: { windowMs: 15 * 60 * 1000, max: 30 },
  resendVerification: { windowMs: 15 * 60 * 1000, max: 10 },
  forgotPassword: { windowMs: 15 * 60 * 1000, max: 10 },
  resetPassword: { windowMs: 15 * 60 * 1000, max: 10 },
};

function getAppBaseUrl(req) {
  if (APP_URL) return APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function getGoogleRedirectUri(req) {
  return `${getAppBaseUrl(req)}/api/auth/google/callback`;
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  const list = Array.isArray(existing) ? existing.concat(value) : [existing, value];
  res.setHeader('Set-Cookie', list);
}

function setCookie(res, name, value, { maxAge = 300, secure = false } = {}) {
  appendSetCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

function clearCookie(res, name, { secure = false } = {}) {
  appendSetCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

async function exchangeGoogleCode(req, code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: getGoogleRedirectUri(req),
    grant_type: 'authorization_code',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || 'Google token exchange failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error?.message || 'Failed to load Google profile');
    error.status = response.status;
    throw error;
  }
  return data;
}

function ensureWorkspaceName(profile) {
  const company = clampText(profile?.hd || '', 160);
  const name = clampText(profile?.name || '', 160);
  return company || `${name || 'Google'} Workspace`;
}

function findInviteById(store, inviteId) {
  return (store.invites || []).find((invite) => invite.id === inviteId) || null;
}

function inviteForUser(store, inviteId, email) {
  const invite = findInviteById(store, inviteId);
  if (!invite) return null;
  const inviteeEmail = String(invite.inviteeEmail || '').trim().toLowerCase();
  return invite.status === 'pending' && inviteeEmail === String(email || '').trim().toLowerCase() ? invite : null;
}

function setVerificationToken(user) {
  user.verificationToken = uid('verify');
  user.verificationTokenExpiresAt = addHours(Date.now(), VERIFY_TOKEN_HOURS);
}

function setResetToken(user) {
  user.resetToken = uid('reset');
  user.resetTokenExpiresAt = addHours(Date.now(), RESET_TOKEN_HOURS);
}

function clearExpiredAuthTokens(user) {
  if (user?.verificationToken && user?.verificationTokenExpiresAt && !isFutureIsoDate(user.verificationTokenExpiresAt)) {
    delete user.verificationToken;
    user.verificationTokenExpiresAt = null;
  }
  if (user?.resetToken && user?.resetTokenExpiresAt && !isFutureIsoDate(user.resetTokenExpiresAt)) {
    delete user.resetToken;
    user.resetTokenExpiresAt = null;
  }
}

function shouldRefreshLastSeen(user) {
  if (!user) return false;
  if (!user.lastSeenAt) return true;
  const lastSeen = new Date(user.lastSeenAt);
  if (Number.isNaN(lastSeen.getTime())) return true;
  const now = new Date();
  return lastSeen.getUTCFullYear() !== now.getUTCFullYear()
    || lastSeen.getUTCMonth() !== now.getUTCMonth()
    || lastSeen.getUTCDate() !== now.getUTCDate();
}

async function refreshLastSeen(store, user) {
  if (!shouldRefreshLastSeen(user)) return false;
  user.lastSeenAt = new Date().toISOString();
  await saveStore(store);
  return true;
}

function enforceRateLimit(req, res, key) {
  const policy = AUTH_RATE_LIMITS[key];
  if (!policy) return true;
  const result = checkRateLimit(req, `auth:${key}`, policy);
  if (result.allowed) return true;
  tooManyRequests(res, 'Too many requests for that action. Please wait a few minutes and try again.');
  return false;
}

function ensureSameOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const currentOrigin = getAppBaseUrl(req);
  if (origin === currentOrigin) return true;
  sendJson(res, 403, { error: 'Origin check failed.' });
  return false;
}

function ensureWorkspaceWritable(res, workspace) {
  if (!isWorkspaceReadOnly(workspace)) return true;
  sendJson(res, 402, { error: 'Your 7 day trial has ended. This workspace is now read-only until you choose Personal or Business.' });
  return false;
}

function stripePlanTierFromPriceId(priceId) {
  if (priceId === STRIPE_BUSINESS_PRICE_ID) return 'business';
  return 'personal';
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyStripeSignature(rawBody, signatureHeader) {
  if (!STRIPE_WEBHOOK_SECRET || !signatureHeader) return false;
  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function stripeRequest(pathname) {
  if (!STRIPE_SECRET_KEY) return null;
  const response = await fetch(`https://api.stripe.com/v1${pathname}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  if (!response.ok) return null;
  return response.json();
}

async function findWorkspaceForStripeEvent(eventObject) {
  const customerId = String(eventObject?.customer || '').trim();
  if (customerId) {
    const rows = await supabaseRequest(`workspaces?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=*`);
    if (rows?.[0]) return rows[0];
  }

  const emailCandidates = [
    eventObject?.customer_details?.email,
    eventObject?.customer_email,
    eventObject?.receipt_email,
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase());

  if (!emailCandidates.length && customerId && STRIPE_SECRET_KEY) {
    const customer = await stripeRequest(`/customers/${encodeURIComponent(customerId)}`);
    if (customer?.email) emailCandidates.push(String(customer.email).trim().toLowerCase());
  }

  for (const email of emailCandidates) {
    const userRows = await supabaseRequest(`users?email=eq.${encodeURIComponent(email)}&select=workspace_id&limit=1`);
    if (userRows?.[0]?.workspace_id) {
      const workspaceRows = await supabaseRequest(`workspaces?id=eq.${encodeURIComponent(userRows[0].workspace_id)}&select=*`);
      if (workspaceRows?.[0]) return workspaceRows[0];
    }
    const workspaceRows = await supabaseRequest(`workspaces?reply_email=eq.${encodeURIComponent(email)}&select=*&limit=1`);
    if (workspaceRows?.[0]) return workspaceRows[0];
  }

  return null;
}

async function syncStripeBillingFromEvent(event) {
  const eventObject = event?.data?.object || {};
  const workspace = await findWorkspaceForStripeEvent(eventObject);
  if (!workspace) return false;

  const subscription = eventObject?.object === 'subscription'
    ? eventObject
    : (eventObject?.subscription && STRIPE_SECRET_KEY ? await stripeRequest(`/subscriptions/${encodeURIComponent(eventObject.subscription)}`) : null);

  const priceId = subscription?.items?.data?.[0]?.price?.id || eventObject?.metadata?.price_id || workspace.stripe_price_id || null;
  const billingStatus = subscription?.status || (event.type === 'checkout.session.completed' ? 'active' : workspace.billing_status || 'inactive');
  const billingCurrency = (subscription?.currency || eventObject?.currency || workspace.billing_currency || 'GBP').toUpperCase();
  const nextPeriod = subscription?.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null;
  const planTier = stripePlanTierFromPriceId(priceId || workspace.stripe_price_id || STRIPE_PERSONAL_PRICE_ID);

  await supabaseRequest(`workspaces?id=eq.${encodeURIComponent(workspace.id)}`, {
    method: 'PATCH',
    body: {
      billing_plan_tier: planTier,
      billing_status: billingStatus,
      billing_currency: billingCurrency,
      stripe_customer_id: String(subscription?.customer || eventObject?.customer || workspace.stripe_customer_id || ''),
      stripe_subscription_id: String(subscription?.id || eventObject?.subscription || workspace.stripe_subscription_id || ''),
      stripe_price_id: priceId || workspace.stripe_price_id || null,
      stripe_current_period_end: nextPeriod,
    },
    headers: { Prefer: 'return=minimal' },
  });

  return true;
}

async function loadAuthenticatedStore(req, res) {
  const userId = await getSessionUserId(req);
  if (!userId) {
    unauthorized(res);
    return null;
  }
  const requestedWorkspaceId = String(req.headers['x-workspace-id'] || '').trim();
  return loadStore({ userId, workspaceId: requestedWorkspaceId || undefined });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, storage: (await isSupabaseReady()) ? 'supabase' : 'unavailable' });
  }

  if (req.method === 'GET' && pathname === '/api/auth/google/start') {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return badRequest(res, 'Google auth is not configured yet.');
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = getGoogleRedirectUri(req);
    const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    googleUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    googleUrl.searchParams.set('redirect_uri', redirectUri);
    googleUrl.searchParams.set('response_type', 'code');
    googleUrl.searchParams.set('scope', 'openid email profile');
    googleUrl.searchParams.set('prompt', 'select_account');
    googleUrl.searchParams.set('state', state);
    setCookie(res, GOOGLE_STATE_COOKIE, state, { secure: url.protocol === 'https:' });
    res.writeHead(302, { Location: googleUrl.toString() });
    res.end();
    return;
  }

  if (!(await isSupabaseReady())) {
    return sendJson(res, 503, { error: 'Supabase is not configured or not ready.' });
  }

  if (req.method === 'GET' && pathname === '/api/public-config') {
    return sendJson(res, 200, {
      billing: {
        personalCheckoutLink: STRIPE_PERSONAL_PAYMENT_LINK || '',
        businessCheckoutLink: STRIPE_BUSINESS_PAYMENT_LINK || '',
        customerPortalUrl: STRIPE_CUSTOMER_PORTAL_URL || '',
        personalPriceId: STRIPE_PERSONAL_PRICE_ID || '',
        businessPriceId: STRIPE_BUSINESS_PRICE_ID || '',
      },
    });
  }

  if (req.method === 'POST' && pathname === '/api/stripe/webhook') {
    const rawBody = await readRawBody(req);
    if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'])) {
      return sendJson(res, 400, { error: 'Invalid Stripe signature.' });
    }
    const event = JSON.parse(rawBody.toString('utf8') || '{}');
    const handledEvents = new Set([
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
    ]);
    if (handledEvents.has(event.type)) {
      await syncStripeBillingFromEvent(event);
    }
    return sendJson(res, 200, { received: true });
  }

  if (req.method === 'GET' && pathname === '/api/app/bootstrap') {
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const user = await getSessionUser(req, store);
    if (!user) return unauthorized(res);
    await refreshLastSeen(store, user);
    return sendJson(res, 200, buildBootstrap(store, user));
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const userId = await getSessionUserId(req);
    if (!userId) return sendJson(res, 200, { user: null });
    const store = await loadStore({ userId });
    const user = await getSessionUser(req, store);
    await refreshLastSeen(store, user);
    return sendJson(res, 200, { user: user ? sanitizeUser(user) : null });
  }

  if (req.method === 'GET' && pathname === '/api/auth/google/callback') {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      res.writeHead(302, { Location: '/landing-page/login.html?google=not-configured' });
      res.end();
      return;
    }

    const cookies = parseCookies(req);
    const state = String(url.searchParams.get('state') || '');
    const code = String(url.searchParams.get('code') || '');
    const error = String(url.searchParams.get('error') || '');
    const secure = url.protocol === 'https:';

    if (error) {
      clearCookie(res, GOOGLE_STATE_COOKIE, { secure });
      res.writeHead(302, { Location: '/landing-page/login.html?google=cancelled' });
      res.end();
      return;
    }

    if (!code || !state || !cookies[GOOGLE_STATE_COOKIE] || cookies[GOOGLE_STATE_COOKIE] !== state) {
      clearCookie(res, GOOGLE_STATE_COOKIE, { secure });
      res.writeHead(302, { Location: '/landing-page/login.html?google=invalid-state' });
      res.end();
      return;
    }

    try {
      const tokenData = await exchangeGoogleCode(req, code);
      const profile = await fetchGoogleProfile(tokenData.access_token);
      const email = String(profile.email || '').trim().toLowerCase();
      if (!profile.verified_email || !isValidEmail(email)) {
        throw new Error('Google account email is missing or not verified.');
      }

      const store = await loadStore({ email });
      let user = findUserByEmail(store, email);
      if (!user) {
        const createdAt = new Date().toISOString();
        const workspace = {
          id: uid('workspace'),
          name: ensureWorkspaceName(profile),
          replyEmail: email,
          firstFollowupDays: 2,
          secondFollowupDays: 5,
          notes: withWorkspaceMeta({ createdAt }, 'Keep quote follow ups concise, direct, and easy to reply to.', { planTier: 'personal' }),
          billingPlanTier: 'personal',
          billingStatus: 'inactive',
          billingCurrency: 'GBP',
          stripeCustomerId: '',
          stripeSubscriptionId: '',
          stripePriceId: '',
          stripeCurrentPeriodEnd: null,
          createdAt,
        };
        user = {
          id: uid('user'),
          workspaceId: workspace.id,
          name: normalizeName(profile.name || email.split('@')[0]),
          email,
          passwordHash: '',
          verified: true,
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        store.workspaces.push(workspace);
        store.users.push(user);
        seedWorkspace(store, workspace, user);
        await saveStore(store);
      } else {
        user.verified = true;
        user.lastSeenAt = new Date().toISOString();
        if (!user.name && profile.name) user.name = normalizeName(profile.name);
        await saveStore(store);
      }

      await createSession(res, user.id);
      clearCookie(res, GOOGLE_STATE_COOKIE, { secure });
      res.writeHead(302, { Location: '/dashboard/dashboard.html' });
      res.end();
      return;
    } catch {
      clearCookie(res, GOOGLE_STATE_COOKIE, { secure });
      res.writeHead(302, { Location: '/landing-page/login.html?google=failed' });
      res.end();
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/signup') {
    if (!enforceRateLimit(req, res, 'signup')) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const name = normalizeName(body.name);
    const company = clampText(body.company, 160);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const planTier = String(body.plan || 'personal').trim().toLowerCase() === 'business' ? 'business' : 'personal';
    if (!name || !company || !email || !password) return badRequest(res, 'Fill in all fields to create your workspace.');
    if (!isValidEmail(email)) return badRequest(res, 'Use a valid email address.');
    if (password.length < 8) return badRequest(res, 'Use at least 8 characters for your password.');
    const store = await loadStore({ email });
    if (findUserByEmail(store, email)) return badRequest(res, 'An account with this email already exists.');

    const createdAt = new Date().toISOString();
    const workspace = {
      id: uid('workspace'),
      name: company,
      replyEmail: email,
      firstFollowupDays: 2,
      secondFollowupDays: 5,
      notes: withWorkspaceMeta({ createdAt }, 'Keep quote follow ups concise, direct, and easy to reply to.', { planTier }),
      billingPlanTier: planTier,
      billingStatus: 'inactive',
      billingCurrency: 'GBP',
      stripeCustomerId: '',
      stripeSubscriptionId: '',
      stripePriceId: '',
      stripeCurrentPeriodEnd: null,
      createdAt,
    };
    const user = {
      id: uid('user'),
      workspaceId: workspace.id,
      name,
      email,
      passwordHash: hashPassword(password),
      verified: false,
      verificationToken: '',
      verificationTokenExpiresAt: null,
      resetToken: '',
      resetTokenExpiresAt: null,
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    setVerificationToken(user);
    store.workspaces.push(workspace);
    store.users.push(user);
    seedWorkspace(store, workspace, user);
    await saveStore(store);
    const delivery = await attemptEmail(() => sendVerificationEmail(req, user));
    return sendJson(res, 201, {
      ok: true,
      email,
      emailSent: Boolean(delivery.sent),
      verifyUrl: delivery.sent ? null : `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}`,
    });
  }

  if (req.method === 'GET' && pathname === '/api/auth/check-email') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    if (!isValidEmail(email)) return sendJson(res, 200, { email, exists: false, verified: false, verifyUrl: '/landing-page/login.html?verified=invalid' });
    const store = await loadStore({ email });
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, { email, exists: false, verified: false, verifyUrl: '/landing-page/login.html?verified=invalid' });
    clearExpiredAuthTokens(user);
    return sendJson(res, 200, {
      email,
      exists: true,
      verified: Boolean(user.verified),
      emailDeliveryAvailable: Boolean(RESEND_API_KEY),
      verifyUrl: !RESEND_API_KEY && user.verificationToken ? `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}` : null,
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/resend-verification') {
    if (!enforceRateLimit(req, res, 'resendVerification')) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const email = String(body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return badRequest(res, 'Enter a valid email address.');
    const store = await loadStore({ email });
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, { ok: true, sent: false, emailDeliveryAvailable: Boolean(RESEND_API_KEY) });
    clearExpiredAuthTokens(user);
    if (user.verified) return sendJson(res, 200, { ok: true, sent: false, verified: true, emailDeliveryAvailable: Boolean(RESEND_API_KEY) });
    if (!user.verificationToken) setVerificationToken(user);
    await saveStore(store);
    const delivery = await attemptEmail(() => sendVerificationEmail(req, user));
    return sendJson(res, 200, {
      ok: true,
      sent: Boolean(delivery.sent),
      verified: false,
      emailDeliveryAvailable: Boolean(RESEND_API_KEY),
      verifyUrl: delivery.sent ? null : `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}`,
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (!enforceRateLimit(req, res, 'login')) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!isValidEmail(email)) return badRequest(res, 'Invalid email or password.');
    const store = await loadStore({ email });
    const user = findUserByEmail(store, email);
    if (!user) return badRequest(res, 'Invalid email or password.');
    if (!user.passwordHash) return badRequest(res, 'Use Google sign-in for this account.');
    if (!verifyPassword(password, user.passwordHash)) return badRequest(res, 'Invalid email or password.');
    if (!user.verified) return badRequest(res, 'Check your email page and verify your account before logging in.');
    user.lastSeenAt = new Date().toISOString();
    await saveStore(store);
    await createSession(res, user.id);
    return sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    if (!ensureSameOrigin(req, res)) return;
    await clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/auth/verify') {
    if (!enforceRateLimit(req, res, 'verify')) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const token = String(body.token || '').trim();
    const store = await loadStore({ verificationToken: token });
    const user = store.users.find((item) => item.verificationToken === token);
    const tokenValid = user && (!user.verificationTokenExpiresAt || isFutureIsoDate(user.verificationTokenExpiresAt));
    if (!tokenValid) return badRequest(res, 'That verification link is invalid or expired.');
    user.verified = true;
    delete user.verificationToken;
    user.verificationTokenExpiresAt = null;
    await saveStore(store);
    return sendJson(res, 200, { ok: true, email: user.email });
  }

  if (req.method === 'POST' && pathname === '/api/auth/forgot-password') {
    if (!enforceRateLimit(req, res, 'forgotPassword')) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const email = String(body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return badRequest(res, 'Enter a valid email address.');
    const store = await loadStore({ email });
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, { ok: true, sent: false, emailDeliveryAvailable: Boolean(RESEND_API_KEY) });
    clearExpiredAuthTokens(user);
    setResetToken(user);
    await saveStore(store);
    const delivery = await attemptEmail(() => sendPasswordResetEmail(req, user));
    return sendJson(res, 200, {
      ok: true,
      sent: Boolean(delivery.sent),
      emailDeliveryAvailable: Boolean(RESEND_API_KEY),
      resetUrl: delivery.sent ? null : `/landing-page/reset-password.html?token=${encodeURIComponent(user.resetToken)}`,
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    if (!enforceRateLimit(req, res, 'resetPassword')) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const token = String(body.token || '').trim();
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');
    const store = await loadStore({ resetToken: token });
    const user = store.users.find((item) => item.resetToken === token);
    const tokenValid = user && (!user.resetTokenExpiresAt || isFutureIsoDate(user.resetTokenExpiresAt));
    if (!tokenValid) return badRequest(res, 'That reset link is invalid or expired.');
    if (password.length < 8) return badRequest(res, 'Use at least 8 characters for your new password.');
    if (password !== confirmPassword) return badRequest(res, 'Passwords do not match.');
    user.passwordHash = hashPassword(password);
    delete user.resetToken;
    user.resetTokenExpiresAt = null;
    await saveStore(store);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/workspace/select') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const workspaceId = String(body.workspaceId || '').trim();
    const allowed = new Set((store.accessibleWorkspaces || []).map((workspaceAccess) => workspaceAccess.id));
    if (!allowed.has(workspaceId)) return badRequest(res, 'You do not have access to that workspace.');
    return sendJson(res, 200, { ok: true, workspaceId });
  }

  if (req.method === 'POST' && pathname === '/api/billing/portal-session') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const currentWorkspaceAccess = (store.accessibleWorkspaces || []).find((workspaceAccess) => workspaceAccess.id === auth.workspace.id);
    if (currentWorkspaceAccess && currentWorkspaceAccess.role !== 'Owner') return unauthorized(res);
    const billing = auth.workspace || {};
    if (!billing.stripeCustomerId || !STRIPE_SECRET_KEY) {
      return sendJson(res, 400, { error: 'No active billing profile is available for this workspace yet.' });
    }

    const body = new URLSearchParams({
      customer: billing.stripeCustomerId,
      return_url: `${getAppBaseUrl(req)}/dashboard/dashboard.html#settings`,
    });

    const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    const data = await response.json();
    if (!response.ok || !data?.url) {
      return sendJson(res, 502, { error: 'Could not create a Stripe billing portal session right now.' });
    }

    return sendJson(res, 200, { url: data.url });
  }

  if (req.method === 'PATCH' && pathname === '/api/workspace') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const currentWorkspaceAccess = (store.accessibleWorkspaces || []).find((workspaceAccess) => workspaceAccess.id === auth.workspace.id);
    if (currentWorkspaceAccess && currentWorkspaceAccess.role !== 'Owner') return unauthorized(res);
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    if (!ensureWorkspaceWritable(res, auth.workspace)) return;
    auth.workspace.name = clampText(body.name, 160) || auth.workspace.name;
    const replyEmail = String(body.replyEmail || '').trim().toLowerCase();
    auth.workspace.replyEmail = isValidEmail(replyEmail) ? replyEmail : (auth.workspace.replyEmail || auth.user.email);
    auth.workspace.firstFollowupDays = Math.max(1, Number(body.firstFollowupDays || auth.workspace.firstFollowupDays || 2));
    auth.workspace.secondFollowupDays = Math.max(1, Number(body.secondFollowupDays || auth.workspace.secondFollowupDays || 5));
    auth.workspace.notes = withWorkspaceMeta(auth.workspace, body.notes, { planTier: getWorkspacePlanTier(auth.workspace) });
    await saveStore(store);
    return sendJson(res, 200, { ok: true, workspace: auth.workspace });
  }

  if (req.method === 'POST' && pathname === '/api/team') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    if (!ensureWorkspaceWritable(res, auth.workspace)) return;
    if (!isTeamFeatureUnlocked(auth.workspace)) {
      return badRequest(res, 'Team collaboration is available only inside an active Business workspace.');
    }
    const currentMember = store.teamMembers.find((member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === auth.user.email.toLowerCase());
    if (!currentMember || currentMember.role !== 'Owner') return unauthorized(res);
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const name = normalizeName(body.name);
    const email = String(body.email || '').trim().toLowerCase();
    const role = normalizeRole(body.role);
    if (!name || !email) return badRequest(res, 'Name and email are required.');
    if (!isValidEmail(email)) return badRequest(res, 'Use a valid email address.');
    if (store.teamMembers.some((member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === email)) {
      return badRequest(res, 'A team member with that email already exists.');
    }
    const existingPendingInvite = (store.invites || []).find(
      (invite) => invite.workspaceId === auth.workspace.id && invite.status === 'pending' && String(invite.inviteeEmail || '').trim().toLowerCase() === email,
    );
    const existingUserStore = await loadStore({ email });
    const existingUser = findUserByEmail(existingUserStore, email);
    if (existingPendingInvite && !existingUser) {
      return badRequest(res, 'There is already a pending invite for that email.');
    }
    if (!existingUser) {
      return sendJson(res, 200, {
        ok: false,
        needsAccount: true,
        message: 'That member needs an account before they can join this workspace.',
      });
    }
    const existingMembership = existingUserStore.teamMembers.some(
      (member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === email,
    ) || store.teamMembers.some((member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === email);
    if (existingPendingInvite) {
      store.invites = (store.invites || []).filter((invite) => invite.id !== existingPendingInvite.id);
      queueStoreDelete(store, 'workspace_invites', existingPendingInvite.id);
    }
    if (!existingMembership) {
      store.teamMembers.push({
        id: uid('team'),
        workspaceId: auth.workspace.id,
        name,
        email,
        role,
        activeQuotes: 0,
        createdAt: new Date().toISOString(),
      });
    }
    await saveStore(store);
    return sendJson(res, 201, {
      ok: true,
      joined: true,
      member: {
        name,
        email,
        role,
      },
    });
  }

  const inviteAcceptMatch = pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
  if (inviteAcceptMatch && req.method === 'POST') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const invite = inviteForUser(store, inviteAcceptMatch[1], auth.user.email);
    if (!invite) return notFound(res);
    if (auth.user.workspaceId !== invite.workspaceId) {
      return badRequest(res, 'You have a workspace invite waiting, but joining another workspace is not live yet.');
    }
    const alreadyMember = store.teamMembers.some(
      (member) => member.workspaceId === invite.workspaceId && member.email.toLowerCase() === auth.user.email.toLowerCase(),
    );
    if (!alreadyMember) {
      store.teamMembers.push({
        id: uid('team'),
        workspaceId: invite.workspaceId,
        name: normalizeName(auth.user.name || invite.inviteeName || auth.user.email.split('@')[0]),
        email: auth.user.email,
        role: normalizeRole(invite.role),
        activeQuotes: 0,
        createdAt: new Date().toISOString(),
      });
    }
    invite.status = 'accepted';
    invite.respondedAt = new Date().toISOString();
    await saveStore(store);
    return sendJson(res, 200, { ok: true, invite });
  }

  const inviteDeclineMatch = pathname.match(/^\/api\/invites\/([^/]+)\/decline$/);
  if (inviteDeclineMatch && req.method === 'POST') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const invite = inviteForUser(store, inviteDeclineMatch[1], auth.user.email);
    if (!invite) return notFound(res);
    invite.status = 'declined';
    invite.respondedAt = new Date().toISOString();
    await saveStore(store);
    return sendJson(res, 200, { ok: true, invite });
  }

  const teamMatch = pathname.match(/^\/api\/team\/([^/]+)$/);
  if (teamMatch && req.method === 'DELETE') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    if (!ensureWorkspaceWritable(res, auth.workspace)) return;
    if (!isTeamFeatureUnlocked(auth.workspace)) {
      return badRequest(res, 'Team collaboration is available only inside an active Business workspace.');
    }
    const currentMember = store.teamMembers.find((member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === auth.user.email.toLowerCase());
    if (!currentMember || currentMember.role !== 'Owner') return unauthorized(res);

    const target = store.teamMembers.find((member) => member.id === teamMatch[1] && member.workspaceId === auth.workspace.id);
    if (!target) return notFound(res);

    const ownerMembers = store.teamMembers.filter((member) => member.workspaceId === auth.workspace.id && member.role === 'Owner');
    if (target.email.toLowerCase() === auth.user.email.toLowerCase() && ownerMembers.length <= 1) {
      return badRequest(res, 'You cannot remove the last owner from the workspace.');
    }

    const replacementOwner = currentMember.name === target.name
      ? ownerMembers.find((member) => member.id !== target.id)?.name || auth.user.name
      : currentMember.name;

    store.teamMembers = store.teamMembers.filter((member) => member.id !== target.id);
    queueStoreDelete(store, 'team_members', target.id);
    store.quotes.forEach((quote) => {
      if (quote.workspaceId === auth.workspace.id && quote.owner === target.name) {
        quote.owner = replacementOwner;
        recordQuoteEvent(quote, 'Quote reassigned', `Ownership moved from ${target.name} to ${replacementOwner}.`);
      }
    });
    await saveStore(store);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/quotes') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    if (!ensureWorkspaceWritable(res, auth.workspace)) return;
    const { title, customer, customerEmail, owner, status, value, sentDate, nextFollowUp, notes } = buildQuoteInput(body, auth, store);
    if (!title || !value) return badRequest(res, 'Add at least a title and value before saving.');
    const quote = {
      id: uid('quote'),
      workspaceId: auth.workspace.id,
      title,
      customer,
      customerEmail,
      owner,
      status,
      value,
      sentDate,
      nextFollowUp,
      notes,
      createdAt: new Date().toISOString(),
      archived: false,
      history: [],
    };
    recordQuoteEvent(quote, 'Quote created', `Added with status ${status} and value £${Number(value).toFixed(0)}.`);
    store.quotes.unshift(quote);
    await saveStore(store);
    return sendJson(res, 201, { ok: true, quote });
  }

  const quoteMatch = pathname.match(/^\/api\/quotes\/([^/]+)$/);
  if (quoteMatch && req.method === 'PATCH') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const quote = store.quotes.find((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (!quote) return notFound(res);
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    if (!ensureWorkspaceWritable(res, auth.workspace)) return;
    const { title, customer, customerEmail, owner, status, value, sentDate, nextFollowUp, notes } = buildQuoteInput(body, auth, store, quote);
    if (!title || !value) return badRequest(res, 'Add at least a title and value before saving.');
    quote.title = title;
    quote.customer = customer;
    quote.customerEmail = customerEmail;
    quote.owner = owner;
    quote.status = status;
    quote.value = value;
    quote.sentDate = sentDate;
    quote.nextFollowUp = nextFollowUp;
    quote.notes = notes;
    quote.archived = quote.status === 'Archived' ? true : Boolean(quote.archived);
    recordQuoteEvent(quote, 'Quote updated', `Status ${quote.status} · follow up ${quote.nextFollowUp}`);
    await saveStore(store);
    return sendJson(res, 200, { ok: true, quote });
  }

  if (quoteMatch && req.method === 'DELETE') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    if (!ensureWorkspaceWritable(res, auth.workspace)) return;
    const index = store.quotes.findIndex((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (index === -1) return notFound(res);
    const [deletedQuote] = store.quotes.splice(index, 1);
    queueStoreDelete(store, 'quotes', deletedQuote?.id);
    await saveStore(store);
    return sendJson(res, 200, { ok: true });
  }

  const quoteEmailMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/send-email$/);
  if (quoteEmailMatch && req.method === 'POST') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    if (!ensureWorkspaceWritable(res, auth.workspace)) return;
    const quote = store.quotes.find((item) => item.id === quoteEmailMatch[1] && item.workspaceId === auth.workspace.id);
    if (!quote) return notFound(res);
    ensureQuoteMeta(quote);
    if (!quote.customerEmail) return badRequest(res, 'Add a customer email to this quote first.');
    const delivery = await attemptEmail(() => sendQuoteFollowupEmail(req, { quote, workspace: auth.workspace, sender: auth.user }));
    if (!delivery.sent) {
      const errorMessage = delivery.provider === 'none'
        ? 'Email sending is not configured yet for this workspace.'
        : (delivery.error || 'Follow-up email could not be sent.');
      return sendJson(res, 503, { error: errorMessage, delivery });
    }
    quote.archived = false;
    if (!['Won', 'Lost', 'Archived', 'Replied'].includes(quote.status)) quote.status = 'Sent';
    quote.nextFollowUp = addDays(today(), auth.workspace.secondFollowupDays || auth.workspace.firstFollowupDays || 2);
    recordQuoteEvent(quote, 'Follow-up email sent', `Sent to ${quote.customerEmail} and queued next follow up for ${quote.nextFollowUp}.`);
    await saveStore(store);
    return sendJson(res, 200, { ok: true, quote, delivery });
  }

  const quoteActionMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/actions$/);
  if (quoteActionMatch && req.method === 'POST') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    if (!ensureWorkspaceWritable(res, auth.workspace)) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const action = String(body.action || '').trim();
    if (!ALLOWED_QUOTE_ACTIONS.has(action)) return badRequest(res, 'Unknown action.');
    const quote = store.quotes.find((item) => item.id === quoteActionMatch[1] && item.workspaceId === auth.workspace.id);
    if (!quote) return notFound(res);
    ensureQuoteMeta(quote);
    if (action === 'archive') {
      quote.archived = true;
      quote.status = 'Archived';
      recordQuoteEvent(quote, 'Quote archived', 'Removed from active pipeline but kept for reference.');
    } else if (action === 'mark-contacted') {
      quote.archived = false;
      quote.status = 'Replied';
      quote.nextFollowUp = addDays(today(), auth.workspace.firstFollowupDays || 2);
      recordQuoteEvent(quote, 'Quote marked replied', 'Status updated from the editor.');
    } else if (action === 'mark-won') {
      quote.archived = false;
      quote.status = 'Won';
      recordQuoteEvent(quote, 'Quote marked won', 'Status updated from the editor.');
    } else if (action === 'mark-lost') {
      quote.archived = false;
      quote.status = 'Lost';
      recordQuoteEvent(quote, 'Quote marked lost', 'Status updated from the editor.');
    } else if (action === 'contacted') {
      quote.archived = false;
      quote.status = 'Replied';
      quote.nextFollowUp = addDays(today(), auth.workspace.secondFollowupDays || auth.workspace.firstFollowupDays || 2);
      recordQuoteEvent(quote, 'Customer contacted', `Moved to replied and scheduled next follow up for ${quote.nextFollowUp}.`);
    } else if (action === 'reschedule') {
      quote.archived = false;
      if (quote.status === 'Won' || quote.status === 'Lost') quote.status = normalizeQuoteStatus('Follow up due');
      quote.nextFollowUp = addDays(today(), 1);
      recordQuoteEvent(quote, 'Follow up rescheduled', `Moved to ${quote.nextFollowUp} from the chase list.`);
    } else if (action === 'done-today') {
      quote.archived = false;
      quote.nextFollowUp = addDays(today(), 1);
      recordQuoteEvent(quote, 'Cleared from today', 'Removed from the current chase queue and pushed to tomorrow.');
    } else {
      return badRequest(res, 'Unknown action.');
    }
    await saveStore(store);
    return sendJson(res, 200, { ok: true, quote });
  }

  return notFound(res);
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || 'Server error' });
  }
}

module.exports = { requestHandler };
