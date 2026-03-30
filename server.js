const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

for (const envFile of ['.env.local', '.env']) {
  const envPath = path.join(__dirname, envFile);
  if (!fs.existsSync(envPath)) continue;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line) || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (!key || process.env[key] != null) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const ROOT = __dirname;
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = IS_VERCEL ? path.join('/tmp', 'catalyst-data') : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 18081);
const SESSION_COOKIE = 'catalyst_sid';
const LOCAL_SESSIONS = new Map();

const SUPABASE_REF = process.env.SUPABASE_URL_CATALYST || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_CATALYST || '';
const SUPABASE_BASE_URL = SUPABASE_REF ? `https://${SUPABASE_REF}.supabase.co` : '';
const SUPABASE_ENABLED = Boolean(SUPABASE_BASE_URL && SUPABASE_SERVICE_KEY);
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || process.env.CATALYST_FROM_EMAIL || 'onboarding@resend.dev';
const APP_URL = process.env.APP_URL_CATALYST || process.env.APP_URL || '';
let supabaseReadyCache = null;
let supabaseCheckedAt = 0;
const SUPABASE_RECHECK_MS = 60_000;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const ALLOWED_QUOTE_STATUSES = new Set(['Draft', 'Sent', 'Follow up due', 'Replied', 'Won', 'Lost', 'Archived']);
const ALLOWED_QUOTE_ACTIONS = new Set(['archive', 'mark-contacted', 'mark-won', 'mark-lost', 'contacted', 'reschedule', 'done-today']);

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function clampText(value, max = 5000) {
  return String(value || '').trim().slice(0, max);
}

function normalizeName(value, fallback = '') {
  return clampText(value, 120) || fallback;
}

function normalizeRole(value) {
  return clampText(value || 'Member', 80) || 'Member';
}

function normalizeQuoteStatus(value, fallback = 'Draft') {
  const status = clampText(value, 40) || fallback;
  return ALLOWED_QUOTE_STATUSES.has(status) ? status : fallback;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeDate(value, fallback) {
  return isIsoDate(value) ? value : fallback;
}

function normalizeCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}_${Date.now().toString(36)}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAppBaseUrl(req) {
  if (APP_URL) return APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function buildAbsoluteUrl(req, pathname) {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${getAppBaseUrl(req)}${normalized}`;
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) return { sent: false, provider: 'none' };
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [to],
      subject,
      html,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Failed to send email (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return { sent: true, provider: 'resend' };
}

async function sendVerificationEmail(req, user) {
  if (!user?.verificationToken) return { sent: false, provider: 'none' };
  const verifyUrl = buildAbsoluteUrl(req, `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}`);
  const firstName = escapeHtml((user.name || '').trim().split(/\s+/)[0] || 'there');
  return sendEmail({
    to: user.email,
    subject: 'Verify your Catalyst email',
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;line-height:1.6">
        <h1 style="font-size:24px;margin:0 0 16px">Verify your email</h1>
        <p style="margin:0 0 16px">Hi ${firstName},</p>
        <p style="margin:0 0 16px">Click below to verify your email and activate your Catalyst workspace.</p>
        <p style="margin:24px 0">
          <a href="${verifyUrl}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600">Verify email</a>
        </p>
        <p style="margin:0 0 16px">If the button does not work, use this link:</p>
        <p style="word-break:break-all;margin:0 0 16px"><a href="${verifyUrl}">${verifyUrl}</a></p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(req, user) {
  if (!user?.resetToken) return { sent: false, provider: 'none' };
  const resetUrl = buildAbsoluteUrl(req, `/landing-page/reset-password.html?token=${encodeURIComponent(user.resetToken)}`);
  const firstName = escapeHtml((user.name || '').trim().split(/\s+/)[0] || 'there');
  return sendEmail({
    to: user.email,
    subject: 'Reset your Catalyst password',
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;line-height:1.6">
        <h1 style="font-size:24px;margin:0 0 16px">Reset your password</h1>
        <p style="margin:0 0 16px">Hi ${firstName},</p>
        <p style="margin:0 0 16px">Click below to choose a new password for your Catalyst workspace.</p>
        <p style="margin:24px 0">
          <a href="${resetUrl}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600">Reset password</a>
        </p>
        <p style="margin:0 0 16px">If the button does not work, use this link:</p>
        <p style="word-break:break-all;margin:0 0 16px"><a href="${resetUrl}">${resetUrl}</a></p>
      </div>
    `,
  });
}

async function attemptEmail(task) {
  try {
    return await task();
  } catch (error) {
    return {
      sent: false,
      provider: 'fallback',
      error: error?.message || 'Email delivery failed',
      status: error?.status,
      body: error?.body,
    };
  }
}

function isoDate(value) {
  if (!value) return new Date().toISOString();
  return value;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  if (!encoded || !encoded.includes(':')) return false;
  const [salt, expected] = encoded.split(':');
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function readJsonOrReject(req, res) {
  try {
    return await readJson(req);
  } catch (error) {
    if (error?.message === 'Invalid JSON') {
      badRequest(res, 'Invalid JSON');
      return null;
    }
    throw error;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function localLoadStoreRaw() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    const empty = { users: [], workspaces: [], quotes: [], teamMembers: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(empty, null, 2));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
      teamMembers: Array.isArray(parsed.teamMembers) ? parsed.teamMembers : [],
    };
  } catch {
    return { users: [], workspaces: [], quotes: [], teamMembers: [] };
  }
}

