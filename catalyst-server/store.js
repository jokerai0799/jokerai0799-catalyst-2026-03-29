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
  const existingTeam = getWorkspaceTeam(store, workspace.id);
  if (!existingTeam.length) {
    store.teamMembers.push(
      { id: uid('team'), workspaceId: workspace.id, name: ownerName, email: ownerEmail, role: 'Owner', activeQuotes: 0, createdAt: new Date().toISOString() },
      { id: uid('team'), workspaceId: workspace.id, name: 'Ella', email: 'ella@example.com', role: 'Ops', activeQuotes: 0, createdAt: new Date().toISOString() },
      { id: uid('team'), workspaceId: workspace.id, name: 'Lewis', email: 'lewis@example.com', role: 'Estimator', activeQuotes: 0, createdAt: new Date().toISOString() },
    );
  }
  if (getWorkspaceQuotes(store, workspace.id).length) return;
  const quotes = [
    ['Kitchen rewiring - Harris', 'Harris', ownerName, 'Follow up due', 3250, -4, -2, 'Customer asked for two options and wants a callback after 4pm.'],
    ['Boiler replacement - Ahmed', 'Ahmed', 'Ella', 'Follow up due', 2940, -2, 0, 'Awaiting final confirmation on timing.'],
    ['Office repaint - Carter', 'Carter', 'Lewis', 'Sent', 1780, -1, 1, 'Commercial repaint quote sent yesterday.'],
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
  const quotes = getWorkspaceQuotes(store, workspace.id).map((quote) => ensureQuoteMeta({ ...quote }));
  const teamMembers = getWorkspaceTeam(store, workspace.id).map((member) => ({ ...member }));
  teamMembers.forEach((member) => {
    member.activeQuotes = quotes.filter((quote) => quote.owner === member.name && !['Won', 'Lost', 'Archived'].includes(quote.status)).length;
  });
  return { user: sanitizeUser(user), workspace, quotes, teamMembers };
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
  getWorkspace,
  getWorkspaceQuotes,
  getWorkspaceTeam,
  loadStore,
  recordQuoteEvent,
  sanitizeUser,
  saveStore,
  seedWorkspace,
  withUser,
  isValidEmail,
  normalizeName,
  normalizeRole,
};
