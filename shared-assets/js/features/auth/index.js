import { api } from '../../core/api.js';
import { setNotice, text } from '../../core/dom.js';

const CHECKOUT_INTENT_STORAGE_KEY = 'qfu-pending-checkout';

function normalizePlan(plan) {
  return String(plan || '').trim().toLowerCase() === 'business' ? 'business' : 'personal';
}

function isCheckoutIntent(params) {
  return String(params?.get('next') || '').trim().toLowerCase() === 'checkout';
}

function buildCheckoutQuery(plan) {
  const query = new URLSearchParams();
  query.set('next', 'checkout');
  query.set('plan', normalizePlan(plan));
  return query.toString();
}

function buildAuthPageUrl(page, plan, wantsCheckout = false) {
  if (!wantsCheckout) return `${page}.html`;
  return `${page}.html?${buildCheckoutQuery(plan)}`;
}

function appendCheckoutParams(targetUrl, plan, wantsCheckout = false) {
  if (!wantsCheckout) return targetUrl;
  const url = new URL(targetUrl, window.location.href);
  url.searchParams.set('next', 'checkout');
  url.searchParams.set('plan', normalizePlan(plan));
  return `${url.pathname}${url.search}${url.hash}`;
}

function storePendingCheckout(plan) {
  try {
    window.localStorage.setItem(CHECKOUT_INTENT_STORAGE_KEY, JSON.stringify({
      next: 'checkout',
      plan: normalizePlan(plan),
    }));
  } catch {}
}

function clearPendingCheckout() {
  try {
    window.localStorage.removeItem(CHECKOUT_INTENT_STORAGE_KEY);
  } catch {}
}

function readPendingCheckout() {
  try {
    const raw = window.localStorage.getItem(CHECKOUT_INTENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.next !== 'checkout') return null;
    return { next: 'checkout', plan: normalizePlan(parsed.plan) };
  } catch {
    return null;
  }
}

function getRequestedPlan(params) {
  if (isCheckoutIntent(params)) return normalizePlan(params.get('plan'));
  return readPendingCheckout()?.plan || 'personal';
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

async function redirectToCheckout(plan) {
  const billing = await fetchBillingConfig();
  const normalizedPlan = normalizePlan(plan);
  const checkoutUrl = normalizedPlan === 'business'
    ? billing?.businessCheckoutLink || ''
    : billing?.personalCheckoutLink || '';
  clearPendingCheckout();
  window.location.href = checkoutUrl || '../dashboard/dashboard.html#settings';
}

function updateAuthPageLinks({ plan, wantsCheckout }) {
  const loginUrl = buildAuthPageUrl('login', plan, wantsCheckout);
  const signupUrl = buildAuthPageUrl('signup', plan, wantsCheckout);
  document.querySelectorAll('a[href="login.html"]').forEach((node) => {
    node.setAttribute('href', loginUrl);
  });
  document.querySelectorAll('a[href="signup.html"]').forEach((node) => {
    node.setAttribute('href', signupUrl);
  });
  document.querySelectorAll('a[href="/api/auth/google/start"]').forEach((node) => {
    node.setAttribute('href', wantsCheckout
      ? `/api/auth/google/start?${buildCheckoutQuery(plan)}`
      : '/api/auth/google/start');
  });
}

export async function ensureLandingLinks() {
  const { user } = await api.getMe();
  if (!user) return null;
  document.querySelectorAll('a.ud-login-btn').forEach((node) => {
    node.textContent = 'Open workspace';
    node.setAttribute('href', '../dashboard/dashboard.html');
  });
  Array.from(document.querySelectorAll('a.ud-white-btn, a.ud-main-btn'))
    .filter((node) => /Start 7 Day Trial|Sign Up|Open workspace/i.test(node.textContent || ''))
    .forEach((node) => {
      node.textContent = 'Open workspace';
      node.setAttribute('href', '../dashboard/dashboard.html');
    });
  return user;
}

export function initSignupPage() {
  const form = document.querySelector('.ud-login-form');
  if (!form) return;
  const params = new URLSearchParams(window.location.search);
  const wantsCheckout = isCheckoutIntent(params);
  const selectedPlan = getRequestedPlan(params);
  if (wantsCheckout) storePendingCheckout(selectedPlan);
  updateAuthPageLinks({ plan: selectedPlan, wantsCheckout });

  const planInput = form.querySelector('input[name="plan"]');
  if (planInput) planInput.value = selectedPlan;
  const planLabel = document.querySelector('[data-selected-plan]');
  if (planLabel) planLabel.textContent = selectedPlan === 'business' ? 'Business workspace trial' : 'Personal workspace trial';
  const notice = document.createElement('div');
  notice.className = 'qfu-inline-notice';
  notice.style.display = 'none';
  form.prepend(notice);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: String(new FormData(form).get('name') || '').trim(),
      company: String(new FormData(form).get('company') || '').trim(),
      email: String(new FormData(form).get('email') || '').trim().toLowerCase(),
      password: String(new FormData(form).get('password') || ''),
      plan: String(new FormData(form).get('plan') || selectedPlan),
    };
    try {
      await api.signup(payload);
      const checkEmailUrl = new URL('check-email.html', window.location.href);
      checkEmailUrl.searchParams.set('email', payload.email);
      if (wantsCheckout) {
        checkEmailUrl.searchParams.set('next', 'checkout');
        checkEmailUrl.searchParams.set('plan', selectedPlan);
      }
      window.location.href = `${checkEmailUrl.pathname}${checkEmailUrl.search}${checkEmailUrl.hash}`;
    } catch (error) {
      setNotice(notice, `${error.message} If you recently created an account, verify your email first or use Google sign-in if that is how you joined.`, 'error');
    }
  });
}

