create table if not exists sync_state (
  source text primary key,
  sync_token text,
  updated_at timestamptz not null default now()
);
