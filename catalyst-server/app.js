const { URL } = require('url');
const { RESEND_API_KEY } = require('./config');
const { attemptEmail, sendPasswordResetEmail, sendVerificationEmail } = require('./email');
const { badRequest, notFound, readJsonOrReject, sendJson, serveStatic, unauthorized } = require('./http');
const { clearSession, createSession, getSessionUser } = require('./session');
const { isSupabaseReady } = require('./supabase');
const {
  ALLOWED_QUOTE_ACTIONS,
  buildBootstrap,
  buildQuoteInput,
  ensureDemoAccount,
  ensureQuoteMeta,
  findUserByEmail,
  loadStore,
  recordQuoteEvent,
  sanitizeUser,
  saveStore,
  seedWorkspace,
  withUser,
  isValidEmail,
  normalizeName,
  normalizeRole,
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

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, storage: (await isSupabaseReady()) ? 'supabase' : 'unavailable' });
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

  if (req.method === 'POST' && pathname === '/api/auth/signup') {
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const name = normalizeName(body.name);
    const company = clampText(body.company, 160);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!name || !company || !email || !password) return badRequest(res, 'Fill in all fields to create your workspace.');
    if (!isValidEmail(email)) return badRequest(res, 'Use a valid email address.');
    if (password.length < 8) return badRequest(res, 'Use at least 8 characters for your password.');
    if (findUserByEmail(store, email)) return badRequest(res, 'An account with this email already exists.');

    const workspace = {
      id: uid('workspace'),
      name: company,
      replyEmail: email,
      firstFollowupDays: 2,
      secondFollowupDays: 5,
      notes: 'Keep quote follow ups concise, direct, and easy to reply to.',
      createdAt: new Date().toISOString(),
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
    if (!user || !verifyPassword(password, user.passwordHash)) return badRequest(res, 'Invalid email or password.');
    if (!user.verified) return badRequest(res, 'Check your email page and verify your account before logging in.');
    await createSession(res, user.id);
    return sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
  }

  if (req.method === 'POST' && pathname === '/api/auth/demo-login') {
    const demo = await ensureDemoAccount(store);
    await createSession(res, demo.user.id);
    return sendJson(res, 200, { ok: true, user: sanitizeUser(demo.user) });
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
    auth.workspace.notes = clampText(body.notes, 2000);
    await saveStore(store);
    return sendJson(res, 200, { ok: true, workspace: auth.workspace });
  }

  if (req.method === 'POST' && pathname === '/api/team') {
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
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
    const member = { id: uid('team'), workspaceId: auth.workspace.id, name, email, role, activeQuotes: 0, createdAt: new Date().toISOString() };
    store.teamMembers.push(member);
    await saveStore(store);
    return sendJson(res, 201, { ok: true, member });
  }

  if (req.method === 'POST' && pathname === '/api/quotes') {
    const auth = await withUser(req, res, store, getSessionUser, unauthorized);
    if (!auth) return;
    const body = await readJsonOrReject(req, res, badRequest);
    if (!body) return;
    const { title, customer, owner, status, value, sentDate, nextFollowUp, notes } = buildQuoteInput(body, auth, store);
    if (!title || !value) return badRequest(res, 'Add at least a title and value before saving.');
    const quote = {
      id: uid('quote'),
      workspaceId: auth.workspace.id,
      title,
      customer,
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
    const { title, customer, owner, status, value, sentDate, nextFollowUp, notes } = buildQuoteInput(body, auth, store, quote);
    if (!title || !value) return badRequest(res, 'Add at least a title and value before saving.');
    quote.title = title;
    quote.customer = customer;
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
