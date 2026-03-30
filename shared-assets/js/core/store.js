import { api } from './api.js';

const state = {
  user: null,
  workspace: null,
  quotes: [],
  teamMembers: [],
  alerts: {},
};

const ALERTS_KEY = 'catalyst_alerts_v2';

function readAlerts() {
  try {
    state.alerts = JSON.parse(localStorage.getItem(ALERTS_KEY) || '{}');
  } catch {
    state.alerts = {};
  }
}

function writeAlerts() {
  localStorage.setItem(ALERTS_KEY, JSON.stringify(state.alerts));
}

export function getState() {
  return state;
}

export async function refreshState() {
  const bootstrap = await api.getBootstrap();
  state.user = bootstrap.user;
  state.workspace = bootstrap.workspace;
  state.quotes = bootstrap.quotes || [];
  state.teamMembers = bootstrap.teamMembers || [];
  readAlerts();
  return state;
}

export function getAttentionSignature(quotes) {
  return quotes
    .map((quote) => `${quote.id}:${quote.status}:${quote.nextFollowUp}:${quote.archived ? '1' : '0'}`)
    .sort()
    .join('|');
}

export function dismissWorkspaceAlert(workspaceId, signature) {
  state.alerts[workspaceId] = signature;
  writeAlerts();
}

export function isWorkspaceAlertDismissed(workspaceId, signature) {
  readAlerts();
  return state.alerts[workspaceId] === signature;
}
