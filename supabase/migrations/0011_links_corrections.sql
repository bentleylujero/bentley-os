-- 0011_links_corrections.sql — corrections to the 0010 registry.
--
-- Two changes, plus one doctrine reversal that 0010 forced.
--
-- 1. event_attendees stays, and its rows leave `links`.
--    0010 backfilled event_attendees into `links` on the way to dropping it. That is
--    wrong: event_attendees.response (accepted/needsAction) is a QUALITY of the
--    participation, not a relation type, and link_types can express types but not
--    qualities. Folding it into `links` would drop `response` on the floor. So the
--    table stays as the store of that relation, the 32 mirrored rows are deleted from
--    `links` (store-once, §2.2), and the registry records where the relation now lives.
--    By contrast email_recipients.kind (to/cc) IS a type, already folds into two
--    distinct link types, and is still dropped in 0013.
--
--    event_attendees is a junction table: PK (event_id, person_id), no `id` column.
--    Both endpoints are FK columns, so the (via_table, via_column) pair 0010 shipped
--    cannot address it — hence via_from_column and via_kind='join' below.
--
-- 2. links.id is harmonized to `bigint generated always as identity`, the convention
--    0003 and 0009 use. 0010's `bigserial` was the odd one out. Existing ids are
--    preserved and the new identity sequence resumes past the pre-migration high-water
--    mark, so no id is ever reused — including those freed by the delete above.
--
-- REVERSES A 0010 DOCTRINE. 0010's header states that an inverse link_type "carries the
-- same via_kind/via_table/via_column as its forward partner because the engine reads the
-- same physical place backwards". Reading the same place is right; carrying the same
-- columns is not. via_column names the RANGE side, and for a reverse row the range side
-- is a different column than it is for the forward row. Under 0010's rule every reverse
-- fk row resolved its range to the forward row's column, which renders that direction of
-- the edge backwards. Four rows were seeded that way and are corrected here.
--
-- Runs in a single transaction. The gates at the bottom RAISE — and therefore roll the
-- whole file back — if any correction did not land exactly.

begin;

-- ---------------------------------------------------------------------------
-- pre-migration state, captured before anything mutates
-- ---------------------------------------------------------------------------
-- The gates compare against these rather than against literals, and the identity
-- sequence is advanced past max_id so the ids freed by the delete are never reissued.
create temporary table _0011_before on commit drop as
select (select count(*)            from links)                                     as links_count,
       (select count(*)            from links where link_type = 'event_has_attendee') as attendee_links,
       (select coalesce(max(id),0) from links)                                     as max_id,
       (select count(*)            from event_attendees)                           as event_attendees_count;

-- ---------------------------------------------------------------------------
-- link_types — via_from_column, and a third via_kind
-- ---------------------------------------------------------------------------
alter table link_types add column if not exists via_from_column text;

-- 'join': the relation is stored in a junction table that is nobody's backing table.
alter table link_types drop constraint if exists link_types_via_kind_check;
alter table link_types add constraint link_types_via_kind_check
  check (via_kind in ('links','fk','join'));

