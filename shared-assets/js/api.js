async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
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
  demoLogin() {
    return request('/api/auth/demo-login', { method: 'POST', body: JSON.stringify({}) });
  },
  logout() {
    return request('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) });
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
};
