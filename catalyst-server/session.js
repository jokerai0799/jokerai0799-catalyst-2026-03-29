const crypto = require('crypto');
const { IS_VERCEL, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } = require('./config');
const { isSupabaseReady, supabaseRequest } = require('./supabase');

async function getSessionRecord(sessionId) {
  if (!sessionId) return null;
  if (!(await isSupabaseReady())) return null;
  const rows = await supabaseRequest(`sessions?id=eq.${encodeURIComponent(sessionId)}&select=*`);
  const session = rows?.[0] || null;
  if (!session) return null;
  if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
    await supabaseRequest(`sessions?id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return null;
  }
  return { id: session.id, userId: session.user_id, createdAt: session.created_at };
}

async function persistSession(userId) {
  const sid = crypto.randomBytes(24).toString('hex');
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await supabaseRequest('sessions', {
    method: 'POST',
    body: [{ id: sid, user_id: userId, created_at: createdAt, expires_at: expiresAt }],
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  });
  return sid;
}

async function deleteSession(sessionId) {
  if (!sessionId) return;
  await supabaseRequest(`sessions?id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
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

async function getSessionUserId(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const session = await getSessionRecord(sid);
  return session?.userId || null;
}

async function getSessionUser(req, store) {
  const userId = await getSessionUserId(req);
  if (!userId) return null;
  return store.users.find((user) => user.id === userId) || null;
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  const list = Array.isArray(existing) ? existing.concat(value) : [existing, value];
  res.setHeader('Set-Cookie', list);
}

async function createSession(res, userId) {
  const sid = await persistSession(userId);
  appendSetCookie(res, `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${IS_VERCEL ? '; Secure' : ''}`);
}

async function clearSession(req, res) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  await deleteSession(sid);
  appendSetCookie(res, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_VERCEL ? '; Secure' : ''}`);
}

module.exports = {
  clearSession,
  createSession,
  getSessionUser,
  getSessionUserId,
  parseCookies,
};
