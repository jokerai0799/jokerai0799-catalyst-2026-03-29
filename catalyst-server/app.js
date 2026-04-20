const crypto = require('crypto');
const { URL } = require('url');
const {
  APP_URL,
  BILLING_CONFIG_ERRORS,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  IS_PRODUCTION,
  IS_VERCEL,
  PROJECT_METRICS_TOKEN,
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
const { clearSession, createSession, getSessionUser, getSessionUserId, parseCookies, requestIsSecure } = require('./session');
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
  quoteOwnedByMember,
  recordQuoteEvent,
  sanitizeUser,
  saveChanges,
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
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;
const LIVE_USERS_WINDOW_MS = 15 * 60 * 1000;
const PROJECT_METRICS_CACHE_MS = 30 * 1000;
const BUSINESS_TEAM_MEMBER_LIMIT = 20;
const AUTH_RATE_LIMITS = {
  signup: { windowMs: 15 * 60 * 1000, max: 10 },
  checkEmail: { windowMs: 15 * 60 * 1000, max: 20 },
  login: { windowMs: 15 * 60 * 1000, max: 20 },
  verify: { windowMs: 15 * 60 * 1000, max: 30 },
  resendVerification: { windowMs: 15 * 60 * 1000, max: 10 },
  forgotPassword: { windowMs: 15 * 60 * 1000, max: 10 },
  resetPassword: { windowMs: 15 * 60 * 1000, max: 10 },
};
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
let projectMetricsCache = null;
let projectMetricsCachedAt = 0;

const GENERIC_LOGIN_ERROR = 'We could not sign you in with those details.';

function getAppBaseUrl(req) {
  if (APP_URL) return APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function safeTokenMatch(expected, actual) {
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
  if (!expectedBuffer.length || expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function getProjectMetricsToken(req) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
  return String(req.headers['x-project-metrics-token'] || bearer || '').trim();
}

function canReadProjectMetrics(req) {
  if (PROJECT_METRICS_TOKEN) return safeTokenMatch(PROJECT_METRICS_TOKEN, getProjectMetricsToken(req));
  return !IS_VERCEL;
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

function shouldExposeDirectAuthLinks() {
  return !IS_PRODUCTION;
}

function setCookie(res, name, value, { maxAge = 300, secure = false, path = '/', sameSite = 'Lax' } = {}) {
  appendSetCookie(res, `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}; Priority=High${secure ? '; Secure' : ''}`);
}

function clearCookie(res, name, { secure = false, path = '/', sameSite = 'Lax' } = {}) {
  appendSetCookie(res, `${name}=; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=0; Priority=High${secure ? '; Secure' : ''}`);
}

function getGenericCheckEmailResponse(email) {
  return {
    email,
    emailDeliveryAvailable: Boolean(RESEND_API_KEY),
    verifyUrl: null,
  };
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

function shouldRefreshLastSeen(user, maxAgeMs = LAST_SEEN_REFRESH_MS) {
  if (!user) return false;
  if (!user.lastSeenAt) return true;
  const lastSeen = new Date(user.lastSeenAt);
  if (Number.isNaN(lastSeen.getTime())) return true;
  return Date.now() - lastSeen.getTime() >= maxAgeMs;
}

async function refreshLastSeen(store, user) {
  if (!shouldRefreshLastSeen(user)) return false;
  user.lastSeenAt = new Date().toISOString();
  await saveChanges({ users: [user] });
  return true;
}

function startOfUtcDayIso() {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

async function buildProjectMetrics() {
  const generatedAt = new Date().toISOString();
  const storageReady = await isSupabaseReady();

  if (!storageReady) {
    return {
      ok: false,
      project: 'catalyst',
      health: 'degraded',
      liveUsers: 0,
      signupsToday: 0,
      storage: 'unavailable',
      liveWindowMinutes: Math.round(LIVE_USERS_WINDOW_MS / 60000),
      generatedAt,
    };
  }

  const liveSinceIso = new Date(Date.now() - LIVE_USERS_WINDOW_MS).toISOString();
  const signupsSinceIso = startOfUtcDayIso();

  const [liveUsersRows, signupsTodayRows] = await Promise.all([
    supabaseRequest(`users?select=id&last_seen_at=gte.${encodeURIComponent(liveSinceIso)}`),
    supabaseRequest(`users?select=id&created_at=gte.${encodeURIComponent(signupsSinceIso)}`),
  ]);

  return {
    ok: true,
    project: 'catalyst',
    health: 'ok',
    liveUsers: Array.isArray(liveUsersRows) ? liveUsersRows.length : 0,
    signupsToday: Array.isArray(signupsTodayRows) ? signupsTodayRows.length : 0,
    storage: 'supabase',
    liveWindowMinutes: Math.round(LIVE_USERS_WINDOW_MS / 60000),
    generatedAt,
  };
}

async function getProjectMetrics() {
  const now = Date.now();
  if (projectMetricsCache && now - projectMetricsCachedAt < PROJECT_METRICS_CACHE_MS) {
    return projectMetricsCache;
  }
  projectMetricsCache = await buildProjectMetrics();
  projectMetricsCachedAt = now;
  return projectMetricsCache;
}

async function enforceRateLimit(req, res, key) {
  const policy = AUTH_RATE_LIMITS[key];
  if (!policy) return true;
  const result = await checkRateLimit(req, `auth:${key}`, policy);
  if (result.allowed) return true;
  if (result.resetAt) {
    const retryAfterSeconds = Math.max(1, Math.ceil((new Date(result.resetAt).getTime() - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
  }
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

function getWorkspaceMemberCount(store, workspaceId) {
  return store.teamMembers.filter((member) => member.workspaceId === workspaceId).length;
}

function stripePlanTierFromPriceId(priceId) {
  if (!priceId) return null;
  if (STRIPE_PERSONAL_PRICE_ID && priceId === STRIPE_PERSONAL_PRICE_ID) return 'personal';
  if (STRIPE_BUSINESS_PRICE_ID && priceId === STRIPE_BUSINESS_PRICE_ID) return 'business';
  return null;
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
  const timestamp = Number(parts.t || 0);
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (ageSeconds > STRIPE_WEBHOOK_TOLERANCE_SECONDS) return false;
  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

async function recordStripeWebhookEvent(event) {
  if (!event?.id) return true;
  try {
    await supabaseRequest('stripe_webhook_events', {
      method: 'POST',
      body: [{
        id: event.id,
        type: event.type || 'unknown',
        created_at: event.created ? new Date(Number(event.created) * 1000).toISOString() : new Date().toISOString(),
        processed_at: new Date().toISOString(),
      }],
      headers: { Prefer: 'return=minimal' },
      allow404: true,
    });
    return true;
  } catch (error) {
    if (error?.status === 409 || String(error?.body || '').includes('duplicate key')) return false;
    if (error?.status === 404 || String(error?.body || '').includes('stripe_webhook_events')) return true;
    throw error;
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
    const billingRows = await supabaseRequest(`workspace_billing?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=workspace_id`, { allow404: true });
    if (billingRows?.[0]?.workspace_id) {
      const workspaceRows = await supabaseRequest(`workspaces?id=eq.${encodeURIComponent(billingRows[0].workspace_id)}&select=*`);
      if (workspaceRows?.[0]) return workspaceRows[0];
    }
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
  const knownPlanTier = stripePlanTierFromPriceId(priceId || workspace.stripe_price_id || null);
  const requiresPlanResolution = Boolean(priceId || event.type === 'checkout.session.completed' || subscription);
  if (requiresPlanResolution && BILLING_CONFIG_ERRORS.length) {
    throw new Error(`Stripe billing is misconfigured: ${BILLING_CONFIG_ERRORS.join(' ')}`);
  }
  if (requiresPlanResolution && priceId && !knownPlanTier) {
    throw new Error(`Stripe price ${priceId} does not match the configured Personal or Business price ids.`);
  }
  const planTier = knownPlanTier || workspace.billing_plan_tier || 'personal';

  const billingPayload = {
    workspace_id: workspace.id,
    billing_plan_tier: planTier,
    billing_status: billingStatus,
    billing_currency: billingCurrency,
    stripe_customer_id: String(subscription?.customer || eventObject?.customer || workspace.stripe_customer_id || ''),
    stripe_subscription_id: String(subscription?.id || eventObject?.subscription || workspace.stripe_subscription_id || ''),
    stripe_price_id: priceId || workspace.stripe_price_id || null,
    stripe_current_period_end: nextPeriod,
    created_at: workspace.created_at || new Date().toISOString(),
  };

  await supabaseRequest('workspace_billing', {
    method: 'POST',
    body: [billingPayload],
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    allow404: true,
  });

  await supabaseRequest(`workspaces?id=eq.${encodeURIComponent(workspace.id)}`, {
    method: 'PATCH',
    body: {
      billing_plan_tier: billingPayload.billing_plan_tier,
      billing_status: billingPayload.billing_status,
      billing_currency: billingPayload.billing_currency,
      stripe_customer_id: billingPayload.stripe_customer_id,
      stripe_subscription_id: billingPayload.stripe_subscription_id,
      stripe_price_id: billingPayload.stripe_price_id,
      stripe_current_period_end: billingPayload.stripe_current_period_end,
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

  if (req.method === 'GET' && pathname === '/api/project-metrics') {
    if (!canReadProjectMetrics(req)) return notFound(res);
    return sendJson(res, 200, await getProjectMetrics());
  }

  if (req.method === 'GET' && pathname === '/api/auth/google/start') {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return badRequest(res, 'Google auth is not configured yet.');
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = getGoogleRedirectUri(req);
    const secure = requestIsSecure(req);
    const googleUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    googleUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    googleUrl.searchParams.set('redirect_uri', redirectUri);
    googleUrl.searchParams.set('response_type', 'code');
    googleUrl.searchParams.set('scope', 'openid email profile');
    googleUrl.searchParams.set('prompt', 'select_account');
    googleUrl.searchParams.set('state', state);
    setCookie(res, GOOGLE_STATE_COOKIE, state, { secure, path: '/api/auth/google' });
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
        configured: BILLING_CONFIG_ERRORS.length === 0,
      },
    });
  }

  if (req.method === 'POST' && pathname === '/api/stripe/webhook') {
    const rawBody = await readRawBody(req);
    if (!verifyStripeSignature(rawBody, req.headers['stripe-signature'])) {
      return sendJson(res, 400, { error: 'Invalid Stripe signature.' });
    }
    const event = JSON.parse(rawBody.toString('utf8') || '{}');
    const firstSeen = await recordStripeWebhookEvent(event);
    if (!firstSeen) return sendJson(res, 200, { received: true, duplicate: true });
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

  if (req.method === 'POST' && pathname === '/api/activity/ping') {
    if (!ensureSameOrigin(req, res)) return;
    const store = await loadAuthenticatedStore(req, res);
    if (!store) return;
    const user = await getSessionUser(req, store);
    if (!user) return unauthorized(res);
    await refreshLastSeen(store, user);
    return sendJson(res, 200, { ok: true, lastSeenAt: user.lastSeenAt || new Date().toISOString() });
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
    const secure = requestIsSecure(req);

    if (error) {
      clearCookie(res, GOOGLE_STATE_COOKIE, { secure, path: '/api/auth/google' });
      res.writeHead(302, { Location: '/landing-page/login.html?google=cancelled' });
      res.end();
      return;
    }

    if (!code || !state || !cookies[GOOGLE_STATE_COOKIE] || cookies[GOOGLE_STATE_COOKIE] !== state) {
      clearCookie(res, GOOGLE_STATE_COOKIE, { secure, path: '/api/auth/google' });
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
          notes: withWorkspaceMeta({ createdAt }, 'Keep quote follow ups concise, direct, and easy to reply to.'),
          trialEndsAt: addDays(String(createdAt).slice(0, 10), 7),
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
          passwordHash: null,
          verified: true,
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        store.workspaces.push(workspace);
        store.users.push(user);
        seedWorkspace(store, workspace, user);
        await saveChanges({
          workspaces: [workspace],
          users: [user],
          teamMembers: store.teamMembers.filter((member) => member.workspaceId === workspace.id),
          quotes: store.quotes.filter((quote) => quote.workspaceId === workspace.id),
        });
      } else {
        user.verified = true;
        user.lastSeenAt = new Date().toISOString();
        if (!user.name && profile.name) user.name = normalizeName(profile.name);
        await saveChanges({ users: [user] });
      }

      await createSession(req, res, user.id);
      clearCookie(res, GOOGLE_STATE_COOKIE, { secure, path: '/api/auth/google' });
      res.writeHead(302, { Location: '/dashboard/dashboard.html' });
      res.end();
      return;
    } catch {
      clearCookie(res, GOOGLE_STATE_COOKIE, { secure, path: '/api/auth/google' });
      res.writeHead(302, { Location: '/landing-page/login.html?google=failed' });
      res.end();
      return;
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/signup') {
    if (!(await enforceRateLimit(req, res, 'signup'))) return;
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
      notes: withWorkspaceMeta({ createdAt }, 'Keep quote follow ups concise, direct, and easy to reply to.'),
      trialEndsAt: addDays(String(createdAt).slice(0, 10), 7),
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
    await saveChanges({
      workspaces: [workspace],
      users: [user],
      teamMembers: store.teamMembers.filter((member) => member.workspaceId === workspace.id),
      quotes: store.quotes.filter((quote) => quote.workspaceId === workspace.id),
    });
    const delivery = await attemptEmail(() => sendVerificationEmail(req, user));
    return sendJson(res, 201, {
      ok: true,
      email,
      emailSent: Boolean(delivery.sent),
      verifyUrl: !delivery.sent && shouldExposeDirectAuthLinks() ? `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}` : null,
    });
  }

  if (req.method === 'GET' && pathname === '/api/auth/check-email') {
    if (!(await enforceRateLimit(req, res, 'checkEmail'))) return;
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    const genericResponse = getGenericCheckEmailResponse(email);
    if (!isValidEmail(email)) return sendJson(res, 200, genericResponse);
    const store = await loadStore({ email });
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, genericResponse);
    clearExpiredAuthTokens(user);
    return sendJson(res, 200, {
      ...genericResponse,
      verifyUrl: shouldExposeDirectAuthLinks() && !RESEND_API_KEY && !user.verified && user.verificationToken
        ? `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}`
        : null,
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/resend-verification') {
    if (!(await enforceRateLimit(req, res, 'resendVerification'))) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const email = String(body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return badRequest(res, 'Enter a valid email address.');
    const genericResponse = {
      ok: true,
      sent: false,
      emailDeliveryAvailable: Boolean(RESEND_API_KEY),
      verifyUrl: null,
    };
    const store = await loadStore({ email });
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, genericResponse);
    clearExpiredAuthTokens(user);
    if (user.verified) return sendJson(res, 200, genericResponse);
    if (!user.verificationToken) setVerificationToken(user);
    await saveChanges({ users: [user] });
    const delivery = await attemptEmail(() => sendVerificationEmail(req, user));
    return sendJson(res, 200, {
      ...genericResponse,
      sent: Boolean(delivery.sent),
      verifyUrl: !delivery.sent && shouldExposeDirectAuthLinks()
        ? `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}`
        : null,
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (!(await enforceRateLimit(req, res, 'login'))) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!isValidEmail(email)) return badRequest(res, GENERIC_LOGIN_ERROR);
    const store = await loadStore({ email });
    const user = findUserByEmail(store, email);
    if (!user) return badRequest(res, GENERIC_LOGIN_ERROR);
    if (!user.passwordHash) return badRequest(res, GENERIC_LOGIN_ERROR);
    if (!verifyPassword(password, user.passwordHash)) return badRequest(res, GENERIC_LOGIN_ERROR);
    if (!user.verified) return badRequest(res, GENERIC_LOGIN_ERROR);
    user.lastSeenAt = new Date().toISOString();
    await saveChanges({ users: [user] });
    await createSession(req, res, user.id);
    return sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    if (!ensureSameOrigin(req, res)) return;
    await clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/auth/verify') {
    if (!(await enforceRateLimit(req, res, 'verify'))) return;
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
    await saveChanges({ users: [user] });
    return sendJson(res, 200, { ok: true, email: user.email });
  }

  if (req.method === 'POST' && pathname === '/api/auth/forgot-password') {
    if (!(await enforceRateLimit(req, res, 'forgotPassword'))) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const email = String(body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return badRequest(res, 'Enter a valid email address.');
    const store = await loadStore({ email });
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, { ok: true, sent: false, emailDeliveryAvailable: Boolean(RESEND_API_KEY), resetUrl: null });
    clearExpiredAuthTokens(user);
    setResetToken(user);
    await saveChanges({ users: [user] });
    const delivery = await attemptEmail(() => sendPasswordResetEmail(req, user));
    return sendJson(res, 200, {
      ok: true,
      sent: Boolean(delivery.sent),
      emailDeliveryAvailable: Boolean(RESEND_API_KEY),
      resetUrl: !delivery.sent && shouldExposeDirectAuthLinks() ? `/landing-page/reset-password.html?token=${encodeURIComponent(user.resetToken)}` : null,
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    if (!(await enforceRateLimit(req, res, 'resetPassword'))) return;
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
    await saveChanges({ users: [user] });
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
    if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
      auth.workspace.notes = withWorkspaceMeta(auth.workspace, body.notes, { planTier: getWorkspacePlanTier(auth.workspace) });
    }
    await saveChanges({ workspaces: [auth.workspace] });
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
    if (getWorkspaceMemberCount(store, auth.workspace.id) >= BUSINESS_TEAM_MEMBER_LIMIT) {
      return badRequest(res, `Business supports up to ${BUSINESS_TEAM_MEMBER_LIMIT} users per workspace. Contact us if you need a larger team setup.`);
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
    const newMember = !existingMembership ? {
      id: uid('team'),
      workspaceId: auth.workspace.id,
      userId: existingUser.id,
      name,
      email,
      role,
      activeQuotes: 0,
      createdAt: new Date().toISOString(),
    } : null;
    if (newMember) store.teamMembers.push(newMember);
    await saveChanges({ teamMembers: newMember ? [newMember] : [], deletes: store.__deletes || {} });
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
    if (!alreadyMember && getWorkspaceMemberCount(store, invite.workspaceId) >= BUSINESS_TEAM_MEMBER_LIMIT) {
      return badRequest(res, `This workspace already has ${BUSINESS_TEAM_MEMBER_LIMIT} users. Contact us if you need a larger team setup.`);
    }
    const acceptedMember = !alreadyMember ? {
      id: uid('team'),
      workspaceId: invite.workspaceId,
      userId: auth.user.id,
      name: normalizeName(auth.user.name || invite.inviteeName || auth.user.email.split('@')[0]),
      email: auth.user.email,
      role: normalizeRole(invite.role),
      activeQuotes: 0,
      createdAt: new Date().toISOString(),
    } : null;
    if (acceptedMember) store.teamMembers.push(acceptedMember);
    invite.status = 'accepted';
    invite.respondedAt = new Date().toISOString();
    await saveChanges({ teamMembers: acceptedMember ? [acceptedMember] : [], invites: [invite] });
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
    await saveChanges({ invites: [invite] });
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

    const replacementMember = currentMember.id === target.id
      ? ownerMembers.find((member) => member.id !== target.id) || currentMember
      : currentMember;
    const replacementOwner = replacementMember?.name || auth.user.name;

    store.teamMembers = store.teamMembers.filter((member) => member.id !== target.id);
    queueStoreDelete(store, 'team_members', target.id);
    const reassignedQuotes = [];
    store.quotes.forEach((quote) => {
      if (quote.workspaceId === auth.workspace.id && quoteOwnedByMember(quote, target)) {
        quote.owner = replacementOwner;
        quote.ownerTeamMemberId = replacementMember?.id || null;
        recordQuoteEvent(quote, 'Quote reassigned', `Ownership moved from ${target.name} to ${replacementOwner}.`);
        reassignedQuotes.push(quote);
      }
    });
    await saveChanges({ quotes: reassignedQuotes, deletes: store.__deletes || {} });
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
    const { title, customer, customerEmail, owner, ownerTeamMemberId, status, value, sentDate, nextFollowUp, notes } = buildQuoteInput(body, auth, store);
    if (!title || !value) return badRequest(res, 'Add at least a title and value before saving.');
    const quote = {
      id: uid('quote'),
      workspaceId: auth.workspace.id,
      title,
      customer,
      customerEmail,
      owner,
      ownerTeamMemberId,
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
    await saveChanges({ quotes: [quote] });
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
    const { title, customer, customerEmail, owner, ownerTeamMemberId, status, value, sentDate, nextFollowUp, notes } = buildQuoteInput(body, auth, store, quote);
    if (!title || !value) return badRequest(res, 'Add at least a title and value before saving.');
    quote.title = title;
    quote.customer = customer;
    quote.customerEmail = customerEmail;
    quote.owner = owner;
    quote.ownerTeamMemberId = ownerTeamMemberId;
    quote.status = status;
    quote.value = value;
    quote.sentDate = sentDate;
    quote.nextFollowUp = nextFollowUp;
    quote.notes = notes;
    quote.archived = quote.status === 'Archived' ? true : Boolean(quote.archived);
    recordQuoteEvent(quote, 'Quote updated', `Status ${quote.status} · follow up ${quote.nextFollowUp}`);
    await saveChanges({ quotes: [quote] });
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
    await saveChanges({ deletes: store.__deletes || {} });
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
    await saveChanges({ quotes: [quote] });
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
    await saveChanges({ quotes: [quote] });
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
    const status = error.status || 500;
    const message = status >= 500 && (IS_VERCEL || process.env.NODE_ENV === 'production')
      ? 'Server error'
      : (error.message || 'Server error');
    sendJson(res, status, { error: message });
  }
}

module.exports = { requestHandler };
