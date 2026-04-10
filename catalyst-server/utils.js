const crypto = require('crypto');

const ALLOWED_QUOTE_STATUSES = new Set(['Draft', 'Sent', 'Due today', 'Follow up due', 'Replied', 'Won', 'Lost', 'Archived']);
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

function isoDate(value) {
  return value || new Date().toISOString();
}

function addHours(value, hours) {
  const date = new Date(value || Date.now());
  date.setTime(date.getTime() + (hours * 60 * 60 * 1000));
  return date.toISOString();
}

function isFutureIsoDate(value) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > Date.now();
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

module.exports = {
  ALLOWED_QUOTE_ACTIONS,
  ALLOWED_QUOTE_STATUSES,
  addDays,
  addHours,
  clampText,
  escapeHtml,
  hashPassword,
  isFutureIsoDate,
  isIsoDate,
  isValidEmail,
  isoDate,
  normalizeCurrency,
  normalizeDate,
  normalizeName,
  normalizeQuoteStatus,
  normalizeRole,
  today,
  uid,
  verifyPassword,
};
