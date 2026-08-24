-- 0010_bfo_registry.sql — BFO ontology registry: object_types, link_types, links
-- Additive only. No existing table is altered or dropped.
--
-- Three tables:
--   object_types — the registry of entity types, each classified under a BFO category
--   link_types   — the registry of relation types, each recording WHERE it is stored
--   links        — the generic edge table for relations that have no backing FK column
--
-- Why link_types.via_kind exists: after this migration relations live in two places —
-- rows in `links` (email→recipient, event→attendee) and FK columns on typed tables
-- (emails.sender_id, document_chunks.document_id). Store-once (§2.2) forbids mirroring
-- an FK into `links`, so the registry records where each relation is stored and
-- /ontology/graph gets one registry-driven traversal engine instead of a hardcoded
-- join list.
--
-- Runs in a single transaction: the backfill gate at the bottom RAISEs (and therefore
-- rolls the whole file back) if `links` does not match the source pair tables. This is
-- the one deviation from 0009's bare-statement style, and it is the point of the file.

begin;

-- ---------------------------------------------------------------------------
-- object_types — registry of entity types
-- ---------------------------------------------------------------------------
create table if not exists object_types (
  name         text primary key,
  bfo_category text not null
    check (bfo_category in ('material_entity','ice','quality','realizable','process')),
  parent_type  text references object_types(name),
  definition   text not null,   -- genus-differentia: "an X that ..."
  table_name   text,            -- backing table; null for abstract types
  icon         text             -- Tabler outline icon name, e.g. 'ti-school'
);

-- ---------------------------------------------------------------------------
-- link_types — registry of relation types
-- ---------------------------------------------------------------------------
create table if not exists link_types (
  name        text primary key,
  domain_type text not null references object_types(name),
  range_type  text not null references object_types(name),
  inverse_of  text references link_types(name),
  via_kind    text not null default 'links' check (via_kind in ('links','fk')),
  via_table   text,
  via_column  text,
  constraint link_types_via_consistent check (
    (via_kind = 'fk'    and via_table is not null and via_column is not null) or
    (via_kind = 'links' and via_table is null     and via_column is null)
  )
);

-- ---------------------------------------------------------------------------
-- links — generic edge table
-- ---------------------------------------------------------------------------
-- from_id/to_id are text, not uuid: the registered backing tables do NOT share a key
-- type. people/emails/calendar_events/documents/document_chunks/tasks are uuid, but
-- actions/audit_log/messages are bigint identity. text is the only column type that
-- can address every registered object type from one edge table.
create table if not exists links (
  id         bigserial primary key,
  from_type  text not null references object_types(name),
  from_id    text not null,
  link_type  text not null references link_types(name),
  to_type    text not null references object_types(name),
  to_id      text not null,
  created_at timestamptz not null default now(),
  constraint links_edge_key unique (from_type, from_id, link_type, to_type, to_id)
);

-- traversal in both directions
create index if not exists idx_links_from on links (from_type, from_id, link_type);
create index if not exists idx_links_to   on links (to_type,   to_id,   link_type);

-- ---------------------------------------------------------------------------
-- seed: object_types
-- ---------------------------------------------------------------------------
-- parent_type is null for every row: no abstract supertype is registered yet, and
-- document_chunks is a PART of a document, not a SUBTYPE of one — parthood is a link,
-- not an inheritance edge.
-- Deliberately NOT registered (not entities): sync_state, dashboard_state, Qdrant
-- collections — they are system state, not facts about the owner's world.
insert into object_types (name, bfo_category, parent_type, definition, table_name, icon) values
  ('people', 'material_entity', null,
   'A material entity that is a human being with whom the owner corresponds, individuated by a unique email address.',
   'people', 'ti-users'),

  ('emails', 'ice', null,
   'An information content entity that is a single mail message sent to or from the owner''s account, about the owner''s affairs and borne by the Gmail store.',
   'emails', 'ti-mail'),

  ('documents', 'ice', null,
   'An information content entity that is a whole uploaded file whose body is held verbatim in Postgres as the source of truth.',
   'documents', 'ti-file-text'),

  ('document_chunks', 'ice', null,
   'An information content entity that is a contiguous span of exactly one document, cut by the chunker to serve as the unit of retrieval.',
   'document_chunks', 'ti-stack'),

  ('messages', 'ice', null,
   'An information content entity that is one turn of a conversation, authored by either the owner or the assistant and ordered within a conversation.',
   'messages', 'ti-message-circle'),

  ('tasks', 'realizable', null,
   'A realizable entity that is a unit of work the owner intends to complete, borne until its status leaves ''open'' and realized in the doing of it.',
   'tasks', 'ti-checkbox'),

  ('actions', 'realizable', null,
   'A realizable entity that is a capability the assistant has proposed to exercise, realized when it is approved and executed.',
   'actions', 'ti-bolt'),

  -- deliberate reclassification: an event is a happening, not a record of one
  ('calendar_events', 'process', null,
   'A process that is a scheduled happening occupying a bounded interval, in which an organizer and zero or more attendees participate.',
   'calendar_events', 'ti-calendar-event'),

  ('audit_log', 'process', null,
   'A process that is a completed occurrence written by a service at the moment it happened; the single append-only ledger of what the system did.',
   'audit_log', 'ti-history')
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- seed: link_types
-- ---------------------------------------------------------------------------
-- Inverse rows are TRAVERSAL DESCRIPTORS, not mirrored storage: an inverse carries the
-- same via_kind/via_table/via_column as its forward partner because the engine reads
-- the same physical place backwards. It never writes a second row for the inverse.
insert into link_types (name, domain_type, range_type, via_kind, via_table, via_column) values
  -- stored as rows in `links` (backfilled below from the pair tables)
  ('email_has_to_recipient',    'emails',          'people',          'links', null, null),
  ('person_is_to_recipient_of', 'people',          'emails',          'links', null, null),
  ('email_has_cc_recipient',    'emails',          'people',          'links', null, null),
  ('person_is_cc_recipient_of', 'people',          'emails',          'links', null, null),
  ('event_has_attendee',        'calendar_events', 'people',          'links', null, null),
  ('person_attends_event',      'people',          'calendar_events', 'links', null, null),

  -- stored as FK columns on typed tables — NOT mirrored into `links`
  ('email_has_sender',          'emails',          'people',          'fk', 'emails',          'sender_id'),
  ('person_sent_email',         'people',          'emails',          'fk', 'emails',          'sender_id'),
  ('event_has_organizer',       'calendar_events', 'people',          'fk', 'calendar_events', 'organizer_id'),
  ('person_organizes_event',    'people',          'calendar_events', 'fk', 'calendar_events', 'organizer_id'),
  ('document_has_chunk',        'documents',       'document_chunks', 'fk', 'document_chunks', 'document_id'),
  ('chunk_is_part_of_document', 'document_chunks', 'documents',       'fk', 'document_chunks', 'document_id'),
  -- actions.supersedes_id is column-backed but carries no FK constraint in the live
  -- schema; it is still a real stored relation, so the registry records where it lives.
  ('action_supersedes',         'actions',         'actions',         'fk', 'actions',         'supersedes_id'),
  ('action_superseded_by',      'actions',         'actions',         'fk', 'actions',         'supersedes_id')
