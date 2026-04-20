async function handleAuthRoutes(req, res, url, ctx) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/auth/google/callback') {
    if (!ctx.config.GOOGLE_CLIENT_ID || !ctx.config.GOOGLE_CLIENT_SECRET) {
      res.writeHead(302, { Location: '/landing-page/login.html?google=not-configured' });
      res.end();
      return true;
    }

    const cookies = ctx.parseCookies(req);
    const state = String(url.searchParams.get('state') || '');
    const code = String(url.searchParams.get('code') || '');
    const error = String(url.searchParams.get('error') || '');
    const secure = ctx.requestIsSecure(req);

    if (error) {
      ctx.clearCookie(res, ctx.GOOGLE_STATE_COOKIE, { secure, path: '/api/auth/google' });
      res.writeHead(302, { Location: '/landing-page/login.html?google=cancelled' });
      res.end();
      return true;
    }

    if (!code || !state || !cookies[ctx.GOOGLE_STATE_COOKIE] || cookies[ctx.GOOGLE_STATE_COOKIE] !== state) {
      ctx.clearCookie(res, ctx.GOOGLE_STATE_COOKIE, { secure, path: '/api/auth/google' });
      res.writeHead(302, { Location: '/landing-page/login.html?google=invalid-state' });
      res.end();
      return true;
    }

    try {
      const tokenData = await ctx.exchangeGoogleCode(req, code);
      const profile = await ctx.fetchGoogleProfile(tokenData.access_token);
      const email = String(profile.email || '').trim().toLowerCase();
      if (!profile.verified_email || !ctx.isValidEmail(email)) {
        throw new Error('Google account email is missing or not verified.');
      }

      const store = await ctx.loadStore({ email });
      let user = ctx.findUserByEmail(store, email);
      if (!user) {
        const createdAt = new Date().toISOString();
        const workspace = {
          id: ctx.uid('workspace'),
          name: ctx.ensureWorkspaceName(profile),
          replyEmail: email,
          firstFollowupDays: 2,
          secondFollowupDays: 5,
          notes: ctx.withWorkspaceMeta({ createdAt }, 'Keep quote follow ups concise, direct, and easy to reply to.'),
          trialEndsAt: ctx.addDays(String(createdAt).slice(0, 10), 7),
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
          id: ctx.uid('user'),
          workspaceId: workspace.id,
          name: ctx.normalizeName(profile.name || email.split('@')[0]),
          email,
          passwordHash: null,
          verified: true,
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        store.workspaces.push(workspace);
        store.users.push(user);
        ctx.seedWorkspace(store, workspace, user);
        await ctx.saveChanges({
          workspaces: [workspace],
          users: [user],
          teamMembers: store.teamMembers.filter((member) => member.workspaceId === workspace.id),
          quotes: store.quotes.filter((quote) => quote.workspaceId === workspace.id),
        });
      } else {
        user.verified = true;
        user.lastSeenAt = new Date().toISOString();
        if (!user.name && profile.name) user.name = ctx.normalizeName(profile.name);
        await ctx.saveChanges({ users: [user] });
      }

      await ctx.createSession(req, res, user.id);
      ctx.clearCookie(res, ctx.GOOGLE_STATE_COOKIE, { secure, path: '/api/auth/google' });
      res.writeHead(302, { Location: '/dashboard/dashboard.html' });
      res.end();
      return true;
    } catch {
      ctx.clearCookie(res, ctx.GOOGLE_STATE_COOKIE, { secure, path: '/api/auth/google' });
      res.writeHead(302, { Location: '/landing-page/login.html?google=failed' });
      res.end();
      return true;
    }
  }

  if (req.method === 'POST' && pathname === '/api/auth/signup') {
    if (!(await ctx.enforceRateLimit(req, res, 'signup'))) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const name = ctx.normalizeName(body.name);
    const company = ctx.clampText(body.company, 160);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const planTier = String(body.plan || 'personal').trim().toLowerCase() === 'business' ? 'business' : 'personal';
    if (!name || !company || !email || !password) return ctx.badRequest(res, 'Fill in all fields to create your workspace.'), true;
    if (!ctx.isValidEmail(email)) return ctx.badRequest(res, 'Use a valid email address.'), true;
    if (password.length < 8) return ctx.badRequest(res, 'Use at least 8 characters for your password.'), true;
    const store = await ctx.loadStore({ email });
    if (ctx.findUserByEmail(store, email)) return ctx.badRequest(res, 'An account with this email already exists.'), true;

    const createdAt = new Date().toISOString();
    const workspace = {
      id: ctx.uid('workspace'),
      name: company,
      replyEmail: email,
      firstFollowupDays: 2,
      secondFollowupDays: 5,
      notes: ctx.withWorkspaceMeta({ createdAt }, 'Keep quote follow ups concise, direct, and easy to reply to.'),
      trialEndsAt: ctx.addDays(String(createdAt).slice(0, 10), 7),
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
      id: ctx.uid('user'),
      workspaceId: workspace.id,
      name,
      email,
      passwordHash: ctx.hashPassword(password),
      verified: false,
      verificationToken: '',
      verificationTokenExpiresAt: null,
      resetToken: '',
      resetTokenExpiresAt: null,
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    ctx.setVerificationToken(user);
    store.workspaces.push(workspace);
    store.users.push(user);
    ctx.seedWorkspace(store, workspace, user);
    await ctx.saveChanges({
      workspaces: [workspace],
      users: [user],
      teamMembers: store.teamMembers.filter((member) => member.workspaceId === workspace.id),
      quotes: store.quotes.filter((quote) => quote.workspaceId === workspace.id),
    });
    const delivery = await ctx.attemptEmail(() => ctx.sendVerificationEmail(req, user));
    ctx.sendJson(res, 201, {
      ok: true,
      email,
      emailSent: Boolean(delivery.sent),
      verifyUrl: !delivery.sent && ctx.shouldExposeDirectAuthLinks() ? `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}` : null,
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/auth/check-email') {
    if (!(await ctx.enforceRateLimit(req, res, 'checkEmail'))) return true;
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    const genericResponse = ctx.getGenericCheckEmailResponse(email);
    if (!ctx.isValidEmail(email)) {
      ctx.sendJson(res, 200, genericResponse);
      return true;
    }
    const store = await ctx.loadStore({ email });
    const user = ctx.findUserByEmail(store, email);
    if (!user) {
      ctx.sendJson(res, 200, genericResponse);
      return true;
    }
    ctx.clearExpiredAuthTokens(user);
    ctx.sendJson(res, 200, {
      ...genericResponse,
      verifyUrl: ctx.shouldExposeDirectAuthLinks() && !ctx.config.RESEND_API_KEY && !user.verified && user.verificationToken
        ? `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}`
        : null,
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/resend-verification') {
    if (!(await ctx.enforceRateLimit(req, res, 'resendVerification'))) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const email = String(body.email || '').trim().toLowerCase();
    if (!ctx.isValidEmail(email)) return ctx.badRequest(res, 'Enter a valid email address.'), true;
    const genericResponse = {
      ok: true,
      sent: false,
      emailDeliveryAvailable: Boolean(ctx.config.RESEND_API_KEY),
      verifyUrl: null,
    };
    const store = await ctx.loadStore({ email });
    const user = ctx.findUserByEmail(store, email);
    if (!user) {
      ctx.sendJson(res, 200, genericResponse);
      return true;
    }
    ctx.clearExpiredAuthTokens(user);
    if (user.verified) {
      ctx.sendJson(res, 200, genericResponse);
      return true;
    }
    if (!user.verificationToken) ctx.setVerificationToken(user);
    await ctx.saveChanges({ users: [user] });
    const delivery = await ctx.attemptEmail(() => ctx.sendVerificationEmail(req, user));
    ctx.sendJson(res, 200, {
      ...genericResponse,
      sent: Boolean(delivery.sent),
      verifyUrl: !delivery.sent && ctx.shouldExposeDirectAuthLinks()
        ? `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}`
        : null,
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    if (!(await ctx.enforceRateLimit(req, res, 'login'))) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!ctx.isValidEmail(email)) return ctx.badRequest(res, ctx.GENERIC_LOGIN_ERROR), true;
    const store = await ctx.loadStore({ email });
    const user = ctx.findUserByEmail(store, email);
    if (!user || !user.passwordHash || !ctx.verifyPassword(password, user.passwordHash) || !user.verified) {
      ctx.badRequest(res, ctx.GENERIC_LOGIN_ERROR);
      return true;
    }
    user.lastSeenAt = new Date().toISOString();
    await ctx.saveChanges({ users: [user] });
    await ctx.createSession(req, res, user.id);
    ctx.sendJson(res, 200, { ok: true, user: ctx.sanitizeUser(user) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    if (!ctx.ensureSameOrigin(req, res)) return true;
    await ctx.clearSession(req, res);
    ctx.sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/verify') {
    if (!(await ctx.enforceRateLimit(req, res, 'verify'))) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const token = String(body.token || '').trim();
    const store = await ctx.loadStore({ verificationToken: token });
    const user = store.users.find((item) => item.verificationToken === token);
    const tokenValid = user && (!user.verificationTokenExpiresAt || ctx.isFutureIsoDate(user.verificationTokenExpiresAt));
    if (!tokenValid) return ctx.badRequest(res, 'That verification link is invalid or expired.'), true;
    user.verified = true;
    delete user.verificationToken;
    user.verificationTokenExpiresAt = null;
    await ctx.saveChanges({ users: [user] });
    ctx.sendJson(res, 200, { ok: true, email: user.email });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/forgot-password') {
    if (!(await ctx.enforceRateLimit(req, res, 'forgotPassword'))) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const email = String(body.email || '').trim().toLowerCase();
    if (!ctx.isValidEmail(email)) return ctx.badRequest(res, 'Enter a valid email address.'), true;
    const store = await ctx.loadStore({ email });
    const user = ctx.findUserByEmail(store, email);
    if (!user) {
      ctx.sendJson(res, 200, { ok: true, sent: false, emailDeliveryAvailable: Boolean(ctx.config.RESEND_API_KEY), resetUrl: null });
      return true;
    }
    ctx.clearExpiredAuthTokens(user);
    ctx.setResetToken(user);
    await ctx.saveChanges({ users: [user] });
    const delivery = await ctx.attemptEmail(() => ctx.sendPasswordResetEmail(req, user));
    ctx.sendJson(res, 200, {
      ok: true,
      sent: Boolean(delivery.sent),
      emailDeliveryAvailable: Boolean(ctx.config.RESEND_API_KEY),
      resetUrl: !delivery.sent && ctx.shouldExposeDirectAuthLinks() ? `/landing-page/reset-password.html?token=${encodeURIComponent(user.resetToken)}` : null,
    });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    if (!(await ctx.enforceRateLimit(req, res, 'resetPassword'))) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const token = String(body.token || '').trim();
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');
    const store = await ctx.loadStore({ resetToken: token });
    const user = store.users.find((item) => item.resetToken === token);
    const tokenValid = user && (!user.resetTokenExpiresAt || ctx.isFutureIsoDate(user.resetTokenExpiresAt));
    if (!tokenValid) return ctx.badRequest(res, 'That reset link is invalid or expired.'), true;
    if (password.length < 8) return ctx.badRequest(res, 'Use at least 8 characters for your new password.'), true;
    if (password !== confirmPassword) return ctx.badRequest(res, 'Passwords do not match.'), true;
    user.passwordHash = ctx.hashPassword(password);
    delete user.resetToken;
    user.resetTokenExpiresAt = null;
    await ctx.saveChanges({ users: [user] });
    ctx.sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = {
  handleAuthRoutes,
};
