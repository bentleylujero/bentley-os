# Bentley OS — status

<!-- GENERATED 2026-08-24 22:55 UTC — run bin/status, do not hand-edit -->
- Box: `spaghettios@192.168.68.51` · `~/bentley-os`
- HEAD: `dbd9850` (dirty)
- Latest migration: `0009_messages.sql`
- Services: 12/12 up
<!-- END GENERATED -->

## Now
- Nothing in flight — networking session closed

## Next
- `0010` BFO registry: object_types, link_types, links + backfill (2043 rows: 2011 email_recipients + 32 event_attendees)
- `0011` Canvas object types
- `0012` drop pair tables (write-only: gmail.ts:164,174 gcal.ts:134,142)
- Bible surgery: delete §4/§6/§8, point to STATUS.md

## Problems
- contractor/src/index.ts:26 hardcoded 172.16.30.4:4096 → host.docker.internal:4096 (silently broken)
- THE_BIBLE.md has 7 stale 172.16.30.4 refs + obsolete cloudflared LAN-IP rule
- 84 pending updates, 36 security

## Parked
- Deco DHCP reservation (04:d9:f5:f3:0a:82 → .51) — optional now host.docker.internal is in
- messages table retention policy
- opencode binds 0.0.0.0:4096, unauthenticated on LAN
- MOTD reports 216°C, probably a bogus sensor
