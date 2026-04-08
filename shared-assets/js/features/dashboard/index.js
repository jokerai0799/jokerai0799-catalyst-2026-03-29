import { api } from '../../core/api.js';
import { $, $all, clear, create, show, text } from '../../core/dom.js';
import { dismissWorkspaceAlert, getAttentionSignature, isWorkspaceAlertDismissed } from '../../core/store.js';
import { daysBetween, formatCurrency, formatEventTime, relativeFollowUpLabel, statusSortValue } from '../../core/utils.js';
import { bindChaseActions } from '../chase-list/index.js';
import { bindQuoteInteractions, loadQuoteIntoEditor, renderAllQuotesTable, renderDashboardAttentionTable, renderQuoteDetail, resetQuoteEditor } from '../quotes/index.js';

function renderAnalytics(quotes) {
  const statusBars = $('#qfu-analytics-status-bars');
  const teamBars = $('#qfu-analytics-team-bars');
  if (!statusBars || !teamBars) return;
  clear(statusBars);
  clear(teamBars);

  const byStatus = {};
  quotes.forEach((quote) => {
    const key = quote.archived ? 'Archived' : quote.status;
    byStatus[key] = (byStatus[key] || 0) + Number(quote.value || 0);
  });
  const maxStatus = Math.max(1, ...Object.values(byStatus));
  Object.entries(byStatus).forEach(([label, value]) => {
    const fill = create('div', { className: 'qfu-chart-fill' });
    fill.style.width = `${Math.max(10, (value / maxStatus) * 100)}%`;
    statusBars.appendChild(create('div', {
      className: 'qfu-chart-row',
      children: [
        create('div', { className: 'qfu-chart-meta', children: [create('strong', { text: label }), create('span', { text: formatCurrency(value) })] }),
        create('div', { className: 'qfu-chart-track', children: [fill] }),
      ],
    }));
  });

  const byOwner = {};
  quotes.filter((quote) => !quote.archived).forEach((quote) => {
    byOwner[quote.owner] = (byOwner[quote.owner] || 0) + Number(quote.value || 0);
  });
  const maxOwner = Math.max(1, ...Object.values(byOwner));
  Object.entries(byOwner).forEach(([label, value]) => {
    const fill = create('div', { className: 'qfu-chart-fill qfu-chart-fill-alt' });
    fill.style.width = `${Math.max(10, (value / maxOwner) * 100)}%`;
    teamBars.appendChild(create('div', {
      className: 'qfu-chart-row',
      children: [
        create('div', { className: 'qfu-chart-meta', children: [create('strong', { text: label }), create('span', { text: formatCurrency(value) })] }),
        create('div', { className: 'qfu-chart-track', children: [fill] }),
      ],
    }));
  });

  const openQuotes = quotes.filter((quote) => !quote.archived && !['Won', 'Lost'].includes(quote.status));
  const avg = quotes.length ? quotes.reduce((sum, quote) => sum + Number(quote.value || 0), 0) / quotes.length : 0;
  const pressureCount = openQuotes.filter((quote) => daysBetween(quote.nextFollowUp) <= 0).length;
  const pressure = openQuotes.length ? Math.round((pressureCount / openQuotes.length) * 100) : 0;
  const bestOwnerEntry = Object.entries(byOwner).sort((a, b) => b[1] - a[1])[0] || ['—', 0];
  text($('#qfu-analytics-average-value'), formatCurrency(avg));
  text($('#qfu-analytics-average-note'), `${quotes.length} total quotes tracked`);
  text($('#qfu-analytics-followup-pressure'), `${pressure}%`);
  text($('#qfu-analytics-followup-note'), `${pressureCount} of ${openQuotes.length} open quotes need action`);
  text($('#qfu-analytics-best-owner'), bestOwnerEntry[0]);
  text($('#qfu-analytics-best-owner-note'), `${formatCurrency(bestOwnerEntry[1])} currently owned`);
}

