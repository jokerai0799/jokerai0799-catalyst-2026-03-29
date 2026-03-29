# Catalyst

Catalyst is an active standalone Quote Follow Up-style prototype.

## Current state

This project now runs as a small local client + backend prototype with:
- public landing page
- sign up / sign in flow
- check-email / verify flow for local prototype use
- forgot/reset password prototype flow
- authenticated dashboard shell
- quote creation + persisted workspace data
- chase list / team / settings backed by the local server

## Important rules

- Use `quote-followup-os` only as inspiration/reference.
- Do not modify the original live app files while building Catalyst unless explicitly requested.

## Architecture

### Backend
- `server.js`
- local JSON persistence in `data/store.json`
- cookie-based session auth
- API routes for auth, workspace, quotes, and team data

### Frontend modules
- `shared-assets/js/main.js`
- `shared-assets/js/auth.js`
- `shared-assets/js/store.js`
- `shared-assets/js/dashboard.js`
- `shared-assets/js/quotes.js`
- `shared-assets/js/chase-list.js`
- `shared-assets/js/api.js`
- `shared-assets/js/dom.js`
- `shared-assets/js/utils.js`

## Run locally

```bash
cd /root/.openclaw/workspace/projects/catalyst
npm start
```

Then open:
- `http://127.0.0.1:18081/`
- `http://127.0.0.1:18081/dashboard/dashboard.html`

Demo login:
- `demo@catalyst.local`
- `Catalyst123!`

## Near-term next steps

1. move from JSON-file persistence to a real database
2. add server-side validation and stronger auth/session hardening
3. turn the remaining prototype actions into fuller CRUD workflows
4. clean remaining template residue from marketing/auth pages
