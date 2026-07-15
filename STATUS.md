# Bentley OS — STATUS

**The 10-second front page.** What's live right now, where we are, what's next.
For rules, architecture, and full history, see `THE_BIBLE.md` — that's the deep
reference; this is the front door. When they conflict on *current state*, trust
whichever was regenerated from the box more recently (see the header below).

---

## Machine-checkable header

*These fields are verifiable against the box. A `bin/session-start` script can
diff each `check:` line and flag drift. Regenerate this block from repo + DB
state at every checkpoint — never hand-edit it stale.*

```
generated_at: 2026-07-15
head:         6b3ff2b   check: git rev-parse --short HEAD
migrations:   6         check: ls supabase/migrations/ | wc -l
services_up:  12        check: docker compose ps --status running | tail -n +2 | wc -l
emails:       869       check: SELECT count(*) FROM emails
classified:   869       check: SELECT count(*) FROM emails WHERE classified_at IS NOT NULL
embedded:     822       check: SELECT count(*) FROM emails WHERE embedded_at IS NOT NULL
actions:      10        check: SELECT count(*) FROM actions
events:       1542      check: SELECT count(*) FROM calendar_events
```

*Drift note: `classified` and `embedded` move on their own — the 5-min cron
auto-drains new mail. state. A gap between `emails` and `embedded` (822/869 here) is
normal: newly-synced mail awaits the next tick, and a few token-dense bodies
that 400'd stay unembedded until re-picked. Not a fault.*

---

## Services (all up)

| Service | Port | Role |
|---|---|---|
| **api** | 3000 | HTTP surface — dashboard, ingestion, OpenCode proxy, Telegram webhook |
| **postgres** | 5432 | All persisted state (ontology, audit ledger) |
| **qdrant** | 6333 | Vector index — `emails` collection, 1536-dim |
| **redis** | 6379 | Cache (unused by app yet) |
| **marionette** | 4200 | The AI brain — reasoning, classify, embed, action lifecycle |
| **contractor** | 4100 | Coding/build layer — real OpenCode sessions |
| **deploy** | 4000 | Build + health-check + audited rollback |
| **whisper** | 4300 | Self-hosted speech-to-text (`base` model) |
| **cloudflared** | — | Public tunnel (gated on api health) |
| portainer / dozzle / uptime-kuma | 9000 / 8080 / 3001 | Ops visibility |

Box: `spaghettios@172.16.30.4`, `/home/spaghettios/bentley-os`. One
`docker-compose.yml`, `backend` + `monitoring` networks.

---

## Milestones

| # | Milestone | Status |
|---|---|---|
| 0 | Clean the base | ✅ done |
| — | Orchestrator (deploy, contractor, marionette, Telegram) | ✅ done |
| 1 | Data in (Gmail + Calendar) | ✅ done |
| 2 | Insight out (dashboard: Today, What changed, Triage) | ✅ done |
| 3 | AI layer (classify, embed, grounded Q&A, auto-drain) | 🔨 **morning brief only remains** |
| 4 | Action layer (approval-gated) | ✅ done — no open gaps |
| 5 | Earned autonomy (auto-execute low-risk tier) | ⬜ unblocked, not started |
| 6 | Self-extension (system ships its own tools) | ⬜ not started |

**Command interfaces:** Telegram is live (allow-listed, webhook-secret gated).
Dashboard at `spaghettios.bentleyos.me`.

---

## Next action

**M3 is one feature from done: the morning brief / live responsibilities
surface on the dashboard (Clair).** Scoped but not started — a live surface of
"what's on you right now" that routes actionable items into the existing M4
action gate. See THE_BIBLE §8 for the design notes. This is the intended nexus:
calendar + triaged email + audit, in one place, at the top of Clair.

After that, M3 closes and M5 (earned autonomy) opens.

---

## Standing debts (not blocking, worth closing)

- **Credential rotation** — 4 secrets pasted plaintext across sessions, none
  rotated: `whisper-laptop` service token (most-repeated), Postgres password,
  DeepSeek key fragment, Postgres role. A batch-rotation session closes all.
- **Parked branch `slice1-image-rollback` (`0cf613e`)** — unmerged, unverified,
  do NOT build on it. Verifying needs a deliberate forced-failure deploy.
- **Copilot cloud agent is active** — periodically reverts THE_BIBLE.md to a
  stale snapshot. Standing rule: `git fetch origin` + diff before every push.

---

*Regenerate this file from the box at each checkpoint. It's only ground truth
if it's kept fresh — same discipline as THE_BIBLE.md.*
