import { api } from '../../core/api.js';
import { $, clear, create, setNotice, text } from '../../core/dom.js';
import { formatCurrency, quoteStatusBadge } from '../../core/utils.js';

function createActionButton(label, action, quoteId) {
  return create('button', {
    className: 'qfu-link-button',
    text: label,
    attrs: { type: 'button' },
    dataset: { chaseAction: action, quoteActionId: quoteId },
  });
}

export function renderChaseList(attentionQuotes, overdueCount, dueTodayCount) {
  text($('#qfu-chase-overdue-count'), String(overdueCount));
  text($('#qfu-chase-overdue-note'), overdueCount ? `${overdueCount} quotes still need contact` : 'No overdue quotes');
  text($('#qfu-chase-due-today-count'), String(dueTodayCount));
  text($('#qfu-chase-due-today-note'), dueTodayCount ? `${dueTodayCount} quotes planned for today` : 'Nothing due today');
  text($('#qfu-chase-queue-value'), formatCurrency(attentionQuotes.reduce((sum, quote) => sum + Number(quote.value || 0), 0)));
  text($('#qfu-chase-queue-note'), `${attentionQuotes.length} quote${attentionQuotes.length === 1 ? '' : 's'} currently in the queue`);

  const tbody = $('#qfu-chase-list-body');
  if (!tbody) return;
  clear(tbody);
  if (!attentionQuotes.length) {
    const row = create('tr');
    row.appendChild(create('td', { attrs: { colspan: '4' }, children: [create('strong', { text: 'Nothing due.' }), create('span', { text: 'Your follow-up queue is clear.' })] }));
    tbody.appendChild(row);
    return;
  }

  attentionQuotes.forEach((quote) => {
    const [label, badgeClass] = quoteStatusBadge(quote.status, quote.nextFollowUp);
    const row = create('tr', { dataset: { quoteId: quote.id }, className: 'qfu-quote-row' });
    row.appendChild(create('td', { children: [create('strong', { text: quote.customer || quote.title }), create('span', { text: quote.title })] }));
    row.appendChild(create('td', { text: formatCurrency(quote.value) }));
    row.appendChild(create('td', { children: [create('span', { className: `qfu-badge ${badgeClass}`, text: label })] }));
    const actions = create('div', { className: 'qfu-inline-link-actions qfu-inline-link-actions-stack' });
    actions.appendChild(createActionButton('Mark contacted', 'contacted', quote.id));
    actions.appendChild(createActionButton('Reschedule', 'reschedule', quote.id));
    actions.appendChild(createActionButton('Done for today', 'done-today', quote.id));
    actions.appendChild(create('button', {
      className: 'qfu-link-button',
      text: 'Open quote record',
      attrs: { type: 'button' },
      dataset: { loadQuoteId: quote.id },
    }));
    row.appendChild(create('td', { children: [actions] }));
    tbody.appendChild(row);
  });
}

export function bindChaseActions(refreshApp) {
  document.querySelectorAll('[data-chase-action][data-quote-action-id]').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      const action = button.dataset.chaseAction;
      const quoteId = button.dataset.quoteActionId;
      await api.quoteAction(quoteId, action);
      const labels = {
        contacted: 'marked contacted.',
        reschedule: 'rescheduled for tomorrow.',
        'done-today': 'cleared from today.',
      };
      setNotice($('#qfu-chase-action-notice'), `Quote ${labels[action] || 'updated.'}`, 'success');
      await refreshApp();
    });
  });
}
