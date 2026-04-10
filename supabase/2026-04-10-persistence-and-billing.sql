alter table if exists users add column if not exists verification_token_expires_at timestamptz;
alter table if exists users add column if not exists reset_token_expires_at timestamptz;
alter table if exists workspaces add column if not exists billing_plan_tier text;
alter table if exists workspaces add column if not exists billing_status text;
alter table if exists workspaces add column if not exists billing_currency text;
alter table if exists workspaces add column if not exists stripe_customer_id text;
alter table if exists workspaces add column if not exists stripe_subscription_id text;
alter table if exists workspaces add column if not exists stripe_price_id text;
alter table if exists workspaces add column if not exists stripe_current_period_end timestamptz;

create index if not exists users_verification_token_idx on users (verification_token);
create index if not exists users_reset_token_idx on users (reset_token);
create index if not exists workspaces_reply_email_idx on workspaces (reply_email);
create index if not exists workspaces_stripe_customer_id_idx on workspaces (stripe_customer_id);

update workspaces
set billing_plan_tier = case
  when notes like '<!--qfu:plan=business%' then 'business'
  else 'personal'
end
where billing_plan_tier is null;

update workspaces
set billing_status = coalesce(billing_status, 'inactive'),
    billing_currency = coalesce(billing_currency, 'GBP');
