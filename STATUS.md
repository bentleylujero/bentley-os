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
documents:    check: SELECT count(*) FROM documents
doc_chunks:   check: SELECT count(*) FROM document_chunks
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
| **api** | 3000 | HTTP surface — dashboard (CRT + MONITOR), ingestion, host/app metrics, OpenCode proxy, Telegram webhook, tasks CRUD, document upload |
| **postgres** | 5432 | All persisted state (ontology, audit ledger) |
| **qdrant** | 6333 | Vector index — `emails` collection, 1536-dim |
| **redis** | 6379 | Cache (unused by app yet) |
| **marionette** | 4200 | The AI brain — reasoning, classify, embed, task-enrich, document-embed (Chonkie chunks → Qdrant), action lifecycle |
| **contractor** | 4100 | Coding/build layer — real OpenCode sessions |
| **deploy** | 4000 | Build + restart + health-check + audited rollback (dispatches on `job.kind`: build/deploy + `service-restart`) |
| **whisper** | 4300 | Self-hosted speech-to-text (`small.en` model, Vulkan GPU) |
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
| 3 | AI layer (classify, embed, grounded Q&A, auto-drain, tasks panel, document ingestion) | ✅ done |
| 4 | Action layer (approval-gated) | ✅ done — no open gaps |
| 5 | Earned autonomy (auto-execute low-risk tier) | 🟡 first hand `service-restart` shipped; auto-execute tier not started |
| 6 | Self-extension (system ships its own tools) | ⬜ not started |

**Command interfaces:** Telegram live (allow-listed, webhook-secret gated).
Dashboard at `spaghettios.bentleyos.me` (Clair).

---

## Next action

**Most recent ship: PDF extraction** (`1c90a43`). `extractText()` handles
`application/pdf` via `unpdf` (bundled serverless pdf.js, pure ESM, no native deps —
`pdf-parse` rejected for its import-time `test/data` read). Text layer only; the existing
`MIN_CHARS` guard catches scanned/image-only as a clean 415. `/embed-doc` needed no change.
Dropzone accepts and advertises `.pdf`. Verified end-to-end: real 5-page PDF -> 39642 chars
(body read back in psql, not glyph soup), text-layerless PDF -> 415, then a real work PDF on
the live public path -> 2 chunks -> both Qdrant points retrieved BY ID -> answered from
Telegram by title. **The format seam is closed for md/txt/docx/pdf; OCR is a separate later
slice.** Gotcha logged in Bible §7: Qdrant's `points_count` lags segment optimization and read
unchanged the whole time — fetch the point by id, never trust the count.

**Before that: the question-router** (`9700240`). Mari now decides what to
fetch with a model, not a keyword list. One `deepseek-v4-flash` classify per
`/think` returns `{needs_data, needs_system}`, driving both pre-fetch blocks; the
old keyword gates stay in the tree as the fallback when the router call fails, so
degraded is exactly the prior behavior and never worse. `route` (incl.
`source: router|fallback`) is written into the `marionette.think` audit payload, so
a silently-degrading router is visible in the ledger. **What forced it:** a real
document question ("what's the key promise in the chickens creative brief?") matched
no keyword, so retrieval never ran and Mari claimed blindness while holding the
answer in Qdrant — and a deliberate widening pass STILL missed 3 of 4 natural
phrasings. Structural failure, not a bad list. Verified 8/8 on a phrasing panel,
then end-to-end with `2+2` and `what have you done today?` unregressed. See Bible §4
(marionette) + §7 + §8.

**Before that: DOCX extraction** (`960116a`). `extractText()` handles DOCX via
`mammoth`; a `MIN_CHARS = 20` guard rejects empty/image-only extraction as a clean
415 for EVERY format — which also pre-solves scanned PDFs. Dropzone accepts and
advertises `.docx`. Verified with a real work document on the live path: 2287 chars
→ `documents` row → 5 Chonkie chunks → Qdrant, both downstream effects checked in
Postgres rather than trusting the route's 201.

