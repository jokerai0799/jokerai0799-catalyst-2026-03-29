create table if not exists workspaces (
  id text primary key,
  name text not null,
  reply_email text not null,
  first_followup_days integer not null default 2,
  second_followup_days integer not null default 5,
  notes text not null default '',
  billing_plan_tier text,
  billing_status text,
  billing_currency text,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  stripe_current_period_end timestamptz,
  created_at timestamptz not null default now()
);

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

create table if not exists users (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  email text not null unique,
  password_hash text not null,
  verified boolean not null default false,
  verification_token text,
  verification_token_expires_at timestamptz,
  reset_token text,
  reset_token_expires_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists team_members (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  email text not null,
  role text not null default 'Member',
  active_quotes integer not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists team_members_workspace_email_idx on team_members (workspace_id, email);
create index if not exists team_members_email_idx on team_members (email);

create table if not exists quotes (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  title text not null,
  customer text not null,
  customer_email text,
  owner text not null,
  status text not null,
  value numeric(12,2) not null default 0,
  sent_date date not null,
  next_follow_up date not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  archived boolean not null default false
);

create index if not exists quotes_workspace_id_idx on quotes (workspace_id);
create index if not exists quotes_workspace_followup_idx on quotes (workspace_id, next_follow_up);

create table if not exists workspace_invites (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  inviter_user_id text not null references users(id) on delete cascade,
  inviter_name text not null default '',
  workspace_name text not null default '',
  invitee_name text not null default '',
  invitee_email text not null,
  role text not null default 'Member',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists workspace_invites_workspace_idx on workspace_invites (workspace_id, status, created_at desc);
create index if not exists workspace_invites_email_idx on workspace_invites (invitee_email, status, created_at desc);

create table if not exists quote_events (
  id text primary key,
  quote_id text not null references quotes(id) on delete cascade,
  summary text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists quote_events_quote_id_idx on quote_events (quote_id, created_at desc);

create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_user_id_idx on sessions (user_id);
create index if not exists sessions_expires_at_idx on sessions (expires_at);

alter table workspaces enable row level security;
alter table workspace_billing enable row level security;
alter table users enable row level security;
alter table team_members enable row level security;
alter table quotes enable row level security;
alter table workspace_invites enable row level security;
alter table quote_events enable row level security;
alter table sessions enable row level security;

revoke all on table workspaces from anon, authenticated;
revoke all on table workspace_billing from anon, authenticated;
revoke all on table users from anon, authenticated;
revoke all on table team_members from anon, authenticated;
revoke all on table quotes from anon, authenticated;
revoke all on table workspace_invites from anon, authenticated;
revoke all on table quote_events from anon, authenticated;
revoke all on table sessions from anon, authenticated;

alter table if exists quotes add column if not exists customer_email text;
alter table if exists users add column if not exists verification_token_expires_at timestamptz;
alter table if exists users add column if not exists reset_token_expires_at timestamptz;
alter table if exists users add column if not exists last_seen_at timestamptz;
alter table if exists workspaces add column if not exists trial_ends_at date;
alter table if exists workspaces add column if not exists billing_plan_tier text;
alter table if exists workspaces add column if not exists billing_status text;
alter table if exists workspaces add column if not exists billing_currency text;
alter table if exists workspaces add column if not exists stripe_customer_id text;
alter table if exists workspaces add column if not exists stripe_subscription_id text;
alter table if exists workspaces add column if not exists stripe_price_id text;
alter table if exists workspaces add column if not exists stripe_current_period_end timestamptz;

create index if not exists users_verification_token_idx on users (verification_token);
create index if not exists users_reset_token_idx on users (reset_token);
create index if not exists users_last_seen_at_idx on users (last_seen_at);
create index if not exists workspaces_reply_email_idx on workspaces (reply_email);
create index if not exists workspaces_stripe_customer_id_idx on workspaces (stripe_customer_id);

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

update users
set last_seen_at = coalesce(last_seen_at, created_at)
where last_seen_at is null;


-- 2026-04-14 hardening patch

-- Catalyst hardening patch · 2026-04-14
-- Safe to run multiple times.

alter table if exists users alter column password_hash drop not null;
update users set password_hash = null where password_hash = '';

alter table if exists team_members add column if not exists user_id text;
alter table if exists quotes add column if not exists owner_team_member_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'team_members_user_id_fkey'
  ) THEN
    ALTER TABLE team_members
      ADD CONSTRAINT team_members_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotes_owner_team_member_id_fkey'
  ) THEN
    ALTER TABLE quotes
      ADD CONSTRAINT quotes_owner_team_member_id_fkey
      FOREIGN KEY (owner_team_member_id) REFERENCES team_members(id) ON DELETE SET NULL;
  END IF;
END $$;

create unique index if not exists users_email_lower_idx on users (lower(email));
create unique index if not exists team_members_workspace_email_lower_idx on team_members (workspace_id, lower(email));
create unique index if not exists team_members_workspace_user_idx on team_members (workspace_id, user_id) where user_id is not null;
create index if not exists quotes_workspace_owner_member_idx on quotes (workspace_id, owner_team_member_id);

alter table if exists workspaces drop constraint if exists workspaces_reply_email_lowercase_check;
alter table if exists workspaces add constraint workspaces_reply_email_lowercase_check check (reply_email = lower(reply_email));
alter table if exists workspaces drop constraint if exists workspaces_followup_days_positive_check;
alter table if exists workspaces add constraint workspaces_followup_days_positive_check check (first_followup_days > 0 and second_followup_days > 0);
alter table if exists workspaces drop constraint if exists workspaces_billing_plan_tier_check;
alter table if exists workspaces add constraint workspaces_billing_plan_tier_check check (billing_plan_tier is null or billing_plan_tier in ('personal', 'business'));
alter table if exists workspaces drop constraint if exists workspaces_billing_status_check;
alter table if exists workspaces add constraint workspaces_billing_status_check check (billing_status is null or billing_status in ('inactive', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'));

alter table if exists workspace_billing drop constraint if exists workspace_billing_plan_tier_check;
alter table if exists workspace_billing add constraint workspace_billing_plan_tier_check check (billing_plan_tier is null or billing_plan_tier in ('personal', 'business'));
alter table if exists workspace_billing drop constraint if exists workspace_billing_status_check;
alter table if exists workspace_billing add constraint workspace_billing_status_check check (billing_status is null or billing_status in ('inactive', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired'));

alter table if exists users drop constraint if exists users_email_lowercase_check;
alter table if exists users add constraint users_email_lowercase_check check (email = lower(email));

alter table if exists team_members drop constraint if exists team_members_email_lowercase_check;
alter table if exists team_members add constraint team_members_email_lowercase_check check (email = lower(email));
alter table if exists team_members drop constraint if exists team_members_active_quotes_nonnegative_check;
alter table if exists team_members add constraint team_members_active_quotes_nonnegative_check check (active_quotes >= 0);

alter table if exists workspace_invites drop constraint if exists workspace_invites_email_lowercase_check;
alter table if exists workspace_invites add constraint workspace_invites_email_lowercase_check check (invitee_email = lower(invitee_email));
alter table if exists workspace_invites drop constraint if exists workspace_invites_status_check;
alter table if exists workspace_invites add constraint workspace_invites_status_check check (status in ('pending', 'accepted', 'declined', 'expired'));

alter table if exists quotes drop constraint if exists quotes_status_check;
alter table if exists quotes add constraint quotes_status_check check (status in ('Draft', 'Sent', 'Due today', 'Follow up due', 'Replied', 'Won', 'Lost', 'Archived'));
alter table if exists quotes drop constraint if exists quotes_value_nonnegative_check;
alter table if exists quotes add constraint quotes_value_nonnegative_check check (value >= 0);
alter table if exists quotes drop constraint if exists quotes_owner_present_check;
alter table if exists quotes add constraint quotes_owner_present_check check (length(trim(owner)) > 0);

update team_members tm
set user_id = u.id,
    email = lower(tm.email)
from users u
where tm.user_id is null
  and lower(tm.email) = lower(u.email);

insert into team_members (
  id,
  workspace_id,
  user_id,
  name,
  email,
  role,
  active_quotes,
  created_at
)
select
  'team_owner_' || substr(md5(w.id || ':' || u.id), 1, 20),
  w.id,
  u.id,
  u.name,
  lower(u.email),
  'Owner',
  0,
  coalesce(u.created_at, now())
from workspaces w
join users u on u.workspace_id = w.id
where not exists (
  select 1
  from team_members tm
  where tm.workspace_id = w.id
    and (tm.user_id = u.id or lower(tm.email) = lower(u.email))
)
on conflict (id) do update
set user_id = excluded.user_id,
    name = excluded.name,
    email = excluded.email,
    role = 'Owner';

update quotes q
set owner_team_member_id = tm.id,
    owner = tm.name
from team_members tm
where q.workspace_id = tm.workspace_id
  and q.owner_team_member_id is null
  and q.owner = tm.name;

create or replace function recalc_workspace_active_quotes(target_workspace_id text)
returns void
language sql
as $$
  update team_members tm
  set active_quotes = coalesce(counts.active_quotes, 0)
  from (
    select
      tm_inner.id as member_id,
      count(q.id)::integer as active_quotes
    from team_members tm_inner
    left join quotes q
      on q.workspace_id = tm_inner.workspace_id
     and not q.archived
     and q.status not in ('Won', 'Lost', 'Archived')
     and (
       q.owner_team_member_id = tm_inner.id
       or (q.owner_team_member_id is null and q.owner = tm_inner.name)
     )
    where tm_inner.workspace_id = target_workspace_id
    group by tm_inner.id
  ) counts
  where tm.id = counts.member_id;
$$;

create or replace function trigger_recalc_active_quotes()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  perform recalc_workspace_active_quotes(coalesce(new.workspace_id, old.workspace_id));
  if tg_op = 'UPDATE' and old.workspace_id is distinct from new.workspace_id then
    perform recalc_workspace_active_quotes(old.workspace_id);
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists quotes_recalc_active_quotes on quotes;
create trigger quotes_recalc_active_quotes
after insert or update or delete on quotes
for each row execute function trigger_recalc_active_quotes();

drop trigger if exists team_members_recalc_active_quotes on team_members;
create trigger team_members_recalc_active_quotes
after insert or delete or update of workspace_id, user_id, email, name, role on team_members
for each row execute function trigger_recalc_active_quotes();

DO $$
DECLARE
  row record;
BEGIN
  FOR row IN SELECT id FROM workspaces LOOP
    PERFORM recalc_workspace_active_quotes(row.id);
  END LOOP;
END $$;

create or replace function sync_workspace_billing_from_workspaces()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

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
  ) values (
    new.id,
    new.billing_plan_tier,
    new.billing_status,
    new.billing_currency,
    new.stripe_customer_id,
    new.stripe_subscription_id,
    new.stripe_price_id,
    new.stripe_current_period_end,
    coalesce(new.created_at, now())
  )
  on conflict (workspace_id) do update set
    billing_plan_tier = excluded.billing_plan_tier,
    billing_status = excluded.billing_status,
    billing_currency = excluded.billing_currency,
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    stripe_price_id = excluded.stripe_price_id,
    stripe_current_period_end = excluded.stripe_current_period_end;

  return new;
end;
$$;

drop trigger if exists workspaces_sync_workspace_billing on workspaces;
create trigger workspaces_sync_workspace_billing
after insert or update of billing_plan_tier, billing_status, billing_currency, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_current_period_end, created_at
on workspaces
for each row execute function sync_workspace_billing_from_workspaces();

create or replace function sync_workspaces_from_workspace_billing()
returns trigger
language plpgsql
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  update workspaces
  set billing_plan_tier = new.billing_plan_tier,
      billing_status = new.billing_status,
      billing_currency = new.billing_currency,
      stripe_customer_id = new.stripe_customer_id,
      stripe_subscription_id = new.stripe_subscription_id,
      stripe_price_id = new.stripe_price_id,
      stripe_current_period_end = new.stripe_current_period_end
  where id = new.workspace_id;

  return new;
end;
$$;

drop trigger if exists workspace_billing_sync_workspaces on workspace_billing;
create trigger workspace_billing_sync_workspaces
after insert or update of billing_plan_tier, billing_status, billing_currency, stripe_customer_id, stripe_subscription_id, stripe_price_id, stripe_current_period_end
on workspace_billing
for each row execute function sync_workspaces_from_workspace_billing();

create table if not exists stripe_webhook_events (
  id text primary key,
  type text not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz not null default now()
);

create index if not exists stripe_webhook_events_processed_at_idx on stripe_webhook_events (processed_at desc);

alter table stripe_webhook_events enable row level security;
revoke all on table stripe_webhook_events from anon, authenticated;

create table if not exists auth_rate_limit_events (
  bucket_key text not null,
  created_at timestamptz not null default now()
);

create index if not exists auth_rate_limit_events_bucket_created_idx on auth_rate_limit_events (bucket_key, created_at desc);

alter table auth_rate_limit_events enable row level security;
revoke all on table auth_rate_limit_events from anon, authenticated;

create or replace function consume_rate_limit(bucket_key text, window_ms integer, max_hits integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  window_interval interval := (window_ms::text || ' milliseconds')::interval;
  window_start timestamptz := clock_timestamp() - window_interval;
  current_hits integer;
  earliest_hit timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext(bucket_key));

  delete from auth_rate_limit_events
  where created_at < clock_timestamp() - interval '1 day';

  select count(*)::integer, min(created_at)
    into current_hits, earliest_hit
  from auth_rate_limit_events
  where auth_rate_limit_events.bucket_key = consume_rate_limit.bucket_key
    and created_at >= window_start;

  if current_hits >= max_hits then
    return jsonb_build_object(
      'allowed', false,
      'remaining', 0,
      'reset_at', coalesce(earliest_hit + window_interval, clock_timestamp() + window_interval)
    );
  end if;

  insert into auth_rate_limit_events (bucket_key)
  values (consume_rate_limit.bucket_key);

  select count(*)::integer, min(created_at)
    into current_hits, earliest_hit
  from auth_rate_limit_events
  where auth_rate_limit_events.bucket_key = consume_rate_limit.bucket_key
    and created_at >= window_start;

  return jsonb_build_object(
    'allowed', true,
    'remaining', greatest(max_hits - current_hits, 0),
    'reset_at', coalesce(earliest_hit + window_interval, clock_timestamp() + window_interval)
  );
end;
$$;

revoke all on function consume_rate_limit(text, integer, integer) from anon, authenticated;
