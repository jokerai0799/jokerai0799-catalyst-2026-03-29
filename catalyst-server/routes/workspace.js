async function handleWorkspaceRoutes(req, res, url, ctx) {
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/workspace/select') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true });
    if (!auth) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const workspaceId = String(body.workspaceId || '').trim();
    if (!workspaceId) return ctx.badRequest(res, 'Choose a workspace first.'), true;
    const allowed = new Set((auth.store.accessibleWorkspaces || []).map((workspaceAccess) => workspaceAccess.id));
    if (!allowed.has(workspaceId)) return ctx.badRequest(res, 'You do not have access to that workspace.'), true;
    ctx.sendJson(res, 200, { ok: true, workspaceId });
    return true;
  }

  if (req.method === 'PATCH' && pathname === '/api/workspace') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true, ownerOnly: true, writable: true });
    if (!auth) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;

    auth.workspace.name = ctx.clampText(body.name, 160) || auth.workspace.name;
    const replyEmail = String(body.replyEmail || '').trim().toLowerCase();
    auth.workspace.replyEmail = ctx.isValidEmail(replyEmail) ? replyEmail : (auth.workspace.replyEmail || auth.user.email);
    auth.workspace.firstFollowupDays = Math.max(1, Number(body.firstFollowupDays || auth.workspace.firstFollowupDays || 2));
    auth.workspace.secondFollowupDays = Math.max(1, Number(body.secondFollowupDays || auth.workspace.secondFollowupDays || 5));
    if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
      auth.workspace.notes = ctx.withWorkspaceMeta(auth.workspace, body.notes, { planTier: ctx.getWorkspacePlanTier(auth.workspace) });
    }
    await ctx.saveChanges({ workspaces: [auth.workspace] });
    ctx.sendJson(res, 200, { ok: true, workspace: auth.workspace });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/team') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true, writable: true });
    if (!auth) return true;
    if (!ctx.isTeamFeatureUnlocked(auth.workspace)) {
      return ctx.badRequest(res, 'Team collaboration is available only inside an active Business workspace.'), true;
    }
    const currentMember = auth.store.teamMembers.find((member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === auth.user.email.toLowerCase());
    if (!currentMember || currentMember.role !== 'Owner') return ctx.unauthorized(res), true;

    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const name = ctx.normalizeName(body.name);
    const email = String(body.email || '').trim().toLowerCase();
    if (email === auth.user.email.toLowerCase()) {
      return ctx.badRequest(res, 'You are already part of this workspace.'), true;
    }
    const role = ctx.normalizeRole(body.role);
    if (!name || !email) return ctx.badRequest(res, 'Name and email are required.'), true;
    if (!ctx.isValidEmail(email)) return ctx.badRequest(res, 'Use a valid email address.'), true;
    if (auth.store.teamMembers.some((member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === email)) {
      return ctx.badRequest(res, 'A team member with that email already exists.'), true;
    }
    if (ctx.getWorkspaceMemberCount(auth.store, auth.workspace.id) >= ctx.BUSINESS_TEAM_MEMBER_LIMIT) {
      return ctx.badRequest(res, `Business supports up to ${ctx.BUSINESS_TEAM_MEMBER_LIMIT} users per workspace. Contact us if you need a larger team setup.`), true;
    }
    const existingPendingInvite = (auth.store.invites || []).find(
      (invite) => invite.workspaceId === auth.workspace.id && invite.status === 'pending' && String(invite.inviteeEmail || '').trim().toLowerCase() === email,
    );
    const existingUserStore = await ctx.loadStore({ email });
    const existingUser = ctx.findUserByEmail(existingUserStore, email);
    if (existingPendingInvite && !existingUser) {
      return ctx.badRequest(res, 'There is already a pending invite for that email.'), true;
    }
    if (!existingUser) {
      ctx.sendJson(res, 200, {
        ok: false,
        needsAccount: true,
        message: 'That member needs an account before they can join this workspace.',
      });
      return true;
    }
    const existingMembership = existingUserStore.teamMembers.some(
      (member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === email,
    ) || auth.store.teamMembers.some((member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === email);
    if (existingPendingInvite) {
      auth.store.invites = (auth.store.invites || []).filter((invite) => invite.id !== existingPendingInvite.id);
      ctx.queueStoreDelete(auth.store, 'workspace_invites', existingPendingInvite.id);
    }
    const newMember = !existingMembership ? {
      id: ctx.uid('team'),
      workspaceId: auth.workspace.id,
      userId: existingUser.id,
      name,
      email,
      role,
      activeQuotes: 0,
      createdAt: new Date().toISOString(),
    } : null;
    if (newMember) auth.store.teamMembers.push(newMember);
    await ctx.saveChanges({ teamMembers: newMember ? [newMember] : [], deletes: auth.store.__deletes || {} });
    ctx.sendJson(res, 201, {
      ok: true,
      joined: true,
      member: { name, email, role },
    });
    return true;
  }

  const inviteAcceptMatch = pathname.match(/^\/api\/invites\/([^/]+)\/accept$/);
  if (inviteAcceptMatch && req.method === 'POST') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true });
    if (!auth) return true;
    const invite = ctx.inviteForUser(auth.store, inviteAcceptMatch[1], auth.user.email);
    if (!invite) return ctx.notFound(res), true;
    if (auth.user.workspaceId !== invite.workspaceId) {
      return ctx.badRequest(res, 'You have a workspace invite waiting, but joining another workspace is not live yet.'), true;
    }
    const alreadyMember = auth.store.teamMembers.some(
      (member) => member.workspaceId === invite.workspaceId && member.email.toLowerCase() === auth.user.email.toLowerCase(),
    );
    if (!alreadyMember && ctx.getWorkspaceMemberCount(auth.store, invite.workspaceId) >= ctx.BUSINESS_TEAM_MEMBER_LIMIT) {
      return ctx.badRequest(res, `This workspace already has ${ctx.BUSINESS_TEAM_MEMBER_LIMIT} users. Contact us if you need a larger team setup.`), true;
    }
    const acceptedMember = !alreadyMember ? {
      id: ctx.uid('team'),
      workspaceId: invite.workspaceId,
      userId: auth.user.id,
      name: ctx.normalizeName(auth.user.name || invite.inviteeName || auth.user.email.split('@')[0]),
      email: auth.user.email,
      role: ctx.normalizeRole(invite.role),
      activeQuotes: 0,
      createdAt: new Date().toISOString(),
    } : null;
    if (acceptedMember) auth.store.teamMembers.push(acceptedMember);
    invite.status = 'accepted';
    invite.respondedAt = new Date().toISOString();
    await ctx.saveChanges({ teamMembers: acceptedMember ? [acceptedMember] : [], invites: [invite] });
    ctx.sendJson(res, 200, { ok: true, invite });
    return true;
  }

  const inviteDeclineMatch = pathname.match(/^\/api\/invites\/([^/]+)\/decline$/);
  if (inviteDeclineMatch && req.method === 'POST') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true });
    if (!auth) return true;
    const invite = ctx.inviteForUser(auth.store, inviteDeclineMatch[1], auth.user.email);
    if (!invite) return ctx.notFound(res), true;
    invite.status = 'declined';
    invite.respondedAt = new Date().toISOString();
    await ctx.saveChanges({ invites: [invite] });
    ctx.sendJson(res, 200, { ok: true, invite });
    return true;
  }

  const teamMatch = pathname.match(/^\/api\/team\/([^/]+)$/);
  if (teamMatch && req.method === 'DELETE') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true, writable: true });
    if (!auth) return true;
    if (!ctx.isTeamFeatureUnlocked(auth.workspace)) {
      return ctx.badRequest(res, 'Team collaboration is available only inside an active Business workspace.'), true;
    }
    const currentMember = auth.store.teamMembers.find((member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === auth.user.email.toLowerCase());
    if (!currentMember || currentMember.role !== 'Owner') return ctx.unauthorized(res), true;

    const target = auth.store.teamMembers.find((member) => member.id === teamMatch[1] && member.workspaceId === auth.workspace.id);
    if (!target) return ctx.notFound(res), true;

    const ownerMembers = auth.store.teamMembers.filter((member) => member.workspaceId === auth.workspace.id && member.role === 'Owner');
    if (target.email.toLowerCase() === auth.user.email.toLowerCase() && ownerMembers.length <= 1) {
      return ctx.badRequest(res, 'You cannot remove the last owner from the workspace.'), true;
    }

    const replacementMember = currentMember.id === target.id
      ? ownerMembers.find((member) => member.id !== target.id) || currentMember
      : currentMember;
    const replacementOwner = replacementMember?.name || auth.user.name;

    auth.store.teamMembers = auth.store.teamMembers.filter((member) => member.id !== target.id);
    ctx.queueStoreDelete(auth.store, 'team_members', target.id);
    const reassignedQuotes = [];
    auth.store.quotes.forEach((quote) => {
      if (quote.workspaceId === auth.workspace.id && ctx.quoteOwnedByMember(quote, target)) {
        quote.owner = replacementOwner;
        quote.ownerTeamMemberId = replacementMember?.id || null;
        ctx.recordQuoteEvent(quote, 'Quote reassigned', `Ownership moved from ${target.name} to ${replacementOwner}.`);
        reassignedQuotes.push(quote);
      }
    });
    await ctx.saveChanges({ quotes: reassignedQuotes, deletes: auth.store.__deletes || {} });
    ctx.sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = {
  handleWorkspaceRoutes,
};