export async function initCheckEmailPage() {
  const params = new URLSearchParams(window.location.search);
  const email = params.get('email') || '';
  const wantsCheckout = isCheckoutIntent(params);
  const selectedPlan = getRequestedPlan(params);
  if (wantsCheckout) storePendingCheckout(selectedPlan);
  text(document.querySelector('[data-email-target]'), email || 'your email address');
  const verifyLink = document.querySelector('[data-verify-link]');
  const resendButton = document.querySelector('[data-resend-verification]');
  const helper = document.querySelector('[data-check-email-helper]');
  const signInLink = Array.from(document.querySelectorAll('a')).find((node) => (node.getAttribute('href') || '') === 'login.html');
  if (signInLink) signInLink.setAttribute('href', buildAuthPageUrl('login', selectedPlan, wantsCheckout));
  if (!verifyLink) return;
  const data = await api.checkEmail(email);
  if (helper) {
    helper.textContent = data.emailDeliveryAvailable
      ? 'We sent a verification email to your inbox. Open it to activate your login.'
      : 'Email delivery is not configured here, so you can verify directly using the button below.';
  }
  if (data.verifyUrl) {
    verifyLink.style.display = '';
    verifyLink.setAttribute('href', appendCheckoutParams(data.verifyUrl, selectedPlan, wantsCheckout));
  } else {
    verifyLink.style.display = 'none';
  }
  if (resendButton) {
    resendButton.addEventListener('click', async () => {
      try {
        const result = await api.resendVerification(email);
        if (helper) {
          helper.textContent = result.sent
            ? 'If your account still needs verification, a fresh email is on the way.'
            : (result.verifyUrl
              ? 'A fresh verification link is ready below.'
              : 'If your account still needs verification, check your inbox or try again shortly.');
        }
        if (result.verifyUrl) {
          verifyLink.style.display = '';
          verifyLink.setAttribute('href', appendCheckoutParams(result.verifyUrl, selectedPlan, wantsCheckout));
        } else {
          verifyLink.style.display = 'none';
        }
      } catch (error) {
        if (helper) helper.textContent = error.message;
      }
    });
  }
}

export async function initVerifyPage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const storedCheckout = readPendingCheckout();
  const wantsCheckout = isCheckoutIntent(params) || Boolean(storedCheckout);
  const selectedPlan = isCheckoutIntent(params) ? getRequestedPlan(params) : (storedCheckout?.plan || 'personal');
  if (wantsCheckout) storePendingCheckout(selectedPlan);
  try {
    const data = await api.verify(token);
    const loginUrl = new URL('login.html', window.location.href);
    loginUrl.searchParams.set('verified', 'success');
    loginUrl.searchParams.set('email', data.email);
    if (wantsCheckout) {
      loginUrl.searchParams.set('next', 'checkout');
      loginUrl.searchParams.set('plan', selectedPlan);
    }
    window.location.href = `${loginUrl.pathname}${loginUrl.search}${loginUrl.hash}`;
  } catch {
    const loginUrl = new URL('login.html', window.location.href);
    loginUrl.searchParams.set('verified', 'invalid');
    if (wantsCheckout) {
      loginUrl.searchParams.set('next', 'checkout');
      loginUrl.searchParams.set('plan', selectedPlan);
    }
    window.location.href = `${loginUrl.pathname}${loginUrl.search}${loginUrl.hash}`;
  }
}