function localSaveStoreRaw(store) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

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
  } catch (error) {
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

async function loadSupabaseStoreRaw() {
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
      headers: {
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
    });
  }

  await deleteMissingRows(table, existingIds, desiredIds);
}

async function saveSupabaseStoreRaw(store) {
  await syncTable('workspaces', store.workspaces, mapWorkspaceToDb);
  await syncTable('users', store.users, mapUserToDb);
  await syncTable('team_members', store.teamMembers, mapTeamMemberToDb);
  await syncTable('quotes', store.quotes, mapQuoteToDb);
  await syncTable('quote_events', flattenQuoteEvents(store.quotes), (row) => row);
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
  let store;
  if (await isSupabaseReady()) {
    try {
      store = await loadSupabaseStoreRaw();
    } catch (error) {
      if (error?.status === 404) {
        supabaseReadyCache = false;
        supabaseCheckedAt = Date.now();
        store = localLoadStoreRaw();
      } else {
        throw error;
      }
    }
  } else {
    store = localLoadStoreRaw();
  }
  await ensureDemoAccount(store);
  return store;
}

async function saveStore(store) {
  if (await isSupabaseReady()) return saveSupabaseStoreRaw(store);
  return localSaveStoreRaw(store);
}

async function getSessionRecord(sessionId) {
  if (!sessionId) return null;
  if (await isSupabaseReady()) {
    const rows = await supabaseRequest(`sessions?id=eq.${encodeURIComponent(sessionId)}&select=*`);
    const session = rows?.[0] || null;
    if (!session) return null;
    if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
      await supabaseRequest(`sessions?id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return null;
    }
    return { id: session.id, userId: session.user_id, createdAt: session.created_at };
  }
  return LOCAL_SESSIONS.get(sessionId) || null;
}

async function persistSession(userId) {
  const sid = crypto.randomBytes(24).toString('hex');
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  if (await isSupabaseReady()) {
    await supabaseRequest('sessions', {
      method: 'POST',
      body: [{ id: sid, user_id: userId, created_at: createdAt, expires_at: expiresAt }],
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  } else {
    LOCAL_SESSIONS.set(sid, { userId, createdAt, expiresAt });
  }
  return sid;
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  if (await isSupabaseReady()) {
    await supabaseRequest(`sessions?id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return;
  }
  LOCAL_SESSIONS.delete(sessionId);
}

async function getSessionUser(req, store) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const session = await getSessionRecord(sid);
  if (!session) return null;
  return store.users.find((user) => user.id === session.userId) || null;
}

async function createSession(res, userId) {
  const sid = await persistSession(userId);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${IS_VERCEL ? '; Secure' : ''}`);
}

async function clearSession(req, res) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  await deleteSession(sid);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_VERCEL ? '; Secure' : ''}`);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function unauthorized(res) {
  sendJson(res, 401, { error: 'Unauthorized' });
}

function badRequest(res, message) {
  sendJson(res, 400, { error: message });
}

async function withUser(req, res, store) {
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

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream');
}

function serveStatic(req, res, pathname) {
  let target = pathname === '/' ? '/landing-page/index.html' : pathname;
  const filePath = path.normalize(path.join(ROOT, decodeURIComponent(target)));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stats) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const finalPath = stats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(finalPath, (readErr, buffer) => {
      if (readErr) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(finalPath), 'Cache-Control': 'no-store' });
      res.end(buffer);
    });
  });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const store = await loadStore();

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, storage: (await isSupabaseReady()) ? 'supabase' : 'local' });
  }

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
    const body = await readJsonOrReject(req, res);
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
    const body = await readJsonOrReject(req, res);
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
    const body = await readJsonOrReject(req, res);
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
    const body = await readJsonOrReject(req, res);
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
    const body = await readJsonOrReject(req, res);
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
    const body = await readJsonOrReject(req, res);
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
    const auth = await withUser(req, res, store);
    if (!auth) return;
    const body = await readJsonOrReject(req, res);
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
    const auth = await withUser(req, res, store);
    if (!auth) return;
    const body = await readJsonOrReject(req, res);
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
    const auth = await withUser(req, res, store);
    if (!auth) return;
    const body = await readJsonOrReject(req, res);
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
    const auth = await withUser(req, res, store);
    if (!auth) return;
    const quote = store.quotes.find((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (!quote) return notFound(res);
    const body = await readJsonOrReject(req, res);
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
    const auth = await withUser(req, res, store);
    if (!auth) return;
    const index = store.quotes.findIndex((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (index === -1) return notFound(res);
    store.quotes.splice(index, 1);
    await saveStore(store);
    return sendJson(res, 200, { ok: true });
  }

  const quoteActionMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/actions$/);
  if (quoteActionMatch && req.method === 'POST') {
    const auth = await withUser(req, res, store);
    if (!auth) return;
    const body = await readJsonOrReject(req, res);
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
      if (quote.status === 'Won' || quote.status === 'Lost') quote.status = 'Follow up due';
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
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Server error' });
  }
}

const server = http.createServer(requestHandler);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Catalyst server running at http://${HOST}:${PORT}`);
  });
}

module.exports = { server, requestHandler };
