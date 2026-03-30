import { api } from './api.js';
import { $, setNotice, text } from './dom.js';
import { loadQuoteIntoEditor, renderQuoteDetail } from './quotes.js';
import { getState, refreshState } from './store.js';
import { addDays, formatCurrency, today } from './utils.js';

function currentQuoteId() {
  return new URLSearchParams(window.location.search).get('id') || '';
}

function quotePayload(workspace) {
  const title = $('#quote-title')?.value.trim() || '';
  const rawValue = ($('#quote-value')?.value || '').replace(/[^0-9.]/g, '');
  const sentDate = $('#quote-date')?.value || today();
  return {
    title,
    customer: title.split('-')[1]?.trim() || title,
    value: Number(rawValue),
    status: $('#quote-status')?.value || 'Draft',
    owner: $('#quote-owner')?.value || '',
    sentDate,
    nextFollowUp: $('#quote-followup')?.value || addDays(sentDate, workspace.firstFollowupDays || 2),
    notes: $('#quote-notes')?.value.trim() || '',
  };
}

function updateShell(state, quote) {
  text($('#qfu-quote-page-workspace'), state.workspace?.name || 'Workspace');
  text($('#qfu-quote-page-title'), quote?.title || 'Quote record');
  text($('#qfu-quote-page-subtitle'), quote
    ? `${quote.owner} · ${quote.status} · ${formatCurrency(quote.value)}`
    : 'Quote not found');
  const backLink = $('#qfu-quote-back-link');
  if (backLink) backLink.href = './dashboard.html#quotes';
}

function setOwnerOptions(state) {
  const ownerSelect = $('#quote-owner');
  if (!ownerSelect) return;
  const current = ownerSelect.value || state.user?.name || '';
  ownerSelect.replaceChildren();
  state.teamMembers.forEach((member) => {
    const option = document.createElement('option');
    option.value = member.name;
    option.textContent = member.name;
    ownerSelect.appendChild(option);
  });
  ownerSelect.value = state.teamMembers.some((member) => member.name === current)
    ? current
    : (state.user?.name || state.teamMembers[0]?.name || 'Owner');
}

async function renderPage() {
  const quoteId = currentQuoteId();
  if (!quoteId) {
    window.location.href = './dashboard.html#quotes';
    return;
  }

  await refreshState();
  const state = getState();
  const quote = state.quotes.find((item) => item.id === quoteId);
  updateShell(state, quote);
  setOwnerOptions(state);

  if (!quote) {
    renderQuoteDetail(null);
    setNotice($('#qfu-quote-form-notice'), 'This quote could not be found.', 'error');
    return;
  }

  loadQuoteIntoEditor(quote);
  const trigger = document.querySelector('.qfu-app-nav-vertical [data-tab="quotes"]');
  if (trigger) trigger.classList.add('active');
}

function bindPageActions() {
  const logout = $('#qfu-logout-link');
  if (logout && !logout.dataset.bound) {
    logout.dataset.bound = 'true';
    logout.addEventListener('click', async (event) => {
      event.preventDefault();
      await api.logout();
      window.location.href = '../landing-page/login.html';
    });
  }

  const form = $('#qfu-quote-form');
  if (form && !form.dataset.bound) {
    form.dataset.bound = 'true';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await refreshState();
      const state = getState();
      const quoteId = currentQuoteId();
      const payload = quotePayload(state.workspace);
      if (!payload.title || !payload.value) {
        setNotice($('#qfu-quote-form-notice'), 'Add at least a title and value before saving.', 'error');
        return;
      }
      await api.updateQuote(quoteId, payload);
      await renderPage();
      setNotice($('#qfu-quote-form-notice'), 'Quote updated.', 'success');
    });
  }

  const scheduleButton = $('#qfu-quote-followup-button');
  if (scheduleButton && !scheduleButton.dataset.bound) {
    scheduleButton.dataset.bound = 'true';
    scheduleButton.addEventListener('click', async () => {
      await refreshState();
      const state = getState();
      const sentDate = $('#quote-date').value || today();
      $('#quote-followup').value = addDays(sentDate, state.workspace.firstFollowupDays || 2);
      $('#quote-status').value = 'Follow up due';
      setNotice($('#qfu-quote-form-notice'), 'Follow-up date scheduled from workspace settings.', 'success');
    });
  }

  [
    ['#qfu-quote-mark-contacted', 'mark-contacted', 'Quote marked as replied.'],
    ['#qfu-quote-mark-won', 'mark-won', 'Quote marked as won.'],
    ['#qfu-quote-mark-lost', 'mark-lost', 'Quote marked as lost.'],
    ['#qfu-quote-archive', 'archive', 'Quote archived.'],
  ].forEach(([selector, action, message]) => {
    const button = $(selector);
    if (!button || button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', async () => {
      await api.quoteAction(currentQuoteId(), action);
      await renderPage();
      setNotice($('#qfu-quote-form-notice'), message, 'success');
    });
  });

  const deleteButton = $('#qfu-quote-delete');
  if (deleteButton && !deleteButton.dataset.bound) {
    deleteButton.dataset.bound = 'true';
    deleteButton.addEventListener('click', async () => {
      const confirmed = window.confirm('Delete this quote permanently from the workspace?');
      if (!confirmed) return;
      await api.deleteQuote(currentQuoteId());
      window.location.href = './dashboard.html#quotes';
    });
  }
}

export async function initQuotePage() {
  try {
    await renderPage();
    bindPageActions();
  } catch (error) {
    if (error.status === 401) {
      window.location.href = '../landing-page/login.html';
      return;
    }
    throw error;
  }
}
