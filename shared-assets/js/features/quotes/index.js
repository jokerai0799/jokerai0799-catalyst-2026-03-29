import { api } from '../../core/api.js';
import { $, clear, create, setNotice, text } from '../../core/dom.js';
import { addDays, daysBetween, formatCurrency, formatEventTime, quoteStatusBadge, relativeFollowUpLabel, today } from '../../core/utils.js';

const QUOTES_PAGE_SIZE = 10;
let quotesPage = 1;

function openQuotesTab() {
  const trigger = document.querySelector('.qfu-app-nav-vertical [data-tab="quotes"]');
  if (trigger) trigger.click();
}

function scrollQuoteEditorIntoView() {
  const panel = document.querySelector('.qfu-panel.qfu-panel-editing');
  if (!panel) return;
  setTimeout(() => {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
}

export function openQuoteInEditor(quote, options = {}) {
  loadQuoteIntoEditor(quote);
  openQuotesTab();
  if (options.scroll !== false) scrollQuoteEditorIntoView();
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
    customerEmail: $('#quote-customer-email')?.value.trim().toLowerCase() || '',
    notes: $('#quote-notes')?.value.trim() || '',
  };
}

export function resetQuoteEditor(workspace, ownerName) {
  const form = $('#qfu-quote-form');
  if (!form) return;
  form.reset();
  $('#quote-id').value = '';
  $('#quote-date').value = today();
  $('#quote-followup').value = addDays(today(), workspace.firstFollowupDays || 2);
  if ($('#quote-customer-email')) $('#quote-customer-email').value = '';
  if ($('#quote-owner') && ownerName) $('#quote-owner').value = ownerName;
  text($('#qfu-quote-form-kicker'), 'New quote');
  text($('#qfu-quote-form-title'), 'Add a quote quickly');
  text($('#qfu-quote-save-button'), 'Save quote');
  renderQuoteDetail(null);
}

export function renderQuoteDetail(quote) {
  if (!$('#qfu-detail-title')) return;
  if (!quote) {
    text($('#qfu-detail-title'), 'Select a quote');
    text($('#qfu-detail-status'), '—');
    text($('#qfu-detail-owner'), '—');
    text($('#qfu-detail-value'), '—');
    text($('#qfu-detail-followup'), '—');
    text($('#qfu-detail-notes'), 'Load a quote to inspect its notes and recent actions.');
    const list = $('#qfu-quote-activity-list');
    clear(list);
    list?.appendChild(create('li', {
      children: [create('strong', { text: 'No quote selected' }), create('span', { text: 'Click a row in the quote table to inspect it here.' })],
    }));
    return;
  }
  text($('#qfu-detail-title'), quote.title);
  text($('#qfu-detail-status'), quote.archived ? 'Archived' : quote.status);
  text($('#qfu-detail-owner'), quote.owner);
  text($('#qfu-detail-value'), formatCurrency(quote.value));
  text($('#qfu-detail-followup'), relativeFollowUpLabel(quote.nextFollowUp));
  text($('#qfu-detail-notes'), quote.notes || 'No notes added yet.');
  const list = $('#qfu-quote-activity-list');
  clear(list);
  const events = quote.history?.length ? quote.history : [{ summary: 'Quote record ready', detail: 'Use the editor actions to build a timeline.', createdAt: quote.createdAt }];
  events.forEach((event) => {
    list?.appendChild(create('li', {
      children: [create('strong', { text: event.summary }), create('span', { text: `${event.detail} · ${formatEventTime(event.createdAt)}` })],
    }));
  });
}

export function loadQuoteIntoEditor(quote) {
  const values = {
    'quote-id': quote.id,
    'quote-title': quote.title,
    'quote-value': String(quote.value),
    'quote-status': quote.status,
    'quote-owner': quote.owner,
    'quote-date': quote.sentDate,
    'quote-followup': quote.nextFollowUp,
    'quote-customer-email': quote.customerEmail || '',
    'quote-notes': quote.notes || '',
  };
  Object.entries(values).forEach(([id, value]) => {
    const node = document.getElementById(id);
    if (node) node.value = value;
  });
  text($('#qfu-quote-form-kicker'), 'Editing quote');
  text($('#qfu-quote-form-title'), quote.title);
  text($('#qfu-quote-save-button'), 'Save changes');
  renderQuoteDetail(quote);
  setNotice($('#qfu-quote-form-notice'), `Loaded ${quote.title}. Update the fields below and save.`, 'success');
}

function createActionButton(label, action, quoteId) {
  return create('button', {
    className: 'qfu-link-button',
    text: label,
    attrs: { type: 'button' },
    dataset: { chaseAction: action, quoteActionId: quoteId },
  });
}

function createOpenLink(quoteId) {
  return create('button', {
    className: 'qfu-link-button',
    text: 'Open quote',
    attrs: { type: 'button' },
    dataset: { loadQuoteId: quoteId },
  });
}

function createEmailClientButton(quote) {
  return create('button', {
    className: 'qfu-link-button',
    text: 'Email client',
    attrs: { type: 'button' },
    dataset: {
      emailClientId: quote.id,
      emailClientAddress: quote.customerEmail || '',
      emailClientTitle: quote.title || '',
      emailClientCustomer: quote.customer || '',
    },
  });
}

function quoteAgeLabel(quote) {
  const baseDate = quote.sentDate || quote.createdAt?.slice(0, 10) || today();
  const age = Math.max(0, -daysBetween(baseDate));
  if (age === 0) return 'Sent today';
  if (age === 1) return '1 day old';
  return `${age} days old`;
}

function recommendedNextStep(quote) {
  const diff = daysBetween(quote.nextFollowUp);
  if (quote.status === 'Draft') return 'Send quote';
  if (quote.status === 'Won') return 'Book work';
  if (quote.status === 'Lost') return 'Close out';
  if (diff < 0) return 'Follow up now';
  if (diff === 0) return 'Call or email today';
  if (quote.status === 'Sent') return 'Plan first chase';
  return 'Review and update';
}

export function renderDashboardAttentionTable(quotes) {
  const tbody = $('#qfu-dashboard-attention-body');
  if (!tbody) return;
  clear(tbody);
  if (!quotes.length) {
    const row = create('tr');
    row.appendChild(create('td', { attrs: { colspan: '6' }, children: [create('strong', { text: 'No quotes due right now.' }), create('span', { text: 'Your chase list is clear.' })] }));
    tbody.appendChild(row);
    return;
  }
  quotes.slice(0, 6).forEach((quote) => {
    const [label, badgeClass] = quoteStatusBadge(quote.status, quote.nextFollowUp);
    const row = create('tr', { dataset: { quoteId: quote.id }, className: 'qfu-quote-row' });
    row.appendChild(create('td', { children: [create('strong', { text: quote.title }), create('span', { text: `Owner: ${quote.owner}` })] }));
    row.appendChild(create('td', { text: quoteAgeLabel(quote) }));
    row.appendChild(create('td', { children: [create('span', { className: `qfu-badge ${badgeClass}`, text: label })] }));
    row.appendChild(create('td', { text: relativeFollowUpLabel(quote.nextFollowUp) }));
    row.appendChild(create('td', { text: formatCurrency(quote.value) }));
    const actions = create('div', { className: 'qfu-inline-link-actions qfu-inline-link-actions-stack' });
    actions.appendChild(create('span', { className: 'qfu-next-step-label', text: recommendedNextStep(quote) }));
    const links = create('div', { className: 'qfu-inline-link-actions' });
    links.appendChild(createOpenLink(quote.id));
    links.appendChild(createEmailClientButton(quote));
    actions.appendChild(links);
    row.appendChild(create('td', { children: [actions] }));
    tbody.appendChild(row);
  });
}

function updateQuotesPagination(totalItems) {
  const totalPages = Math.max(1, Math.ceil(totalItems / QUOTES_PAGE_SIZE));
  if (quotesPage > totalPages) quotesPage = totalPages;
  const start = totalItems ? ((quotesPage - 1) * QUOTES_PAGE_SIZE) + 1 : 0;
  const end = Math.min(totalItems, quotesPage * QUOTES_PAGE_SIZE);

  text($('#qfu-quotes-pagination-summary'), totalItems ? `Showing ${start}-${end} of ${totalItems} quotes` : 'No quotes yet');
  text($('#qfu-quotes-page-label'), `Page ${quotesPage} of ${totalPages}`);

  const prev = $('#qfu-quotes-prev');
  const next = $('#qfu-quotes-next');
  if (prev) prev.disabled = quotesPage <= 1;
  if (next) next.disabled = quotesPage >= totalPages;
}

export function renderAllQuotesTable(quotes) {
  const tbody = $('#qfu-all-quotes-body');
  if (!tbody) return;
  clear(tbody);
  if (!quotes.length) {
    updateQuotesPagination(0);
    const row = create('tr');
    row.appendChild(create('td', { attrs: { colspan: '5' }, children: [create('strong', { text: 'No quotes yet.' }), create('span', { text: 'Add your first quote to populate the workspace.' })] }));
    tbody.appendChild(row);
    return;
  }
  updateQuotesPagination(quotes.length);
  const visibleQuotes = quotes.slice((quotesPage - 1) * QUOTES_PAGE_SIZE, quotesPage * QUOTES_PAGE_SIZE);
  visibleQuotes.forEach((quote) => {
    const [label, badgeClass] = quoteStatusBadge(quote.status, quote.nextFollowUp);
    const row = create('tr', { dataset: { quoteId: quote.id }, className: 'qfu-quote-row' });
    row.appendChild(create('td', { children: [create('strong', { text: quote.title }), create('span', { text: quote.customer || 'Customer not set' })] }));
    row.appendChild(create('td', { text: quote.owner }));
    row.appendChild(create('td', { children: [create('span', { className: `qfu-badge ${badgeClass}`, text: label })] }));
    row.appendChild(create('td', { text: relativeFollowUpLabel(quote.nextFollowUp) }));
    row.appendChild(create('td', { text: formatCurrency(quote.value) }));
    tbody.appendChild(row);
  });
}

export function bindQuoteInteractions(state, refreshApp) {
  const readOnly = Boolean(state.workspace?.readOnly);
  const prev = $('#qfu-quotes-prev');
  if (prev && !prev.dataset.bound) {
    prev.dataset.bound = 'true';
    prev.addEventListener('click', () => {
      if (quotesPage <= 1) return;
      quotesPage -= 1;
      renderAllQuotesTable(state.quotes);
      bindQuoteInteractions(state, refreshApp);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  const next = $('#qfu-quotes-next');
  if (next && !next.dataset.bound) {
    next.dataset.bound = 'true';
    next.addEventListener('click', () => {
      const totalPages = Math.max(1, Math.ceil(state.quotes.length / QUOTES_PAGE_SIZE));
      if (quotesPage >= totalPages) return;
      quotesPage += 1;
      renderAllQuotesTable(state.quotes);
      bindQuoteInteractions(state, refreshApp);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  document.querySelectorAll('[data-quote-id]').forEach((row) => {
    if (row.dataset.bound) return;
    row.dataset.bound = 'true';
    row.addEventListener('click', (event) => {
      if (event.target.closest('a,button')) return;
      const quote = state.quotes.find((item) => item.id === row.dataset.quoteId);
      if (!quote) return;
      openQuoteInEditor(quote);
    });
  });

  document.querySelectorAll('[data-load-quote-id]').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const quote = state.quotes.find((item) => item.id === button.dataset.loadQuoteId);
      if (!quote) return;
      openQuoteInEditor(quote);
    });
  });

  document.querySelectorAll('[data-email-client-id]').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const email = button.dataset.emailClientAddress || '';
      const quote = state.quotes.find((item) => item.id === button.dataset.emailClientId);
      if (!email) {
        if (quote) openQuoteInEditor(quote);
        setNotice($('#qfu-quote-form-notice'), 'Add a customer email to this quote first.', 'error');
        return;
      }
      const quoteId = button.dataset.emailClientId;
      if (readOnly) {
        setNotice($('#qfu-quote-form-notice'), state.workspace?.readOnlyReason || 'This workspace is read-only right now.', 'error');
        return;
      }
      api.sendQuoteEmail(quoteId)
        .then(async () => {
          setNotice($('#qfu-quote-form-notice'), 'Follow-up email sent.', 'success');
          await refreshApp();
        })
        .catch((error) => {
          const subject = encodeURIComponent(`Quote follow up: ${button.dataset.emailClientTitle || 'Quote'}`);
          const body = encodeURIComponent(`Hi ${button.dataset.emailClientCustomer || ''},\n\nJust following up on your quote. Happy to answer any questions or make any changes if helpful.\n`);
          window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
          setNotice($('#qfu-quote-form-notice'), error.message.includes('configured') ? 'Email sending is not configured yet, so we opened your mail client instead.' : error.message, error.message.includes('configured') ? 'success' : 'error');
        });
    });
  });

  const form = $('#qfu-quote-form');
  if (form && !form.dataset.bound) {
    form.dataset.bound = 'true';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (readOnly) {
        setNotice($('#qfu-quote-form-notice'), state.workspace?.readOnlyReason || 'This workspace is read-only right now.', 'error');
        return;
      }
      const payload = quotePayload(state.workspace);
      if (!payload.title || !payload.value) {
        setNotice($('#qfu-quote-form-notice'), 'Add at least a title and value before saving.', 'error');
        return;
      }
      const quoteId = $('#quote-id').value;
      if (quoteId) {
        await api.updateQuote(quoteId, payload);
        setNotice($('#qfu-quote-form-notice'), 'Quote updated.', 'success');
      } else {
        await api.createQuote(payload);
        setNotice($('#qfu-quote-form-notice'), 'Quote added to the workspace.', 'success');
        quotesPage = 1;
      }
      await refreshApp();
      resetQuoteEditor(state.workspace, state.user.name);
    });
  }

  const scheduleButton = $('#qfu-quote-followup-button');
  if (scheduleButton && !scheduleButton.dataset.bound) {
    scheduleButton.dataset.bound = 'true';
    scheduleButton.addEventListener('click', () => {
      if (readOnly) {
        setNotice($('#qfu-quote-form-notice'), state.workspace?.readOnlyReason || 'This workspace is read-only right now.', 'error');
        return;
      }
      const sentDate = $('#quote-date').value || today();
      $('#quote-followup').value = addDays(sentDate, state.workspace.firstFollowupDays || 2);
      $('#quote-status').value = 'Follow up due';
      setNotice($('#qfu-quote-form-notice'), 'Follow-up date scheduled from your workspace settings.', 'success');
    });
  }

  const clearButton = $('#qfu-quote-clear-button');
  if (clearButton && !clearButton.dataset.bound) {
    clearButton.dataset.bound = 'true';
    clearButton.addEventListener('click', () => {
      if (readOnly) {
        setNotice($('#qfu-quote-form-notice'), state.workspace?.readOnlyReason || 'This workspace is read-only right now.', 'error');
        return;
      }
      resetQuoteEditor(state.workspace, state.user.name);
      setNotice($('#qfu-quote-form-notice'), 'Quote form cleared.', 'success');
    });
  }

  [
    ['#qfu-quote-mark-contacted', 'mark-contacted', 'marked as replied.'],
    ['#qfu-quote-mark-won', 'mark-won', 'marked as won.'],
    ['#qfu-quote-mark-lost', 'mark-lost', 'marked as lost.'],
    ['#qfu-quote-archive', 'archive', 'archived.'],
  ].forEach(([selector, action, message]) => {
    const button = $(selector);
    if (!button || button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', async () => {
      if (readOnly) {
        setNotice($('#qfu-quote-form-notice'), state.workspace?.readOnlyReason || 'This workspace is read-only right now.', 'error');
        return;
      }
      const quoteId = $('#quote-id').value;
      if (!quoteId) return setNotice($('#qfu-quote-form-notice'), 'Load a quote into the editor first.', 'error');
      await api.quoteAction(quoteId, action);
      setNotice($('#qfu-quote-form-notice'), `Quote ${message}`, 'success');
      await refreshApp();
    });
  });

  const deleteButton = $('#qfu-quote-delete');
  if (deleteButton && !deleteButton.dataset.bound) {
    deleteButton.dataset.bound = 'true';
    deleteButton.addEventListener('click', async () => {
      if (readOnly) {
        setNotice($('#qfu-quote-form-notice'), state.workspace?.readOnlyReason || 'This workspace is read-only right now.', 'error');
        return;
      }
      const quoteId = $('#quote-id').value;
      if (!quoteId) return setNotice($('#qfu-quote-form-notice'), 'Load a quote into the editor first.', 'error');
      const confirmed = window.confirm('Delete this quote permanently from your workspace?');
      if (!confirmed) return;
      await api.deleteQuote(quoteId);
      const remaining = Math.max(0, state.quotes.length - 1);
      const totalPages = Math.max(1, Math.ceil(remaining / QUOTES_PAGE_SIZE));
      if (quotesPage > totalPages) quotesPage = totalPages;
      await refreshApp();
      resetQuoteEditor(state.workspace, state.user.name);
      setNotice($('#qfu-quote-form-notice'), 'Quote deleted.', 'success');
    });
  }
}
