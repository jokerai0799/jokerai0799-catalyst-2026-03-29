const {
  ALLOWED_QUOTE_ACTIONS,
  addDays,
  clampText,
  isValidEmail,
  normalizeCurrency,
  normalizeDate,
  normalizeName,
  normalizeQuoteStatus,
  normalizeRole,
  today,
  uid,
} = require('./utils');
const {
  STRIPE_BUSINESS_PAYMENT_LINK,
  STRIPE_BUSINESS_PRICE_ID,
  STRIPE_CUSTOMER_PORTAL_URL,
  STRIPE_PERSONAL_PAYMENT_LINK,
  STRIPE_PERSONAL_PRICE_ID,
} = require('./config');
const { isSupabaseReady, loadStore: loadSupabaseStore, saveStore: saveSupabaseStore } = require('./supabase');

const WORKSPACE_META_PATTERN = /^<!--qfu:([^>]+)-->/;

function parseWorkspaceMeta(workspace) {
  const rawNotes = String(workspace?.notes || '');
  const match = rawNotes.match(WORKSPACE_META_PATTERN);
  const meta = {
    planTier: 'personal',
    trialEndsAt: workspace?.createdAt ? addDays(String(workspace.createdAt).slice(0, 10), 7) : addDays(today(), 7),
  };
  if (!match) return meta;
  for (const part of match[1].split(';')) {
    const [key, value] = part.split('=').map((item) => String(item || '').trim());
    if (!key) continue;
    if (key === 'plan' && (value === 'personal' || value === 'business')) meta.planTier = value;
    if (key === 'trialEndsAt' && value) meta.trialEndsAt = value;
  }
  return meta;
}

function getVisibleWorkspaceNotes(workspace) {
  return String(workspace?.notes || '').replace(WORKSPACE_META_PATTERN, '').trim();
}

function withWorkspaceMeta(workspace, notes, overrides = {}) {
  const current = parseWorkspaceMeta(workspace);
  const planTier = overrides.planTier || current.planTier || 'personal';
  const trialEndsAt = overrides.trialEndsAt || current.trialEndsAt || addDays(today(), 7);
  const visibleNotes = clampText(notes, 2000);
  const meta = `<!--qfu:plan=${planTier};trialEndsAt=${trialEndsAt}-->`;
  return visibleNotes ? `${meta}\n${visibleNotes}` : meta;
}

function getWorkspacePlanTier(workspace) {
  if (workspace?.billingPlanTier === 'business' || workspace?.billingPlanTier === 'personal') return workspace.billingPlanTier;
  return parseWorkspaceMeta(workspace).planTier;
}

function isWorkspaceTrialActive(workspace) {
  const meta = parseWorkspaceMeta(workspace);
  return Boolean(meta.trialEndsAt && meta.trialEndsAt >= today());
}

function isWorkspacePaid(workspace) {
  const status = String(workspace?.billingStatus || '').toLowerCase();
  return ['active', 'trialing'].includes(status);
}

function isWorkspaceReadOnly(workspace) {
  return !isWorkspaceTrialActive(workspace) && !isWorkspacePaid(workspace);
}

function isTeamFeatureUnlocked(workspace) {
  return getWorkspacePlanTier(workspace) === 'business' && isWorkspacePaid(workspace);
}

function getWorkspaceBilling(workspace) {
  const planTier = getWorkspacePlanTier(workspace);
  const defaultPriceId = planTier === 'business' ? STRIPE_BUSINESS_PRICE_ID : STRIPE_PERSONAL_PRICE_ID;
  return {
    planTier,
    billingStatus: workspace?.billingStatus || (isWorkspaceTrialActive(workspace) ? 'trialing' : 'inactive'),
    billingCurrency: workspace?.billingCurrency || 'GBP',
    stripeCustomerId: workspace?.stripeCustomerId || '',
    stripeSubscriptionId: workspace?.stripeSubscriptionId || '',
    stripePriceId: workspace?.stripePriceId || defaultPriceId,
    stripeCurrentPeriodEnd: workspace?.stripeCurrentPeriodEnd || null,
    checkoutLinks: {
      personal: STRIPE_PERSONAL_PAYMENT_LINK,
      business: STRIPE_BUSINESS_PAYMENT_LINK,
    },
    portalUrl: STRIPE_CUSTOMER_PORTAL_URL || '',
    upgradeTarget: 'business',
  };
}

function findUserByEmail(store, email) {
  return store.users.find((user) => user.email.toLowerCase() === String(email || '').trim().toLowerCase()) || null;
}

