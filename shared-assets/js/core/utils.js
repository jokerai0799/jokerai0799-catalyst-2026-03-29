export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

const REGION_CURRENCY_MAP = {
  GB: 'GBP',
  US: 'USD',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  IE: 'EUR',
  FR: 'EUR',
  DE: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  PT: 'EUR',
  AT: 'EUR',
  FI: 'EUR',
  GR: 'EUR',
  LU: 'EUR',
  MT: 'EUR',
  CY: 'EUR',
  SI: 'EUR',
  SK: 'EUR',
  EE: 'EUR',
  LV: 'EUR',
  LT: 'EUR'
};

let cachedCurrencyConfig;

function getLocaleCandidates() {
  if (typeof navigator === 'undefined') return ['en-GB'];
  const locales = [];
  if (Array.isArray(navigator.languages)) locales.push(...navigator.languages.filter(Boolean));
  if (navigator.language) locales.push(navigator.language);
  return locales.length ? locales : ['en-GB'];
}

function getRegionFromLocale(locale) {
  if (!locale) return '';
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Locale === 'function') {
      return new Intl.Locale(locale).region || '';
    }
  } catch {}
  const match = String(locale).match(/-([A-Za-z]{2})\b/);
  return match ? match[1].toUpperCase() : '';
}

export function getCurrencyConfig() {
  if (cachedCurrencyConfig) return cachedCurrencyConfig;
  const locales = getLocaleCandidates();
  const locale = locales[0] || 'en-GB';
  const region = locales.map(getRegionFromLocale).find(Boolean) || 'GB';
  const currency = REGION_CURRENCY_MAP[region] || 'GBP';
  cachedCurrencyConfig = { locale, currency, region };
  return cachedCurrencyConfig;
}

export function formatCurrency(value) {
  const { locale, currency } = getCurrencyConfig();
  return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(value || 0));
}

export function daysBetween(targetDate) {
  const a = new Date(`${today()}T12:00:00`);
  const b = new Date(`${targetDate}T12:00:00`);
  return Math.round((b - a) / 86400000);
}

export function relativeFollowUpLabel(dateString) {
  const diff = daysBetween(dateString);
  if (diff < 0) return `${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} ago`;
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return `In ${diff} days`;
}

export function quoteStatusBadge(status, nextFollowUp) {
  const diff = daysBetween(nextFollowUp);
  if (status === 'Archived') return ['Archived', 'qfu-badge-open'];
  if (diff < 0 && status !== 'Won' && status !== 'Lost') return ['Overdue', 'qfu-badge-overdue'];
  if (diff === 0 && status !== 'Won' && status !== 'Lost') return ['Due today', 'qfu-badge-today'];
  if (status === 'Won') return ['Won', 'qfu-badge-open'];
  return [status || 'Open', 'qfu-badge-open'];
}

export function statusSortValue(quote) {
  const diff = daysBetween(quote.nextFollowUp);
  if (quote.status === 'Won' || quote.status === 'Lost' || quote.status === 'Archived') return 999;
  if (diff < 0) return 0;
  if (diff === 0) return 1;
  return 2;
}

export function formatEventTime(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return 'Recently';
  }
}
