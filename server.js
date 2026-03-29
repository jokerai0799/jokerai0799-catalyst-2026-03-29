const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = IS_VERCEL ? path.join('/tmp', 'catalyst-data') : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 18081);
const SESSION_COOKIE = 'catalyst_sid';
const sessions = new Map();

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

function loadStore() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) {
    const empty = { users: [], workspaces: [], quotes: [], teamMembers: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(empty, null, 2));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const store = {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
      teamMembers: Array.isArray(parsed.teamMembers) ? parsed.teamMembers : [],
    };
    ensureDemoAccount(store);
    return store;
  } catch {
    const store = { users: [], workspaces: [], quotes: [], teamMembers: [] };
    ensureDemoAccount(store);
    return store;
  }
}

function saveStore(store) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
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
      { id: uid('team'), workspaceId: workspace.id, name: ownerName, email: ownerEmail, role: 'Owner', activeQuotes: 0 },
      { id: uid('team'), workspaceId: workspace.id, name: 'Ella', email: 'ella@example.com', role: 'Ops', activeQuotes: 0 },
      { id: uid('team'), workspaceId: workspace.id, name: 'Lewis', email: 'lewis@example.com', role: 'Estimator', activeQuotes: 0 },
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
        store.teamMembers.push({ id: uid('team'), workspaceId: workspace.id, activeQuotes: 0, ...member });
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

function ensureDemoAccount(store) {
  const demoEmail = 'demo@catalyst.local';
  let demoUser = findUserByEmail(store, demoEmail);
  if (demoUser) {
    const existingWorkspace = getWorkspace(store, demoUser.workspaceId);
    if (existingWorkspace) {
      ensureDemoWorkspaceRichData(store, existingWorkspace);
      saveStore(store);
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
  saveStore(store);
  return { user: demoUser, workspace };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function getSessionUser(req, store) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  return store.users.find((user) => user.id === session.userId) || null;
}

function createSession(res, userId) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { userId, createdAt: Date.now() });
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
}

function clearSession(req, res) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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

