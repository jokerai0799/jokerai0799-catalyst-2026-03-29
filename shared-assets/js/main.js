import { resolvePageInitializer } from './routes.js';

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const init = await resolvePageInitializer();
    if (!init) return;
    await init();
  } catch (error) {
    console.error('Catalyst init failed', error);
  }
});
