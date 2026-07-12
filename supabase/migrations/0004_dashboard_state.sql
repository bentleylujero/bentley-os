-- 0004_dashboard_state.sql
-- Singleton state for the dashboard's "what changed" view.
-- Holds one fact: the last time the owner viewed the dashboard.
-- Enforced single-row (id pinned to 1) — not a shadow table, one fact stored once.
create table if not exists dashboard_state (
  id           smallint primary key default 1 check (id = 1),
  last_seen_at timestamptz not null default now()
);

-- Seed the singleton row. on conflict keeps re-running the migration safe.
insert into dashboard_state (id, last_seen_at)
values (1, now())
on conflict (id) do nothing;
