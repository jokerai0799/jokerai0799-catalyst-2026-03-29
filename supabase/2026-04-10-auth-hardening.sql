alter table if exists users add column if not exists verification_token_expires_at timestamptz;
alter table if exists users add column if not exists reset_token_expires_at timestamptz;
