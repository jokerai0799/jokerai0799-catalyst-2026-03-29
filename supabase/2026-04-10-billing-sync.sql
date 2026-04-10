alter table if exists workspaces add column if not exists billing_plan_tier text;
alter table if exists workspaces add column if not exists billing_status text;
alter table if exists workspaces add column if not exists billing_currency text;
alter table if exists workspaces add column if not exists stripe_customer_id text;
alter table if exists workspaces add column if not exists stripe_subscription_id text;
alter table if exists workspaces add column if not exists stripe_price_id text;
alter table if exists workspaces add column if not exists stripe_current_period_end timestamptz;

update workspaces
set billing_plan_tier = case
  when notes like '<!--qfu:plan=business%' then 'business'
  else 'personal'
end
where billing_plan_tier is null;

update workspaces
set billing_status = coalesce(billing_status, 'inactive'),
    billing_currency = coalesce(billing_currency, 'GBP');
