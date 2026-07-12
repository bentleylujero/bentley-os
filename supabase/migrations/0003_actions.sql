-- 0003_actions.sql
-- First-class action objects: proposed side-effecting operations awaiting human approval.
-- Mutable current-state store. audit_log remains the append-only ledger (target = actions.id).

create table if not exists actions (
  id            bigint generated always as identity primary key,
  kind          text not null,                    -- 'commit_deploy' (first + only slice for now)
  status        text not null default 'proposed', -- proposed|approved|executing|succeeded|failed|denied
  proposed_by   text not null,                    -- 'marionette'
  intent        jsonb not null default '{}',      -- machine-executable: {service, commit_message, ...}
  briefing      text,                             -- marionette's human-facing synthesis (dormant until steering lands)
  result        jsonb not null default '{}',      -- filled on execution outcome
  supersedes_id bigint,                           -- lineage pointer (dormant until steering lands)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_actions_status on actions (status);
create index if not exists idx_actions_created on actions (created_at desc);
