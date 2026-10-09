-- 0015_drop_email_recipients.sql
-- email_recipients is a write-dead pair table: since a5bd0fa gmail.ts writes recipients
-- straight to links (email_has_to_recipient / email_has_cc_recipient, via_kind 'links'),
-- and nothing in apps/api/src or marionette/src reads the table. Store each fact once.
--
-- Before dropping, close the gap: 4 'to' rows were written to the table only, during the
-- window after the 0010 backfill and before a5bd0fa reached prod (2026-09-22). Backfill
-- them with 0010's exact insert logic and link types, then assert nothing is uncovered.
-- The DROP has no CASCADE, so it fails if any view/FK still depends on the table.
--
-- event_attendees is NOT touched: it is live join storage for event_has_attendee and
-- person_attends_event (link_types.via_kind = 'join'), not a duplicate of links.

begin;

insert into links (from_type, from_id, link_type, to_type, to_id)
select 'emails', r.email_id::text,
       case r.kind when 'cc' then 'email_has_cc_recipient'
                   else 'email_has_to_recipient' end,
       'people', r.person_id::text
from email_recipients r
where r.kind in ('to','cc')
on conflict on constraint links_edge_key do nothing;

do $gate$
declare
  stray_kinds text;
  uncovered   bigint;
begin
  select string_agg(distinct kind, ', ') into stray_kinds
    from email_recipients where kind not in ('to','cc');
  if stray_kinds is not null then
    raise exception '0015 gate: email_recipients has unregistered kind(s): %', stray_kinds;
  end if;

  select count(*) into uncovered
    from email_recipients r
   where not exists (
     select 1 from links l
      where l.from_type = 'emails' and l.from_id = r.email_id::text
        and l.to_type   = 'people' and l.to_id   = r.person_id::text
        and l.link_type = case r.kind when 'cc' then 'email_has_cc_recipient'
                                      else 'email_has_to_recipient' end);
  if uncovered <> 0 then
    raise exception '0015 gate: % email_recipients row(s) not covered by links, rolling back', uncovered;
  end if;

  raise notice '0015 gate OK: 0 uncovered email_recipients rows';
end
$gate$;

drop table email_recipients;

commit;
