import { api } from './api.js';
import { $, $all, clear, create, show, text } from './dom.js';
import { dismissWorkspaceAlert, getAttentionSignature, isWorkspaceAlertDismissed } from './store.js';
import { bindChaseActions, renderChaseList } from './chase-list.js';
import { bindQuoteInteractions, loadQuoteIntoEditor, renderAllQuotesTable, renderDashboardAttentionTable, renderQuoteDetail, resetQuoteEditor } from './quotes.js';
import { daysBetween, formatCurrency, formatEventTime, quoteStatusBadge, relativeFollowUpLabel, statusSortValue } from './utils.js';

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

function renderTeam(state) {
  const teamGrid = document.querySelector('.qfu-member-grid');
  if (teamGrid) {
    clear(teamGrid);
    state.teamMembers.forEach((member) => {
      teamGrid.appendChild(create('div', {
        className: 'qfu-member-card',
        children: [
          create('div', { className: 'qfu-member-avatar', text: member.name.charAt(0).toUpperCase() }),
          create('div', { children: [create('strong', { text: member.name }), create('span', { text: member.role })] }),
          create('label', { text: `${member.activeQuotes} active quotes` }),
        ],
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
  text(document.querySelector('.qfu-dashboard-kicker'), 'Workspace dashboard');
  text(document.querySelector('.qfu-app-topbar h1'), `Good morning, ${workspace.name}`);
  text(document.querySelector('.qfu-app-topbar p'), 'Start with what needs action today, then review pipeline health and recent movement.');
}

function setMetricCards(openQuotes, wonQuotes, lostQuotes, allQuotes, attentionQuotes, overdueCount, dueTodayCount, teamCount) {
  const metricCards = $all('.qfu-dashboard-metrics .qfu-metric-card');
  const quoteHealthCards = $all('.qfu-stat-stack .qfu-stat-card');
  const openValue = openQuotes.reduce((sum, quote) => sum + Number(quote.value || 0), 0);
  const wonValue = wonQuotes.reduce((sum, quote) => sum + Number(quote.value || 0), 0);
  const trackedCount = allQuotes.length;
  const winRate = trackedCount ? Math.round((wonQuotes.length / trackedCount) * 100) : 0;
  const sentQuoteItems = openQuotes.filter((quote) => quote.status === 'Sent');
  const draftQuoteItems = allQuotes.filter((quote) => quote.status === 'Draft' && !quote.archived);
  const followUpDueItems = allQuotes.filter((quote) => !quote.archived && !['Won', 'Lost'].includes(quote.status) && daysBetween(quote.nextFollowUp) <= 0);
  const sentQuotes = sentQuoteItems.length;
  const draftQuotes = draftQuoteItems.length;
  const followUpDueQuotes = followUpDueItems.length;
  const draftValue = draftQuoteItems.reduce((sum, quote) => sum + Number(quote.value || 0), 0);
  const sentValue = sentQuoteItems.reduce((sum, quote) => sum + Number(quote.value || 0), 0);
  const dueValue = followUpDueItems.reduce((sum, quote) => sum + Number(quote.value || 0), 0);

  if (metricCards[0]) text(metricCards[0].querySelector('h3'), formatCurrency(openValue));
  if (metricCards[1]) text(metricCards[1].querySelector('h3'), formatCurrency(wonValue));
  if (metricCards[2]) text(metricCards[2].querySelector('h3'), String(trackedCount));
  if (metricCards[3]) text(metricCards[3].querySelector('h3'), `${winRate}%`);
  if (metricCards[4]) text(metricCards[4].querySelector('h3'), String(attentionQuotes.length));

  text($('#qfu-pipeline-draft-count'), String(draftQuotes));
  text($('#qfu-pipeline-sent-count'), String(sentQuotes));
  text($('#qfu-pipeline-due-count'), String(followUpDueQuotes));
  text($('#qfu-pipeline-won-count'), String(wonQuotes.length));
  text($('#qfu-pipeline-draft-value'), `${formatCurrency(draftValue)} waiting to send`);
  text($('#qfu-pipeline-sent-value'), `${formatCurrency(sentValue)} waiting first reply`);
  text($('#qfu-pipeline-due-value'), `${formatCurrency(dueValue)} needs action now`);
  text($('#qfu-pipeline-won-value'), `${formatCurrency(wonValue)} booked work`);

  text($('#qfu-dashboard-team-count'), `${teamCount || 0} active`);
  text($('#qfu-dashboard-sent-total'), String(sentQuotes));
  text($('#qfu-dashboard-due-total'), String(attentionQuotes.length));
  text($('#qfu-dashboard-won-total'), String(wonQuotes.length));
  text($('#qfu-dashboard-lost-total'), String(lostQuotes.length));
  text($('#qfu-dashboard-booked-total'), formatCurrency(wonValue));

  if (quoteHealthCards[0]) {
    text(quoteHealthCards[0].querySelector('strong'), `${sentQuotes} quotes`);
    text(quoteHealthCards[0].querySelector('span'), `Average age: ${openQuotes.length ? Math.max(1, Math.round(openQuotes.length * 0.7)) : 0} days`);
  }
  if (quoteHealthCards[1]) {
    text(quoteHealthCards[1].querySelector('strong'), `${overdueCount} quotes`);
    text(quoteHealthCards[1].querySelector('span'), `Worth ${formatCurrency(attentionQuotes.reduce((sum, quote) => sum + Number(quote.value || 0), 0))} combined`);
  }
  if (quoteHealthCards[2]) {
    text(quoteHealthCards[2].querySelector('strong'), formatCurrency(wonValue));
    text(quoteHealthCards[2].querySelector('span'), `${wonQuotes.length} jobs booked`);
  }
  const sideFocus = document.querySelector('.qfu-dashboard-hero-sidecard');
  if (sideFocus) {
    text(sideFocus.querySelector('strong'), `${attentionQuotes.length} quotes need attention`);
    text(sideFocus.querySelector('p'), `Work the queue first, then review anything starting to drift.`);
  }
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

  document.querySelectorAll('[data-tab="chase-list"], .qfu-alert-link').forEach((node) => {
    if (node.dataset.dismissBound) return;
    node.dataset.dismissBound = 'true';
    node.addEventListener('click', () => {
      dismissWorkspaceAlert(state.workspace.id, attentionSignature);
      show(document.querySelector('.qfu-alert-strip'), false);
    });
  });

  const activeHash = window.location.hash.replace('#', '');
  if (activeHash === 'chase-list') {
    dismissWorkspaceAlert(state.workspace.id, attentionSignature);
    show(document.querySelector('.qfu-alert-strip'), false);
  }

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
  renderChaseList(attentionQuotes, overdueCount, dueTodayCount);
  renderTeam(state);
  renderRecentActivity(state.quotes);
  renderStaleQuotes(openQuotes);
  renderAnalytics(state.quotes);

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
