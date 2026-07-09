-- 0001_secretary_ontology.sql
-- Bentley OS — initial ontology for the "secretary" tool (email + calendar).
-- Scope: Gmail + Calendar only. Foreign keys (not object_links) for now.
-- Principle: store each fact once; one shared people table; DB-enforced relationships.
CREATE TABLE people (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text UNIQUE NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE emails (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source         text NOT NULL DEFAULT 'gmail',
  source_id      text NOT NULL,
  thread_id      text,
  sender_id      uuid REFERENCES people(id),
  subject        text,
  snippet        text,
  received_at    timestamptz,
  is_unread      boolean,
  category       text,
  importance     smallint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX idx_emails_received_at ON emails (received_at DESC);
CREATE INDEX idx_emails_sender ON emails (sender_id);
CREATE TABLE email_recipients (
  email_id   uuid NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES people(id),
  kind       text NOT NULL DEFAULT 'to',
  PRIMARY KEY (email_id, person_id, kind)
);
CREATE TABLE calendar_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source         text NOT NULL DEFAULT 'gcal',
  source_id      text NOT NULL,
  title          text,
  description    text,
  location       text,
  starts_at      timestamptz,
  ends_at        timestamptz,
  organizer_id   uuid REFERENCES people(id),
  status         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX idx_events_starts_at ON calendar_events (starts_at);
CREATE TABLE event_attendees (
  event_id    uuid NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id),
  response    text,
  PRIMARY KEY (event_id, person_id)
);
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL,
  target      text,
  outcome     text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_audit_at ON audit_log (at DESC);
CREATE INDEX idx_audit_action ON audit_log (action);
