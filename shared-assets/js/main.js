import { ensureLandingLinks, initCheckEmailPage, initForgotPasswordPage, initLoginPage, initResetPasswordPage, initSignupPage, initVerifyPage } from './auth.js';
import { renderDashboard } from './dashboard.js';
import { getState, refreshState } from './store.js';

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

async function initPage() {
  const body = document.body;
  if (body.classList.contains('qfu-auth-page-signup')) return initSignupPage();
  if (body.classList.contains('qfu-auth-page-login')) return initLoginPage();
  if (body.classList.contains('qfu-check-email-page')) return initCheckEmailPage();
  if (body.classList.contains('qfu-verify-page')) return initVerifyPage();
  if (body.classList.contains('qfu-forgot-page')) return initForgotPasswordPage();
  if (body.classList.contains('qfu-reset-page')) return initResetPasswordPage();
  if (body.classList.contains('qfu-dashboard-page')) return initDashboardPage();
  if (body.classList.contains('qfu-landing-page')) return ensureLandingLinks();
}

document.addEventListener('DOMContentLoaded', () => {
  initPage().catch((error) => {
    console.error('Catalyst init failed', error);
  });
});
