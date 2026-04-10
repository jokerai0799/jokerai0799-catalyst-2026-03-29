const { SUPABASE_BASE_URL, SUPABASE_SERVICE_KEY } = require('./config');
const { isoDate } = require('./utils');

const SUPABASE_ENABLED = Boolean(SUPABASE_BASE_URL && SUPABASE_SERVICE_KEY);
let supabaseReadyCache = null;
let supabaseCheckedAt = 0;
const SUPABASE_RECHECK_MS = 60_000;

async function supabaseRequest(resource, { method = 'GET', body, headers = {}, allow404 = false } = {}) {
  const response = await fetch(`${SUPABASE_BASE_URL}/rest/v1/${resource}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  if (allow404 && response.status === 404) return null;

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Supabase ${method} ${resource} failed (${response.status})`);
    error.status = response.status;
    error.body = text;
    throw error;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function isSupabaseReady() {
  if (!SUPABASE_ENABLED) return false;
  const now = Date.now();
  if (supabaseReadyCache === true && now - supabaseCheckedAt < SUPABASE_RECHECK_MS) return true;
  if (supabaseReadyCache === false && now - supabaseCheckedAt < SUPABASE_RECHECK_MS) return false;
  try {
    const result = await supabaseRequest('workspaces?select=id&limit=1', { allow404: true });
    supabaseReadyCache = Array.isArray(result) || result === null;
  } catch {
    supabaseReadyCache = false;
  }
  supabaseCheckedAt = now;
  return supabaseReadyCache;
}

function mapWorkspaceFromDb(row) {
  return {
    id: row.id,
    name: row.name,
    replyEmail: row.reply_email,
    firstFollowupDays: Number(row.first_followup_days || 2),
    secondFollowupDays: Number(row.second_followup_days || 5),
    notes: row.notes || '',
    billingPlanTier: row.billing_plan_tier || null,
    billingStatus: row.billing_status || null,
    billingCurrency: row.billing_currency || null,
    stripeCustomerId: row.stripe_customer_id || '',
    stripeSubscriptionId: row.stripe_subscription_id || '',
    stripePriceId: row.stripe_price_id || '',
    stripeCurrentPeriodEnd: row.stripe_current_period_end ? isoDate(row.stripe_current_period_end) : null,
    createdAt: isoDate(row.created_at),
  };
}

function mapUserFromDb(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    verified: Boolean(row.verified),
    verificationToken: row.verification_token || undefined,
    verificationTokenExpiresAt: row.verification_token_expires_at ? isoDate(row.verification_token_expires_at) : null,
    resetToken: row.reset_token || undefined,
    resetTokenExpiresAt: row.reset_token_expires_at ? isoDate(row.reset_token_expires_at) : null,
    lastSeenAt: row.last_seen_at ? isoDate(row.last_seen_at) : null,
    createdAt: isoDate(row.created_at),
  };
}

function mapQuoteFromDb(row, eventsByQuote) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    customer: row.customer,
    customerEmail: row.customer_email || '',
    owner: row.owner,
    status: row.status,
    value: Number(row.value || 0),
    sentDate: row.sent_date,
    nextFollowUp: row.next_follow_up,
    notes: row.notes || '',
    createdAt: isoDate(row.created_at),
    archived: Boolean(row.archived),
    history: (eventsByQuote.get(row.id) || []).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
  };
}

function mapTeamMemberFromDb(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    email: row.email,
    role: row.role,
    activeQuotes: Number(row.active_quotes || 0),
    createdAt: isoDate(row.created_at),
  };
}

function mapInviteFromDb(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    inviterUserId: row.inviter_user_id,
    inviterName: row.inviter_name || '',
    workspaceName: row.workspace_name || '',
    inviteeName: row.invitee_name || '',
    inviteeEmail: row.invitee_email,
    role: row.role,
    status: row.status || 'pending',
    createdAt: isoDate(row.created_at),
    respondedAt: row.responded_at ? isoDate(row.responded_at) : null,
  };
}

