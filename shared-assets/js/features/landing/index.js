import { ensureLandingLinks } from '../auth/index.js';
import { formatCurrency, getCurrencyConfig } from '../../core/utils.js';

function localizeDemoCurrency() {
  const { currency } = getCurrencyConfig();
  document.documentElement.setAttribute('data-demo-currency', currency);
  document.querySelectorAll('[data-currency-value]').forEach((node) => {
    node.textContent = formatCurrency(Number(node.getAttribute('data-currency-value') || 0));
  });
}

export async function initLandingPage() {
  localizeDemoCurrency();
  try {
    await ensureLandingLinks();
  } catch (error) {
    console.warn('Landing session lookup failed', error);
  }
}
