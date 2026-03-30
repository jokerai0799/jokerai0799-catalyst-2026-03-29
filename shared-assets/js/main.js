import { resolvePageInitializer } from './routes.js';

document.addEventListener('DOMContentLoaded', () => {
  const init = resolvePageInitializer();
  if (!init) return;
  init().catch((error) => {
    console.error('Catalyst init failed', error);
  });
});