function mapWorkspaceToDb(row) {
  return {
    id: row.id,
    name: row.name,
    reply_email: row.replyEmail,
    first_followup_days: row.firstFollowupDays,
    second_followup_days: row.secondFollowupDays,
    notes: row.notes || '',
    billing_plan_tier: row.billingPlanTier || null,
    billing_status: row.billingStatus || null,
    billing_currency: row.billingCurrency || null,
    stripe_customer_id: row.stripeCustomerId || null,
    stripe_subscription_id: row.stripeSubscriptionId || null,
    stripe_price_id: row.stripePriceId || null,
    stripe_current_period_end: row.stripeCurrentPeriodEnd ? isoDate(row.stripeCurrentPeriodEnd) : null,
    created_at: isoDate(row.createdAt),
  };
}

function mapUserToDb(row) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    email: row.email,
    password_hash: row.passwordHash,
    verified: Boolean(row.verified),
    verification_token: row.verificationToken || null,
    verification_token_expires_at: row.verificationTokenExpiresAt ? isoDate(row.verificationTokenExpiresAt) : null,
    reset_token: row.resetToken || null,
    reset_token_expires_at: row.resetTokenExpiresAt ? isoDate(row.resetTokenExpiresAt) : null,
    last_seen_at: row.lastSeenAt ? isoDate(row.lastSeenAt) : null,
    created_at: isoDate(row.createdAt),
  };
}

function mapQuoteToDb(row) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    title: row.title,
    customer: row.customer,
    customer_email: row.customerEmail || null,
    owner: row.owner,
    status: row.status,
    value: Number(row.value || 0),
    sent_date: row.sentDate,
    next_follow_up: row.nextFollowUp,
    notes: row.notes || '',
    created_at: isoDate(row.createdAt),
    archived: Boolean(row.archived),
  };
}

function mapTeamMemberToDb(row) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    email: row.email,
    role: row.role,
    active_quotes: Number(row.activeQuotes || 0),
    created_at: isoDate(row.createdAt),
  };
}

function mapInviteToDb(row) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    inviter_user_id: row.inviterUserId,
    inviter_name: row.inviterName || '',
    workspace_name: row.workspaceName || '',
    invitee_name: row.inviteeName || '',
    invitee_email: row.inviteeEmail,
    role: row.role,
    status: row.status || 'pending',
    created_at: isoDate(row.createdAt),
    responded_at: row.respondedAt ? isoDate(row.respondedAt) : null,
  };
}

function flattenQuoteEvents(quotes) {
  return quotes.flatMap((quote) =>
    (Array.isArray(quote.history) ? quote.history : []).map((event) => ({
      id: event.id,
      quote_id: quote.id,
      summary: event.summary,
      detail: event.detail,
      created_at: isoDate(event.createdAt),
    })),
  );
}

function emptyStore() {
  return {
    users: [],
    workspaces: [],
    quotes: [],
    teamMembers: [],
    invites: [],
    __deletes: {},
  };
}

function dedupeById(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    if (!row?.id) continue;
    seen.set(row.id, row);
  }
  return Array.from(seen.values());
}

async function loadWorkspaceScope(workspaceRow, { usersRows, incomingInviteEmail, accessibleWorkspaces = [], activeWorkspaceId = null } = {}) {
  if (!workspaceRow?.id) return emptyStore();
  const [resolvedUsers, quotesRows, teamRows, inviteRows, incomingInviteRows, eventRows] = await Promise.all([
    usersRows ? Promise.resolve(usersRows) : supabaseRequest(`users?workspace_id=eq.${encodeURIComponent(workspaceRow.id)}&select=*`),
    supabaseRequest(`quotes?workspace_id=eq.${encodeURIComponent(workspaceRow.id)}&select=*`),
    supabaseRequest(`team_members?workspace_id=eq.${encodeURIComponent(workspaceRow.id)}&select=*`),
    supabaseRequest(`workspace_invites?workspace_id=eq.${encodeURIComponent(workspaceRow.id)}&select=*`, { allow404: true }),
    incomingInviteEmail
      ? supabaseRequest(`workspace_invites?invitee_email=eq.${encodeURIComponent(incomingInviteEmail)}&status=eq.pending&select=*`, { allow404: true })
      : Promise.resolve([]),
    supabaseRequest('quote_events?select=*'),
  ]);

  const quoteIds = new Set((quotesRows || []).map((row) => row.id));
  const eventsByQuote = new Map();
  for (const row of eventRows || []) {
    if (!quoteIds.has(row.quote_id)) continue;
    if (!eventsByQuote.has(row.quote_id)) eventsByQuote.set(row.quote_id, []);
    eventsByQuote.get(row.quote_id).push({
      id: row.id,
      summary: row.summary,
      detail: row.detail,
      createdAt: isoDate(row.created_at),
    });
  }

  return {
    users: (resolvedUsers || []).map(mapUserFromDb),
    workspaces: [mapWorkspaceFromDb(workspaceRow)],
    quotes: (quotesRows || []).map((row) => mapQuoteFromDb(row, eventsByQuote)),
    teamMembers: (teamRows || []).map(mapTeamMemberFromDb),
    invites: dedupeById([...(inviteRows || []), ...(incomingInviteRows || [])]).map(mapInviteFromDb),
    accessibleWorkspaces,
    activeWorkspaceId: activeWorkspaceId || workspaceRow.id,
    __deletes: {},
  };
}

