import { ensureLandingLinks } from '../auth/index.js';
import { formatCurrency, getCurrencyConfig } from '../../core/utils.js';

const PLAN_BASELINES_GBP = {
  personal: 29.99,
  business: 59.99,
};

const CURRENCY_RATES = {
  GBP: 1,
  USD: 1.27,
  EUR: 1.17,
  AUD: 1.95,
  CAD: 1.72,
  NZD: 2.1,
};

function localizeDemoCurrency() {
  const { currency } = getCurrencyConfig();
  document.documentElement.setAttribute('data-demo-currency', currency);
  document.querySelectorAll('[data-currency-value]').forEach((node) => {
    node.textContent = formatCurrency(Number(node.getAttribute('data-currency-value') || 0));
  });
}

function roundPsychologically(amount) {
  const roundedBase = Math.max(0, Math.floor(amount));
  return Number((roundedBase + 0.99).toFixed(2));
}

function formatLocalizedPrice(amount, locale, currency) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function localizePricing() {
  const { locale, currency } = getCurrencyConfig();
  const rate = CURRENCY_RATES[currency] || 1;

  document.querySelectorAll('[data-plan-price]').forEach((node) => {
    const plan = node.getAttribute('data-plan-price');
    const gbpBase = PLAN_BASELINES_GBP[plan];
    if (!gbpBase) return;
    const localizedAmount = roundPsychologically(gbpBase * rate);
    node.textContent = `${formatLocalizedPrice(localizedAmount, locale, currency)}/mo`;
  });

  document.querySelectorAll('[data-plan-note]').forEach((node) => {
    node.textContent = `Converted from the £${PLAN_BASELINES_GBP[node.getAttribute('data-plan-note')]?.toFixed(2) || '0.00'} GBP base · billed monthly`;
  });

  document.querySelectorAll('[data-plan-checkout]').forEach((node) => {
    const stripeLink = node.getAttribute('data-stripe-link');
    if (stripeLink) node.setAttribute('href', stripeLink);
  });
}

export async function initLandingPage() {
  localizeDemoCurrency();
  localizePricing();
  try {
    await ensureLandingLinks();
  } catch (error) {
    console.warn('Landing session lookup failed', error);
  }
}
