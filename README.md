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
- optional Supabase-backed persistence/session storage for the Catalyst project only

## Important rules

- Use `quote-followup-os` only as inspiration/reference.
- Do not modify the original live app files while building Catalyst unless explicitly requested.

## Architecture

### Backend
- `server.js`
- fallback local JSON persistence in `data/store.json`
- optional Supabase persistence via `SUPABASE_URL_CATALYST` + `SUPABASE_SECRET_CATALYST`
- cookie-based session auth stored either locally or in Supabase `sessions`
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
- If the Supabase schema is not present yet, Catalyst falls back to local `data/store.json` automatically.
- On Vercel, this removes the current `/tmp/catalyst-data` persistence dependency once the schema exists and env vars are set.
- The current auth model is still app-managed (custom users + sessions), now with optional database-backed storage. Moving to full Supabase Auth can happen later if desired.
- Security: enable RLS for all Catalyst tables. The current backend uses the service-role key server-side, so it continues to work with RLS enabled while public/anon access stays blocked.

## Near-term next steps

1. apply `supabase/schema.sql` to the Catalyst Supabase project
2. run the local-to-Supabase import once
3. set the three Catalyst Supabase env vars in Vercel
4. verify signup/login/demo flows against Supabase-backed storage
5. later, decide whether to keep custom auth or move to Supabase Auth fully
