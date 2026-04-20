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

async function fetchBillingConfig() {
  try {
    const response = await fetch('/api/public-config', { credentials: 'same-origin' });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.billing || null;
  } catch {
    return null;
  }
}

function buildCheckoutAuthUrl(plan) {
  const params = new URLSearchParams({
    next: 'checkout',
    plan: plan === 'business' ? 'business' : 'personal',
  });
  return `/landing-page/login.html?${params.toString()}`;
}

function localizePricing(billingConfig = {}, user = null) {
  const { locale, currency } = getCurrencyConfig();
  const rate = CURRENCY_RATES[currency] || 1;

  document.querySelectorAll('[data-plan-price]').forEach((node) => {
    const plan = node.getAttribute('data-plan-price');
    const gbpBase = PLAN_BASELINES_GBP[plan];
    if (!gbpBase) return;
    const localizedAmount = roundPsychologically(gbpBase * rate);
    node.textContent = `${formatLocalizedPrice(localizedAmount, locale, currency)}/mo`;
  });

  const checkoutLinks = {
    personal: billingConfig.personalCheckoutLink || '',
    business: billingConfig.businessCheckoutLink || '',
  };

  document.querySelectorAll('[data-plan-checkout]').forEach((node) => {
    const plan = node.getAttribute('data-plan-checkout');
    const stripeLink = node.getAttribute('data-stripe-link') || checkoutLinks[plan] || '';
    if (stripeLink) {
      node.dataset.checkoutUrl = stripeLink;
      node.setAttribute('href', user ? stripeLink : buildCheckoutAuthUrl(plan));
      node.classList.remove('is-disabled');
      node.setAttribute('aria-disabled', 'false');
    } else {
      node.setAttribute('href', '#pricing');
      node.classList.add('is-disabled');
      node.setAttribute('aria-disabled', 'true');
      delete node.dataset.checkoutUrl;
    }
  });

  document.querySelectorAll('[data-pricing-anchor]').forEach((node) => {
    node.setAttribute('href', '#pricing');
  });
}

export async function initLandingPage() {
  localizeDemoCurrency();
  const billingConfig = await fetchBillingConfig();
  let user = null;
  try {
    user = await ensureLandingLinks();
  } catch (error) {
    console.warn('Landing session lookup failed', error);
  }
  localizePricing(billingConfig || {}, user || null);
}
