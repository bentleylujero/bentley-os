# Bentley OS — status

<!-- GENERATED 2026-10-09 17:27 UTC — run bin/status, do not hand-edit -->
- Box: `spaghettios@192.168.68.58` · `~/bentley-os`
- HEAD: `1d9de23` (dirty)
- Latest migration: `0015_drop_email_recipients.sql`
- Services: 12/12 up
<!-- END GENERATED -->

## Now
- Nothing in flight — networking session closed

## Next
- Canvas object types (not built; `object_types` has none)
- Path B: remote MCP connector (claude.ai web/phone) with OAuth; `0013` tables exist, no route consumes them (Bible §6)
- Later, Bible §6: Wolverine (fixer), M5.1 auto-execute rate limiting (deferred), Milestone 6 self-extension, local embeddings, Gmail snippet polish (cosmetic)

## Problems
- contractor/src/index.ts:26 baseUrl 172.16.30.4:4096 is dead (confirmed 2026-09-24); OpenCode delegation is likely broken until repointed to 192.168.68.58:4096 or host.docker.internal:4096
- 84 pending updates, 36 security

## Parked
- Deco DHCP reservation (04:d9:f5:f3:0a:82 → .51) — optional now host.docker.internal is in
- messages table retention policy
- opencode binds 0.0.0.0:4096, unauthenticated on LAN
- MOTD reports 216°C, probably a bogus sensor
