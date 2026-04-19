# catalyst-server/app.js refactor map

Purpose: split `catalyst-server/app.js` into focused backend modules without changing behaviour, route paths, response shapes, or auth/billing semantics.

## Action one outcome

This file defines the module boundaries, ownership rules, migration order, and regression checks for the refactor.

It does **not** wire the refactor yet.

## Non-negotiables

- Preserve every existing route path and method.
- Preserve current response payload shapes and current error strings unless a bug fix is explicitly intended.
- Keep `server.js` unchanged except for the existing `requestHandler` import.
- Keep `requestHandler(req, res)` as the single entry point exported by `catalyst-server/app.js`.
- Do not change storage shape, Supabase contracts, session cookie names, Stripe webhook semantics, or auth token semantics during extraction.
- Keep read-only enforcement, same-origin checks, owner checks, and workspace scoping exactly intact.

## Current responsibility map inside app.js

### App shell / routing
- `requestHandler` at line 1224
- `handleApi` at line 453

### Shared request helpers
- `getAppBaseUrl` line 74
- `ensureSameOrigin` line 261
- `ensureWorkspaceWritable` line 270
- `getWorkspaceMemberCount` line 276
- `loadAuthenticatedStore` line 443
- `shouldRefreshLastSeen` line 180
- `refreshLastSeen` line 188

### Auth + session + Google OAuth
- `getGoogleRedirectUri` line 81
- cookie helpers at lines 85 to 99
- `exchangeGoogleCode` line 103
- `fetchGoogleProfile` line 128
- `ensureWorkspaceName` line 142
- verification/reset token helpers at lines 159 to 177
- auth rate limit helper at line 248
- routes:
  - `GET /api/auth/google/start`
  - `GET /api/auth/google/callback`
  - `GET /api/auth/me`
  - `POST /api/auth/signup`
  - `GET /api/auth/check-email`
  - `POST /api/auth/resend-verification`
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `POST /api/auth/verify`
  - `POST /api/auth/forgot-password`
  - `POST /api/auth/reset-password`
  - `POST /api/activity/ping`
  - `GET /api/app/bootstrap`
  - `POST /api/workspace/select`

### System / public status
- `startOfUtcDayIso` line 195
- `buildProjectMetrics` line 201
- `getProjectMetrics` line 238
- routes:
  - `GET /api/health`
  - `GET /api/project-metrics`
  - `GET /api/public-config`

### Billing / Stripe
- `stripePlanTierFromPriceId` line 280
- `readRawBody` line 285
- `verifyStripeSignature` line 303
- `recordStripeWebhookEvent` line 325
- `stripeRequest` line 347
- `findWorkspaceForStripeEvent` line 356
- `syncStripeBillingFromEvent` line 392
- routes:
  - `POST /api/stripe/webhook`
  - `POST /api/billing/portal-session`

### Workspace / team / invites
- `findInviteById` line 148
- `inviteForUser` line 152
- routes:
  - `PATCH /api/workspace`
  - `POST /api/team`
  - `POST /api/invites/:id/accept`
  - `POST /api/invites/:id/decline`
  - `DELETE /api/team/:id`

### Quotes
- routes:
  - `POST /api/quotes`
  - `PATCH /api/quotes/:id`
  - `DELETE /api/quotes/:id`
  - `POST /api/quotes/:id/send-email`
  - `POST /api/quotes/:id/actions`

## Target module layout

```text
catalyst-server/
  app.js                    # thin router/orchestrator only
  api/
    common.js               # shared request guards and auth-store loading
    system.js               # health, project metrics, public config
    auth.js                 # auth, google oauth, session-aware identity endpoints
    billing.js              # stripe webhook + billing portal session
    workspace.js            # workspace settings, team membership, invites, workspace select
    quotes.js               # quote CRUD, send-email, actions
```

## Exact ownership rules

### `app.js`
Owns only:
- `handleApi(req, res, url)` orchestration
- route-module call order
- final API `notFound`
- static serving handoff inside `requestHandler`
- top-level error boundary

After extraction, `app.js` should not contain domain logic, Stripe code, Google OAuth code, quote mutation logic, or workspace mutation logic.

### `api/common.js`
Owns only cross-domain helpers used by multiple route modules:
- `getAppBaseUrl`
- `ensureSameOrigin`
- `ensureWorkspaceWritable`
- `getWorkspaceMemberCount`
- `loadAuthenticatedStore`
- `shouldRefreshLastSeen`
- `refreshLastSeen`
- generic `enforceRateLimit(req, res, namespace, policy, message?)`
- `readRawBody` if billing is the only caller, otherwise keep it in `billing.js`

Rules:
- no route definitions here
- no Stripe-specific logic here
- no Google-specific logic here
- no quote/workspace mutation logic here

### `api/system.js`
Owns only:
- `GET /api/health`
- `GET /api/project-metrics`
- `GET /api/public-config`
- project metrics cache and helpers