async function loadUserScopedStore(userRow, requestedWorkspaceId) {
  if (!userRow) return emptyStore();
  const membershipRows = await supabaseRequest(`team_members?email=eq.${encodeURIComponent(userRow.email)}&select=*`);
  const workspaceIds = Array.from(new Set([userRow.workspace_id, ...(membershipRows || []).map((row) => row.workspace_id).filter(Boolean)]));
  const workspaceRows = (await Promise.all(workspaceIds.map((workspaceId) => supabaseRequest(`workspaces?id=eq.${encodeURIComponent(workspaceId)}&select=*`))))
    .map((rows) => rows?.[0] || null)
    .filter(Boolean);
  const membershipByWorkspace = new Map((membershipRows || []).map((row) => [row.workspace_id, row]));
  const accessibleWorkspaces = workspaceRows.map((workspaceRow) => {
    const membership = membershipByWorkspace.get(workspaceRow.id);
    const isPrimary = workspaceRow.id === userRow.workspace_id;
    return {
      id: workspaceRow.id,
      name: workspaceRow.name,
      role: isPrimary ? 'Owner' : (membership?.role || 'Member'),
      isPrimary,
      billingPlanTier: workspaceRow.billing_plan_tier || 'personal',
      billingStatus: workspaceRow.billing_status || 'inactive',
    };
  });
  const activeWorkspaceRow = workspaceRows.find((row) => row.id === requestedWorkspaceId) || workspaceRows.find((row) => row.id === userRow.workspace_id) || workspaceRows[0] || null;
  if (!activeWorkspaceRow) return { ...emptyStore(), users: [mapUserFromDb(userRow)], accessibleWorkspaces: [] };
  return loadWorkspaceScope(activeWorkspaceRow, {
    usersRows: [userRow],
    incomingInviteEmail: userRow.email,
    accessibleWorkspaces,
    activeWorkspaceId: activeWorkspaceRow.id,
  });
}

