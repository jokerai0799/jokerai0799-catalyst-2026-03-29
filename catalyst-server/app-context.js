const crypto = require('crypto');
const { URL } = require('url');
const config = require('./config');
const email = require('./email');
const http = require('./http');
const session = require('./session');
const { checkRateLimit } = require('./rate-limit');
const supabase = require('./supabase');
const store = require('./store');
const utils = require('./utils');

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
const GENERIC_LOGIN_ERROR = 'We could not sign you in with those details.';

function createAppContext(overrides = {}) {
  const runtimeConfig = {
    APP_URL: config.APP_URL,
    BILLING_CONFIG_ERRORS: config.BILLING_CONFIG_ERRORS,
    GOOGLE_CLIENT_ID: config.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: config.GOOGLE_CLIENT_SECRET,
    IS_PRODUCTION: config.IS_PRODUCTION,
    IS_VERCEL: config.IS_VERCEL,
    PROJECT_METRICS_TOKEN: config.PROJECT_METRICS_TOKEN,
    RESEND_API_KEY: config.RESEND_API_KEY,
    STRIPE_BUSINESS_PAYMENT_LINK: config.STRIPE_BUSINESS_PAYMENT_LINK,
    STRIPE_BUSINESS_PRICE_ID: config.STRIPE_BUSINESS_PRICE_ID,
    STRIPE_CUSTOMER_PORTAL_URL: config.STRIPE_CUSTOMER_PORTAL_URL,
    STRIPE_PERSONAL_PAYMENT_LINK: config.STRIPE_PERSONAL_PAYMENT_LINK,
    STRIPE_PERSONAL_PRICE_ID: config.STRIPE_PERSONAL_PRICE_ID,
    STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: config.STRIPE_WEBHOOK_SECRET,
    ...(overrides.config || {}),
  };

  const ctx = {
    config: runtimeConfig,
    attemptEmail: email.attemptEmail,
    sendPasswordResetEmail: email.sendPasswordResetEmail,
    sendQuoteFollowupEmail: email.sendQuoteFollowupEmail,
    sendVerificationEmail: email.sendVerificationEmail,
    badRequest: http.badRequest,
    notFound: http.notFound,
    readJsonOrReject: http.readJsonOrReject,
    sendJson: http.sendJson,
    serveStatic: http.serveStatic,
    tooManyRequests: http.tooManyRequests,
    unauthorized: http.unauthorized,
    clearSession: session.clearSession,
    createSession: session.createSession,
    getSessionUser: session.getSessionUser,
    getSessionUserId: session.getSessionUserId,
    parseCookies: session.parseCookies,
    requestIsSecure: session.requestIsSecure,
    checkRateLimit,
    cleanupExpiredSessions: supabase.cleanupExpiredSessions,
    isSupabaseReady: supabase.isSupabaseReady,
    supabaseRequest: supabase.supabaseRequest,
    ALLOWED_QUOTE_ACTIONS: store.ALLOWED_QUOTE_ACTIONS,
    buildBootstrap: store.buildBootstrap,
    buildQuoteInput: store.buildQuoteInput,
    ensureQuoteMeta: store.ensureQuoteMeta,
    findUserByEmail: store.findUserByEmail,
    getWorkspacePlanTier: store.getWorkspacePlanTier,
    isTeamFeatureUnlocked: store.isTeamFeatureUnlocked,
    isWorkspaceReadOnly: store.isWorkspaceReadOnly,
    loadStore: store.loadStore,
    queueStoreDelete: store.queueStoreDelete,
    quoteOwnedByMember: store.quoteOwnedByMember,
    recordQuoteEvent: store.recordQuoteEvent,
    sanitizeUser: store.sanitizeUser,
    saveChanges: store.saveChanges,
    seedWorkspace: store.seedWorkspace,
    withUser: store.withUser,
    withWorkspaceMeta: store.withWorkspaceMeta,
    isValidEmail: store.isValidEmail,
    normalizeName: store.normalizeName,
    normalizeRole: store.normalizeRole,
    addDays: utils.addDays,
    addHours: utils.addHours,
    clampText: utils.clampText,
    hashPassword: utils.hashPassword,
    isFutureIsoDate: utils.isFutureIsoDate,
    normalizeQuoteStatus: utils.normalizeQuoteStatus,
    today: utils.today,
    uid: utils.uid,
    verifyPassword: utils.verifyPassword,
    GOOGLE_STATE_COOKIE,
    VERIFY_TOKEN_HOURS,
    RESET_TOKEN_HOURS,
    LAST_SEEN_REFRESH_MS,
    LIVE_USERS_WINDOW_MS,
    PROJECT_METRICS_CACHE_MS,
    BUSINESS_TEAM_MEMBER_LIMIT,
    AUTH_RATE_LIMITS,
    STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    GENERIC_LOGIN_ERROR,
    ...overrides,
  };

  let projectMetricsCache = null;
  let projectMetricsCachedAt = 0;

  ctx.getAppBaseUrl = function getAppBaseUrl(req) {
    if (ctx.config.APP_URL) return ctx.config.APP_URL.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
    return `${proto}://${host}`.replace(/\/$/, '');
  };

  ctx.safeTokenMatch = function safeTokenMatch(expected, actual) {
    const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
    const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
    if (!expectedBuffer.length || expectedBuffer.length !== actualBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  };

  ctx.getProjectMetricsToken = function getProjectMetricsToken(req) {
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
    return String(req.headers['x-project-metrics-token'] || bearer || '').trim();
  };

  ctx.canReadProjectMetrics = function canReadProjectMetrics(req) {
    if (ctx.config.PROJECT_METRICS_TOKEN) {
      return ctx.safeTokenMatch(ctx.config.PROJECT_METRICS_TOKEN, ctx.getProjectMetricsToken(req));
    }
    return !ctx.config.IS_VERCEL;
  };

  ctx.getGoogleRedirectUri = function getGoogleRedirectUri(req) {
    return `${ctx.getAppBaseUrl(req)}/api/auth/google/callback`;
  };

  ctx.appendSetCookie = function appendSetCookie(res, value) {
    const existing = res.getHeader('Set-Cookie');
    if (!existing) {
      res.setHeader('Set-Cookie', value);
      return;
    }
    const list = Array.isArray(existing) ? existing.concat(value) : [existing, value];
    res.setHeader('Set-Cookie', list);
  };

  ctx.shouldExposeDirectAuthLinks = function shouldExposeDirectAuthLinks() {
    return !ctx.config.IS_PRODUCTION;
  };

  ctx.setCookie = function setCookie(res, name, value, { maxAge = 300, secure = false, path = '/', sameSite = 'Lax' } = {}) {
    ctx.appendSetCookie(res, `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}; Priority=High${secure ? '; Secure' : ''}`);
  };

  ctx.clearCookie = function clearCookie(res, name, { secure = false, path = '/', sameSite = 'Lax' } = {}) {
    ctx.appendSetCookie(res, `${name}=; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=0; Priority=High${secure ? '; Secure' : ''}`);
  };

  ctx.getGenericCheckEmailResponse = function getGenericCheckEmailResponse(emailAddress) {
    return {
      email: emailAddress,
      emailDeliveryAvailable: Boolean(ctx.config.RESEND_API_KEY),
      verifyUrl: null,
    };
  };

  ctx.exchangeGoogleCode = async function exchangeGoogleCode(req, code) {
    const body = new URLSearchParams({
      code,
      client_id: ctx.config.GOOGLE_CLIENT_ID,
      client_secret: ctx.config.GOOGLE_CLIENT_SECRET,
      redirect_uri: ctx.getGoogleRedirectUri(req),
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
  };

  ctx.fetchGoogleProfile = async function fetchGoogleProfile(accessToken) {
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
  };

  ctx.ensureWorkspaceName = function ensureWorkspaceName(profile) {
    const company = ctx.clampText(profile?.hd || '', 160);
    const name = ctx.clampText(profile?.name || '', 160);
    return company || name || 'New workspace';
  };

  ctx.inviteForUser = function inviteForUser(storeState, inviteId, emailAddress) {
    return (storeState.invites || []).find(
      (invite) => invite.id === inviteId && String(invite.inviteeEmail || '').trim().toLowerCase() === String(emailAddress || '').trim().toLowerCase() && invite.status === 'pending',
    ) || null;
  };

  ctx.setVerificationToken = function setVerificationToken(user) {
    user.verificationToken = crypto.randomBytes(20).toString('hex');
    user.verificationTokenExpiresAt = ctx.addHours(new Date().toISOString(), ctx.VERIFY_TOKEN_HOURS);
    return user;
  };

  ctx.setResetToken = function setResetToken(user) {
    user.resetToken = crypto.randomBytes(24).toString('hex');
    user.resetTokenExpiresAt = ctx.addHours(new Date().toISOString(), ctx.RESET_TOKEN_HOURS);
    return user;
  };

  ctx.clearExpiredAuthTokens = function clearExpiredAuthTokens(user) {
    if (!user) return;
    if (user.verificationToken && !ctx.isFutureIsoDate(user.verificationTokenExpiresAt)) {
      delete user.verificationToken;
      user.verificationTokenExpiresAt = null;
    }
    if (user.resetToken && !ctx.isFutureIsoDate(user.resetTokenExpiresAt)) {
      delete user.resetToken;
      user.resetTokenExpiresAt = null;
    }
  };

  ctx.shouldRefreshLastSeen = function shouldRefreshLastSeen(user, maxAgeMs = ctx.LAST_SEEN_REFRESH_MS) {
    if (!user) return false;
    if (!user.lastSeenAt) return true;
    const lastSeen = new Date(user.lastSeenAt);
    if (Number.isNaN(lastSeen.getTime())) return true;
    return Date.now() - lastSeen.getTime() >= maxAgeMs;
  };

  ctx.refreshLastSeen = async function refreshLastSeen(storeState, user) {
    if (!ctx.shouldRefreshLastSeen(user)) return false;
    user.lastSeenAt = new Date().toISOString();
    await ctx.saveChanges({ users: [user] });
    return true;
  };

  ctx.startOfUtcDayIso = function startOfUtcDayIso() {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    return date.toISOString();
  };

  ctx.buildProjectMetrics = async function buildProjectMetrics() {
    const generatedAt = new Date().toISOString();
    const storageReady = await ctx.isSupabaseReady();

    if (!storageReady) {
      return {
        ok: false,
        project: 'catalyst',
        health: 'degraded',
        liveUsers: 0,
        signupsToday: 0,
        storage: 'unavailable',
        liveWindowMinutes: Math.round(ctx.LIVE_USERS_WINDOW_MS / 60000),
        generatedAt,
      };
    }

    const liveSinceIso = new Date(Date.now() - ctx.LIVE_USERS_WINDOW_MS).toISOString();
    const signupsSinceIso = ctx.startOfUtcDayIso();
    const [liveUsersRows, signupsTodayRows] = await Promise.all([
      ctx.supabaseRequest(`users?select=id&last_seen_at=gte.${encodeURIComponent(liveSinceIso)}`),
      ctx.supabaseRequest(`users?select=id&created_at=gte.${encodeURIComponent(signupsSinceIso)}`),
    ]);

    return {
      ok: true,
      project: 'catalyst',
      health: 'ok',
      liveUsers: Array.isArray(liveUsersRows) ? liveUsersRows.length : 0,
      signupsToday: Array.isArray(signupsTodayRows) ? signupsTodayRows.length : 0,
      storage: 'supabase',
      liveWindowMinutes: Math.round(ctx.LIVE_USERS_WINDOW_MS / 60000),
      generatedAt,
    };
  };

  ctx.getProjectMetrics = async function getProjectMetrics() {
    const now = Date.now();
    if (projectMetricsCache && now - projectMetricsCachedAt < ctx.PROJECT_METRICS_CACHE_MS) {
      return projectMetricsCache;
    }
    projectMetricsCache = await ctx.buildProjectMetrics();
    projectMetricsCachedAt = now;
    return projectMetricsCache;
  };

  ctx.enforceRateLimit = async function enforceRateLimit(req, res, key) {
    const policy = ctx.AUTH_RATE_LIMITS[key];
    if (!policy) return true;
    const result = await ctx.checkRateLimit(req, `auth:${key}`, policy);
    if (result.allowed) return true;
    if (result.resetAt) {
      const retryAfterSeconds = Math.max(1, Math.ceil((new Date(result.resetAt).getTime() - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
    }
    ctx.tooManyRequests(res, 'Too many requests for that action. Please wait a few minutes and try again.');
    return false;
  };

  ctx.ensureSameOrigin = function ensureSameOrigin(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const currentOrigin = ctx.getAppBaseUrl(req);
    if (origin === currentOrigin) return true;
    ctx.sendJson(res, 403, { error: 'Origin check failed.' });
    return false;
  };

  ctx.ensureWorkspaceWritable = function ensureWorkspaceWritable(res, workspace) {
    if (!ctx.isWorkspaceReadOnly(workspace)) return true;
    ctx.sendJson(res, 402, { error: 'Your 7 day trial has ended. This workspace is now read-only until you choose Personal or Business.' });
    return false;
  };

  ctx.getWorkspaceMemberCount = function getWorkspaceMemberCount(storeState, workspaceId) {
    return storeState.teamMembers.filter((member) => member.workspaceId === workspaceId).length;
  };

  ctx.ensureOwnerAccess = function ensureOwnerAccess(res, storeState, workspaceId) {
    const currentWorkspaceAccess = (storeState.accessibleWorkspaces || []).find((workspaceAccess) => workspaceAccess.id === workspaceId);
    if (currentWorkspaceAccess && currentWorkspaceAccess.role !== 'Owner') {
      ctx.unauthorized(res);
      return false;
    }
    return true;
  };

  ctx.loadAuth = async function loadAuth(req, res, { sameOrigin = false, ownerOnly = false, writable = false } = {}) {
    if (sameOrigin && !ctx.ensureSameOrigin(req, res)) return null;
    const storeState = await ctx.loadAuthenticatedStore(req, res);
    if (!storeState) return null;
    const auth = await ctx.withUser(req, res, storeState, ctx.getSessionUser, ctx.unauthorized);
    if (!auth) return null;
    if (ownerOnly && !ctx.ensureOwnerAccess(res, storeState, auth.workspace.id)) return null;
    if (writable && !ctx.ensureWorkspaceWritable(res, auth.workspace)) return null;
    return { store: storeState, ...auth };
  };

  ctx.stripePlanTierFromPriceId = function stripePlanTierFromPriceId(priceId) {
    if (!priceId) return null;
    if (ctx.config.STRIPE_PERSONAL_PRICE_ID && priceId === ctx.config.STRIPE_PERSONAL_PRICE_ID) return 'personal';
    if (ctx.config.STRIPE_BUSINESS_PRICE_ID && priceId === ctx.config.STRIPE_BUSINESS_PRICE_ID) return 'business';
    return null;
  };

  ctx.readRawBody = async function readRawBody(req) {
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
  };

  ctx.verifyStripeSignature = function verifyStripeSignature(rawBody, signatureHeader) {
    if (!ctx.config.STRIPE_WEBHOOK_SECRET || !signatureHeader) return false;
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
    if (ageSeconds > ctx.STRIPE_WEBHOOK_TOLERANCE_SECONDS) return false;
    const payload = `${timestamp}.${rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', ctx.config.STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
    } catch {
      return false;
    }
  };

  ctx.recordStripeWebhookEvent = async function recordStripeWebhookEvent(event) {
    if (!event?.id) return true;
    try {
      await ctx.supabaseRequest('stripe_webhook_events', {
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
  };

  ctx.stripeRequest = async function stripeRequest(pathname) {
    if (!ctx.config.STRIPE_SECRET_KEY) return null;
    const response = await fetch(`https://api.stripe.com/v1${pathname}`, {
      headers: { Authorization: `Bearer ${ctx.config.STRIPE_SECRET_KEY}` },
    });
    if (!response.ok) return null;
    return response.json();
  };

  ctx.getWorkspaceBillingPatch = function getWorkspaceBillingPatch(workspace, billingPayload) {
    return {
      billing_plan_tier: billingPayload.billing_plan_tier,
      billing_status: billingPayload.billing_status,
      billing_currency: billingPayload.billing_currency,
      stripe_customer_id: billingPayload.stripe_customer_id,
      stripe_subscription_id: billingPayload.stripe_subscription_id,
      stripe_price_id: billingPayload.stripe_price_id,
      stripe_current_period_end: billingPayload.stripe_current_period_end,
      trial_ends_at: workspace?.trial_ends_at || null,
    };
  };

  ctx.findWorkspaceForStripeEvent = async function findWorkspaceForStripeEvent(eventObject) {
    const customerId = String(eventObject?.customer || '').trim();
    if (customerId) {
      const rows = await ctx.supabaseRequest(`workspaces?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=*&limit=1`, { allow404: true });
      if (rows?.[0]) return rows[0];
    }

    const emailCandidates = [
      eventObject?.customer_details?.email,
      eventObject?.customer_email,
      eventObject?.receipt_email,
    ].filter(Boolean).map((value) => String(value).trim().toLowerCase());

    if (!emailCandidates.length && customerId && ctx.config.STRIPE_SECRET_KEY) {
      const customer = await ctx.stripeRequest(`/customers/${encodeURIComponent(customerId)}`);
      if (customer?.email) emailCandidates.push(String(customer.email).trim().toLowerCase());
    }

    for (const emailAddress of emailCandidates) {
      const userRows = await ctx.supabaseRequest(`users?email=eq.${encodeURIComponent(emailAddress)}&select=workspace_id&limit=1`);
      if (userRows?.[0]?.workspace_id) {
        const workspaceRows = await ctx.supabaseRequest(`workspaces?id=eq.${encodeURIComponent(userRows[0].workspace_id)}&select=*`);
        if (workspaceRows?.[0]) return workspaceRows[0];
      }
      const workspaceRows = await ctx.supabaseRequest(`workspaces?reply_email=eq.${encodeURIComponent(emailAddress)}&select=*&limit=1`);
      if (workspaceRows?.[0]) return workspaceRows[0];
    }

    return null;
  };

  ctx.syncStripeBillingFromEvent = async function syncStripeBillingFromEvent(event) {
    const eventObject = event?.data?.object || {};
    const workspace = await ctx.findWorkspaceForStripeEvent(eventObject);
    if (!workspace) return false;

    const subscription = eventObject?.object === 'subscription'
      ? eventObject
      : (eventObject?.subscription && ctx.config.STRIPE_SECRET_KEY ? await ctx.stripeRequest(`/subscriptions/${encodeURIComponent(eventObject.subscription)}`) : null);

    const priceId = subscription?.items?.data?.[0]?.price?.id || eventObject?.metadata?.price_id || workspace.stripe_price_id || null;
    const billingStatus = subscription?.status || (event.type === 'checkout.session.completed' ? 'active' : workspace.billing_status || 'inactive');
    const billingCurrency = (subscription?.currency || eventObject?.currency || workspace.billing_currency || 'GBP').toUpperCase();
    const nextPeriod = subscription?.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null;
    const knownPlanTier = ctx.stripePlanTierFromPriceId(priceId || workspace.stripe_price_id || null);
    const requiresPlanResolution = Boolean(priceId || event.type === 'checkout.session.completed' || subscription);
    if (requiresPlanResolution && ctx.config.BILLING_CONFIG_ERRORS.length) {
      throw new Error(`Stripe billing is misconfigured: ${ctx.config.BILLING_CONFIG_ERRORS.join(' ')}`);
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

    await ctx.supabaseRequest(`workspaces?id=eq.${encodeURIComponent(workspace.id)}`, {
      method: 'PATCH',
      body: ctx.getWorkspaceBillingPatch(workspace, billingPayload),
      headers: { Prefer: 'return=minimal' },
    });

    return true;
  };

  ctx.loadAuthenticatedStore = async function loadAuthenticatedStore(req, res) {
    const userId = await ctx.getSessionUserId(req);
    if (!userId) {
      ctx.unauthorized(res);
      return null;
    }
    const requestedWorkspaceId = String(req.headers['x-workspace-id'] || '').trim();
    return ctx.loadStore({ userId, workspaceId: requestedWorkspaceId || undefined });
  };

  if (overrides.helpers) Object.assign(ctx, overrides.helpers);

  return ctx;
}

module.exports = {
  createAppContext,
  AUTH_RATE_LIMITS,
  BUSINESS_TEAM_MEMBER_LIMIT,
  GENERIC_LOGIN_ERROR,
  GOOGLE_STATE_COOKIE,
};
