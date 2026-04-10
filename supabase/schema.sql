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

create table if not exists users (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  email text not null unique,
  password_hash text not null,
  verified boolean not null default false,
  verification_token text,
  reset_token text,
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
alter table users enable row level security;
alter table team_members enable row level security;
alter table quotes enable row level security;
alter table workspace_invites enable row level security;
alter table quote_events enable row level security;
alter table sessions enable row level security;

revoke all on table workspaces from anon, authenticated;
revoke all on table users from anon, authenticated;
revoke all on table team_members from anon, authenticated;
revoke all on table quotes from anon, authenticated;
revoke all on table workspace_invites from anon, authenticated;
revoke all on table quote_events from anon, authenticated;
revoke all on table sessions from anon, authenticated;

alter table if exists quotes add column if not exists customer_email text;
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
