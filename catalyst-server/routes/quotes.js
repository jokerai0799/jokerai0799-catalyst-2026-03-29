async function handleQuoteRoutes(req, res, url, ctx) {
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/quotes') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true, writable: true });
    if (!auth) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const { title, customer, customerEmail, owner, ownerTeamMemberId, status, value, sentDate, nextFollowUp, notes } = ctx.buildQuoteInput(body, auth, auth.store);
    if (!title || !value) return ctx.badRequest(res, 'Add at least a title and value before saving.'), true;
    const quote = {
      id: ctx.uid('quote'),
      workspaceId: auth.workspace.id,
      title,
      customer,
      customerEmail,
      owner,
      ownerTeamMemberId,
      status,
      value,
      sentDate,
      nextFollowUp,
      notes,
      createdAt: new Date().toISOString(),
      archived: false,
      history: [],
    };
    ctx.recordQuoteEvent(quote, 'Quote created', `Added with status ${status} and value £${Number(value).toFixed(0)}.`);
    auth.store.quotes.unshift(quote);
    await ctx.saveChanges({ quotes: [quote] });
    ctx.sendJson(res, 201, { ok: true, quote });
    return true;
  }

  const quoteMatch = pathname.match(/^\/api\/quotes\/([^/]+)$/);
  if (quoteMatch && req.method === 'PATCH') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true, writable: true });
    if (!auth) return true;
    const quote = auth.store.quotes.find((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (!quote) return ctx.notFound(res), true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const { title, customer, customerEmail, owner, ownerTeamMemberId, status, value, sentDate, nextFollowUp, notes } = ctx.buildQuoteInput(body, auth, auth.store, quote);
    if (!title || !value) return ctx.badRequest(res, 'Add at least a title and value before saving.'), true;
    quote.title = title;
    quote.customer = customer;
    quote.customerEmail = customerEmail;
    quote.owner = owner;
    quote.ownerTeamMemberId = ownerTeamMemberId;
    quote.status = status;
    quote.value = value;
    quote.sentDate = sentDate;
    quote.nextFollowUp = nextFollowUp;
    quote.notes = notes;
    quote.archived = quote.status === 'Archived' ? true : Boolean(quote.archived);
    ctx.recordQuoteEvent(quote, 'Quote updated', `Status ${quote.status} · follow up ${quote.nextFollowUp}`);
    await ctx.saveChanges({ quotes: [quote] });
    ctx.sendJson(res, 200, { ok: true, quote });
    return true;
  }

  if (quoteMatch && req.method === 'DELETE') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true, writable: true });
    if (!auth) return true;
    const index = auth.store.quotes.findIndex((item) => item.id === quoteMatch[1] && item.workspaceId === auth.workspace.id);
    if (index === -1) return ctx.notFound(res), true;
    const [deletedQuote] = auth.store.quotes.splice(index, 1);
    ctx.queueStoreDelete(auth.store, 'quotes', deletedQuote?.id);
    await ctx.saveChanges({ deletes: auth.store.__deletes || {} });
    ctx.sendJson(res, 200, { ok: true });
    return true;
  }

  const quoteEmailMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/send-email$/);
  if (quoteEmailMatch && req.method === 'POST') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true, writable: true });
    if (!auth) return true;
    const quote = auth.store.quotes.find((item) => item.id === quoteEmailMatch[1] && item.workspaceId === auth.workspace.id);
    if (!quote) return ctx.notFound(res), true;
    ctx.ensureQuoteMeta(quote);
    if (!quote.customerEmail) return ctx.badRequest(res, 'Add a customer email to this quote first.'), true;
    const delivery = await ctx.attemptEmail(() => ctx.sendQuoteFollowupEmail(req, { quote, workspace: auth.workspace, sender: auth.user }));
    if (!delivery.sent) {
      const errorMessage = delivery.provider === 'none'
        ? 'Email sending is not configured yet for this workspace.'
        : (delivery.error || 'Follow-up email could not be sent.');
      ctx.sendJson(res, 503, { error: errorMessage, delivery });
      return true;
    }
    quote.archived = false;
    if (!['Won', 'Lost', 'Archived', 'Replied'].includes(quote.status)) quote.status = 'Sent';
    quote.nextFollowUp = ctx.addDays(ctx.today(), auth.workspace.secondFollowupDays || auth.workspace.firstFollowupDays || 2);
    ctx.recordQuoteEvent(quote, 'Follow-up email sent', `Sent to ${quote.customerEmail} and queued next follow up for ${quote.nextFollowUp}.`);
    await ctx.saveChanges({ quotes: [quote] });
    ctx.sendJson(res, 200, { ok: true, quote, delivery });
    return true;
  }

  const quoteActionMatch = pathname.match(/^\/api\/quotes\/([^/]+)\/actions$/);
  if (quoteActionMatch && req.method === 'POST') {
    const auth = await ctx.loadAuth(req, res, { sameOrigin: true, writable: true });
    if (!auth) return true;
    const body = await ctx.readJsonOrReject(req, res, ctx.badRequest);
    if (!body) return true;
    const action = String(body.action || '').trim();
    if (!ctx.ALLOWED_QUOTE_ACTIONS.has(action)) return ctx.badRequest(res, 'Unknown action.'), true;
    const quote = auth.store.quotes.find((item) => item.id === quoteActionMatch[1] && item.workspaceId === auth.workspace.id);
    if (!quote) return ctx.notFound(res), true;
    ctx.ensureQuoteMeta(quote);

    if (action === 'archive') {
      quote.archived = true;
      quote.status = 'Archived';
      ctx.recordQuoteEvent(quote, 'Quote archived', 'Removed from active pipeline but kept for reference.');
    } else if (action === 'mark-contacted') {
      quote.archived = false;
      quote.status = 'Replied';
      quote.nextFollowUp = ctx.addDays(ctx.today(), auth.workspace.firstFollowupDays || 2);
      ctx.recordQuoteEvent(quote, 'Quote marked replied', 'Status updated from the editor.');
    } else if (action === 'mark-won') {
      quote.archived = false;
      quote.status = 'Won';
      ctx.recordQuoteEvent(quote, 'Quote marked won', 'Status updated from the editor.');
    } else if (action === 'mark-lost') {
      quote.archived = false;
      quote.status = 'Lost';
      ctx.recordQuoteEvent(quote, 'Quote marked lost', 'Status updated from the editor.');
    } else if (action === 'contacted') {
      quote.archived = false;
      quote.status = 'Replied';
      quote.nextFollowUp = ctx.addDays(ctx.today(), auth.workspace.secondFollowupDays || auth.workspace.firstFollowupDays || 2);
      ctx.recordQuoteEvent(quote, 'Customer contacted', `Moved to replied and scheduled next follow up for ${quote.nextFollowUp}.`);
    } else if (action === 'reschedule') {
      quote.archived = false;
      if (quote.status === 'Won' || quote.status === 'Lost') quote.status = ctx.normalizeQuoteStatus('Follow up due');
      quote.nextFollowUp = ctx.addDays(ctx.today(), 1);
      ctx.recordQuoteEvent(quote, 'Follow up rescheduled', `Moved to ${quote.nextFollowUp} from the chase list.`);
    } else if (action === 'done-today') {
      quote.archived = false;
      quote.nextFollowUp = ctx.addDays(ctx.today(), 1);
      ctx.recordQuoteEvent(quote, 'Cleared from today', 'Removed from the current chase queue and pushed to tomorrow.');
    } else {
      return ctx.badRequest(res, 'Unknown action.'), true;
    }

    await ctx.saveChanges({ quotes: [quote] });
    ctx.sendJson(res, 200, { ok: true, quote });
    return true;
  }

  return false;
}

module.exports = {
  handleQuoteRoutes,
};
