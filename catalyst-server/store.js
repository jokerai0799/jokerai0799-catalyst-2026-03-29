const {
  ALLOWED_QUOTE_ACTIONS,
  addDays,
  clampText,
  hashPassword,
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
  const notes = clampText(body.notes, 4000);
  return { title, customer, owner, status, value, sentDate, nextFollowUp, notes };
}

function ensureQuoteMeta(quote) {
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

function ensureDemoWorkspaceRichData(store, workspace) {
  const existingQuotes = getWorkspaceQuotes(store, workspace.id);
  const existingTeam = getWorkspaceTeam(store, workspace.id);
  const members = [
    { name: 'Ella', email: 'ella@example.com', role: 'Ops' },
    { name: 'Lewis', email: 'lewis@example.com', role: 'Estimator' },
    { name: 'Sam', email: 'sam@example.com', role: 'Sales' },
    { name: 'Nina', email: 'nina@example.com', role: 'Admin' },
  ];
  if (existingTeam.length < 5) {
    for (const member of members) {
      if (!store.teamMembers.some((item) => item.workspaceId === workspace.id && item.email === member.email)) {
        store.teamMembers.push({ id: uid('team'), workspaceId: workspace.id, activeQuotes: 0, createdAt: new Date().toISOString(), ...member });
      }
    }
  }
  if (existingQuotes.length >= 18) return;
  const seedQuotes = [
    ['Kitchen rewiring - Harris', 'Harris', 'Demo User', 'Follow up due', 3250, -4, -2, 'Customer asked for two options and wants a callback after 4pm.'],
    ['Boiler replacement - Ahmed', 'Ahmed', 'Ella', 'Follow up due', 2940, -2, 0, 'Awaiting final confirmation on timing.'],
    ['Office repaint - Carter', 'Carter', 'Lewis', 'Sent', 1780, -1, 1, 'Commercial repaint quote sent yesterday.'],
    ['Garden wall repair - Patel', 'Patel', 'Demo User', 'Won', 1150, -7, -1, 'Approved and booked in.'],
    ['Bathroom refit - Morgan', 'Morgan', 'Sam', 'Sent', 6840, -3, 1, 'Needs decision on premium fittings.'],
    ['Driveway clean - Wilkes', 'Wilkes', 'Ella', 'Follow up due', 890, -5, -1, 'Customer opened the quote twice.'],
    ['Loft insulation - Green', 'Green', 'Lewis', 'Draft', 2210, 0, 2, 'Waiting for updated measurements.'],
    ['Shop signage install - Barnes', 'Barnes', 'Sam', 'Replied', 4120, -6, 3, 'Asked for split payment option.'],
    ['Roof repair - Collins', 'Collins', 'Demo User', 'Follow up due', 5760, -8, -3, 'Storm damage quote, high urgency.'],
    ['Patio sealing - Jacobs', 'Jacobs', 'Ella', 'Sent', 960, -2, 2, 'Sent after site visit.'],
    ['Warehouse lighting - Singh', 'Singh', 'Lewis', 'Won', 9320, -10, -2, 'Booked for next month.'],
    ['Garden office wiring - Price', 'Price', 'Demo User', 'Lost', 2675, -12, -4, 'Went with cheaper local quote.'],
    ['Restaurant repaint - Khan', 'Khan', 'Sam', 'Follow up due', 4380, -4, 0, 'Needs revised start date.'],
    ['Fence replacement - Doyle', 'Doyle', 'Ella', 'Replied', 1520, -6, 4, 'Customer replied asking about lead time.'],
    ['Solar battery install - Foster', 'Foster', 'Lewis', 'Sent', 7180, -1, 2, 'High-value opportunity.'],
    ['Gutter replacement - Bell', 'Bell', 'Demo User', 'Follow up due', 1240, -3, -1, 'Chase after rainfall.'],
    ['Retail fit-out electrical - Young', 'Young', 'Sam', 'Draft', 11800, 0, 3, 'Need landlord approval note.'],
    ['Emergency boiler swap - Ali', 'Ali', 'Ella', 'Won', 3490, -9, -2, 'Fast turnaround, already scheduled.'],
    ['External render repair - Murphy', 'Murphy', 'Lewis', 'Sent', 2950, -2, 1, 'Waiting on customer availability.'],
    ['Security lighting - Turner', 'Turner', 'Demo User', 'Follow up due', 1320, -5, 0, 'Customer asked if weekend install possible.'],
  ];
  for (const [title, customer, owner, status, value, sentOffset, followOffset, notes] of seedQuotes) {
    if (store.quotes.some((quote) => quote.workspaceId === workspace.id && quote.title === title)) continue;
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
    if (status === 'Won') recordQuoteEvent(quote, 'Quote marked won', 'Booked into the demo pipeline.');
    if (status === 'Lost') recordQuoteEvent(quote, 'Quote marked lost', 'Closed out in the demo pipeline.');
    if (status === 'Follow up due') recordQuoteEvent(quote, 'Follow up due', `Needs attention on ${quote.nextFollowUp}.`);
    store.quotes.push(quote);
  }
}

async function ensureDemoAccount(store) {
  const demoEmail = 'demo@catalyst.local';
  let changed = false;
  let demoUser = findUserByEmail(store, demoEmail);
  if (demoUser) {
    const existingWorkspace = getWorkspace(store, demoUser.workspaceId);
    if (existingWorkspace) {
      const teamBefore = store.teamMembers.length;
      const quotesBefore = store.quotes.length;
      ensureDemoWorkspaceRichData(store, existingWorkspace);
      changed = changed || teamBefore !== store.teamMembers.length || quotesBefore !== store.quotes.length;
      if (changed) await saveStore(store);
      return { user: demoUser, workspace: existingWorkspace };
    }
  }
  const workspace = {
    id: uid('workspace'),
    name: 'Catalyst Demo Workspace',
    replyEmail: demoEmail,
    firstFollowupDays: 2,
    secondFollowupDays: 5,
    notes: 'Prototype demo workspace',
    createdAt: new Date().toISOString(),
  };
  demoUser = {
    id: uid('user'),
    workspaceId: workspace.id,
    name: 'Demo User',
    email: demoEmail,
    passwordHash: hashPassword('Catalyst123!'),
    verified: true,
    createdAt: new Date().toISOString(),
  };
  store.workspaces.push(workspace);
  store.users.push(demoUser);
  seedWorkspace(store, workspace, demoUser);
  ensureDemoWorkspaceRichData(store, workspace);
  await saveStore(store);
  return { user: demoUser, workspace };
}

async function loadStore() {
  if (!(await isSupabaseReady())) {
    const error = new Error('Supabase is not configured or not ready.');
    error.status = 503;
    throw error;
  }
  const store = await loadSupabaseStore();
  await ensureDemoAccount(store);
  return store;
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
  ensureDemoAccount,
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
