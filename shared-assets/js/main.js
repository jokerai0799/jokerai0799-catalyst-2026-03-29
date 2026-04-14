import { resolvePageInitializer } from './routes.js';

function injectVercelAnalytics() {
  const hostname = window.location.hostname || '';
  const isVercelAnalyticsHost = hostname === 'quotechaser.online'
    || hostname.endsWith('.quotechaser.online')
    || hostname.endsWith('.vercel.app');

  if (!isVercelAnalyticsHost) return;

  window.va = window.va || function va() {
    (window.vaq = window.vaq || []).push(arguments);
  };

  if (document.querySelector('script[data-vercel-analytics]')) return;

  const script = document.createElement('script');
  script.defer = true;
  script.src = '/_vercel/insights/script.js';
  script.dataset.vercelAnalytics = 'true';
  document.head.appendChild(script);
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    injectVercelAnalytics();
    const init = await resolvePageInitializer();
    if (!init) return;
    await init();
  } catch (error) {
    console.error('Catalyst init failed', error);
  }
});
