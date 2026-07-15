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
head:         5ab35ad   check: git rev-parse --short HEAD
migrations:   7         check: ls supabase/migrations/ | wc -l
services_up:  12        check: docker compose ps --status running | tail -n +2 | wc -l
emails:       <EMAILS>      check: SELECT count(*) FROM emails
classified:   <CLASSIFIED>  check: SELECT count(*) FROM emails WHERE classified_at IS NOT NULL
embedded:     <EMBEDDED>    check: SELECT count(*) FROM emails WHERE embedded_at IS NOT NULL
actions:      <ACTIONS>     check: SELECT count(*) FROM actions
events:       <EVENTS>      check: SELECT count(*) FROM calendar_events
tasks:        <TASKS>       check: SELECT count(*) FROM tasks
```

*Drift note: `classified` and `embedded` move on their own — the 5-min cron
auto-drains new mail. A gap between `emails` and `embedded` is normal: newly-synced
mail awaits the next tick, and a few token-dense bodies that 400'd stay unembedded
until re-picked. Not a fault. `tasks` also moves as the owner adds/completes them;
the same cron enriches new tasks (`reason`/`category`) without touching priority.*

---

## Services (all up)

| Service | Port | Role |
|---|---|---|
| **api** | 3000 | HTTP surface — dashboard, ingestion, OpenCode proxy, Telegram webhook, tasks CRUD |
| **postgres** | 5432 | All persisted state (ontology, audit ledger) |
| **qdrant** | 6333 | Vector index — `emails` collection, 1536-dim |
| **redis** | 6379 | Cache (unused by app yet) |
| **marionette** | 4200 | The AI brain — reasoning, classify, embed, enrich-task, action lifecycle |
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
| 3 | AI layer (classify, embed, grounded Q&A, auto-drain, **tasks panel**) | ✅ done |
| 4 | Action layer (approval-gated) | ✅ done — no open gaps |
| 5 | Earned autonomy (auto-execute low-risk tier) | ⬜ unblocked, not started |
| 6 | Self-extension (system ships its own tools) | ⬜ not started |

**Command interfaces:** Telegram is live (allow-listed, webhook-secret gated).
Dashboard at `spaghettios.bentleyos.me`.

---

## Next action

**M3 is done — M5 (earned autonomy) is next.** The final M3 piece, originally
scoped as a "morning brief," was redefined with the owner into a **live
responsibilities panel** and shipped: the dashboard's "Right Now" card
(tasks + think-first email + upcoming calendar) plus a collapsed "Everything
else" section. Manual task creation with owner-set priority (high/med/low) and
AI-added insight (`reason`/`category`) via the enrich cron.

**Slice A (manual tasks) is complete.** Still open within the tasks feature,
deferred deliberately: **Slice B** (self-email → task) and **Slice C**
(insight/help layer). Neither is started.

M5 opens the auto-execute low-risk tier, reusing the M4 action gate. See
THE_BIBLE §6.

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