-- via_from_column is required for 'join' (neither endpoint is the table's own PK) and
-- optional for 'fk' (null means the domain side is via_table's own id).
alter table link_types drop constraint if exists link_types_via_consistent;
alter table link_types add constraint link_types_via_consistent check (
  (via_kind = 'fk'    and via_table is not null and via_column is not null) or
  (via_kind = 'join'  and via_table is not null and via_column is not null
                      and via_from_column is not null) or
  (via_kind = 'links' and via_table is null     and via_column is null
                      and via_from_column is null)
);

comment on column link_types.via_kind is
  'Where this relation is stored: ''links'' = a row in the links edge table; ''fk'' = a '
  'column on the domain type''s own backing table; ''join'' = a junction table that is '
  'nobody''s backing table (both endpoints are FK columns there).';

comment on column link_types.via_column is
  'Column of via_table that resolves the RANGE side of this relation. Always the range '
  'side, in every direction — a reverse link_type names a different column than its '
  'forward partner, and typically names via_table''s own id.';

comment on column link_types.via_from_column is
  'Column of via_table that resolves the DOMAIN side. Required only when via_table is '
  'not the domain type''s own backing table — i.e. every ''join'' row, and every ''fk'' '
  'row read in the reverse direction. Null means the domain side is via_table.id.';

-- ---------------------------------------------------------------------------
-- correct the reverse-direction fk rows
-- ---------------------------------------------------------------------------
-- Each of these traverses INTO via_table on a foreign key and back OUT via the row's own
-- id, so the range side is 'id' and the domain side is the FK column. action_superseded_by
-- is included even though its via_table is its own domain's table: it is a self-relation
-- read backwards ("which action supersedes X" is actions.supersedes_id -> actions.id), so
-- the domain-side gate below cannot see it and it must be corrected explicitly.
update link_types set via_from_column = v.from_col, via_column = 'id'
from (values
  ('person_sent_email',      'sender_id'),
  ('person_organizes_event', 'organizer_id'),
  ('document_has_chunk',     'document_id'),
  ('action_superseded_by',   'supersedes_id')
) as v(name, from_col)
where link_types.name = v.name;

-- ---------------------------------------------------------------------------
-- event_attendees: out of `links`, into the registry as a join table
-- ---------------------------------------------------------------------------
-- Only event_has_attendee was ever materialized (inverses are descriptors, never stored),
-- but both names are cleared so no attendee edge can survive under either.
delete from links where link_type in ('event_has_attendee','person_attends_event');

-- The two rows are NOT identical: the inverse swaps the columns, because via_from_column
-- resolves the domain and via_column the range. Seeding both as (event_id, person_id)
-- would render every person_attends_event edge backwards.
update link_types set via_kind        = 'join',
                      via_table       = 'event_attendees',
                      via_from_column = v.from_col,
                      via_column      = v.to_col
from (values
  ('event_has_attendee',   'event_id',  'person_id'),
  ('person_attends_event', 'person_id', 'event_id')
) as v(name, from_col, to_col)
where link_types.name = v.name;

-- ---------------------------------------------------------------------------
-- links.id — bigserial -> bigint generated always as identity
-- ---------------------------------------------------------------------------
alter table links alter column id drop default;
drop sequence if exists links_id_seq;
alter table links alter column id add generated always as identity;

do $advance$
declare
  seq  text;
  high bigint;
begin
  select pg_get_serial_sequence('links','id') into seq;
  select max_id into high from _0011_before;
  execute format('alter sequence %s restart with %s', seq, high + 1);
  raise notice '0011: % restarted at % (pre-migration max id)', seq, high + 1;
end
$advance$;

-- ---------------------------------------------------------------------------
-- gates — the point of this migration
-- ---------------------------------------------------------------------------
do $gate$
declare
  b        record;
  n        bigint;
  bad      text;
  probe_id bigint;
begin
  select * into b from _0011_before;

  -- links lost exactly the attendee rows, and nothing else
  select count(*) into n from links;
  if n <> b.links_count - b.attendee_links then
    raise exception '0011 gate: links = % rows, expected % (% before minus % attendee rows)',
      n, b.links_count - b.attendee_links, b.links_count, b.attendee_links;
  end if;

  -- no attendee edge survives under either name
  select count(*) into n from links
   where link_type in ('event_has_attendee','person_attends_event');
  if n <> 0 then
    raise exception '0011 gate: % attendee row(s) still in links', n;
  end if;

  -- the source table is untouched; this migration must not cost a single fact
  select count(*) into n from event_attendees;
  if n <> b.event_attendees_count then
    raise exception '0011 gate: event_attendees = % rows, was % — source data must not be touched',
      n, b.event_attendees_count;
  end if;

  -- both attendee link_types resolve through event_attendees, in opposite directions
  select string_agg(name, ', ') into bad from link_types
   where name in ('event_has_attendee','person_attends_event')
     and not (via_kind        = 'join'
              and via_table   = 'event_attendees'
              and via_from_column is not null
              and via_column      is not null);
  if bad is not null then
    raise exception '0011 gate: attendee link_type(s) not resolvable through event_attendees: %', bad;
  end if;

  select count(*) into n from link_types a join link_types b2 on b2.name = a.inverse_of
   where a.name = 'event_has_attendee'
     and a.via_from_column = b2.via_column
     and a.via_column      = b2.via_from_column;
  if n <> 1 then
    raise exception '0011 gate: attendee link_type pair does not swap its columns — one direction would traverse backwards';
  end if;

  -- domain-side invariant: an fk row may omit via_from_column only when via_table IS the
  -- domain type's own backing table. Catches a mis-seeded fk row here, not as a wrong
  -- edge at query time.
  select string_agg(lt.name, ', ') into bad
    from link_types lt
    join object_types ot on ot.name = lt.domain_type
   where lt.via_kind = 'fk'
     and lt.via_from_column is null
     and lt.via_table is distinct from ot.table_name;
  if bad is not null then
    raise exception '0011 gate: fk link_type(s) omitting via_from_column whose via_table is not the domain''s own table: %', bad;
  end if;

  -- every column the registry names must actually exist on the table it names
  select string_agg(format('%s -> %s', lt.name, lt.via_table), ', ') into bad
    from link_types lt
   where lt.via_kind in ('fk','join')
     and (not exists (select 1 from information_schema.columns c
                       where c.table_schema = 'public'
                         and c.table_name   = lt.via_table
                         and c.column_name  = lt.via_column)
          or (lt.via_from_column is not null
              and not exists (select 1 from information_schema.columns c
                               where c.table_schema = 'public'
                                 and c.table_name   = lt.via_table
                                 and c.column_name  = lt.via_from_column)));
  if bad is not null then
    raise exception '0011 gate: link_type(s) naming a column that does not exist: %', bad;
  end if;

  -- identity resumes past the pre-migration high-water mark, so no freed id is reissued
  insert into links (from_type, from_id, link_type, to_type, to_id)
  values ('emails', '_0011_probe', 'email_has_to_recipient', 'people', '_0011_probe')
  returning id into probe_id;

  if probe_id <= b.max_id then
    raise exception '0011 gate: identity issued % which is not past the pre-migration max %',
      probe_id, b.max_id;
  end if;

  delete from links where from_id = '_0011_probe' and to_id = '_0011_probe';

  raise notice '0011 gate OK: links % -> % (% attendee rows removed); identity probe id % > pre-migration max %',
    b.links_count, b.links_count - b.attendee_links, b.attendee_links, probe_id, b.max_id;
end
$gate$;

commit;
