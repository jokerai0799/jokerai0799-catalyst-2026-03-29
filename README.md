# Catalyst

Catalyst is an active standalone Quote Follow Up-style prototype.

## Current state

This project now runs as a small static frontend + Node backend prototype with:
- public landing page
- sign up / sign in flow
- check-email / verify flow for local prototype use
- forgot/reset password prototype flow
- authenticated dashboard shell
- quote creation + persisted workspace data
- chase list / team / settings backed by the local server
- Supabase-backed persistence/session storage for the Catalyst project only

## Important rules

- Use `quote-followup-os` only as inspiration/reference.
- Do not modify the original live app files while building Catalyst unless explicitly requested.

## Architecture

### Backend
- `server.js` bootstraps the HTTP server only
- `catalyst-server/` contains config, API handlers, sessions, email delivery, store/domain helpers, and Supabase access
- Supabase persistence via `SUPABASE_URL_CATALYST` + `SUPABASE_SECRET_CATALYST`
- cookie-based session auth stored in Supabase `sessions`
- API routes for auth, workspace, quotes, and team data

### Frontend modules
- `shared-assets/js/main.js` bootstraps page loading
- `shared-assets/js/routes.js` resolves page initializers
- `shared-assets/js/core/` holds shared API, DOM, state, and utility modules
- `shared-assets/js/features/auth/` owns login/signup/check-email/reset flows
- `shared-assets/js/features/dashboard/` owns dashboard rendering
- `shared-assets/js/features/quotes/` owns quote table/editor/detail flows
- `shared-assets/js/features/chase-list/` owns follow-up queue rendering/actions
- top-level files in `shared-assets/js/` are compatibility re-export shims during the refactor

## Run locally

```bash
cd /root/.openclaw/workspace/projects/catalyst
npm start
```

Then open:
- `http://127.0.0.1:18081/`
- `http://127.0.0.1:18081/dashboard/dashboard.html`

## Supabase setup

Catalyst now supports its own dedicated Supabase project without touching any other app.

1. Create/apply the schema from:
   - `supabase/schema.sql`
2. Set env vars:
   - `SUPABASE_URL_CATALYST`
   - `SUPABASE_PUBLIC_CATALYST`
   - `SUPABASE_SECRET_CATALYST`
3. Import the current local prototype data if wanted:

```bash
npm run migrate:supabase
```

### Notes
- Supabase is now the required runtime storage layer.
- The current auth model is still app-managed (custom users + sessions), backed by Supabase tables rather than Supabase Auth.
- Security: enable RLS for all Catalyst tables. The current backend uses the service-role key server-side, so it continues to work with RLS enabled while public/anon access stays blocked.

## Near-term next steps

1. apply `supabase/schema.sql` to the Catalyst Supabase project
2. run the local-to-Supabase import once
3. set the three Catalyst Supabase env vars in Vercel
4. verify signup/login flows against Supabase-backed storage
5. later, decide whether to keep custom auth or move to Supabase Auth fully
