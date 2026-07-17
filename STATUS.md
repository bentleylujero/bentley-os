# Bentley OS — STATUS

**The 10-second front page.** What's live, where we are, what's next. For rules,
architecture, and full history, see `THE_BIBLE.md` — that's the deep reference;
this is the front door.

---

## Live state — read it from the box, don't trust a snapshot

**This file stores no live counts.** Anything the 5-min cron moves
(emails/classified/embedded/events/tasks) is *not written here* — only the
command to read it. Run `bin/session-start` at session start; its output IS
ground truth over this file, the Bible, or memory. Numbers in a doc are stale
the moment the cron ticks; commands never are.

```
# Slow-moving — changes only when WE ship. Value + check.
head:         check: git rev-parse --short HEAD
git_sync:     check: git status -sb | head -1
migrations:   check: ls supabase/migrations/ | wc -l
services_up:  check: docker compose ps --status running | tail -n +2 | wc -l

# Cron-driven — NO value stored, read live via bin/session-start.
emails:       check: SELECT count(*) FROM emails
classified:   check: SELECT count(*) FROM emails WHERE classified_at IS NOT NULL
embedded:     check: SELECT count(*) FROM emails WHERE embedded_at IS NOT NULL
actions:      check: SELECT count(*) FROM actions
events:       check: SELECT count(*) FROM calendar_events
tasks:        check: SELECT count(*) FROM tasks
```

*Normal, not a fault: `embedded` trails `emails`. Newly-synced mail waits for
the next 5-min tick, and a few token-dense bodies stay unembedded until
re-picked. A gap is expected — don't chase it.*

*When WE ship (a commit, a new service, a migration): update the slow-moving
block + the relevant section below. That's the only time this file changes.*

---

## Services (all up)

| Service | Port | Role |
|---|---|---|
| **api** | 3000 | HTTP surface — dashboard (CRT + MONITOR), ingestion, host/app metrics, OpenCode proxy, Telegram webhook, tasks CRUD |
| **postgres** | 5432 | All persisted state (ontology, audit ledger) |
| **qdrant** | 6333 | Vector index — `emails` collection, 1536-dim |
| **redis** | 6379 | Cache (unused by app yet) |
| **marionette** | 4200 | The AI brain — reasoning, classify, embed, task-enrich, action lifecycle |
| **contractor** | 4100 | Coding/build layer — real OpenCode sessions |
| **deploy** | 4000 | Build + restart + health-check + audited rollback (dispatches on `job.kind`: build/deploy + `service-restart`) |
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
| 3 | AI layer (classify, embed, grounded Q&A, auto-drain, tasks panel) | ✅ done |
| 4 | Action layer (approval-gated) | ✅ done — no open gaps |
| 5 | Earned autonomy (auto-execute low-risk tier) | 🟡 first hand `service-restart` shipped; auto-execute tier not started |
| 6 | Self-extension (system ships its own tools) | ⬜ not started |

**Command interfaces:** Telegram live (allow-listed, webhook-secret gated).
Dashboard at `spaghettios.bentleyos.me` (Clair).

---

## Next action

**Most recent ship: Mari's first homelab "hand" — `service-restart`.** An
approval-gated `service-restart` action, ridden on the M4 action lifecycle as a
new `job.kind` (NOT a parallel mechanism). Built as a sibling `runRestartJob` in
deploy (`docker compose restart <svc>` → health-poll → resolve, no build/commit/
rollback); target allow-listed to `{api, contractor, marionette}` at propose
time in marionette. Verified live end-to-end via contractor (direct API) and
marionette (real Telegram Approve tap, incl. the self-teardown edge). This is the
first hand PROVEN, not autonomy turned on — an Approve tap is still required. See
Bible §4 Milestone 5 subsection + §6/§8.

**Before that:** the **CRT dashboard + THE MONITOR** — a two-color CRT reskin of
`/` (Right Now card, Priority triage, What changed, Everything-else all
preserved) plus a sidebar MONITOR modal: host/situation feed, THE DOCK (container
berths + load), CPU digital twin (per-core die grid), core-four gauges. Real host
vitals via `apps/api/src/routes/metrics.ts` (`GET /metrics/host`, `GET /metrics/app`
over the Docker socket), behind the same Cloudflare Access "Me" gate.

**Debt on that ship:** it went out iteratively with **no isolation-test / spec
pass** — observed-working, not reviewed. Worth a deliberate review later.

**Open choices / next work:**
- **Hand #2 = `update_docs`** — BLOCKED on a generation-source call (Bible §8):
  (A) marionette regenerates prose from box state vs. (B) a deterministic box
  script templates the mechanical parts. Decide in its own session before
  building. (Ironic-but-intended: the system can't yet safely write its own docs
  — that's the whole point of hand #2.)
- **M5 proper — auto-execute the low-risk action tier** — a step ON TOP of the
  hands; the hands stay approval-gated until it lands. Not started.
- Tasks feature follow-ons: Slice B (self-email → task), Slice C (insight/help
  layer).

---

## Standing debts (not blocking, worth closing)

- **CRT/MONITOR spec review** — shipped without isolation-test; `/metrics/*`
  exposes host telemetry, gated only by Access "Me". Don't widen that boundary
  without a gate. Line-review against intent when convenient.
- **Credential rotation** — 4 secrets pasted plaintext, none rotated:
  `whisper-laptop` service token (most-repeated), Postgres password, DeepSeek
  key fragment, Postgres role. One batch-rotation session closes all.
- **Parked branch `slice1-image-rollback` (`0cf613e`)** — unmerged, unverified,
  do NOT build on it. Verifying needs a deliberate forced-failure deploy.
- **Copilot cloud agent is active** — periodically regenerates docs to stale
  snapshots (signature: terse capitalized commit msgs — "Revise"/"Update").
  Mitigation is the two-file split itself: live counts live nowhere it writes.
  Standing rule: `git fetch origin` + diff before every push.

---

*This file changes only when we ship — never on a schedule. If it needs live
numbers, run `bin/session-start`; don't paste them in here.*