async function loadStore(scope = {}) {
  if (scope?.workspaceId && !scope?.userId && !scope?.email) {
    const workspaceRows = await supabaseRequest(`workspaces?id=eq.${encodeURIComponent(scope.workspaceId)}&select=*`);
    const workspaceRow = workspaceRows?.[0] || null;
    if (!workspaceRow) return emptyStore();
    return loadWorkspaceScope(workspaceRow, { incomingInviteEmail: scope.incomingInviteEmail });
  }

  if (scope?.userId) {
    const userRows = await supabaseRequest(`users?id=eq.${encodeURIComponent(scope.userId)}&select=*`);
    const userRow = userRows?.[0] || null;
    return loadUserScopedStore(userRow, scope.workspaceId);
  }

  if (scope?.email) {
    const userRows = await supabaseRequest(`users?email=eq.${encodeURIComponent(scope.email)}&select=*`);
    const userRow = userRows?.[0] || null;
    return loadUserScopedStore(userRow, scope.workspaceId);
  }

  if (scope?.verificationToken) {
    const userRows = await supabaseRequest(`users?verification_token=eq.${encodeURIComponent(scope.verificationToken)}&select=*`);
    const userRow = userRows?.[0] || null;
    return loadUserScopedStore(userRow, scope.workspaceId);
  }

  if (scope?.resetToken) {
    const userRows = await supabaseRequest(`users?reset_token=eq.${encodeURIComponent(scope.resetToken)}&select=*`);
    const userRow = userRows?.[0] || null;
    return loadUserScopedStore(userRow, scope.workspaceId);
  }

  const [workspacesRows, usersRows, quotesRows, teamRows, eventRows, inviteRows] = await Promise.all([
    supabaseRequest('workspaces?select=*'),
    supabaseRequest('users?select=*'),
    supabaseRequest('quotes?select=*'),
    supabaseRequest('team_members?select=*'),
    supabaseRequest('quote_events?select=*'),
    supabaseRequest('workspace_invites?select=*', { allow404: true }),
  ]);

  const eventsByQuote = new Map();
  for (const row of eventRows || []) {
    const quoteId = row.quote_id;
    if (!eventsByQuote.has(quoteId)) eventsByQuote.set(quoteId, []);
    eventsByQuote.get(quoteId).push({
      id: row.id,
      summary: row.summary,
      detail: row.detail,
      createdAt: isoDate(row.created_at),
    });
  }

  return {
    users: (usersRows || []).map(mapUserFromDb),
    workspaces: (workspacesRows || []).map(mapWorkspaceFromDb),
    quotes: (quotesRows || []).map((row) => mapQuoteFromDb(row, eventsByQuote)),
    teamMembers: (teamRows || []).map(mapTeamMemberFromDb),
    invites: (inviteRows || []).map(mapInviteFromDb),
    __deletes: {},
  };
}

function isMissingColumnError(error, columnName) {
  return error?.status === 400 && String(error?.body || '').includes(`Could not find the '${columnName}' column`);
}

async function syncTable(table, rows, mapper, { allowMissing = false } = {}) {
  if (allowMissing) {
    const existing = await supabaseRequest(`${table}?select=id&limit=1`, { allow404: true });
    if (existing == null) {
      if (rows.length) {
        const error = new Error(`Supabase table ${table} is missing.`);
        error.status = 503;
        throw error;
      }
      return;
    }
  }

  const desired = (rows || []).map(mapper);
  if (!desired.length) return;

  try {
    await supabaseRequest(table, {
      method: 'POST',
      body: desired,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  } catch (error) {
    if (table === 'users' && (isMissingColumnError(error, 'verification_token_expires_at') || isMissingColumnError(error, 'reset_token_expires_at') || isMissingColumnError(error, 'last_seen_at'))) {
      const legacyDesired = desired.map(({ verification_token_expires_at, reset_token_expires_at, last_seen_at, ...row }) => row);
      await supabaseRequest(table, {
        method: 'POST',
        body: legacyDesired,
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      });
      return;
    }
    throw error;
  }
}

async function deleteQueuedRows(table, ids, { allowMissing = false } = {}) {
  const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (!uniqueIds.length) return;
  for (const id of uniqueIds) {
    try {
      await supabaseRequest(`${table}?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
        allow404: allowMissing,
      });
    } catch (error) {
      if (allowMissing && error?.status === 404) continue;
      throw error;
    }
  }
}

async function saveStore(store) {
  await syncTable('workspaces', store.workspaces || [], mapWorkspaceToDb);
  await syncTable('users', store.users || [], mapUserToDb);
  await syncTable('team_members', store.teamMembers || [], mapTeamMemberToDb);
  await syncTable('quotes', store.quotes || [], mapQuoteToDb);
  await syncTable('quote_events', flattenQuoteEvents(store.quotes || []), (row) => row);
  await syncTable('workspace_invites', store.invites || [], mapInviteToDb, { allowMissing: true });

  const deletes = store.__deletes || {};
  await deleteQueuedRows('quotes', deletes.quotes);
  await deleteQueuedRows('team_members', deletes.team_members);
  await deleteQueuedRows('workspace_invites', deletes.workspace_invites, { allowMissing: true });
}

module.exports = {
  isSupabaseReady,
  loadStore,
  saveStore,
  supabaseRequest,
};
