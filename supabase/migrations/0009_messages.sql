-- 0009_messages.sql — conversation memory
-- One row per turn. conversation_id is OPTIONAL: absent = stateless (today's behavior).

create table if not exists messages (
  id            bigint generated always as identity primary key,
  conversation_id text not null,
  role          text not null check (role in ('user','assistant')),
  content       text not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_messages_conversation
  on messages (conversation_id, created_at desc);