function withUser(req, res, store) {
  const user = getSessionUser(req, store);
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
  const store = loadStore();

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/app/bootstrap') {
    const user = getSessionUser(req, store);
    if (!user) return unauthorized(res);
    return sendJson(res, 200, buildBootstrap(store, user));
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = getSessionUser(req, store);
    return sendJson(res, 200, { user: user ? sanitizeUser(user) : null });
  }

  if (req.method === 'POST' && pathname === '/api/auth/signup') {
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const company = String(body.company || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!name || !company || !email || !password) return badRequest(res, 'Fill in all fields to create your workspace.');
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
    saveStore(store);
    return sendJson(res, 201, {
      ok: true,
      email,
      verificationToken: user.verificationToken,
      verifyUrl: `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}`,
    });
  }

  if (req.method === 'GET' && pathname === '/api/auth/check-email') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    const user = findUserByEmail(store, email);
    if (!user) return sendJson(res, 200, { email, exists: false, verified: false, verifyUrl: '/landing-page/login.html?verified=invalid' });
    return sendJson(res, 200, {
      email,
      exists: true,
      verified: Boolean(user.verified),
      verifyUrl: user.verificationToken ? `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}` : `/landing-page/login.html?verified=success&email=${encodeURIComponent(user.email)}`,
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = findUserByEmail(store, email);
    if (!user || !verifyPassword(password, user.passwordHash)) return badRequest(res, 'Invalid email or password.');
    if (!user.verified) return badRequest(res, 'Check your email page and verify your account before logging in.');
    createSession(res, user.id);
    return sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
  }

  if (req.method === 'POST' && pathname === '/api/auth/demo-login') {
    const demo = ensureDemoAccount(store);
    createSession(res, demo.user.id);
    return sendJson(res, 200, { ok: true, user: sanitizeUser(demo.user) });
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/auth/verify') {
    const body = await readJson(req);
    const token = String(body.token || '').trim();
    const user = store.users.find((item) => item.verificationToken === token);
    if (!user) return badRequest(res, 'That verification link is invalid or expired.');
    user.verified = true;
    delete user.verificationToken;
    saveStore(store);
    return sendJson(res, 200, { ok: true, email: user.email });
  }

  if (req.method === 'POST' && pathname === '/api/auth/forgot-password') {
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const user = findUserByEmail(store, email);
    if (!user) return badRequest(res, 'No account found for that email.');
    user.resetToken = uid('reset');
    saveStore(store);
    return sendJson(res, 200, { ok: true, resetUrl: `/landing-page/reset-password.html?token=${encodeURIComponent(user.resetToken)}` });
  }

  if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
    const body = await readJson(req);
    const token = String(body.token || '').trim();
    const password = String(body.password || '');
    const confirmPassword = String(body.confirmPassword || '');
    const user = store.users.find((item) => item.resetToken === token);
    if (!user) return badRequest(res, 'That reset link is invalid or expired.');
    if (password.length < 8) return badRequest(res, 'Use at least 8 characters for your new password.');
    if (password !== confirmPassword) return badRequest(res, 'Passwords do not match.');
    user.passwordHash = hashPassword(password);
    delete user.resetToken;
    saveStore(store);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'PATCH' && pathname === '/api/workspace') {
    const auth = withUser(req, res, store);
    if (!auth) return;
    const body = await readJson(req);
    auth.workspace.name = String(body.name || '').trim() || auth.workspace.name;
    auth.workspace.replyEmail = String(body.replyEmail || '').trim() || auth.workspace.replyEmail || auth.user.email;
    auth.workspace.firstFollowupDays = Math.max(1, Number(body.firstFollowupDays || auth.workspace.firstFollowupDays || 2));
    auth.workspace.secondFollowupDays = Math.max(1, Number(body.secondFollowupDays || auth.workspace.secondFollowupDays || 5));
    auth.workspace.notes = String(body.notes || '').trim();
    saveStore(store);
    return sendJson(res, 200, { ok: true, workspace: auth.workspace });
  }

  if (req.method === 'POST' && pathname === '/api/team') {
    const auth = withUser(req, res, store);
    if (!auth) return;
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const role = String(body.role || 'Member').trim();
    if (!name || !email) return badRequest(res, 'Name and email are required.');
    if (store.teamMembers.some((member) => member.workspaceId === auth.workspace.id && member.email.toLowerCase() === email)) {
      return badRequest(res, 'A team member with that email already exists.');
    }
    const member = { id: uid('team'), workspaceId: auth.workspace.id, name, email, role, activeQuotes: 0 };
    store.teamMembers.push(member);
    saveStore(store);
    return sendJson(res, 201, { ok: true, member });
  }

  if (req.method === 'POST' && pathname === '/api/quotes') {
    const auth = withUser(req, res, store);
    if (!auth) return;
    const body = await readJson(req);
    const title = String(body.title || '').trim();
    const customer = String(body.customer || '').trim() || title;
    const owner = String(body.owner || '').trim() || auth.user.name;
    const status = String(body.status || 'Draft').trim();
    const value = Number(body.value || 0);
    const sentDate = String(body.sentDate || today());
    const nextFollowUp = String(body.nextFollowUp || addDays(sentDate, auth.workspace.firstFollowupDays || 2));
    const notes = String(body.notes || '').trim();
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
    saveStore(store);
    return sendJson(res, 201, { ok: true, quote });
  }

  const quoteMatch = pathname.match(/^\/api\/quotes\/([^/]+)$/);
  if (quoteMatch && req.method === 'PATCH') {
    const auth = withUser(req, res, store);
    if (!auth) return;
    const quote = store.quotes.find((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (!quote) return notFound(res);
    const body = await readJson(req);
    const title = String(body.title || '').trim();
    const customer = String(body.customer || '').trim() || title;
    const owner = String(body.owner || '').trim();
    const status = String(body.status || '').trim();
    const value = Number(body.value || 0);
    const sentDate = String(body.sentDate || quote.sentDate);
    const nextFollowUp = String(body.nextFollowUp || quote.nextFollowUp);
    const notes = String(body.notes || '').trim();
    if (!title || !value) return badRequest(res, 'Add at least a title and value before saving.');
    quote.title = title;
    quote.customer = customer;
    quote.owner = owner || quote.owner;
    quote.status = status || quote.status;
    quote.value = value;
    quote.sentDate = sentDate;
    quote.nextFollowUp = nextFollowUp;
    quote.notes = notes;
    quote.archived = quote.status === 'Archived' ? true : Boolean(quote.archived);
    recordQuoteEvent(quote, 'Quote updated', `Status ${quote.status} · follow up ${quote.nextFollowUp}`);
    saveStore(store);
    return sendJson(res, 200, { ok: true, quote });
  }

  if (quoteMatch && req.method === 'DELETE') {
    const auth = withUser(req, res, store);
    if (!auth) return;
    const index = store.quotes.findIndex((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (index === -1) return notFound(res);
    store.quotes.splice(index, 1);
    saveStore(store);
    return sendJson(res, 200, { ok: true });
  }

  const quoteActionMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/actions$/);
  if (quoteActionMatch && req.method === 'POST') {
    const auth = withUser(req, res, store);
    if (!auth) return;
    const body = await readJson(req);
    const action = String(body.action || '').trim();
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
    saveStore(store);
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
