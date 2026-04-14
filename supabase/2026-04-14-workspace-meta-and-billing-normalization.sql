alter table if exists workspaces add column if not exists trial_ends_at date;

create table if not exists workspace_billing (
  workspace_id text primary key references workspaces(id) on delete cascade,
  billing_plan_tier text,
  billing_status text,
  billing_currency text,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  stripe_current_period_end timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists workspace_billing_customer_idx on workspace_billing (stripe_customer_id);

alter table workspace_billing enable row level security;
revoke all on table workspace_billing from anon, authenticated;

update workspaces
set trial_ends_at = coalesce(
  trial_ends_at,
  nullif(substring(notes from 'trialEndsAt=([0-9]{4}-[0-9]{2}-[0-9]{2})'), '')::date,
  (created_at at time zone 'utc')::date + 7
)
where trial_ends_at is null;

update workspaces
set billing_plan_tier = case
  when notes like '<!--qfu:plan=business%' then 'business'
  else coalesce(billing_plan_tier, 'personal')
end
where billing_plan_tier is null or billing_plan_tier = '';

update workspaces
set billing_status = coalesce(billing_status, 'inactive'),
    billing_currency = coalesce(billing_currency, 'GBP');

insert into workspace_billing (
  workspace_id,
  billing_plan_tier,
  billing_status,
  billing_currency,
  stripe_customer_id,
  stripe_subscription_id,
  stripe_price_id,
  stripe_current_period_end,
  created_at
)
select
  id,
  coalesce(billing_plan_tier, 'personal'),
  coalesce(billing_status, 'inactive'),
  coalesce(billing_currency, 'GBP'),
  stripe_customer_id,
  stripe_subscription_id,
  stripe_price_id,
  stripe_current_period_end,
  created_at
from workspaces
on conflict (workspace_id) do update set
  billing_plan_tier = excluded.billing_plan_tier,
  billing_status = excluded.billing_status,
  billing_currency = excluded.billing_currency,
  stripe_customer_id = excluded.stripe_customer_id,
  stripe_subscription_id = excluded.stripe_subscription_id,
  stripe_price_id = excluded.stripe_price_id,
  stripe_current_period_end = excluded.stripe_current_period_end;

update workspaces
set notes = regexp_replace(notes, '^<!--qfu:[^>]+-->\s*', '')
where notes like '<!--qfu:%';
