const crypto = require('crypto');
const { URL } = require('url');
const { APP_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = require('./config');
const { attemptEmail, sendPasswordResetEmail, sendQuoteFollowupEmail, sendVerificationEmail } = require('./email');
const { badRequest, notFound, readJsonOrReject, sendJson, serveStatic, unauthorized } = require('./http');
const { clearSession, createSession, getSessionUser } = require('./session');
const { isSupabaseReady } = require('./supabase');
const {
  ALLOWED_QUOTE_ACTIONS,
  buildBootstrap,
  buildQuoteInput,
  ensureQuoteMeta,
  findUserByEmail,
  getWorkspacePlanTier,
  isTeamFeatureUnlocked,
  loadStore,
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
  clampText,
  hashPassword,
  normalizeQuoteStatus,
  today,
  uid,
  verifyPassword,
  addDays,
} = require('./utils');

const GOOGLE_STATE_COOKIE = 'catalyst_google_state';

function getAppBaseUrl(req) {
  if (APP_URL) return APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
  return `${proto}://${host}`.replace(/\/$/, '');
}

function getGoogleRedirectUri(req) {
  return `${getAppBaseUrl(req)}/api/auth/google/callback`;
}

function parseCookieMap(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
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

  const store = await loadStore();

  if (req.method === 'GET' && pathname === '/api/app/bootstrap') {
    const user = await getSessionUser(req, store);
    if (!user) return unauthorized(res);
    return sendJson(res, 200, buildBootstrap(store, user));
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = await getSessionUser(req, store);
    return sendJson(res, 200, { user: user ? sanitizeUser(user) : null });
  }

  if (req.method === 'GET' && pathname === '/api/auth/google/callback') {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      res.writeHead(302, { Location: '/landing-page/login.html?google=not-configured' });
      res.end();
      return;
    }

    const cookies = parseCookieMap(req);
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
          createdAt,
        };
        user = {
          id: uid('user'),
          workspaceId: workspace.id,
          name: normalizeName(profile.name || email.split('@')[0]),
          email,
          passwordHash: '',
          verified: true,
          createdAt: new Date().toISOString(),
        };
        store.workspaces.push(workspace);
        store.users.push(user);
        seedWorkspace(store, workspace, user);
        await saveStore(store);
      } else {
        user.verified = true;
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
    if (findUserByEmail(store, email)) return badRequest(res, 'An account with this email already exists.');

    const createdAt = new Date().toISOString();
    const workspace = {
      id: uid('workspace'),
      name: company,
      replyEmail: email,
      firstFollowupDays: 2,
      secondFollowupDays: 5,
      notes: withWorkspaceMeta({ createdAt }, 'Keep quote follow ups concise, direct, and easy to reply to.', { planTier }),
      createdAt,
    };
    const user = {
      id: uid('user'),
      workspaceId: workspace.id,
      name,
      email,
      passwordHash: hashPassword(password),
      verified: false,
      verificationToken: uid('verify'),
      createdAt: new Date().toISOString(),
    };
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
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, { email, exists: false, verified: false, verifyUrl: '/landing-page/login.html?verified=invalid' });
    return sendJson(res, 200, {
      email,
      exists: true,
      verified: Boolean(user.verified),
      emailDeliveryAvailable: Boolean(RESEND_API_KEY),
      verifyUrl: !RESEND_API_KEY && user.verificationToken ? `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}` : null,
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/resend-verification') {
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const email = String(body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return badRequest(res, 'Enter a valid email address.');
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, { ok: true, sent: false, emailDeliveryAvailable: Boolean(RESEND_API_KEY) });
    if (user.verified) return sendJson(res, 200, { ok: true, sent: false, verified: true, emailDeliveryAvailable: Boolean(RESEND_API_KEY) });
    if (!user.verificationToken) user.verificationToken = uid('verify');
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
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!isValidEmail(email)) return badRequest(res, 'Invalid email or password.');
    const user = findUserByEmail(store, email);
    if (!user) return badRequest(res, 'Invalid email or password.');
    if (!user.passwordHash) return badRequest(res, 'Use Google sign-in for this account.');
    if (!verifyPassword(password, user.passwordHash)) return badRequest(res, 'Invalid email or password.');
    if (!user.verified) return badRequest(res, 'Check your email page and verify your account before logging in.');
    await createSession(res, user.id);
    return sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    await clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/auth/verify') {
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const token = String(body.token || '').trim();
    const user = store.users.find((item) => item.verificationToken === token);
    if (!user) return badRequest(res, 'That verification link is invalid or expired.');
    user.verified = true;
    delete user.verificationToken;
    await saveStore(store);
    return sendJson(res, 200, { ok: true, email: user.email });
  }

  if (req.method === 'POST' && pathname === '/api/auth/forgot-password') {
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const email = String(body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return badRequest(res, 'Enter a valid email address.');
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, { ok: true, sent: false, emailDeliveryAvailable: Boolean(RESEND_API_KEY) });
    user.resetToken = uid('reset');
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
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const token = String(body.token || '').trim();
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');
    const user = store.users.find((item) => item.resetToken === token);
    if (!user) return badRequest(res, 'That reset link is invalid or expired.');
    if (password.length < 8) return badRequest(res, 'Use at least 8 characters for your new password.');
    if (password !== confirmPassword) return badRequest(res, 'Passwords do not match.');
    user.passwordHash = hashPassword(password);
    delete user.resetToken;
    await saveStore(store);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'PATCH' && pathname === '/api/workspace') {
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
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
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    if (!isTeamFeatureUnlocked(auth.workspace)) {
      return badRequest(res, 'Team features unlock after the Business trial ends.');
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
    if (existingPendingInvite) {
      return badRequest(res, 'There is already a pending invite for that email.');
    }
    const existingUser = findUserByEmail(store, email);
    const invite = {
      id: uid('invite'),
      workspaceId: auth.workspace.id,
      inviterUserId: auth.user.id,
      inviterName: auth.user.name || 'Owner',
      workspaceName: auth.workspace.name,
      inviteeName: name,
      inviteeEmail: email,
      role,
      status: 'pending',
      createdAt: new Date().toISOString(),
      respondedAt: null,
    };
    store.invites = Array.isArray(store.invites) ? store.invites : [];
    store.invites.push(invite);
    await saveStore(store);
    return sendJson(res, 201, {
      ok: true,
      invite,
      delivery: existingUser ? 'account-notification' : 'pending-until-signup',
      joinAvailableNow: Boolean(existingUser && existingUser.workspaceId === auth.workspace.id),
    });
  }

  const inviteAcceptMatch = pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
  if (inviteAcceptMatch && req.method === 'POST') {
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
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    if (!isTeamFeatureUnlocked(auth.workspace)) {
      return badRequest(res, 'Team features unlock after the Business trial ends.');
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
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
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
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const quote = store.quotes.find((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (!quote) return notFound(res);
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
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
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const index = store.quotes.findIndex((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (index === -1) return notFound(res);
    store.quotes.splice(index, 1);
    await saveStore(store);
    return sendJson(res, 200, { ok: true });
  }

  const quoteEmailMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/send-email$/);
  if (quoteEmailMatch && req.method === 'POST') {
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
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
    quote.status = 'Replied';
    quote.nextFollowUp = addDays(today(), auth.workspace.secondFollowupDays || auth.workspace.firstFollowupDays || 2);
    recordQuoteEvent(quote, 'Follow-up email sent', `Sent to ${quote.customerEmail} and queued next follow up for ${quote.nextFollowUp}.`);
    await saveStore(store);
    return sendJson(res, 200, { ok: true, quote, delivery });
  }

  const quoteActionMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/actions$/);
  if (quoteActionMatch && req.method === 'POST') {
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
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
