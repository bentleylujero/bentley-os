-- 0007_tasks.sql — tasks: a new object type (things the owner owes action on).
-- Raw row written by api (title/notes/source); enrichment (priority/reason)
-- written by marionette, mirroring the emails classify pattern. Not a shadow
-- table — a task is a distinct fact from an email or a calendar event.

create table if not exists tasks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  notes        text,
  source       text not null default 'manual',   -- 'manual' | 'self_email'
  source_id    text,                              -- email id when source='self_email'
  status       text not null default 'open',      -- 'open' | 'done'

  -- marionette enrichment (nullable — task exists before enrichment):
  priority     text,                              -- 'high' | 'medium' | 'low'
  reason       text,                              -- one-line: what's at stake
  category     text,                              -- marionette-assigned bucket
  enriched_at  timestamptz,                       -- null = not yet enriched

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_tasks_status      on tasks (status);
create index if not exists idx_tasks_created_at   on tasks (created_at desc);
create index if not exists idx_tasks_unenriched   on tasks (created_at desc)
  where enriched_at is null;