function getWorkspace(store, workspaceId) {
  return store.workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

function getActiveWorkspace(store, user) {
  return getWorkspace(store, store.activeWorkspaceId || user.workspaceId);
}

function getWorkspaceQuotes(store, workspaceId) {
  return store.quotes.filter((quote) => quote.workspaceId === workspaceId);
}

function getWorkspaceTeam(store, workspaceId) {
  return store.teamMembers.filter((member) => member.workspaceId === workspaceId);
}

function getWorkspaceInvites(store, workspaceId) {
  return (store.invites || []).filter((invite) => invite.workspaceId === workspaceId);
}

function getIncomingInvites(store, email) {
  const targetEmail = String(email || '').trim().toLowerCase();
  return (store.invites || []).filter((invite) => invite.status === 'pending' && String(invite.inviteeEmail || '').trim().toLowerCase() === targetEmail);
}

function getWorkspaceOwnerNames(store, workspaceId) {
  return new Set(getWorkspaceTeam(store, workspaceId).map((member) => member.name));
}

function buildQuoteInput(body, auth, store, existingQuote = null) {
  const ownerNames = getWorkspaceOwnerNames(store, auth.workspace.id);
  const title = clampText(body.title, 160);
  const customer = clampText(body.customer, 160) || title;
  const requestedOwner = normalizeName(body.owner);
  const fallbackOwner = existingQuote?.owner || auth.user.name;
  const owner = ownerNames.has(requestedOwner) ? requestedOwner : fallbackOwner;
  const status = normalizeQuoteStatus(body.status, existingQuote?.status || 'Draft');
  const value = normalizeCurrency(body.value);
  const sentDate = normalizeDate(body.sentDate, existingQuote?.sentDate || today());
  const nextFollowUp = normalizeDate(body.nextFollowUp, existingQuote?.nextFollowUp || addDays(sentDate, auth.workspace.firstFollowupDays || 2));
  const customerEmail = String(body.customerEmail || existingQuote?.customerEmail || '').trim().toLowerCase();
  const notes = clampText(body.notes, 4000);
  return { title, customer, owner, status, value, sentDate, nextFollowUp, notes, customerEmail };
}

function ensureQuoteMeta(quote) {
  if (!isValidEmail(quote.customerEmail)) quote.customerEmail = '';
  if (!Array.isArray(quote.history)) quote.history = [];
  if (typeof quote.archived !== 'boolean') quote.archived = false;
  return quote;
}

function recordQuoteEvent(quote, summary, detail) {
  ensureQuoteMeta(quote);
  quote.history.unshift({ id: uid('event'), summary, detail, createdAt: new Date().toISOString() });
  quote.history = quote.history.slice(0, 12);
}

function seedWorkspace(store, workspace, ownerUser) {
  const ownerName = ownerUser.name || 'Owner';
  const ownerEmail = ownerUser.email || 'owner@example.com';
  const teamUnlocked = isTeamFeatureUnlocked(workspace);
  if (teamUnlocked) {
    const existingTeam = getWorkspaceTeam(store, workspace.id);
    if (!existingTeam.length) {
      store.teamMembers.push(
        { id: uid('team'), workspaceId: workspace.id, name: ownerName, email: ownerEmail, role: 'Owner', activeQuotes: 0, createdAt: new Date().toISOString() },
        { id: uid('team'), workspaceId: workspace.id, name: 'Ella', email: 'ella@example.com', role: 'Ops', activeQuotes: 0, createdAt: new Date().toISOString() },
        { id: uid('team'), workspaceId: workspace.id, name: 'Lewis', email: 'lewis@example.com', role: 'Estimator', activeQuotes: 0, createdAt: new Date().toISOString() },
      );
    }
  }
  if (getWorkspaceQuotes(store, workspace.id).length) return;
  const quotes = teamUnlocked ? [
    ['Kitchen rewiring - Harris', 'Harris', ownerName, 'Follow up due', 3250, -4, -2, 'Customer asked for two options and wants a callback after 4pm.'],
    ['Boiler replacement - Ahmed', 'Ahmed', 'Ella', 'Follow up due', 2940, -2, 0, 'Awaiting final confirmation on timing.'],
    ['Office repaint - Carter', 'Carter', 'Lewis', 'Sent', 1780, -1, 1, 'Commercial repaint quote sent yesterday.'],
    ['Garden wall repair - Patel', 'Patel', ownerName, 'Won', 1150, -7, -1, 'Approved and booked in.'],
  ] : [
    ['Kitchen rewiring - Harris', 'Harris', ownerName, 'Follow up due', 3250, -4, -2, 'Customer asked for two options and wants a callback after 4pm.'],
    ['Boiler replacement - Ahmed', 'Ahmed', ownerName, 'Follow up due', 2940, -2, 0, 'Awaiting final confirmation on timing.'],
    ['Office repaint - Carter', 'Carter', ownerName, 'Sent', 1780, -1, 1, 'Commercial repaint quote sent yesterday.'],
    ['Garden wall repair - Patel', 'Patel', ownerName, 'Won', 1150, -7, -1, 'Approved and booked in.'],
  ];
  for (const [title, customer, owner, status, value, sentOffset, followOffset, notes] of quotes) {
    const quote = {
      id: uid('quote'),
      workspaceId: workspace.id,
      title,
      customer,
      owner,
      status,
      value,
      sentDate: addDays(today(), sentOffset),
      nextFollowUp: addDays(today(), followOffset),
      notes,
      createdAt: new Date().toISOString(),
      archived: false,
      history: [],
    };
    recordQuoteEvent(quote, 'Quote imported', `Seeded demo record for ${customer}.`);
    store.quotes.push(quote);
  }
}

async function loadStore(scope = {}) {
  if (!(await isSupabaseReady())) {
    const error = new Error('Supabase is not configured or not ready.');
    error.status = 503;
    throw error;
  }
  return loadSupabaseStore(scope);
}

async function saveStore(store) {
  return saveSupabaseStore(store);
}

function sanitizeUser(user, store = null) {
  return {
    id: user.id,
    workspaceId: user.workspaceId,
    activeWorkspaceId: store?.activeWorkspaceId || user.workspaceId,
    name: user.name,
    email: user.email,
    verified: Boolean(user.verified),
  };
}

function queueStoreDelete(store, table, id) {
  if (!id) return;
  if (!store.__deletes || typeof store.__deletes !== 'object') store.__deletes = {};
  if (!Array.isArray(store.__deletes[table])) store.__deletes[table] = [];
  store.__deletes[table].push(id);
}

function buildBootstrap(store, user) {
  const workspace = getActiveWorkspace(store, user);
  const meta = parseWorkspaceMeta(workspace);
  const quotes = getWorkspaceQuotes(store, workspace.id).map((quote) => ensureQuoteMeta({ ...quote }));
  const teamMembers = getWorkspaceTeam(store, workspace.id).map((member) => ({ ...member }));
  const pendingInvites = getWorkspaceInvites(store, workspace.id)
    .filter((invite) => invite.status === 'pending')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const incomingInvites = getIncomingInvites(store, user.email)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  teamMembers.forEach((member) => {
    member.activeQuotes = quotes.filter((quote) => quote.owner === member.name && !['Won', 'Lost', 'Archived'].includes(quote.status)).length;
  });
  const billing = getWorkspaceBilling(workspace);
  const trialActive = meta.trialEndsAt >= today();
  const readOnly = isWorkspaceReadOnly(workspace);
  return {
    user: sanitizeUser(user, store),
    workspace: {
      ...workspace,
      notes: getVisibleWorkspaceNotes(workspace),
      planTier: billing.planTier,
      trialEndsAt: meta.trialEndsAt,
      trialActive,
      readOnly,
      readOnlyReason: readOnly ? 'Your 7 day trial has ended. Choose Personal or Business to unlock editing again.' : '',
      teamEnabled: isTeamFeatureUnlocked(workspace),
      billing,
    },
    quotes,
    teamMembers,
    pendingInvites,
    incomingInvites,
    accessibleWorkspaces: (store.accessibleWorkspaces || []).map((workspaceAccess) => ({ ...workspaceAccess })),
  };
}

async function withUser(req, res, store, getSessionUser, unauthorized) {
  const user = await getSessionUser(req, store);
  if (!user) {
    unauthorized(res);
    return null;
  }
  const workspace = getActiveWorkspace(store, user);
  if (!workspace) {
    unauthorized(res);
    return null;
  }
  return { user, workspace };
}

module.exports = {
  ALLOWED_QUOTE_ACTIONS,
  buildBootstrap,
  buildQuoteInput,
  ensureQuoteMeta,
  findUserByEmail,
  getIncomingInvites,
  getVisibleWorkspaceNotes,
  getWorkspaceInvites,
  getWorkspacePlanTier,
  getActiveWorkspace,
  getWorkspace,
  getWorkspaceQuotes,
  getWorkspaceTeam,
  loadStore,
  queueStoreDelete,
  recordQuoteEvent,
  sanitizeUser,
  saveStore,
  seedWorkspace,
  withWorkspaceMeta,
  withUser,
  isValidEmail,
  normalizeName,
  normalizeRole,
  isWorkspaceTrialActive,
  isWorkspacePaid,
  isWorkspaceReadOnly,
  isTeamFeatureUnlocked,
  getWorkspaceBilling,
};
