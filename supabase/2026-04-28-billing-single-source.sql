-- Catalyst hardening pass · 2026-04-28
-- Goal: make workspaces the single source of truth for billing state.
-- Paste into Supabase SQL editor after reviewing.

begin;

create table if not exists workspace_billing_archive as
select * from workspace_billing where false;

insert into workspace_billing_archive
select wb.*
from workspace_billing wb
where not exists (
  select 1
  from workspace_billing_archive archived
  where archived.workspace_id = wb.workspace_id
);

update workspaces w
set billing_plan_tier = coalesce(w.billing_plan_tier, wb.billing_plan_tier),
    billing_status = coalesce(w.billing_status, wb.billing_status),
    billing_currency = coalesce(w.billing_currency, wb.billing_currency),
    stripe_customer_id = coalesce(nullif(w.stripe_customer_id, ''), wb.stripe_customer_id),
    stripe_subscription_id = coalesce(nullif(w.stripe_subscription_id, ''), wb.stripe_subscription_id),
    stripe_price_id = coalesce(nullif(w.stripe_price_id, ''), wb.stripe_price_id),
    stripe_current_period_end = coalesce(w.stripe_current_period_end, wb.stripe_current_period_end)
from workspace_billing wb
where wb.workspace_id = w.id;

update workspaces
set billing_plan_tier = coalesce(billing_plan_tier, 'personal'),
    billing_status = coalesce(billing_status, 'inactive'),
    billing_currency = coalesce(billing_currency, 'GBP');

create unique index if not exists workspaces_stripe_customer_id_unique
  on workspaces (stripe_customer_id)
  where stripe_customer_id is not null and stripe_customer_id <> '';

create unique index if not exists workspaces_stripe_subscription_id_unique
  on workspaces (stripe_subscription_id)
  where stripe_subscription_id is not null and stripe_subscription_id <> '';

alter table if exists workspace_billing disable trigger workspace_billing_sync_workspaces;
alter table if exists workspaces disable trigger workspaces_sync_workspace_billing;

drop trigger if exists workspace_billing_sync_workspaces on workspace_billing;
drop trigger if exists workspaces_sync_workspace_billing on workspaces;

drop function if exists sync_workspaces_from_workspace_billing();
drop function if exists sync_workspace_billing_from_workspaces();

commit;