function renderTeam(state, refreshApp) {
  const currentMember = state.teamMembers.find((member) => member.email?.toLowerCase() === state.user.email?.toLowerCase());
  const isOwner = currentMember?.role === 'Owner';
  const ownerCount = state.teamMembers.filter((member) => member.role === 'Owner').length;
  const teamGrid = document.querySelector('.qfu-member-grid');
  if (teamGrid) {
    clear(teamGrid);
    state.teamMembers.forEach((member) => {
      const details = create('div', { children: [create('strong', { text: member.name }), create('span', { text: member.role })] });
      const children = [
        create('div', { className: 'qfu-member-avatar', text: member.name.charAt(0).toUpperCase() }),
        details,
        create('label', { text: `${member.activeQuotes} active quotes` }),
      ];

      const canRemove = isOwner && !(member.email?.toLowerCase() === state.user.email?.toLowerCase() && ownerCount <= 1);
      if (canRemove) {
        children.push(create('button', {
          className: 'qfu-link-button qfu-link-button-danger',
          text: 'Remove',
          attrs: { type: 'button' },
          dataset: { removeTeamId: member.id, removeTeamName: member.name },
        }));
      }

      teamGrid.appendChild(create('div', {
        className: 'qfu-member-card',
        children,
      }));
    });
  }

  const ownershipBody = $('#qfu-team-ownership-body');
  if (!ownershipBody) return;
  clear(ownershipBody);
  state.teamMembers.forEach((member) => {
    const memberQuotes = state.quotes.filter((quote) => quote.owner === member.name);
    const due = memberQuotes.filter((quote) => daysBetween(quote.nextFollowUp) <= 0 && !['Won', 'Lost'].includes(quote.status)).length;
    const wonTotal = memberQuotes.filter((quote) => quote.status === 'Won').reduce((sum, quote) => sum + Number(quote.value || 0), 0);
    const row = create('tr');
    row.appendChild(create('td', { children: [create('strong', { text: member.name }), create('span', { text: member.role })] }));
    row.appendChild(create('td', { text: String(member.activeQuotes) }));
    row.appendChild(create('td', { text: String(due) }));
    row.appendChild(create('td', { text: formatCurrency(wonTotal) }));
    row.appendChild(create('td', { text: memberQuotes.length ? `${Math.max(1, Math.round(memberQuotes.length * 0.7))} days` : '—' }));
    ownershipBody.appendChild(row);
  });

  document.querySelectorAll('[data-remove-team-id]').forEach((button) => {
    if (button.dataset.bound) return;
    button.dataset.bound = 'true';
    button.addEventListener('click', async () => {
      const name = button.dataset.removeTeamName || 'this team member';
      const confirmed = window.confirm(`Remove ${name} from the workspace? Their assigned quotes will be reassigned.`);
      if (!confirmed) return;
      try {
        await api.deleteTeamMember(button.dataset.removeTeamId);
        setNotice($('#qfu-team-notice'), `${name} removed from the workspace.`, 'success');
        await refreshApp();
      } catch (error) {
        setNotice($('#qfu-team-notice'), error.message, 'error');
      }
    });
  });
}

function renderRecentActivity(quotes) {
  const activityList = document.querySelector('.qfu-activity-list');
  if (!activityList) return;
  clear(activityList);

  const events = quotes
    .flatMap((quote) => {
      const history = quote.history?.length
        ? quote.history.map((event) => ({
            title: quote.title,
            summary: event.summary,
            detail: event.detail,
            createdAt: event.createdAt,
          }))
        : [{
            title: quote.title,
            summary: quote.archived ? 'Quote archived' : `${quote.status} quote`,
            detail: `Next follow up ${relativeFollowUpLabel(quote.nextFollowUp)}`,
            createdAt: quote.updatedAt || quote.createdAt,
          }];
      return history;
    })
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 5);

  events.forEach((event) => {
    activityList.appendChild(create('li', {
      children: [
        create('strong', { text: `${event.title} · ${event.summary}` }),
        create('span', { text: `${event.detail} · ${formatEventTime(event.createdAt)}` }),
      ],
    }));
  });
}

