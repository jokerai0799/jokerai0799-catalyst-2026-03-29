const pageRegistry = [
  ['qfu-auth-page-signup', async () => (await import('./features/auth/index.js')).initSignupPage],
  ['qfu-auth-page-login', async () => (await import('./features/auth/index.js')).initLoginPage],
  ['qfu-check-email-page', async () => (await import('./features/auth/index.js')).initCheckEmailPage],
  ['qfu-verify-page', async () => (await import('./features/auth/index.js')).initVerifyPage],
  ['qfu-forgot-page', async () => (await import('./features/auth/index.js')).initForgotPasswordPage],
  ['qfu-reset-page', async () => (await import('./features/auth/index.js')).initResetPasswordPage],
  ['qfu-dashboard-page', async () => {
    const [{ renderDashboard }, { getState, refreshState }] = await Promise.all([
      import('./features/dashboard/index.js'),
      import('./core/store.js'),
    ]);

    return async function initDashboardPage() {
      async function refreshApp() {
        await refreshState();
        renderDashboard(getState(), refreshApp);
      }

      try {
        await refreshApp();
      } catch (error) {
        if (error.status === 401) {
          window.location.href = '../landing-page/login.html';
          return;
        }
        throw error;
      }
    };
  }],
  ['qfu-landing-page', async () => (await import('./features/landing/index.js')).initLandingPage],
];

export async function resolvePageInitializer(body = document.body) {
  for (const [className, loadInit] of pageRegistry) {
    if (body.classList.contains(className)) return loadInit();
  }
  return null;
}