export function initForgotPasswordPage() {
  const form = document.querySelector('.ud-login-form');
  if (!form) return;
  const notice = document.createElement('div');
  notice.className = 'qfu-inline-notice';
  notice.style.display = 'none';
  form.prepend(notice);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = String(new FormData(form).get('email') || '').trim().toLowerCase();
    try {
      const data = await api.forgotPassword(email);
      setNotice(notice, data.sent || data.emailDeliveryAvailable
        ? 'If that email exists, we sent password reset instructions.'
        : 'Email delivery is not configured here. Use the local reset link below.', 'success');
      let link = form.querySelector('.qfu-reset-link');
      if (data.resetUrl) {
        if (!link) {
          link = document.createElement('a');
          link.className = 'qfu-reset-link';
          link.style.display = 'block';
          link.style.marginTop = '12px';
          form.appendChild(link);
        }
        link.href = data.resetUrl;
        link.textContent = 'Open reset password page';
      } else if (link) {
        link.remove();
      }
    } catch (error) {
      setNotice(notice, error.message, 'error');
    }
  });
}

export function initResetPasswordPage() {
  const form = document.querySelector('.ud-login-form');
  if (!form) return;
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const notice = document.createElement('div');
  notice.className = 'qfu-inline-notice';
  notice.style.display = 'none';
  form.prepend(notice);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    try {
      await api.resetPassword({
        token,
        password: String(formData.get('password') || ''),
        confirmPassword: String(formData.get('confirmPassword') || ''),
      });
      window.location.href = 'login.html?reset=success';
    } catch (error) {
      setNotice(notice, error.message, 'error');
    }
  });
}

export async function initLoginPage() {
  const form = document.querySelector('.ud-login-form');
  if (!form) return;
  const notice = document.createElement('div');
  notice.className = 'qfu-inline-notice';
  notice.style.display = 'none';
  form.prepend(notice);
  const params = new URLSearchParams(window.location.search);
  const verified = params.get('verified');
  const email = params.get('email');
  const reset = params.get('reset');
  const google = params.get('google');
  const storedCheckout = readPendingCheckout();
  const wantsCheckout = isCheckoutIntent(params) || Boolean(storedCheckout && (verified === 'success' || google === 'success'));
  const selectedPlan = isCheckoutIntent(params) ? getRequestedPlan(params) : (storedCheckout?.plan || 'personal');
  if (wantsCheckout) storePendingCheckout(selectedPlan);
  updateAuthPageLinks({ plan: selectedPlan, wantsCheckout });

  if (verified === 'success') setNotice(notice, `Email verified${email ? ` for ${email}` : ''}. You can log in now.`, 'success');
  if (verified === 'invalid') setNotice(notice, 'That verification link is invalid or expired.', 'error');
  if (reset === 'success') setNotice(notice, 'Password updated. You can log in now.', 'success');
  if (google === 'failed') setNotice(notice, 'Google sign-in failed. Try again.', 'error');
  if (google === 'cancelled') setNotice(notice, 'Google sign-in was cancelled.', 'error');
  if (google === 'invalid-state') setNotice(notice, 'Google sign-in expired. Try again.', 'error');
  if (google === 'not-configured') setNotice(notice, 'Google sign-in is not configured yet.', 'error');

  if (wantsCheckout) {
    try {
      const { user } = await api.getMe();
      if (user) {
        await redirectToCheckout(selectedPlan);
        return;
      }
    } catch {}
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.login({
        email: String(new FormData(form).get('email') || '').trim().toLowerCase(),
        password: String(new FormData(form).get('password') || ''),
      });
      if (wantsCheckout) {
        await redirectToCheckout(selectedPlan);
        return;
      }
      window.location.href = '../dashboard/dashboard.html';
    } catch (error) {
      setNotice(notice, error.message, 'error');
    }
  });
}