function renderStaleQuotes(openQuotes) {
  const staleList = $('#qfu-dashboard-stale-list');
  if (!staleList) return;
  clear(staleList);

  const staleQuotes = openQuotes
    .slice()
    .sort((a, b) => (a.sentDate || a.createdAt || '').localeCompare(b.sentDate || b.createdAt || ''))
    .slice(0, 4);

  if (!staleQuotes.length) {
    staleList.appendChild(create('li', {
      children: [create('strong', { text: 'No stale quotes yet' }), create('span', { text: 'Your oldest open quotes will appear here.' })],
    }));
    return;
  }

  staleQuotes.forEach((quote) => {
    const ageDays = Math.max(0, -daysBetween(quote.sentDate || quote.createdAt?.slice(0, 10)));
    staleList.appendChild(create('li', {
      children: [
        create('strong', { text: quote.title }),
        create('span', { text: `${ageDays} day${ageDays === 1 ? '' : 's'} open · ${formatCurrency(quote.value)} · Next follow up ${relativeFollowUpLabel(quote.nextFollowUp)}` }),
      ],
    }));
  });
}

function setTopbar(workspace) {
  text(document.querySelector('.qfu-workspace-panel strong'), workspace.name);
  text(document.querySelector('.qfu-dashboard-kicker'), 'Today');
  text(document.querySelector('.qfu-app-topbar h1'), `What needs action in ${workspace.name}`);
  text(document.querySelector('.qfu-app-topbar p'), 'Start with overdue follow ups, then update quotes and keep the pipeline moving.');
}

function setMetricCards(openQuotes, wonQuotes, lostQuotes, _allQuotes, attentionQuotes, _overdueCount, _dueTodayCount, teamCount) {
  const metricCards = $all('.qfu-dashboard-metrics .qfu-metric-card');
  const openValue = openQuotes.reduce((sum, quote) => sum + Number(quote.value || 0), 0);
  const wonValue = wonQuotes.reduce((sum, quote) => sum + Number(quote.value || 0), 0);
  const sentQuotes = openQuotes.filter((quote) => quote.status === 'Sent').length;

  if (metricCards[0]) text(metricCards[0].querySelector('h3'), formatCurrency(openValue));
  if (metricCards[1]) text(metricCards[1].querySelector('h3'), String(attentionQuotes.length));
  if (metricCards[2]) text(metricCards[2].querySelector('h3'), formatCurrency(wonValue));

  text($('#qfu-dashboard-team-count'), `${teamCount || 0} active`);
  text($('#qfu-dashboard-sent-total'), String(sentQuotes));
  text($('#qfu-dashboard-due-total'), String(attentionQuotes.length));
  text($('#qfu-dashboard-won-total'), String(wonQuotes.length));
  text($('#qfu-dashboard-lost-total'), String(lostQuotes.length));
  text($('#qfu-dashboard-booked-total'), formatCurrency(wonValue));
}

function setAlert(workspaceId, attentionQuotes, overdueCount, dueTodayCount) {
  const alertStrong = document.querySelector('.qfu-alert-copy strong');
  const alertSpan = document.querySelector('.qfu-alert-copy span');
  text(alertStrong, `${attentionQuotes.length} quotes need attention today.`);
  text(alertSpan, `${overdueCount} are overdue and ${dueTodayCount} are due today.`);
  const signature = getAttentionSignature(attentionQuotes);
  const shouldHide = attentionQuotes.length === 0 || isWorkspaceAlertDismissed(workspaceId, signature);
  show(document.querySelector('.qfu-alert-strip'), !shouldHide);
  return signature;
}

function setOwnerOptions(state) {
  const ownerSelect = $('#quote-owner');
  if (!ownerSelect) return;
  const current = ownerSelect.value || state.user.name;
  clear(ownerSelect);
  state.teamMembers.forEach((member) => ownerSelect.appendChild(create('option', { text: member.name, attrs: { value: member.name } })));
  ownerSelect.value = state.teamMembers.some((member) => member.name === current) ? current : (state.user.name || state.teamMembers[0]?.name || 'Owner');
}

