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
  return parseWorkspaceMeta(workspace).planTier;
}

function isWorkspaceTrialActive(workspace) {
  const meta = parseWorkspaceMeta(workspace);
  return Boolean(meta.trialEndsAt && meta.trialEndsAt >= today());
}

function isTeamFeatureUnlocked(workspace) {
  return getWorkspacePlanTier(workspace) === 'business' && !isWorkspaceTrialActive(workspace);
}

function findUserByEmail(store, email) {
  return store.users.find((user) => user.email.toLowerCase() === String(email || '').trim().toLowerCase()) || null;
}

function getWorkspace(store, workspaceId) {
  return store.workspaces.find((workspace) => workspace.id === workspaceId) || null;
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

async function loadStore() {
  if (!(await isSupabaseReady())) {
    const error = new Error('Supabase is not configured or not ready.');
    error.status = 503;
    throw error;
  }
  return loadSupabaseStore();
}

async function saveStore(store) {
  return saveSupabaseStore(store);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    workspaceId: user.workspaceId,
    name: user.name,
    email: user.email,
    verified: Boolean(user.verified),
  };
}

function buildBootstrap(store, user) {
  const workspace = getWorkspace(store, user.workspaceId);
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
  return {
    user: sanitizeUser(user),
    workspace: {
      ...workspace,
      notes: getVisibleWorkspaceNotes(workspace),
      planTier: meta.planTier,
      trialEndsAt: meta.trialEndsAt,
      trialActive: meta.trialEndsAt >= today(),
      teamEnabled: isTeamFeatureUnlocked(workspace),
    },
    quotes,
    teamMembers,
    pendingInvites,
    incomingInvites,
  };
}

async function withUser(req, res, store, getSessionUser, unauthorized) {
  const user = await getSessionUser(req, store);
  if (!user) {
    unauthorized(res);
    return null;
  }
  const workspace = getWorkspace(store, user.workspaceId);
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
  getWorkspace,
  getWorkspaceQuotes,
  getWorkspaceTeam,
  loadStore,
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
  isTeamFeatureUnlocked,
};