**Before that: the ambient tier — ingestion staleness in `/think`** (`465d8d9`).
Mari now always knows how fresh her data is. `marionette/src/ingest-sight.ts` reads
`sync_state` on EVERY `/think` — no keyword gate, that is what "ambient" means — and
injects one line: `INGESTION: gmail 3m ago, gcal 4m ago`, flagging any source past
15 min as `(STALE)`. Injected fresh OR stale, so she can affirm data is current, not
only fail to warn. `prompt.ts` tells her to say so plainly rather than answer over
stale data — and its false "your ontology is empty" opener was corrected in the same
commit. **This closes the silent-ingestion hole** that let ingestion die for 3d 8h
with `/health` green. Split into a DB read + a PURE formatter (`now` passed in), which
is what made the stale path testable without writing to production `sync_state`.
Isolation-tested four ways, deployed job `daf7719e` (`deploy.succeeded`), file verified
inside the running container. See Bible §4 ambient-sight subsection + the new §7 lessons.

**Before that: documents made retrievable** (`a25074d`). `retrieve.ts` had hardcoded
`QDRANT_COLLECTION = 'emails'`, so the `documents` collection was write-only — indexed
for weeks, never read. Now both collections are searched in parallel and merged by score.

**Before that: document ingestion (`1eef3dc` + `d8342f7`).** The first
long-form RAG source. api `POST /documents` (multipart, `extractText()` md/txt
seam — DOCX/PDF → clean 415, the deferred follow-on) writes a `documents` row;
a dashboard dropzone at the bottom of the Right Now card uploads with no reload;
the 5-min cron drains marionette `/embed-doc` (limit 50) each tick. Marionette
`/embed-doc` chunks each doc via Chonkie `RecursiveChunker` (512-token) → shared
`embedText()` → Qdrant `documents` collection, migration `0008` (`documents` +
`document_chunks`). Deployed via audited `POST /deploy` (job `100e39e3`,
`deploy.succeeded`); verified end-to-end with both downstream effects checked
directly (`documents.embedded_at` timestamp + Qdrant point count), not the drain's
own report. See Bible §4 document-ingestion subsection + §6/§8.

**Before that: Mari's first homelab "hand" — `service-restart`** (`12b0211`). An
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
over the Docker socket), behind the same Cloudflare Access "Me" gate. **Debt:** it
went out iteratively with **no isolation-test / spec pass** — observed-working, not
reviewed. Worth a deliberate review later.

**Open choices / next work:**
- **Hand #2 = `update_docs`** — BLOCKED on a generation-source call (Bible §8):
  (A) marionette regenerates prose from box state vs. (B) a deterministic box
  script templates the mechanical parts. Decide in its own session before
  building. (Ironic-but-intended: the system can't yet safely write its own docs
  — that's the whole point of hand #2.)
- **M5 proper — auto-execute the low-risk action tier** — a step ON TOP of the
  hands; the hands stay approval-gated until it lands. Not started.
- **OCR for scanned PDFs** — deferred, not started. md/txt/docx/pdf all ship
  (`960116a` + `1c90a43`); a scanned PDF is a loud 415, not a silent empty row.
  Tesseract means a ~200MB+ binary in the api image — only worth it if scanned
  documents actually show up.
- **Conversation memory** — migration `0009`, `messages` table keyed on an OPTIONAL
  `conversation_id` (absent = stateless, byte-identical to today). Window capped by
  CHARS not turns. Store user text + Mari's `message`, never `reasoning`. Last,
  because it is the only item needing a migration and the only one that can regress
  existing behavior.
- Tasks feature follow-ons: Slice B (self-email → task), Slice C (insight/help
  layer).

---

## Standing debts (not blocking, worth closing)

- **CRT/MONITOR spec review** — shipped without isolation-test; `/metrics/*`
  exposes host telemetry, gated only by Access "Me". Don't widen that boundary
  without a gate. Line-review against intent when convenient.
- **Credential rotation — DONE.** Postgres password, DeepSeek API key, and the
  whisper Cloudflare service token (now `whisper-laptop-2`) were all rotated in
  prior sessions; old values revoked. Remaining nit: move the Hammerspoon client
  credentials out of plaintext `whisper_secrets.lua` into macOS Keychain.
- **Parked branch `slice1-image-rollback` (`0cf613e`)** — unmerged, unverified,
  do NOT build on it. Verifying needs a deliberate forced-failure deploy.
- **Copilot cloud agent — DISABLED 2026-07-20.** No longer a standing debt. It had
  periodically regenerated docs to stale snapshots (signature: terse capitalized
  commit msgs — "Revise"/"Update"); the two-file split remains good practice
  regardless. `git fetch origin` before a push is now normal hygiene, not a
  bot-defense rule.

---

*This file changes only when we ship — never on a schedule. If it needs live
numbers, run `bin/session-start`; don't paste them in here.*
