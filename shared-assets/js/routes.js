import { initCheckEmailPage, initForgotPasswordPage, initLoginPage, initResetPasswordPage, initSignupPage, initVerifyPage } from './features/auth/index.js';
import { renderDashboard } from './features/dashboard/index.js';
import { initLandingPage } from './features/landing/index.js';
import { getState, refreshState } from './core/store.js';

async function initDashboardPage() {
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
}

const pageRegistry = [
  ['qfu-auth-page-signup', initSignupPage],
  ['qfu-auth-page-login', initLoginPage],
  ['qfu-check-email-page', initCheckEmailPage],
  ['qfu-verify-page', initVerifyPage],
  ['qfu-forgot-page', initForgotPasswordPage],
  ['qfu-reset-page', initResetPasswordPage],
  ['qfu-dashboard-page', initDashboardPage],
  ['qfu-landing-page', initLandingPage],
];

export function resolvePageInitializer(body = document.body) {
  for (const [className, init] of pageRegistry) {
    if (body.classList.contains(className)) return init;
  }
  return null;
}