on conflict (name) do nothing;

-- wire inverses (separate pass: link_types.inverse_of is self-referencing)
update link_types set inverse_of = v.inv from (values
  ('email_has_to_recipient',    'person_is_to_recipient_of'),
  ('person_is_to_recipient_of', 'email_has_to_recipient'),
  ('email_has_cc_recipient',    'person_is_cc_recipient_of'),
  ('person_is_cc_recipient_of', 'email_has_cc_recipient'),
  ('event_has_attendee',        'person_attends_event'),
  ('person_attends_event',      'event_has_attendee'),
  ('email_has_sender',          'person_sent_email'),
  ('person_sent_email',         'email_has_sender'),
  ('event_has_organizer',       'person_organizes_event'),
  ('person_organizes_event',    'event_has_organizer'),
  ('document_has_chunk',        'chunk_is_part_of_document'),
  ('chunk_is_part_of_document', 'document_has_chunk'),
  ('action_supersedes',         'action_superseded_by'),
  ('action_superseded_by',      'action_supersedes')
) as v(name, inv)
where link_types.name = v.name and link_types.inverse_of is distinct from v.inv;

-- ---------------------------------------------------------------------------
-- backfill: pair tables -> links
-- ---------------------------------------------------------------------------
-- Source rows are NOT deleted here. email_recipients.kind is preserved as two distinct
-- link types rather than collapsed into one, so dropping the pair tables in 0012 loses
-- no fact that this table now carries.
insert into links (from_type, from_id, link_type, to_type, to_id)
select 'emails', r.email_id::text,
       case r.kind when 'cc' then 'email_has_cc_recipient'
                   else 'email_has_to_recipient' end,
       'people', r.person_id::text
from email_recipients r
where r.kind in ('to','cc')
on conflict on constraint links_edge_key do nothing;

insert into links (from_type, from_id, link_type, to_type, to_id)
select 'calendar_events', a.event_id::text, 'event_has_attendee', 'people', a.person_id::text
from event_attendees a
on conflict on constraint links_edge_key do nothing;

-- ---------------------------------------------------------------------------
-- gate — the point of this migration
-- ---------------------------------------------------------------------------
-- links must account for every source pair row. Any shortfall (an unregistered kind, a
-- collapsed edge, a silently dropped row) raises and rolls the whole migration back.
do $gate$
declare
  expected      bigint;
  actual        bigint;
  stray_kinds   text;
begin
  select string_agg(distinct kind, ', ') into stray_kinds
    from email_recipients where kind not in ('to','cc');
  if stray_kinds is not null then
    raise exception '0010 gate: email_recipients has unregistered kind(s): % — add a link_type before backfilling', stray_kinds;
  end if;

  select (select count(*) from email_recipients) + (select count(*) from event_attendees)
    into expected;
  select count(*) into actual from links;

  if actual <> expected then
    raise exception '0010 gate: links has % rows, expected % (email_recipients + event_attendees) — rolling back', actual, expected;
  end if;

  raise notice '0010 gate OK: links = % rows (email_recipients + event_attendees = %)', actual, expected;
end
$gate$;

commit;