Rules:
- read-only module
- no session requirement
- no dependency on workspace mutations

### `api/auth.js`
Owns only:
- Google OAuth flow
- signup/login/logout/me
- verify/resend verification
- forgot/reset password
- activity ping
- bootstrap endpoint

Helpers that belong here:
- Google redirect/cookie helpers
- Google token exchange/profile fetch
- verification/reset token helpers
- auth-specific rate-limit policies
- workspace creation path used during signup and first-time Google signup

Rules:
- may use `common.js`
- may use `session.js`, `email.js`, `store.js`, `utils.js`
- must not own Stripe or quote logic

### `api/billing.js`
Owns only:
- `POST /api/stripe/webhook`
- `POST /api/billing/portal-session`
- Stripe signature verification
- Stripe idempotency recording
- Stripe customer/subscription lookup helpers
- billing sync into Supabase

Rules:
- Stripe code stays isolated here
- raw body parsing for webhooks stays here unless promoted to truly generic helper
- no quote/auth/workspace mutation logic other than billing fields

### `api/workspace.js`
Owns only:
- `POST /api/workspace/select`
- `PATCH /api/workspace`
- `POST /api/team`
- `POST /api/invites/:id/accept`
- `POST /api/invites/:id/decline`
- `DELETE /api/team/:id`
- invite lookup helpers

Rules:
- must own Owner-role checks and team feature gating
- must keep reassignment behaviour when removing a member
- must keep trial read-only protection exactly as it works now

### `api/quotes.js`
Owns only:
- `POST /api/quotes`
- `PATCH /api/quotes/:id`
- `DELETE /api/quotes/:id`
- `POST /api/quotes/:id/send-email`
- `POST /api/quotes/:id/actions`

Rules:
- all quote mutation logic lives here
- quote event recording must remain close to mutations
- must keep current action names and semantics exactly

## Route-module contract

Each route module should export one handler:

```js
async function handleXApi(req, res, url) {
  // return true if handled
  // return false if not matched
}
```

`app.js` should call modules in this order:

1. `handleSystemApi`
2. `handleAuthApi`
3. `handleBillingApi`
4. `handleWorkspaceApi`
5. `handleQuotesApi`
6. `notFound(res)`

Why this order:
- system endpoints are read-only and trivial
- auth contains early public endpoints and authenticated identity/bootstrap paths
- billing webhook must remain explicit and isolated
- workspace and quotes are authenticated mutation domains

## Dependency rules

To keep the split clean and avoid the same giant file problem spreading sideways:

- route modules must not import each other
- route modules may import only shared modules (`config`, `http`, `session`, `email`, `store`, `supabase`, `utils`, `api/common`)
- if a helper is used by one route module only, keep it inside that module
- if a helper is used by two or more route modules and is not domain-specific, move it to `api/common.js`
- do not create a generic `services.js` dumping ground
- do not move store/business rules out of `store.js` unless there is a real reuse reason

## Extraction order

Use this order during action two and three:

1. Extract `api/system.js`
   - lowest risk
   - read-only
   - easy parity check

2. Extract `api/billing.js`
   - isolates Stripe complexity early
   - removes raw-body + signature code from app shell

3. Extract `api/auth.js`
   - largest branch cluster
   - removes OAuth, tokens, and session-heavy logic from `app.js`

4. Extract `api/workspace.js`
   - groups workspace, team, and invite mutation rules together

5. Extract `api/quotes.js`
   - groups all quote mutations and follow-up email behaviour together

6. Collapse `app.js` into a thin orchestrator
   - imports route handlers
   - dispatches in order
   - serves static files
   - catches top-level errors

## High-risk parity points to verify during refactor

These are the places most likely to break if extraction is careless:

- `GET /api/auth/google/callback` secure-cookie handling
- same-origin checks on mutating authenticated routes
- `GET /api/auth/me` returning `{ user: null }` instead of 401
- `GET /api/app/bootstrap` still requiring an authenticated workspace-aware store
- `POST /api/workspace/select` continuing to validate accessible workspaces only
- owner-only billing portal access
- Stripe webhook raw-body signature verification staying byte-accurate
- Stripe webhook duplicate-event behaviour staying idempotent
- team removal still reassigning owned quotes
- quote action names and follow-up date rules staying exact
- send-email fallback behaviour staying identical when email is not configured

## Definition of done for the refactor

The refactor is done only when:

- `catalyst-server/app.js` is mostly orchestration
- every current API route still responds with the same method/path/shape semantics
- there is no duplicated helper logic across route modules
- each route domain can be read without scanning the whole backend file
- Stripe, auth, workspace/team, and quotes are isolated enough to change safely later

## Implementation note for later

When wiring this, keep each extraction small and reversible:

- move one domain
- run a quick syntax check
- compare route behaviour
- only then delete the old branch from `app.js`

That is the safest path to clean, bulletproof, and efficient without changing product behaviour.
