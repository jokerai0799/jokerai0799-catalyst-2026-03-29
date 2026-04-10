alter table if exists users add column if not exists last_seen_at timestamptz;
create index if not exists users_last_seen_at_idx on users (last_seen_at);

update users
set last_seen_at = coalesce(last_seen_at, created_at)
where last_seen_at is null;
