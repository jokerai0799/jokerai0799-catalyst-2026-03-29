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
    resetToken: row.reset_token || undefined,
    createdAt: isoDate(row.created_at),
  };
}

function mapQuoteFromDb(row, eventsByQuote) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    customer: row.customer,
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

function mapWorkspaceToDb(row) {
  return {
    id: row.id,
    name: row.name,
    reply_email: row.replyEmail,
    first_followup_days: row.firstFollowupDays,
    second_followup_days: row.secondFollowupDays,
    notes: row.notes || '',
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
    reset_token: row.resetToken || null,
    created_at: isoDate(row.createdAt),
  };
}

function mapQuoteToDb(row) {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    title: row.title,
    customer: row.customer,
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

async function loadStore() {
  const [workspacesRows, usersRows, quotesRows, teamRows, eventRows] = await Promise.all([
    supabaseRequest('workspaces?select=*'),
    supabaseRequest('users?select=*'),
    supabaseRequest('quotes?select=*'),
    supabaseRequest('team_members?select=*'),
    supabaseRequest('quote_events?select=*'),
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
  };
}

async function deleteMissingRows(table, existingIds, desiredIds) {
  for (const id of existingIds) {
    if (desiredIds.has(id)) continue;
    await supabaseRequest(`${table}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
}

async function syncTable(table, rows, mapper) {
  const existing = await supabaseRequest(`${table}?select=id`);
  const existingIds = new Set((existing || []).map((row) => row.id));
  const desired = rows.map(mapper);
  const desiredIds = new Set(desired.map((row) => row.id));

  if (desired.length) {
    await supabaseRequest(table, {
      method: 'POST',
      body: desired,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  }

  await deleteMissingRows(table, existingIds, desiredIds);
}

async function saveStore(store) {
  await syncTable('workspaces', store.workspaces, mapWorkspaceToDb);
  await syncTable('users', store.users, mapUserToDb);
  await syncTable('team_members', store.teamMembers, mapTeamMemberToDb);
  await syncTable('quotes', store.quotes, mapQuoteToDb);
  await syncTable('quote_events', flattenQuoteEvents(store.quotes), (row) => row);
}

module.exports = {
  isSupabaseReady,
  loadStore,
  saveStore,
  supabaseRequest,
};
