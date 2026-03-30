const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'store.json');
const SUPABASE_REF = process.env.SUPABASE_URL_CATALYST || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_CATALYST || '';

if (!SUPABASE_REF || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL_CATALYST or SUPABASE_SECRET_CATALYST');
  process.exit(1);
}

const BASE_URL = `https://${SUPABASE_REF}.supabase.co`;

async function supabaseRequest(resource, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${BASE_URL}/rest/v1/${resource}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase ${method} ${resource} failed (${response.status}): ${text}`);
  }
}

function readStore() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function mapWorkspaces(rows) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    reply_email: row.replyEmail,
    first_followup_days: row.firstFollowupDays,
    second_followup_days: row.secondFollowupDays,
    notes: row.notes || '',
    created_at: row.createdAt,
  }));
}

function mapUsers(rows) {
  return rows.map((row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    email: row.email,
    password_hash: row.passwordHash,
    verified: Boolean(row.verified),
    verification_token: row.verificationToken || null,
    reset_token: row.resetToken || null,
    created_at: row.createdAt,
  }));
}

function mapQuotes(rows) {
  return rows.map((row) => ({
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
    created_at: row.createdAt,
    archived: Boolean(row.archived),
  }));
}

function mapTeamMembers(rows) {
  return rows.map((row) => ({
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    email: row.email,
    role: row.role,
    active_quotes: Number(row.activeQuotes || 0),
    created_at: row.createdAt || new Date().toISOString(),
  }));
}

function mapQuoteEvents(rows) {
  return rows.flatMap((quote) => (Array.isArray(quote.history) ? quote.history : []).map((event) => ({
    id: event.id,
    quote_id: quote.id,
    summary: event.summary,
    detail: event.detail,
    created_at: event.createdAt,
  })));
}

(async () => {
  const store = readStore();
  await supabaseRequest('workspaces', { method: 'POST', body: mapWorkspaces(store.workspaces), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  await supabaseRequest('users', { method: 'POST', body: mapUsers(store.users), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  await supabaseRequest('team_members', { method: 'POST', body: mapTeamMembers(store.teamMembers), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  await supabaseRequest('quotes', { method: 'POST', body: mapQuotes(store.quotes), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  const events = mapQuoteEvents(store.quotes);
  if (events.length) {
    await supabaseRequest('quote_events', { method: 'POST', body: events, headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  }
  console.log(`Migrated ${store.workspaces.length} workspaces, ${store.users.length} users, ${store.teamMembers.length} team members, ${store.quotes.length} quotes.`);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