function bindSharedLinks(state, refreshApp, attentionSignature) {
  const brandLink = document.querySelector('.qfu-app-brand');
  if (brandLink && !brandLink.dataset.bound) {
    brandLink.dataset.bound = 'true';
    brandLink.addEventListener('click', (event) => {
      event.preventDefault();
      const activeTab = document.querySelector('.qfu-tab-panel.is-active')?.dataset.panel;
      const trigger = activeTab ? document.querySelector(`.qfu-app-nav-vertical [data-tab="${activeTab}"]`) : null;
      if (trigger) trigger.click();
    });
  }

  const logout = $('#qfu-logout-link');
  if (logout && !logout.dataset.bound) {
    logout.dataset.bound = 'true';
    logout.addEventListener('click', async (event) => {
      event.preventDefault();
      await api.logout();
      window.location.href = '../landing-page/login.html';
    });
  }

  document.querySelectorAll('.qfu-alert-link').forEach((node) => {
    if (node.dataset.dismissBound) return;
    node.dataset.dismissBound = 'true';
    node.addEventListener('click', () => {
      dismissWorkspaceAlert(state.workspace.id, attentionSignature);
      show(document.querySelector('.qfu-alert-strip'), false);
    });
  });

  const teamForm = $('#qfu-team-form');
  if (teamForm && !teamForm.dataset.bound) {
    teamForm.dataset.bound = 'true';
    teamForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await api.addTeamMember({
        name: $('#team-name').value.trim(),
        email: $('#team-email').value.trim().toLowerCase(),
        role: $('#team-role').value,
      });
      teamForm.reset();
      await refreshApp();
    });
  }

  const settingsForm = $('#qfu-settings-form');
  if (settingsForm && !settingsForm.dataset.bound) {
    settingsForm.dataset.bound = 'true';
    settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await api.updateWorkspace({
        name: $('#business-name').value.trim(),
        replyEmail: $('#business-email').value.trim(),
        firstFollowupDays: Number((($('#first-followup').value || '').match(/\d+/) || ['2'])[0]),
        secondFollowupDays: Number((($('#second-followup').value || '').match(/\d+/) || ['5'])[0]),
        notes: $('#settings-notes').value.trim(),
      });
      await refreshApp();
    });
  }
}

export function renderDashboard(state, refreshApp) {
  setTopbar(state.workspace);
  if ($('#business-name')) $('#business-name').value = state.workspace.name;
  if ($('#business-email')) $('#business-email').value = state.workspace.replyEmail || state.user.email;
  if ($('#first-followup')) $('#first-followup').value = `${state.workspace.firstFollowupDays || 2} days after sent`;
  if ($('#second-followup')) $('#second-followup').value = `${state.workspace.secondFollowupDays || 5} days later`;
  if ($('#settings-notes')) $('#settings-notes').value = state.workspace.notes || '';
  setOwnerOptions(state);

  const openQuotes = state.quotes.filter((quote) => !quote.archived && !['Won', 'Lost'].includes(quote.status));
  const wonQuotes = state.quotes.filter((quote) => !quote.archived && quote.status === 'Won');
  const lostQuotes = state.quotes.filter((quote) => !quote.archived && quote.status === 'Lost');
  const attentionQuotes = openQuotes.filter((quote) => daysBetween(quote.nextFollowUp) <= 0).sort((a, b) => statusSortValue(a) - statusSortValue(b));
  const overdueCount = openQuotes.filter((quote) => daysBetween(quote.nextFollowUp) < 0).length;
  const dueTodayCount = openQuotes.filter((quote) => daysBetween(quote.nextFollowUp) === 0).length;

  setMetricCards(openQuotes, wonQuotes, lostQuotes, state.quotes, attentionQuotes, overdueCount, dueTodayCount, state.teamMembers.length);
  const alertSignature = setAlert(state.workspace.id, attentionQuotes, overdueCount, dueTodayCount);
  renderDashboardAttentionTable(attentionQuotes);
  renderAllQuotesTable(state.quotes);
  renderTeam(state, refreshApp);
  renderRecentActivity(state.quotes);
  renderStaleQuotes(openQuotes);

  const selectedQuoteId = $('#quote-id')?.value || state.quotes[0]?.id;
  renderQuoteDetail(state.quotes.find((quote) => quote.id === selectedQuoteId) || null);
  bindQuoteInteractions(state, refreshApp);
  bindChaseActions(refreshApp);
  bindSharedLinks(state, refreshApp, alertSignature);

  if (!$('#quote-id')?.value) resetQuoteEditor(state.workspace, state.user.name);
  else {
    const selected = state.quotes.find((quote) => quote.id === $('#quote-id').value);
    if (selected) loadQuoteIntoEditor(selected);
  }
}
