const fs = require('fs');
const path = require('path');

function loadEnv(rootDir) {
  for (const envFile of ['.env.local', '.env']) {
    const envPath = path.join(rootDir, envFile);
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
}

const ROOT = path.join(__dirname, '..');
loadEnv(ROOT);

const IS_VERCEL = Boolean(process.env.VERCEL);
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 18081);
const SESSION_COOKIE = 'catalyst_sid';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const APP_URL = process.env.APP_URL_CATALYST || process.env.APP_URL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || process.env.RESEND_TOKEN_CATALYST || process.env.RESEND_API_KEY_CATALYST || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || process.env.CATALYST_FROM_EMAIL || 'onboarding@resend.dev';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID_CATALYST || process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET_CATALYST || process.env.GOOGLE_CLIENT_SECRET || '';
const SUPABASE_REF = process.env.SUPABASE_URL_CATALYST || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_CATALYST || '';
const SUPABASE_BASE_URL = SUPABASE_REF ? `https://${SUPABASE_REF}.supabase.co` : '';
const STRIPE_PERSONAL_PRICE_ID = process.env.STRIPE_PERSONAL_PRICE_ID || '';
const STRIPE_BUSINESS_PRICE_ID = process.env.STRIPE_BUSINESS_PRICE_ID || '';
const STRIPE_PERSONAL_PAYMENT_LINK = process.env.STRIPE_PERSONAL_PAYMENT_LINK || '';
const STRIPE_BUSINESS_PAYMENT_LINK = process.env.STRIPE_BUSINESS_PAYMENT_LINK || '';
const STRIPE_CUSTOMER_PORTAL_URL = process.env.STRIPE_CUSTOMER_PORTAL_URL || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

module.exports = {
  ROOT,
  IS_VERCEL,
  HOST,
  PORT,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  APP_URL,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SUPABASE_REF,
  SUPABASE_SERVICE_KEY,
  SUPABASE_BASE_URL,
  STRIPE_PERSONAL_PRICE_ID,
  STRIPE_BUSINESS_PRICE_ID,
  STRIPE_PERSONAL_PAYMENT_LINK,
  STRIPE_BUSINESS_PAYMENT_LINK,
  STRIPE_CUSTOMER_PORTAL_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
};
