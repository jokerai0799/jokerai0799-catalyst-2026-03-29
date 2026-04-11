const { APP_URL, HOST, PORT, RESEND_API_KEY, RESEND_FROM_EMAIL } = require('./config');
const { escapeHtml } = require('./utils');

function getAppBaseUrl(req) {
  if (APP_URL) return APP_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
  return `${proto}://${host}`.replace(/\/$/, '');
}

function buildAbsoluteUrl(req, pathname) {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${getAppBaseUrl(req)}${normalized}`;
}

async function sendEmail({ to, subject, html, replyTo }) {
  if (!RESEND_API_KEY) return { sent: false, provider: 'none' };
  const payload = {
    from: RESEND_FROM_EMAIL,
    to: [to],
    subject,
    html,
  };
  if (replyTo) payload.reply_to = replyTo;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Failed to send email (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return { sent: true, provider: 'resend' };
}

async function sendVerificationEmail(req, user) {
  if (!user?.verificationToken) return { sent: false, provider: 'none' };
  const verifyUrl = buildAbsoluteUrl(req, `/landing-page/verify.html?token=${encodeURIComponent(user.verificationToken)}`);
  const firstName = escapeHtml((user.name || '').trim().split(/\s+/)[0] || 'there');
  return sendEmail({
    to: user.email,
    subject: 'Verify your Quote Chaser email',
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;line-height:1.6">
        <h1 style="font-size:24px;margin:0 0 16px">Verify your email</h1>
        <p style="margin:0 0 16px">Hi ${firstName},</p>
        <p style="margin:0 0 16px">Click below to verify your email and activate your Quote Chaser workspace.</p>
        <p style="margin:24px 0">
          <a href="${verifyUrl}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600">Verify email</a>
        </p>
        <p style="margin:0 0 16px">If the button does not work, use this link:</p>
        <p style="word-break:break-all;margin:0 0 16px"><a href="${verifyUrl}">${verifyUrl}</a></p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(req, user) {
  if (!user?.resetToken) return { sent: false, provider: 'none' };
  const resetUrl = buildAbsoluteUrl(req, `/landing-page/reset-password.html?token=${encodeURIComponent(user.resetToken)}`);
  const firstName = escapeHtml((user.name || '').trim().split(/\s+/)[0] || 'there');
  return sendEmail({
    to: user.email,
    subject: 'Reset your Quote Chaser password',
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;line-height:1.6">
        <h1 style="font-size:24px;margin:0 0 16px">Reset your password</h1>
        <p style="margin:0 0 16px">Hi ${firstName},</p>
        <p style="margin:0 0 16px">Click below to choose a new password for your Quote Chaser workspace.</p>
        <p style="margin:24px 0">
          <a href="${resetUrl}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600">Reset password</a>
        </p>
        <p style="margin:0 0 16px">If the button does not work, use this link:</p>
        <p style="word-break:break-all;margin:0 0 16px"><a href="${resetUrl}">${resetUrl}</a></p>
      </div>
    `,
  });
}

async function sendQuoteFollowupEmail(_req, { quote, workspace, sender }) {
  const customerEmail = String(quote?.customerEmail || '').trim().toLowerCase();
  if (!customerEmail) return { sent: false, provider: 'none' };
  const customerName = escapeHtml(quote?.customer || 'there');
  const quoteTitle = escapeHtml(quote?.title || 'your quote');
  const senderName = escapeHtml(sender?.name || workspace?.name || 'The team');
  const replyTo = String(workspace?.replyEmail || sender?.email || '').trim().toLowerCase() || undefined;
  return sendEmail({
    to: customerEmail,
    subject: `Following up on ${quote?.title || 'your quote'}`,
    replyTo,
    html: `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;line-height:1.6">
        <p style="margin:0 0 16px">Hi ${customerName},</p>
        <p style="margin:0 0 16px">Just following up on <strong>${quoteTitle}</strong>. If you want any changes, timings, or a quick call to run through it, just reply and we’ll pick it up.</p>
        <p style="margin:0">Thanks,<br />${senderName}</p>
      </div>
    `,
  });
}

async function attemptEmail(task) {
  try {
    return await task();
  } catch (error) {
    return {
      sent: false,
      provider: 'fallback',
      error: error?.message || 'Email delivery failed',
      status: error?.status,
      body: error?.body,
    };
  }
}

module.exports = {
  attemptEmail,
  sendPasswordResetEmail,
  sendQuoteFollowupEmail,
  sendVerificationEmail,
};
