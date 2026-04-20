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
const NODE_ENV = process.env.NODE_ENV || '';
const VERCEL_ENV = process.env.VERCEL_ENV || '';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 18081);
const SESSION_COOKIE = 'catalyst_sid';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const APP_URL = process.env.APP_URL_CATALYST || process.env.APP_URL || '';
const APP_URL_IS_HTTPS = /^https:\/\//i.test(APP_URL);
const IS_PRODUCTION = NODE_ENV === 'production' || VERCEL_ENV === 'production' || (IS_VERCEL && VERCEL_ENV !== 'preview');
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
const PROJECT_METRICS_TOKEN = process.env.PROJECT_METRICS_TOKEN || '';

const BILLING_CONFIG_ERRORS = [];
if (STRIPE_PERSONAL_PAYMENT_LINK && !STRIPE_PERSONAL_PRICE_ID) {
  BILLING_CONFIG_ERRORS.push('STRIPE_PERSONAL_PAYMENT_LINK is set but STRIPE_PERSONAL_PRICE_ID is missing.');
}
if (STRIPE_BUSINESS_PAYMENT_LINK && !STRIPE_BUSINESS_PRICE_ID) {
  BILLING_CONFIG_ERRORS.push('STRIPE_BUSINESS_PAYMENT_LINK is set but STRIPE_BUSINESS_PRICE_ID is missing.');
}

function assertStripeBillingConfig() {
  const hasStripeBackend = Boolean(STRIPE_SECRET_KEY || STRIPE_WEBHOOK_SECRET);
  const configuredPriceIds = [STRIPE_PERSONAL_PRICE_ID, STRIPE_BUSINESS_PRICE_ID].filter(Boolean);

  for (const priceId of configuredPriceIds) {
    if (!/^price_[A-Za-z0-9]+$/.test(priceId)) {
      throw new Error(`Invalid Stripe price id format: ${priceId}`);
    }
  }

  if (!hasStripeBackend) return;

  if (!STRIPE_PERSONAL_PRICE_ID || !STRIPE_BUSINESS_PRICE_ID) {
    throw new Error('Stripe backend configuration requires both STRIPE_PERSONAL_PRICE_ID and STRIPE_BUSINESS_PRICE_ID.');
  }

  if (STRIPE_PERSONAL_PRICE_ID === STRIPE_BUSINESS_PRICE_ID) {
    throw new Error('Stripe personal and business price ids must be different.');
  }
}

assertStripeBillingConfig();

if (BILLING_CONFIG_ERRORS.length) {
  console.warn('[catalyst] Billing configuration warnings:\n- ' + BILLING_CONFIG_ERRORS.join('\n- '));
}

module.exports = {
  ROOT,
  IS_VERCEL,
  NODE_ENV,
  VERCEL_ENV,
  HOST,
  PORT,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  APP_URL,
  APP_URL_IS_HTTPS,
  IS_PRODUCTION,
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
  PROJECT_METRICS_TOKEN,
  BILLING_CONFIG_ERRORS,
};
