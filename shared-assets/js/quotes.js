import { api } from './api.js';
import { $, clear, create, setNotice, text } from './dom.js';
import { addDays, daysBetween, formatCurrency, formatEventTime, quoteStatusBadge, relativeFollowUpLabel, today } from './utils.js';

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

export function resetQuoteEditor(workspace, ownerName) {
  const form = $('#qfu-quote-form');
  if (!form) return;
  form.reset();
  $('#quote-id').value = '';
  $('#quote-date').value = today();
  $('#quote-followup').value = addDays(today(), workspace.firstFollowupDays || 2);
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
  if (!document.body.classList.contains('qfu-quote-page')) {
    const trigger = document.querySelector('.qfu-app-nav-vertical [data-tab="quotes"]');
    if (trigger) trigger.click();
  }
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
  return create('a', {
    text: 'Open quote',
    attrs: { href: `./quote.html?id=${encodeURIComponent(quoteId)}` },
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
    links.appendChild(createActionButton('Done today', 'done-today', quote.id));
    actions.appendChild(links);
    row.appendChild(create('td', { children: [actions] }));
    tbody.appendChild(row);
  });
}

export function renderAllQuotesTable(quotes) {
  const tbody = $('#qfu-all-quotes-body');
  if (!tbody) return;
  clear(tbody);
  if (!quotes.length) {
    const row = create('tr');
    row.appendChild(create('td', { attrs: { colspan: '5' }, children: [create('strong', { text: 'No quotes yet.' }), create('span', { text: 'Add your first quote to populate the workspace.' })] }));
    tbody.appendChild(row);
    return;
  }
  quotes.forEach((quote) => {
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
  document.querySelectorAll('[data-quote-id]').forEach((row) => {
    if (row.dataset.bound) return;
    row.dataset.bound = 'true';
    row.addEventListener('click', (event) => {
      if (event.target.closest('a,button')) return;
      window.location.href = `./quote.html?id=${encodeURIComponent(row.dataset.quoteId)}`;
    });
  });

  document.querySelectorAll('[data-quote-open]').forEach((link) => {
    if (link.dataset.bound) return;
    link.dataset.bound = 'true';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      window.location.href = `./quote.html?id=${encodeURIComponent(link.dataset.quoteOpen)}`;
    });
  });

  const form = $('#qfu-quote-form');
  if (form && !form.dataset.bound) {
    form.dataset.bound = 'true';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
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
      }
      await refreshApp();
      resetQuoteEditor(state.workspace, state.user.name);
    });
  }

  const scheduleButton = $('#qfu-quote-followup-button');
  if (scheduleButton && !scheduleButton.dataset.bound) {
    scheduleButton.dataset.bound = 'true';
    scheduleButton.addEventListener('click', () => {
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
      const quoteId = $('#quote-id').value;
      if (!quoteId) return setNotice($('#qfu-quote-form-notice'), 'Load a quote into the editor first.', 'error');
      const confirmed = window.confirm('Delete this quote permanently from the prototype workspace?');
      if (!confirmed) return;
      await api.deleteQuote(quoteId);
      await refreshApp();
      resetQuoteEditor(state.workspace, state.user.name);
      setNotice($('#qfu-quote-form-notice'), 'Quote deleted.', 'success');
    });
  }
}
