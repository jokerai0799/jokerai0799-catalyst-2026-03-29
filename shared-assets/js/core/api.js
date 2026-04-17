function getActiveWorkspaceId() {
  try {
    return window.localStorage.getItem('qfu-active-workspace-id') || '';
  } catch {
    return '';
  }
}

async function request(path, options = {}) {
  const activeWorkspaceId = getActiveWorkspaceId();
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(activeWorkspaceId ? { 'X-Workspace-Id': activeWorkspaceId } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export const api = {
  getMe() {
    return request('/api/auth/me');
  },
  getBootstrap() {
    return request('/api/app/bootstrap');
  },
  pingActivity() {
    return request('/api/activity/ping', { method: 'POST', body: JSON.stringify({}) });
  },
  signup(payload) {
    return request('/api/auth/signup', { method: 'POST', body: JSON.stringify(payload) });
  },
  checkEmail(email) {
    return request(`/api/auth/check-email?email=${encodeURIComponent(email)}`);
  },
  resendVerification(email) {
    return request('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
  },
  verify(token) {
    return request('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) });
  },
  login(payload) {
    return request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });
  },
  logout() {
    return request('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
  },
  createBillingPortalSession() {
    return request('/api/billing/portal-session', { method: 'POST', body: JSON.stringify({}) });
  },
  selectWorkspace(workspaceId) {
    return request('/api/workspace/select', { method: 'POST', body: JSON.stringify({ workspaceId }) });
  },
  forgotPassword(email) {
    return request('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
  },
  resetPassword(payload) {
    return request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify(payload) });
  },
  updateWorkspace(payload) {
    return request('/api/workspace', { method: 'PATCH', body: JSON.stringify(payload) });
  },
  createQuote(payload) {
    return request('/api/quotes', { method: 'POST', body: JSON.stringify(payload) });
  },
  updateQuote(id, payload) {
    return request(`/api/quotes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
  },
  deleteQuote(id) {
    return request(`/api/quotes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  quoteAction(id, action) {
    return request(`/api/quotes/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action }) });
  },
  addTeamMember(payload) {
    return request('/api/team', { method: 'POST', body: JSON.stringify(payload) });
  },
  acceptInvite(id) {
    return request(`/api/invites/${encodeURIComponent(id)}/accept`, { method: 'POST', body: JSON.stringify({}) });
  },
  declineInvite(id) {
    return request(`/api/invites/${encodeURIComponent(id)}/decline`, { method: 'POST', body: JSON.stringify({}) });
  },
  deleteTeamMember(id) {
    return request(`/api/team/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  sendQuoteEmail(id) {
    return request(`/api/quotes/${encodeURIComponent(id)}/send-email`, { method: 'POST', body: JSON.stringify({}) });
  },
};
