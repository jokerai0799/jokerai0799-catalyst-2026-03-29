import { api } from './api.js';
import { $, setNotice, text } from './dom.js';

export async function ensureLandingLinks() {
  const { user } = await api.getMe();
  if (!user) return;
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
}

export function initSignupPage() {
  const form = document.querySelector('.ud-login-form');
  if (!form) return;
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
    };
    try {
      await api.signup(payload);
      window.location.href = `check-email.html?email=${encodeURIComponent(payload.email)}`;
    } catch (error) {
      setNotice(notice, error.message, 'error');
    }
  });
}

export async function initCheckEmailPage() {
  const params = new URLSearchParams(window.location.search);
  const email = params.get('email') || '';
  text(document.querySelector('[data-email-target]'), email || 'your email address');
  const verifyLink = document.querySelector('[data-verify-link]');
  const resendButton = document.querySelector('[data-resend-verification]');
  const helper = document.querySelector('[data-check-email-helper]');
  if (!verifyLink) return;
  const data = await api.checkEmail(email);
  if (helper) {
    helper.textContent = data.emailDeliveryAvailable
      ? 'We sent a verification email to your inbox. Open it to activate your login.'
      : 'Email delivery is not configured here, so you can verify directly using the button below.';
  }
  if (data.verifyUrl) {
    verifyLink.style.display = '';
    verifyLink.setAttribute('href', data.verifyUrl);
  } else {
    verifyLink.style.display = 'none';
  }
  if (resendButton) {
    resendButton.addEventListener('click', async () => {
      try {
        const result = await api.resendVerification(email);
        if (result.verified) {
          window.location.href = `login.html?verified=success&email=${encodeURIComponent(email)}`;
          return;
        }
        if (helper) {
          helper.textContent = result.sent
            ? 'Verification email resent. Check your inbox.'
            : (result.verifyUrl
              ? 'A fresh verification link is ready below for local/dev use.'
              : 'We could not send an email right now.');
        }
        if (result.verifyUrl) {
          verifyLink.style.display = '';
          verifyLink.setAttribute('href', result.verifyUrl);
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
  try {
    const data = await api.verify(token);
    window.location.href = `login.html?verified=success&email=${encodeURIComponent(data.email)}`;
  } catch {
    window.location.href = 'login.html?verified=invalid';
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

export function initLoginPage() {
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
  if (verified === 'success') setNotice(notice, `Email verified${email ? ` for ${email}` : ''}. You can log in now.`, 'success');
  if (verified === 'invalid') setNotice(notice, 'That verification link is invalid or expired.', 'error');
  if (reset === 'success') setNotice(notice, 'Password updated. You can log in now.', 'success');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api.login({
        email: String(new FormData(form).get('email') || '').trim().toLowerCase(),
        password: String(new FormData(form).get('password') || ''),
      });
      window.location.href = '../dashboard/dashboard.html';
    } catch (error) {
      setNotice(notice, error.message, 'error');
    }
  });

  const demoButton = $('#qfu-demo-login-button');
  if (demoButton) {
    demoButton.addEventListener('click', async () => {
      try {
        await api.demoLogin();
        window.location.href = '../dashboard/dashboard.html';
      } catch (error) {
        setNotice(notice, error.message, 'error');
      }
    });
  }
}
