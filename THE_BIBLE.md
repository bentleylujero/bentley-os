# Bentley OS — The Bible
after the github copilot curfuffle
*The reference doc: rules, architecture, project map, lessons, and the deep "why"
narrative. When this conflicts with anything older, this wins.*

> **Read this first — the two-file split.**
> - **`STATUS.md`** (repo root) is the front door: the machine-checkable header (HEAD,
>   migration count, live row counts, services up), plus a thin "where we are / what's
>   next". It is regenerated from the box by **`bin/session-start`** — never hand-typed.
>   **All live counts live there, nowhere else.**
> - **This file** is the reference: rules (§2), system map (§3), lessons (§7), guardrails
>   (§9), and the milestone narrative. It carries **no live counts** — where a number
>   would go, it says "(see STATUS header)". Regenerate it only when a **rule or decision**
>   changes, not when a count moves.
>
> **The drift test for where a line belongs:** *does it change when the 5-min cron runs?*
> Yes → STATUS.md. No → here. (This split exists because the docs kept drifting: counts
> got hand-typed and rotted, and the Copilot cloud agent periodically regenerates docs to
> a stale snapshot — see §8. Facts a human never types can't rot.)
>
> **At session start:** run `bin/session-start` on the box and paste its header block.
> That, not this file and not memory, is ground truth for current counts/HEAD.

*Last structural verification: 2026-07-22, against HEAD `056fb97` (prior: 2026-07-21 at
`9700240`). Milestone state: M0–M4
complete (M4 clean, no open gaps — gate slice, Task A, Task B all shipped; both self-deploy
and root-owned-git-object gaps resolved). M3 extended with the document-ingestion pipeline
(marionette `1eef3dc` + api `d8342f7`, live), then DOCX extraction (`960116a`) and the
question-router replacing both keyword gates (`9700240`) — PDF extraction the deferred follow-on.
M5's first hand `service-restart` shipped (`12b0211`) and second hand `update_docs` shipped
(`dd4d594`); `/think` reached the action lifecycle via the `propose` decision kind (`056fb97`);
auto-execute tier not started. See §4/§6
for detail and §8 for the resolved-gap history.*

---

## 0. North Star (the destination, not the current state)

**One-sentence vision:** a personal, self-hosted data hub with an AI layer on top that
unifies my digital life (starting with Gmail + Calendar), derives insight from it, and —
increasingly on its own — classifies, briefs, and acts on my behalf, all commanded from a
single web dashboard (`bentleyos.me`) **and now also from Telegram**.

**Three principles that don't bend:**
1. **Host locally by default.** Everything runs on my box except the AI models themselves
   (API-only, no local inference — for now). **Exception, deliberately made:** whisper
   speech-to-text runs locally on the box (`whisper.cpp`), not via an API — a self-hosted
   model was the right call here since it's a small, well-understood model with no need for
   frontier quality, and local hosting avoids sending voice audio to a third party.
2. **One source of truth.** Every fact lives once, attached to the right object, related
   through typed links. No shadow tables, no duplicated state.
3. **Autonomy is earned, not assumed.** The path is guardrail-first: suggest → approve →
   auto, loosened deliberately, never by accident. **Exception, deliberately made:** inside
   the sandbox zone (contractor/OpenCode), autonomy over the filesystem and build actions is
   full by design — Bentley doesn't use OpenCode interactively, so there's no
   human-in-the-loop value to preserve there. Guardrail-first applies to the *production*
   zone and to anything touching the outside world (see §9). **Adding a new *interface* to
   existing sandbox capability (e.g. Telegram) is not a loosening of autonomy** — it's a new
   client of `marionette`'s already-scoped `/think` → `delegate` → contractor path, gated by
   its own allow-list. It does not grant any new capability marionette didn't already have.

**North-star sequencing:** data in (Gmail + Calendar) → insight out (real dashboard) → AI
layer (classify, brief, grounded Q&A) → action layer (approval-gated) → earned autonomy
(low-risk auto) → self-extension (system ships its own tools). **Command interfaces
(Telegram, eventually the web dashboard) are orthogonal to this sequencing** — they're just
new front doors to whatever marionette can already do at any given milestone.

---

## 1. Operating rules (how we work together)

**The most important fact:** Bentley runs everything on the server; Claude cannot. No
network access to the box (private LAN, `172.16.30.4`). The loop:
1. Claude gives exact, copy-pasteable commands or files.
2. Bentley runs them (SSH or browser terminal at `ssh.bentleyos.me`) and pastes back raw
   output.
3. Claude reads the actual output — never assumes it worked — and gives the next step.

**Believe the output, not the prior.** If pasted output contradicts expectation, the output
is truth. **This includes this doc's own prior claims** — the marionette→contractor
delegate path was marked "verified end-to-end" here once already, on the strength of a
trivial no-tool-call reply. It wasn't actually proven until a real multi-step task was run
and two real bugs surfaced. A "verified" claim in this doc is only as good as what was
actually tested. **Same lesson repeated during the Telegram build:** a "webhook registered"
API response from Telegram (`{"ok":true}`) said nothing about whether delivery actually
worked — `getWebhookInfo`'s `last_error_message` was the only source of truth, and even that
required a real send/receive cycle (not just a config check) to confirm the full round trip.

**Ground truth beats vision.** Ground every proposal in current state (this doc, §4). If
unsure whether something exists on the box, give the one command to check — don't assume.

**Working discipline:**
- One step at a time in the terminal. Don't dump ten commands if step 3 depends on step 2.
- Concise, code-forward. Next correct move, not essays.
- Follow the roadmap (§6). Don't skip milestones — N's "done when" must pass before N+1.
- When tempted to jump ahead, log it in Open Questions (§8) and steer back.
- Isolation-test before every commit: throwaway `docker run` to catch bugs before deploy.
- Commit at natural checkpoints; scoped messages; always `git push origin main` after.
- When something finishes, update this doc.
- **When a request will run long (real OpenCode agent work, not a trivial round-trip), give
  it real wall-clock time before concluding it's stuck.** Check `audit_log`, not stdout logs
  (services here don't log per-request) and not a short-lived test client's own timeout —
  the server-side call can still be running after the test client gives up. **Same applies
  to Docker builds:** a `docker compose up --build` can sit on "exporting to image" /
  "unpacking" for 10+ minutes on slow disk I/O with zero visible progress — check
  `docker info` responsiveness and system load before assuming the daemon is hung (see §7).
- **When a downstream response shape is assumed rather than confirmed, confirm it.** The
  first Telegram integration attempt silently failed to send replies because
  `marionette`'s `/think` response was assumed to be `{decision, message, reasoning}` at the
  top level; it's actually `{decision: {decision, message, reasoning}}`. The bug produced no
  error — `sendMessage` just sent `undefined` as text — and was only caught by directly
  curling the upstream service and diffing the real JSON against the code's assumption.
  Don't guess a response shape from a route name; hit the real endpoint and look.

**File-creation quirk:** the browser terminal has bracketed-paste issues. Short heredocs
(`cat > file << 'EOF'`) are fine. **For long files — like this one — heredoc in the browser
terminal reliably fails. Generate the file elsewhere (Claude's sandbox) and commit it via
the GitHub web UI instead** (paste into the online editor, or drag-and-drop upload to
replace the file). Don't keep retrying heredoc/scp on something this doc has already
flagged as failure-prone.

---

## 2. Non-negotiable design rules

1. **Ontology-first.** Every feature maps to an object type, a link type, or an action —
   never a parallel ad-hoc table. Flag anything (Claude's suggestions included) that
   duplicates a fact or creates shadow state.
2. **Store each fact once.**
3. **Schema changes are versioned migrations** in `supabase/migrations/` (sequential numeric
   prefix, plain SQL, e.g. `0001_secretary_ontology.sql`) — never ad-hoc production edits.
4. **Host locally; AI is API-only, except small local-model utilities like whisper.** No
   local LLM inference. Do not reintroduce a local embeddings/LLM service. Whisper (speech-
   to-text) is a deliberate, narrow exception — see §0.
5. **Autonomy is earned — except inside the sandbox, and never for external comms.** Any AI
   action capability that touches the *production* zone or the outside world ships
   approval-gated first. Never wire autonomous actions onto real Gmail without a guardrail.
   Inside the sandbox zone, contractor/OpenCode gets full filesystem/build autonomy by
   design (see §9) — but no email/messaging/external-comms tool is ever wired to contractor,
   full stop, regardless of zone. **Telegram is an inbound command interface only** — it
   lets a human (allow-listed, single user) direct marionette; it does not give marionette
   or contractor any new outbound-comms capability. The distinction is direction: a human
   messaging in is fine, marionette autonomously messaging out to arbitrary
   contacts/services is exactly what rule 5 forbids.

**Code conventions:**
- TypeScript + Hono for the API/app. Python only if genuinely unavoidable (basically never).
- Match the codebase: named Hono route exports, mounted via `routes.route('/', x)`.
- **Import extensions depend on the service** — see the strip-types lesson (§7). Compiled-TS
  services (`api`) use `.js`; strip-types services (`deploy`, `contractor`, `marionette`) use
  `.ts`.
- After any api code change: `cd ~/bentley-os && docker compose up -d --build api` (running
  container keeps serving until the new build succeeds). For known services, prefer the
  deploy service (`POST /deploy {"service":"api"}`) over raw compose. **Services outside
  `deploy`'s `SERVICE_HEALTH` map (e.g. `whisper`) must be rebuilt directly via
  `docker compose up -d --build <service>`** — there's no audited path for them yet.
- Never ship a change that could take down `/health` without saying so and giving the
  rollback.
- **Any process making outbound calls to a service that can legitimately run long (OpenCode
  agent tasks) must set an explicit timeout via `undici`'s `setGlobalDispatcher`** — Node's
  fetch default (5 min headers/body timeout) is too short and fails silently as a generic
  `fetch failed` with no diagnosable cause unless `err.cause` is explicitly captured.
- **`sed -i` syntax differs by platform.** GNU sed (the box, Ubuntu): `sed -i 's/x/y/' file`.
  BSD/macOS sed (laptop): `sed -i '' 's/x/y/' file` (empty string arg required for the
  backup-suffix parameter). Using the wrong form fails silently or errors — always confirm
  which machine you're on before reaching for `sed -i`.
- **Never assume a downstream JSON response shape — curl it directly and read the real
  keys before writing code that parses it.** See §1's Telegram lesson.
- **HTML rendered from DB fields must be escaped.** The dashboard route escapes all
  user/data-derived strings (`esc()` helper) before interpolating into the HTML template —
  email subjects/snippets and event titles are third-party content and must never be
  injected raw. Any new server-rendered view follows the same rule.

---

## 3. System map — who does what

One `docker-compose.yml`, two networks (`backend` for services, `monitoring` for ops
tooling). Every service has exactly one job. **If a new feature doesn't obviously belong to
one row, stop and decide before coding — don't let it leak into two services.**

| Service | Port | Owns | Does NOT own |
|---|---|---|---|
| **postgres** | 5432 (LAN only) | All persisted state — ontology, sync tokens, audit log | Vector search (qdrant) |
| **qdrant** | 6333 (LAN only) | Vector storage for embeddings — **two 1536-dim cosine collections: `emails` (one point per embedded email, written by `marionette/src/embed.ts`, keyed on email id) and `documents` (one point per Chonkie chunk, written by `marionette/src/embed-doc.ts`, keyed on chunk id; SEARCHED by `retrieve.ts` alongside `emails` since `a25074d` — no longer write-only; counts: see STATUS header)** (derived indexes over `emails.body` / `document_chunks.text`) | Reasoning (marionette's job); the source-of-truth body/chunk text (that stays in Postgres) |
| **redis** | 6379 (LAN only) | Caching / ephemeral state | Unused by any service yet |
| **api** | 3000 | HTTP surface: `/health`, **dashboard (`/` — server-rendered "What changed" (deltas since last look) + "Today" (today's calendar events) + recent email, reads Postgres directly via the `pg` pool)**, ingestion (gcal/gmail → Postgres, scheduled via node-cron every 5 min; **after each sync the cron also POSTs marionette `/classify` + `/embed` (limit 50 each) to auto-drain new mail — a thin forward, no reasoning in api**), OpenCode proxy (`/opencode/*`), **Telegram webhook (`/telegram/webhook`) → handles both text messages (→ marionette `/think`) AND button taps (`callback_query` → marionette `/actions/:id/approve|deny`); plus internal relay `POST /telegram/surface/:id` that pushes a proposed action to the allow-listed chat with inline Approve/Deny buttons**, **host/container metrics (`metrics.ts` — `GET /metrics/host` reads host CPU/mem/disk vitals; `GET /metrics/app` streams per-container CPU/mem via the Docker socket) feeding THE MONITOR dashboard modal** | Build/deploy logic, AI reasoning, action lifecycle state (marionette owns that) |
| **deploy** | 4000 (127.0.0.1) | Build + restart + health-check + auto-rollback for `api`, `contractor`, `marionette`; writes every action to `audit_log`. **Dispatches on `job.kind` (`'deploy'` | `'restart'`): `runJob` for build/commit/deploy+rollback, `runRestartJob` for `service-restart` (Mari's first hand — `docker compose restart <svc>` → health-poll → resolve, no build/commit/rollback; see §4)** | *What* code does — purely CI/CD operator. **Does not cover `whisper`** (see §4) |
| **contractor** | 4100 (`backend` only) | The coding/build layer. `POST /execute` — real `@opencode-ai/sdk` session + prompt against the systemd OpenCode server, audited. Full sandbox-zone autonomy (see §9) | Orchestration, ingestion, deploy |
| **marionette** | 4200 (`backend` only) | The orchestrator. `POST /think` — DeepSeek reasoning, structured decision (**response shape: `{decision: {decision, message, reasoning}}`, nested — not flat**), audited. Can `reply` or `delegate` to contractor — build-machine keystone, verified end-to-end incl. real multi-step tool-call tasks, driven live from Telegram. **Also owns conversation memory (`messages` table, read+written by `memory.ts` on every `/think` carrying a `conversation_id`) and the M4 action lifecycle: `actions` table state transitions via `POST /actions`, `GET /actions[?status=]`, `GET /actions/:id`, `POST /actions/:id/approve`, `POST /actions/:id/deny`. And `GET /audit/summary?window=<min>` — Mari's read-only "sight" over her own `audit_log`, **now consumed by `/think`**: system-status questions trigger an in-process `auditSummary(60)` read, injected into the reasoning prompt so Mari narrates real activity instead of claiming blindness** | Ingestion (api's job), deploy (deploy's job) |
| **whisper** | 4300 (`backend` only, exposed publicly via `whisper.bentleyos.me`) | Self-hosted speech-to-text. `whisper.cpp`'s `whisper-server` binary, `POST /inference` (multipart, field `file`) → `{"text": "..."}`. Currently running the `small.en` model (GPU-accelerated via Vulkan) | AI reasoning (that's marionette's job) — whisper is pure transcription, no interpretation |
| **cloudflared** | — | Public tunnel, gated on `api` health | — |
| **portainer / dozzle / uptime-kuma** | 9000 / 8080 / 3001 | Ops visibility | Nothing app-level |

**Rule of thumb:** ingestion + read APIs (incl. dashboard views) live in `api`; AI reasoning
lives in `marionette`; anything touching `docker compose` or git lives in `deploy`. Task
mentions two of these → split the ticket. **Telegram fits this rule cleanly: it's just
another HTTP surface on `api`, forwarding to marionette's existing reasoning endpoint — no
new reasoning logic was added anywhere.** **The dashboard fits it cleanly too: it's a pure
read view over Postgres in `api`, no reasoning — any future "insight" that requires
classification/generation belongs in marionette, not the dashboard route.**

**Cloudflare/networking gotcha:** `cloudflared` runs in a container on `backend`. It reaches
app services by container name (`http://api:3000`), host services (SSH) by LAN IP
(`172.16.30.4:22`). It **cannot** use `localhost` to mean the host.

**Same gotcha class:** `contractor` reaches the real systemd OpenCode server via LAN IP
`172.16.30.4:4096`, never `127.0.0.1` — a service bound to loopback only is unreachable from
any other container regardless of shared network.
---

## 3a. Ontology-bound vs. utility services

Not every service needs a typed object. The ontology rule (§2.1) governs **facts about the
owner's world** — email, calendar events, proposed actions — not services themselves.
`redis`, `portainer`, `dozzle`, `uptime-kuma`, and `deploy` already sit outside it; this
section just makes the line explicit instead of re-litigating it per tool.

**The test:** does this service **create or persist a new durable fact about the owner's
world** — something Mari should be able to reason about, query, or classify later?

- **Yes → ontology-bound.** Needs a typed object + versioned migration, same discipline as
  `emails`/`calendar_events`. New ingestion sources (documents, web pages) fall here.
- **No → utility.** It transforms, indexes, or observes data another service already owns.
  Wire it in freely — no migration, no object type required.

**The guardrail:** a utility that starts writing durable state describing the owner's world
— not just turning a request into a response — has graduated to ontology-bound and needs
the same treatment as any other fact, regardless of which container it lives in. Qdrant
storing vectors is a derived index over ontology objects (utility); a service logging "user
asked about X on date Y" as a queryable fact would not be.

**Current utility services:** `redis` (cache), `qdrant` (vector index — now populated: the
`emails` collection holds one 1536-dim vector per embedded email (derived index over
`emails.body`), and the `documents` collection holds one vector per Chonkie chunk (both collections are searched by `retrieve.ts`, `a25074d`) (derived index
over `document_chunks.text`); the bodies/chunk text stay in Postgres, the one source of truth),
`portainer` /
`dozzle` / `uptime-kuma` (ops visibility), `deploy` (build/rollback — audits *to*
`audit_log`, doesn't own a fact of its own).
---

## 4. Current state (living — what actually exists on the box right now)

Running on the box at `~/bentley-os` (Ubuntu, LAN IP `172.16.30.4`). Absolute path is
`/home/spaghettios/bentley-os` — always exact, never an alias (see §7 bind-mount lesson).

**Infrastructure — all up:** api (healthy, 3000), postgres (healthy, 5432), redis (6379),
qdrant (6333/6334 — reachable, `emails` collection (point count: see STATUS header), actively used by the embed pipeline), cloudflared, dozzle (8080),
portainer (9000/8000/9443), uptime-kuma (healthy, 3001), deploy (healthy, 4000 /
127.0.0.1), contractor (healthy, 4100, backend only), marionette (healthy, 4200, backend
only), whisper (healthy, 4300, backend only, `small.en` model, Vulkan GPU).

**No local `embedder` service exists, by design — embeddings are an external API call.**
The embeddings-provider decision is **RESOLVED = OpenAI `text-embedding-3-small`** (1536-dim,
cosine), consistent with §2.4 (API-only, no local inference). `OPENAI_API_KEY` in `.env`.
The pipeline lives in `marionette/src/embed.ts` (`POST /embed`) — see the embed subsection
below. **Local embeddings were considered and deliberately deferred:** a small local model
(BGE-M3/Jina on the box's idle AMD RX 5700 XT) would arguably fit the whisper-class exception
(small, mature, no frontier need) and keep email bodies off OpenAI's servers (privacy). But
cost is a non-argument — embedding the full backlog is ~2¢ one-time, well under $1/yr ongoing —
so the only real driver for local would be privacy, and it carries the same unfinished
ROCm/HIP GPU-setup cost parked for whisper (§8). Chose OpenAI to ship a working pipeline now;
`embedText()` in `embed.ts` is a clean single-function swap seam if privacy ever wins. See §8.

**Repo:** private, confirmed via `gh repo view`. `.env`/`client_secret.json`/`token.json`
confirmed never tracked (checked full git history for leaked values, not just current
state).

**Database (Postgres `bentley` db):** ontology schema loaded. Tables: `people`, `emails`,
`email_recipients`, `calendar_events`, `event_attendees`, `audit_log`, plus `sync_state`
(from `0002_sync_state.sql`), `actions` (from `0003_actions.sql`, M4 — see below),
`dashboard_state` (from `0004_dashboard_state.sql`, M2 "what changed" — see below), the
email-intelligence columns + partial index (from `0005_email_intelligence.sql`, `4c39435`,
M3 — `body`/`reason`/`confidence`/`classified_at` on `emails` + `idx_emails_unclassified`),
and the embedding-status column + partial index (from `0006_email_embeddings.sql`, `a46d8ce`,
M3 — `embedded_at` on `emails` + `idx_emails_unembedded`), the `tasks` object type (from
`0007_tasks.sql`, M3 — see the tasks-panel subsection below), and the document-ingestion
ontology (from `0008_documents.sql`, M3 — `documents` + `document_chunks` tables +
`idx_documents_unembedded`, see the document-ingestion subsection below), and the
conversation-memory table (from `0009_messages.sql`, `e62ff01` — `messages` +
`idx_messages_conversation`, see the conversation-memory subsection below), all applied live.
Migrations live at `supabase/migrations/` (nine files, `0001`–`0009`).
- `emails` — the Clair classifier (`marionette/src/classify.ts`) **actively writes**
  `category`, `importance`, `reason`, `confidence`, `classified_at`. Don't recreate any of
  them. Live columns confirmed via `\d emails`: `id` (uuid), `source`, `source_id`,
  `thread_id`, `sender_id` (→ people), `subject`, `snippet`, `received_at` (indexed DESC),
  `is_unread`, `category` (text), `importance` (smallint), `created_at`, `body` (text, full
  message body — added by `0005`), `reason` (text — Clair's one-line consequence),
  `confidence` (smallint — Clair's self-assessed certainty), `classified_at` (timestamptz —
  null = unclassified), `embedded_at` (timestamptz — null = not yet embedded; added by
  `0006`). Partial indexes: `idx_emails_unclassified btree (received_at DESC) WHERE
  classified_at IS NULL` (classifier work-queue, `0005`) and `idx_emails_unembedded btree
  (received_at DESC) WHERE body IS NOT NULL AND embedded_at IS NULL` (embed work-queue,
  `0006`). **All rows with a body are embedded (live counts: see STATUS header — `emails` vs `embedded`).**
  (Classification is a separate axis and was NOT advanced this session — it stands where the
  classify slices left it; the embed pipeline does not classify and vice versa.)
- `calendar_events` live columns confirmed: `id` (uuid), `source`, `source_id`, `title`,
  `description`, `location`, `starts_at` (indexed), `ends_at`, `organizer_id` (→ people),
  `status`, `created_at`, `updated_at`. `organizer_id` and `event_attendees` are now
  **populated** — see Milestone 1 status below.
- `audit_log` columns: `id` (bigint identity), `at` (timestamptz, default now()), `actor`,
  `action`, `target` (nullable), `outcome` (nullable), `payload` (jsonb, default `{}`).
  Indexes on `action` and `at DESC`. Real rows now exist from deploy activity,
  `marionette.think`, `marionette.delegate`, `marionette.classify` (Clair — one row per
  email classified, `target` = email id, `payload` = importance/category/confidence/passes),
  `marionette.embed` (one row per email embedded, `target` = email id, `payload` = model/dim;
  one success row per email embedded, from the backlog drain), `marionette.embed_doc` (one row
  per document embedded, `target` = document id, `payload` = model/dim/chunks), and
  `contractor.execute` — **including rows originating from Telegram messages**, indistinguishable in `audit_log` from any other
  `/think` caller (the audit trail doesn't currently tag which interface originated a
  request — see §8). Ingestion (gcal/gmail) does **not** currently write to `audit_log` —
  stdout only. Open item.
- **psql inside the container:** use `-h 127.0.0.1` to force TCP+password auth (peer auth
  fails on the Unix socket):
```bash
  docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c "..."
```
  **Always pass `-P pager=off`** — the container has no `less` installed, so psql's default
  pager silently breaks output display.

**Access / security:**
- `ssh.bentleyos.me` + `spaghettios.bentleyos.me` behind Cloudflare Access, policy **"Me"**
  (email = `bentley.lujero@gmail.com`).
- MFA enforced on the `ssh` app (TOTP via Apple Passwords), configured on that app's own MFA
  tab, not the global org toggle.
- Verify Access changes in **incognito** — existing sessions give false "still open"
  readings.
- **`Telegram Webhook Bypass` Access Application** — scoped to
  `spaghettios.bentleyos.me/telegram/webhook` specifically (a narrower path-level app, not a
  new subdomain), policy Action **Bypass** (not Allow — Bypass skips the auth challenge
  entirely, which is required since Telegram's webhook POST can't complete a Cloudflare
  Access login flow). Path-scoped apps take precedence over the broader hostname-level
  `Bentley OS API` app. **First creation attempt pointed at the wrong hostname
  (`tele.bentleyos.me`, a nonexistent subdomain) instead of `spaghettios.bentleyos.me` with a
  path — always screenshot/confirm the exact domain field before saving an Access app.**
  Auth for this specific endpoint is instead enforced at the application layer: a
  `secret_token` header check (Telegram's native webhook-secret mechanism) plus a
  single-user allow-list check against `TELEGRAM_ALLOWED_USER_ID`.

**Milestone 2 — "Today" dashboard slice — done, live:**
- **`apps/api/src/routes/dashboard.ts`** replaced the static status card with a
  server-rendered dashboard that reads Postgres directly via api's existing `pg` pool
  (`apps/api/src/db/pool.ts`, `pool.query(text, params)`). Two sections:
  - **Today** — today's `calendar_events`, computed in Postgres with
    `AT TIME ZONE 'America/Chicago'` (Bentley's Central tz — explicit to avoid a UTC-midnight
    bug), `starts_at` within `[today, today+1day)`, ordered ascending. Renders time + title
    (+ location if present).
  - **Recent email** — last 15 `emails` by `received_at DESC NULLS LAST`, unread-flagged with
    a blue dot. Renders time + subject + snippet.
- **All DB-derived strings escaped** via an `esc()` helper before interpolation (§2 rule —
  subjects/snippets/titles are third-party content). Time formatting via
  `toLocaleTimeString('en-US', {timeZone: 'America/Chicago'})`.
- **Graceful degradation:** both queries run in `Promise.all` inside a try/catch; a DB error
  renders a muted "couldn't load" note instead of throwing. Empty states ("Nothing on the
  calendar today." / "No emails yet.") render cleanly. Existing dark styling preserved.
- **`/health` untouched** — zero risk to the health check / tunnel gating. `routes/index.ts`
  already imports+mounts `dashboardRoute` (`./dashboard.js`, compiled-TS `.js` convention) —
  no mount change needed.
- **Isolation-tested** (throwaway `docker run` on `bentley-os_backend` + `.env`, probed
  `/health` + `/` body, confirmed real event+email rows render) **before** deploy. Deployed
  via audited `POST /deploy {"service":"api"}` (job `b3da007c`, confirmed by `deploy.succeeded`
  audit row, full enqueued→started→succeeded lifecycle, no rollback).
- **KNOWN COSMETIC GAP:** Gmail marketing snippets carry zero-width padding characters
  (`‌` etc.) that bleed into the rendered snippet. Harmless; strip/truncate in a later
  dashboard polish. Still open.
- **Commit:** `7d79632` (`feat(m2): server-rendered Today dashboard — today's events +
  recent email from Postgres`).

**Milestone 2 — "What changed" slice — done, live (M2 now COMPLETE):**
- **Same file, `apps/api/src/routes/dashboard.ts`** (full rewrite, `5955d8d`) — adds a
  **"What changed" section that renders FIRST**, above "Today", with a green count badge.
  Shows emails + calendar_events ingested since the owner last viewed the dashboard.
- **`dashboard_state` singleton** (migration `0004_dashboard_state.sql`, applied live) holds
  exactly one fact: `last_seen_at`. Single-row-enforced (`id smallint primary key default 1
  check (id = 1)`), seeded with one row via `insert ... on conflict (id) do nothing`.
  **Ontology-correct, not a shadow table** — "since *I* last looked" is a fact about the
  owner, stored server-side once (chosen deliberately over client-side/localStorage, since
  it's an owner fact not a browser fact).
- **"New" is keyed on `created_at` (ingest time), NOT `received_at`/`starts_at`** — an old
  email newly synced still counts as new to us. Queries: `emails WHERE created_at > $1` and
  `calendar_events WHERE created_at > $1` (both `LIMIT 20`, `ORDER BY created_at DESC`),
  `$1 = last_seen_at`.
- **The GET advances `last_seen_at = now()` fire-and-forget, AFTER computing the deltas** —
  so the current load shows what's new and the NEXT load resets to "nothing new". Own guard
  (`void pool.query(...).catch(()=>{})`), never blocks or sinks the response.
- **Singleton read has its own try/catch** — if it fails, `lastSeen = null`, the delta
  queries short-circuit to empty (`Promise.resolve({rows:[]})`), and the "What changed"
  section just shows the empty state while the rest of the page renders. Same
  graceful-degradation pattern as the "Today" slice. Empty-state copy: "Nothing new since
  you last looked."
- **Compact cross-day timestamp** (`fmtStamp` → "Jul 12, 2:40 PM") used in the delta feed,
  since new rows can span days; the "Today"/"Recent email" sections keep the time-only
  `fmtTime`. Same `esc()` escaping on all DB-derived strings.
- **`/health` untouched.** Change stayed in `api` → `.js` imports (`../db/pool.js`), correct
  for compiled-TS.
- **Isolation-tested** (throwaway `docker run` on `bentley-os_backend` + `.env`, probed
  `/health` + `/` body via in-container `node -e fetch(...)` — no curl in `node:22-alpine`;
  confirmed the "What changed" section renders with a real delta row) **before** deploy.
  Deployed via audited `POST /deploy {"service":"api"}` (job `63e689a8`, confirmed by
  `deploy.succeeded` audit row, full enqueued→started→succeeded lifecycle, no rollback).
  Verified live in-browser at `spaghettios.bentleyos.me` (empty state, as expected — the
  isolation test + first live load had already advanced `last_seen_at`; correct behavior).
- **Note:** the isolation test hits the *live* `dashboard_state` via `.env`, so it advances
  the real `last_seen_at` — expect "nothing new" on the first live load after any isolation
  test. Not a bug.
- **Commits:** `5955d8d` (`feat(m2): "what changed" dashboard view — deltas since last
  look`) + `b905e4b` (`migration: 0004_dashboard_state singleton for 'what changed'
  last-seen tracking` — the migration file itself, committed after the fact; it had been
  applied live by hand before being tracked).

**Milestone 3 — AI layer (read-only) — classifier + triage render both done, live:**
- **Full-body Gmail ingestion + intelligence schema** (`4c39435`, migration `0005`): `emails`
  now stores the full `body`, and the four Clair columns (`reason`/`confidence`/
  `classified_at` + reuse of existing `category`/`importance`) plus the
  `idx_emails_unclassified` partial index exist and are populated. Schema is versioned and
  reproducible (§2.3 — earlier worry that these were ad-hoc production edits was wrong; the
  migration is committed at `supabase/migrations/0005_email_intelligence.sql`).
- **Clair classifier** (`marionette/src/classify.ts`, `5d45b8d`) — the triage engine.
  Judges **CONSEQUENCE** ("what happens to the owner if this is never seen?"), NOT
  sender/topic/human-vs-automated. Reasoning lives in marionette (§9 held — the dashboard
  only reads what this writes).
  - **Two-pass:** Pass 1 judges subject+snippet only; Pass 2 re-judges against the full body
    (capped 4000 chars) **only when** Pass-1 confidence < 60 OR importance ≥ 70 (high stakes
    earns a second look) AND a body exists. Uncertainty triggers MORE scrutiny, never silent
    demotion.
  - Writes `importance` (0–100 consequence score), `category` (exactly one of
    action/financial/personal/work/newsletter/receipt/other), `reason` (one-line concrete
    consequence — the whole point), `confidence` (0–100), `classified_at`. All coerced/clamped
    server-side (`coerce()`), category falls back to `other` if the model invents one.
  - **`POST /classify {"limit":N}`** (default 20) — batch endpoint in `marionette/src/index.ts`,
    consumes the `classified_at IS NULL` work-queue newest-first. **Each email audits
    independently** (`marionette.classify`, success/error per row) — one bad email can't sink
    the batch. Confirmed clean at batch size 50 (50/50 ok, 0 err, no timeout).
 - **Live data:** classification backlog fully drained (all emails classified; live counts in STATUS header). The auto-drain cron re-runs classify + embed every 5 min, so counts move on their own — always read STATUS, never a number pasted here.
    Tier spread over the classified set: ~3 high (≥70) / ~11 mid (40–69) / rest noise (<40),
    with natural score gaps at the 70 and 40 boundaries (cutoffs are robust — nothing sits at
    66–69 or 31–39). Top items correctly float up: GitHub token-expiry (90), Google security
    alert (85).
- **Priority-triage dashboard section** (`apps/api/src/routes/dashboard.ts`, `532493a`) —
  pure read-only render in **api** (§9 — no reasoning in the dashboard route). New "Priority
  triage" section between "What changed" and "Today". Three tiers keyed on `importance`:
  **Think about first (≥70, red chip) / Peripheral (40–69, amber) / Noise (<40, grey)**. Each
  row leads with **reason as the headline**, score chip on the left, category tag + subject as
  the sub-line — every DB string `esc()`-escaped. Empty tiers omitted; heading shows
  "N to act on" when the high tier is non-empty. Same `dbError` graceful-degradation guard as
  the sibling sections (one shared try/catch, triage query folded into the existing
  `Promise.all`). `/health` untouched.
  - **Isolation-tested** (`docker build -t api-triage-test apps/api` — context is `apps/api/`
    not repo root, §7; throwaway `docker run` on `bentley-os_backend` + `.env`, probed
    `/health` + `/` via in-container `node -e fetch`, confirmed real reason string renders in
    the high tier) **before** deploy.
  - **Deployed** via audited `POST /deploy {"service":"api"}` — **accidentally fired twice**
    (jobs `7b98f464` + `10eab659`; a garbled command line double-submitted). The deploy
    queue is serialized, so both ran back-to-back cleanly, both `deploy.succeeded`, no
    rollback. Verified live in-browser at `spaghettios.bentleyos.me`.
- **Commits:** `4c39435` (full-body ingestion + `0005`) → `5d45b8d` (Clair classifier
  `POST /classify`) → `532493a` (triage dashboard render).
- **Still open in M3:** (1) **auto-drain — DONE** (`a9e7bc1`, this session): the 5-min
  ingestion cron now POSTs marionette `/classify` (limit 50) after each sync, so new mail
  self-triages; the classify backlog also drains 50/tick until caught up. (See the auto-drain
  subsection below.) (2) **Morning brief** — not built. (3) **Grounded Q&A — DONE** (`a0ced26`,
  live and verified end-to-end against production — see the grounded Q&A subsection below).
  (4) **Snippet zero-width-padding polish** (cosmetic, carried from M2) now also applies to
  triage subjects.
  

**Milestone 3 — email embedding pipeline — done, live (full backlog embedded):**
- **Migration `0006_email_embeddings.sql`** (`a46d8ce`, applied live): adds `embedded_at
  timestamptz` to `emails` + partial index `idx_emails_unembedded (received_at DESC) WHERE
  body IS NOT NULL AND embedded_at IS NULL` — the embed work-queue index, mirroring `0005`'s
  `idx_emails_unclassified`. Embedding-status is a **fact on the email** (a column), not a
  shadow table; the vector itself lives in Qdrant (the derived index, §3a).
- **`marionette/src/embed.ts`** (`a46d8ce`, char-cap fixed in `2947a9b`) — clones
  `classify.ts` structure exactly: same `postgres(DATABASE_URL, {max:2, idle_timeout:20})`
  client, same per-row independent audit, one bad row can't sink the batch. No new npm deps —
  OpenAI and Qdrant are both plain `fetch` (same as `deepseek.ts`).
  - **`embedText(text)`** — OpenAI `POST /v1/embeddings`, model `text-embedding-3-small`,
    `OPENAI_API_KEY` from env, 60s timeout, defensive shape-check (throws unless a 1536-length
    array comes back). **This is the single swap seam** if embeddings ever go local (§8).
  - **`upsertVector(email, vector)`** — Qdrant `PUT /collections/emails/points`, point id =
    the email's uuid, light payload (`subject`/`received_at`/`sender_id`) for display/filter
    at retrieval time. **The body is NOT stored in Qdrant** — it stays in Postgres (one source
    of truth); `retrieve.ts` (next session) will SELECT it back by id.
  - **What gets embedded:** `Subject: <s>\n\n<body>` so a subject-line query still retrieves
    when the body is thin.
  - **Input cap = 8000 chars** (`MAX_INPUT_CHARS`). **Bug caught mid-drain and fixed:** the
    first cap was 24000 chars — mistaking a *char* budget for 3-small's *8192-token* limit.
    Token-dense bodies (marketing HTML, quoted threads) 400'd with "maximum context length is
    8192 tokens" on 25 of the first 200 emails. 8k chars ≈ ~2k tokens worst-case, safely
    under. Same "stakes/signal live near the top" reasoning as classify.ts's 4k cap. Those 25
    correctly audited as errors and stayed `embedded_at IS NULL`, so the retry re-picked them —
    the per-row isolation held exactly as designed. Nothing was corrupted.
- **`POST /embed {"limit":N}`** (default 20, capped 200) in `marionette/src/index.ts` —
  mirrors `/classify`, mounted between `/classify` and `/think`. Drains the
  `body IS NOT NULL AND embedded_at IS NULL` work-queue newest-first; each email audits
  independently as `marionette.embed`.
- **Qdrant `emails` collection** — created via REST PUT (size 1536, distance Cosine). Holds
  one point per embedded email after the drain (count: see STATUS header).
- **Isolation-tested** twice (throwaway `docker run` on `bentley-os_backend` + `.env`, probed
  via in-container `node -e fetch` — no curl in `node:22-slim`): first a 3-email smoke test
  (all four checks green: embed report, Qdrant point count, `embedded_at` set, audit rows),
  then the fix re-tested against a 30-batch that re-picked the previously-400ing long emails
  (30/30 ok). **Deployed** via audited `POST /deploy {"service":"marionette"}` — job
  `0df49452` (initial) + `bf991272` (char-cap fix), both confirmed by `deploy.succeeded` audit
  rows, no rollback.
- **Backlog fully drained:** every email with a body embedded (`remaining=0`), Qdrant
  `points_count` matches the embedded count exactly (live: see STATUS header). Total OpenAI cost ~2¢.
- **Still open in M3 (embed-adjacent):** (1) **embed auto-drain — DONE** (`a9e7bc1`, this
  session): the 5-min ingestion cron now auto-embeds new mail (POSTs marionette `/embed`
  limit 50 after each sync, alongside `/classify`). See the auto-drain subsection below. (2) **Grounded Q&A — DONE** (`a0ced26`): `retrieve.ts`
  (embed query → Qdrant top-k → SELECT bodies → inject as grounding via the pre-fetch
  injection pattern) + a `/think` data-question gate, live and verified end-to-end against
  production. (3) **Chunking** deferred to first long-form source (PDFs/web) — email is one vector,
  no chunk needed; `retrieve.ts` leaves a chunk-ready seam. See §8.
- **Commits:** `a46d8ce` (`feat(m3): email embedding pipeline — OpenAI 3-small -> Qdrant,
  POST /embed`) → `2947a9b` (`fix(m3): cap embed input at 8k chars`).

**Milestone 3 — document ingestion pipeline — done, live (first long-form RAG source):**
The long-form counterpart to the email embedding pipeline above — the "first long-form source"
that email's one-vector design deferred chunking to. **Email = one vector; a document = many
chunks = many vectors.** Ships in two halves: marionette embeds (`1eef3dc`), api uploads
(`d8342f7`, HEAD).
- **Migration `0008_documents.sql`** (applied live): two ontology-bound object types (§3a — docs
  are durable facts about the owner's world). `documents` — one row per uploaded file; `body` is
  the source of truth in Postgres (`id` uuid, `title`, `source` default `'upload'`, `source_id`,
  `mime`, `body`, `char_count`, `created_at`, `embedded_at` — null = not yet chunked/embedded).
  `document_chunks` — one row per Chonkie chunk, the RAG granularity unit (`document_id` FK
  ON DELETE CASCADE, `chunk_index`, `text`, `token_count`, `UNIQUE (document_id, chunk_index)`).
  Partial index `idx_documents_unembedded (created_at DESC) WHERE embedded_at IS NULL` — the embed
  work-queue, mirroring `0006`'s `idx_emails_unembedded`.
- **`marionette/src/embed-doc.ts`** (`1eef3dc`) — clones `embed.ts` structure: same
  `postgres(DATABASE_URL, {max:2, idle_timeout:20})` client, per-**document** independent audit
  (`marionette.embed_doc`), one bad document can't sink the batch.
  - **Chunking via Chonkie `RecursiveChunker`** (`@chonkiejs/core`, 512-token target, safely under
    3-small's 8191-token cap). **This is the chunker the email pipeline's §8 note left "not
    chosen" — now chosen and shipped, in TypeScript (§2 — no Python service).**
  - **Reuses the shared `embedText()` — the §8 swap seam — does NOT reimplement it.** Same OpenAI
    `text-embedding-3-small`, 1536-dim, cosine.
  - **`upsertChunkVector`** — Qdrant `PUT /collections/documents/points`, point id = the chunk
    uuid, light payload (`document_id`/`chunk_index`/`title`) for display/filter at retrieval.
    **Chunk TEXT is NOT stored in Qdrant** — it stays in Postgres (`document_chunks`, one source of
    truth); `retrieve.ts` will SELECT it back by id.
  - **All-chunks-or-none:** chunk rows upsert first (idempotent on the `(document_id, chunk_index)`
    unique constraint), then embed + Qdrant-upsert, and only after every chunk lands is
    `documents.embedded_at` stamped. A mid-document failure leaves `embedded_at` NULL, so the whole
    doc is re-picked on the next drain — nothing corrupts, nothing double-counts (verified: a
    re-run drain does not grow the point count).
  - **`POST /embed-doc {"limit":N}`** (default 20, cap 200) in `marionette/src/index.ts`, mirrors
    `/embed` — drains the `body IS NOT NULL AND embedded_at IS NULL` queue newest-first.
- **`apps/api/src/routes/documents.ts`** (`d8342f7`) — `POST /documents`, multipart, mirrors
  `tasks.ts` (§9-clean — no reasoning in api; it extracts text + writes the row, marionette embeds
  later).
  - **`extractText()` is the single content seam.** Today: `text/markdown` / `text/x-markdown` /
    `text/plain` read as real text. **Any other mime → a clean `415`** (via an `UnsupportedType`
    error mapped to 415, NOT a 500) — the deferred rejection seam for DOCX/PDF, which land here
    later (see §8). api does NO interpretation of the text (§9).
  - Writes the `documents` row only (`title`/`source='upload'`/`mime`/`body`/`char_count`,
    `embedded_at` NULL), returns `201 {document}`. Mounted in `routes/index.ts`.
- **Dashboard dropzone** (`d8342f7`, `apps/api/src/routes/dashboard.ts`) — at the bottom of the
  **Right Now** card: a dashed drop target (drag-drop + click-to-pick, `.md`/`.txt`). `uploadDoc()`
  mirrors `addTask()` — a thin multipart POST to `/documents`, prepends a "✓ <title> queued" row in
  place, **no full-page reload**. Every DB/response string `esc()`-escaped; `/health` untouched.
- **Cron drain** (`d8342f7`, `apps/api/src/ingestion/scheduler.ts`) — `runAllSyncs` now POSTs
  marionette `/embed-doc` (limit 50) after `/enrich-task`, alongside `/classify` + `/embed` +
  `/enrich-task`, on each 5-min tick. Thin HTTP forward, no reasoning in api (§9). Uploaded docs
  self-embed on the next tick; backlog drains 50/tick until caught up.
- **`.gitignore`** (`d8342f7`) — added `whisper/ggml-small.en.bin` + `whisper/jfk.wav` (large
  binaries that must never enter a commit; same `git add`-by-path discipline as §8).
- **Deployed + verified live:** api deployed via audited `POST /deploy {"service":"api"}` (job
  `100e39e3`, `deploy.succeeded`). **Verified end-to-end, downstream effects independently
  confirmed** (not the drain's own `{ok:true}` self-report): uploaded
  `philosophical_llm_finetuning_plan.md` → Postgres `documents` row → `/embed-doc` drain → 12
  Chonkie chunks → Qdrant `documents` collection, with `documents.embedded_at` flipped to a real
  timestamp AND Qdrant `points_count` = 12 both checked directly. Live chunk/doc counts: see STATUS
  header — this subsection carries none.
- **Commits:** `1eef3dc` (`feat(m3): document embedding pipeline — Chonkie chunks -> OpenAI 3-small
  -> Qdrant documents collection, POST /embed-doc`) → `d8342f7` (`feat(slice1): api document upload
  — POST /documents + dashboard dropzone + embed-doc cron drain`).
- **DOCX extraction — SHIPPED (`960116a`).** `extractText()` now handles
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document` via **`mammoth`**
  (`extractRawText({ buffer })`, buffer from `await file.arrayBuffer()`). Mammoth ships its own
  types — no `@types/` dep. Headings, paragraphs, and structure survive as readable plain text
  (verified against a real work brief, not just a synthetic fixture).
- **`MIN_CHARS = 20` empty-text guard, added in the same commit, applies to EVERY format.** A file
  that parses fine but yields no real text is silent garbage — an empty `documents` row that
  embeds to nothing. Below the floor now throws `UnsupportedType` → a clean **415** naming the
  reason ("may be empty or image-only"). This also pre-solves scanned PDFs: a PDF with no text
  layer will be rejected loudly at upload rather than entering the ontology empty. Verified both
  paths fire with distinct messages (`tiny.md` → 415 empty-text; `nope.pdf` → 415 unsupported).
- **Dropzone** (`dashboard.ts`) accepts AND advertises `.docx` — both the `accept` filter and the
  visible label were updated (the label lagged the filter by one commit; a filter that allows a
  type the label denies is a lie to the user).
- **Verified end-to-end on the live public path:** a real `.docx` dropped at
  `spaghettios.bentleyos.me` → 2287 chars extracted → `documents` row → cron tick → 5 Chonkie
  chunks → Qdrant, `embedded_at` stamped. Both downstream effects checked directly in Postgres,
  not the route's own 201.
- **PDF extraction — SHIPPED (`1c90a43`).** `extractText()` handles `application/pdf` via
  **`unpdf`** (`getDocumentProxy(bytes)` -> `extractText(pdf, { mergePages: true })`). Pure ESM,
  bundles a serverless pdf.js build, no native deps and no `test/data` filesystem quirk
  (`pdf-parse` was rejected for that). Ships its own types. **Text layer only** — a
  scanned/image-only PDF yields ~nothing and falls through the existing `MIN_CHARS` guard as a
  clean 415 naming the reason. **OCR remains a deliberately separate later slice**; the seam
  accommodates it without rework. `/embed-doc` needed NO change (it operates on `documents.body`
  regardless of how the text got there). Dropzone accepts AND advertises `.pdf`.
- **Verified end-to-end.** Isolation-tested both paths in a throwaway container on
  `bentley-os_backend`: a real 5-page arXiv PDF -> 201, 39642 chars, body confirmed readable in
  psql (`left(body,400)` — headers/authors/unicode intact, not glyph soup); a synthetic
  text-layerless PDF -> 415 empty/image-only. Deployed job `0fe3324a` (`deploy.succeeded`, no
  rollback). Live public path: a real work PDF dropped at `spaghettios.bentleyos.me` -> 577 chars
  -> `documents` row -> cron tick -> 2 Chonkie chunks -> both Qdrant points retrieved BY ID, then
  a real Telegram question routed `needs_data` and answered from it by title. **The document
  ingestion format seam is now closed for the common cases (md/txt/docx/pdf).**

**Milestone 3 — tasks panel (Slice A) — done, live (Clair responsibilities dashboard):**
This is the old "morning brief" roadmap item, redefined with the owner into a "breathing"
responsibilities panel. **M3-closing feature.**
- **New `tasks` object type** (migration `0007_tasks.sql`, applied live) — its own table, NOT
  jammed onto `emails`/`calendar_events` (§2/§3a — a task is a distinct fact about the owner's
  responsibilities). Columns: `id` (uuid), `title`, `notes`, `source` ('manual'), `source_id`,
  `status` ('open'|'done', default open), `priority` (high|medium|low), `reason`, `category`,
  `enriched_at`, `created_at`, `updated_at`. Indexes: `idx_tasks_created_at`,
  `idx_tasks_status`, `idx_tasks_unenriched (created_at DESC) WHERE enriched_at IS NULL` (the
  enrich work-queue, mirroring the classify/embed queues).
- **Owner-priority / AI-insight split (the core design fact):** the OWNER asserts `priority`
  on creation (a fact they assert, via 3 quick-pick buttons high/med/low). marionette's enrich
  pass writes ONLY `reason`/`category`/`enriched_at` and is prompt-instructed **not to judge or
  overwrite priority** (insight the AI adds, not a judgement it imposes). Proven live: a `high`
  passport task got category+reason written, `priority` stayed `high` untouched.
- **`apps/api/src/routes/tasks.ts`** — `POST /tasks` (validates priority high|medium|low,
  defaults medium; no interpretation in api — §9-clean), `GET /tasks`, `POST /tasks/:id/done`.
  Mounted in `routes/index.ts`.
- **`marionette/src/enrich-task.ts`** + `/enrich-task` route — the insight engine, mirrors
  `classify.ts`: reads `title`/`notes`/`priority` as context, writes `reason` (one-line stakes)
  + `category` (errand|communication|admin|work|personal|other) + `enriched_at`, per-row
  audited. Reasoning lives here, never in api (§9 held).
- **Enrich auto-drain:** the 5-min ingestion cron (`apps/api/src/ingestion/scheduler.ts`) POSTs
  marionette `/enrich-task` (limit 50) after each sync, alongside `/classify` + `/embed` — a
  thin HTTP forward, no reasoning in api. New tasks self-enrich on the next tick.
- **Dashboard `/` rewritten** (`apps/api/src/routes/dashboard.ts`): a **Right Now** card —
  TASKS (owner-priority bands high→med→low, ordered by explicit CASE ordinal not alpha, `reason`
  as sub-line, inline add-input + priority buttons, click-to-done) + NEEDS ATTENTION
  (think-first email, `importance >= 70`) + NEXT UP (today's upcoming events) — plus a
  collapsible **Everything else** `<details>` (peripheral email 40–69 + past events +
  what-changed). **Noise-tier email (<40) dropped from the page entirely.** ~20 lines vanilla
  JS do add-task (`POST /tasks` → prepend row in place) and mark-done (`POST /tasks/:id/done` →
  fade row out) with **no full-page reload**. All DB-derived strings `esc()`-escaped; same
  graceful-degradation try/catch as the sibling sections; `/health` untouched.
- **Live + verified:** backend deployed at `29d53d4` (owner-priority model, `deploy.succeeded`
  both marionette + api). Dashboard render deployed via api (`88df75c`/`5ab35ad`,
  `deploy.succeeded` confirmed in `audit_log`). Verified in-browser at `spaghettios.bentleyos.me`:
  a real high-priority task renders in the Right Now card. **Caveat:** the two dashboard commits
  have terse messages and may be Copilot-agent work — the panel is live and behaves, but they
  were not line-reviewed against the Slice A spec (noted in §8).
- **Still open (tasks feature, LATER slices):** Slice B (self-email → task — a classified email
  auto-proposing a task) and Slice C (insight/help layer). Neither started.
- **Commits:** `251a087` (migration `0007`) → `126e86a` (cron enrich drain) → `3c6863d`
  (`enrich-task.ts` + route) → `37d61be` (`tasks.ts` + mount) → `29d53d4` (owner-priority model)
  → `88df75c` + `5ab35ad` (dashboard rewrite).

**CRT dashboard shell + THE MONITOR (host vitals) — done, live (`c0988b1`):**
The tasks-panel `/` render (above) was reskinned into a **two-color CRT aesthetic** (phosphor
green + purple only) and a live **host/container monitoring** modal was added. Still pure
read/render in **api** — §9-clean, no reasoning; host access lives in api (backend-only
marionette can't reach the host), exactly the api-side read endpoint §8 anticipated for
"Tier 3" audit-sight.
- **Main page `/` (`apps/api/src/routes/dashboard.ts`)** — the tasks-panel structure
  SURVIVED the reskin: **Right Now** card (owner-priority tasks + think-first email `≥70` +
  today's upcoming events), **Priority triage** projection, **What changed**, and a collapsed
  **Everything else** (peripheral email 40–69 + past events + what-changed). Noise-tier email
  (<40) still dropped. All DB strings `esc()`-escaped; same graceful-degradation try/catch;
  `/health` untouched. The file is large (~709 lines after `c0988b1`, `+401/-308` over the
  prior render) — mostly inline CSS/JS for the CRT shell.
- **New route `apps/api/src/routes/metrics.ts`** — the host/container reader, mounted in
  `routes/index.ts`. Two endpoints: **`GET /metrics/host`** (host CPU%/mem/disk vitals) and
  **`GET /metrics/app`** (per-container CPU/mem, read from the Docker socket via
  `/containers/{id}/stats?stream=false`). Read-only; no state of its own (utility, §3a — it
  observes, it doesn't persist a fact about the owner's world).
- **THE MONITOR modal** — opened from the sidebar (the earlier always-on compact bar was
  removed). Sections: **Host / The Situation** feed, **THE DOCK** (containers as horizontal
  berths, cargo-fill = load, CRT hover tooltip — evolved from an earlier "THE PORT" orbiting
  ring that was replaced), **CPU Digital Twin** (per-core die grid), and **core-four vitals
  gauges**. The dashboard polls `/metrics/host` + `/metrics/app` client-side.

  - **Actions card — SHIPPED (`8810517`, `ed66e9d`).** Dashboard's M4 placeholder replaced with
  a live render of the `actions` table (`id, kind, status, intent, result, created_at`,
  `LIMIT 8`, server-rendered in the main grid alongside its sibling cards). Row shows
  timestamp, status tag, kind, `intent->>'service'`, and `result->>'reason'` when present.
  Header badge counts `status='proposed'` using the existing `.count` class — same fact as
  `metrics.ts:210`, not a second source. `.act-*` status colors added to the CRT palette
  (`act-failed` is the only non-phosphor color: `#ff6b6b`). No new table, no new endpoint,
  no marionette change. Verified: 9 rows live at `deploy.succeeded` 17:13.
- **Real data, not mocked:** an earlier iteration (`2a2328f`) shipped the host-hardware
  sections with fake data; `c0988b1` replaced it with real vitals off `/metrics/host` and
  dropped the placeholders. Confirmed in the render (`h.cpu_pct` etc. read from the endpoint).
- **NOT line-reviewed against a written spec** — this feature grew iteratively across
  `a3cd82d`→`c0988b1` (see git log). It's live and behaves, but there was no isolation-test /
  spec-conformance pass logged the way the M2/M3 slices were. Treat the render as
  "observed-working," not "verified" — re-check against the actual page if precision matters.
- **`/metrics/*` has no auth of its own** — it sits behind the same Cloudflare Access "Me"
  gate as the rest of `spaghettios.bentleyos.me`. Fine at single-user scale; note it exposes
  host telemetry, so don't widen that trust boundary without adding a gate.

**Telegram integration — done end-to-end:**
- **Bot:** `@spaghettios_bot`, created via BotFather. Token stored only in `.env`
  (`TELEGRAM_BOT_TOKEN`) — **the first-issued token was pasted in plaintext in chat and was
  rotated immediately** (same leak pattern flagged for whisper/Postgres/DeepSeek, but this
  one *was* actually rotated right away — see §8 for the ones still pending).
- **Route:** `apps/api/src/routes/telegram.ts`, mounted in `routes/index.ts` alongside
  `opencodeRoute`. `POST /telegram/webhook`:
  1. Rejects unless `x-telegram-bot-api-secret-token` header matches
     `TELEGRAM_WEBHOOK_SECRET` (env var, random 32-byte hex, generated via
     `openssl rand -hex 32`).
  2. Always returns `200 {ok:true}` to Telegram regardless of downstream outcome (Telegram
     retries aggressively on non-2xx, which isn't the desired behavior for auth/parse
     failures — same pattern would apply to any future bot-API integration).
  3. Silently drops any message where `from.id` doesn't match `TELEGRAM_ALLOWED_USER_ID`
     (env var, Bentley's numeric Telegram user ID, obtained via `@userinfobot`) — the
     single-user allow-list.
  4. Forwards `message.text` to `http://marionette:4200/think` as `{"request": text}`.
  5. Reads the response as `{decision: {decision, message, reasoning}}` (nested — confirmed
     by direct curl, see §1) and sends `decision.message` back via Telegram's `sendMessage`
     API to the original `chat.id`.
- **Env vars** (in `.env`, flow through automatically via `api`'s existing `env_file: .env`
  compose directive — no compose changes needed): `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_ID`.
- **Webhook registration:** `POST https://api.telegram.org/bot<token>/setWebhook` with
  `url: https://spaghettios.bentleyos.me/telegram/webhook` and
  `secret_token: <TELEGRAM_WEBHOOK_SECRET>`. Check delivery health any time via
  `GET https://api.telegram.org/bot<token>/getWebhookInfo` — `last_error_message` is the
  fastest signal something's broken (was `405 Method Not Allowed` when the URL initially
  pointed at the wrong hostname `bentleyos.me` instead of `spaghettios.bentleyos.me`, then
  `302 Found` once the URL was right but Cloudflare Access was still gating the path).
- **Confirmed working end-to-end with a real task**, not just a trivial reply: message sent
  from the Telegram app → `api` → `marionette` → `delegate` → `contractor` → OpenCode →
  real answer (directory listing) → reply delivered back in the Telegram app.
- **Commit:** `c97ba37` — `feat: Telegram webhook -> marionette, Access-bypassed on
  /telegram/webhook path`.

**Milestone 4 — approval-gated action layer (gate slice) — done, live:**
- **Migration `0003_actions.sql` applied live.** `actions` table — a mutable current-state
  store for proposed side-effecting operations awaiting human approval. `audit_log` remains
  the append-only ledger (`target` = the action's id); the two do not overlap in role.
  Columns: `id` (bigint identity), `kind` (text, currently only `commit_deploy`), `status`
  (text default `proposed`: `proposed|approved|executing|succeeded|failed|denied`),
  `proposed_by` (text, `marionette`), `intent` (jsonb — machine-executable, e.g.
  `{service, commit_message}`), `briefing` (text, dormant until steering lands), `result`
  (jsonb, filled on execution), `supersedes_id` (bigint, lineage — dormant), `created_at`,
  `updated_at`. Indexes on `status` and `created_at desc`.
- **Live row counts live in STATUS.md only**, regenerated by `bin/session-start`. A count in
  this file is drift by construction — never add one back.
- **`marionette/src/actions.ts`** owns all state transitions (reads Postgres directly, same
  `postgres(DATABASE_URL, {max:2, idle_timeout:20})` pattern as `audit.ts`). Lifecycle:
  `proposed → approved → executing → succeeded/failed`, or `proposed → denied`.
  - **Strict guards:** approve/deny only affect a row `where status='proposed'` — a
    double-tap / retry / race on the second call updates zero rows and reports "not
    actionable" (surfaces as HTTP 409). No double-execute.
  - **Fire-and-report:** `approveAction` flips the row to `approved`, then kicks
    `executeAction` **without awaiting it** (`void executeAction(...)`) and returns a fast
    ack. The detached execute owns its own try/catch and **always** writes a terminal
    transition — a silently-stuck `executing` row is the one failure mode this design
    forbids. The terminal-failure catch marks `failed` even if the DB write itself throws.
  - **Execute reads deploy's raw response, does not assume its shape** (§1 lesson). Terminal
    state = `succeeded` if `res.ok` else `failed`.
- **5 marionette routes** (in `marionette/src/index.ts`, mounted between `/audit/summary` and
  the action-lifecycle comment block): `POST /actions` (propose → 201), `GET /actions`
  (optional `?status=`), `GET /actions/:id`, `POST /actions/:id/approve` (→ fires execute,
  409 on non-proposed), `POST /actions/:id/deny` (→ terminal, 409 on non-proposed).
- **Telegram Approve/Deny flow** (`apps/api/src/routes/telegram.ts` — significantly expanded
  from the message-only version):
  - The webhook now handles **both** `message` updates (text → `/think`, unchanged) **and**
    `callback_query` updates (button taps). Button `callback_data` is `approve:<id>` /
    `deny:<id>`, parsed defensively; same single-user allow-list gate as messages.
  - On a tap it `answerCallbackQuery` first (clears the spinner) **before** hitting
    marionette, then POSTs `/actions/:id/approve|deny` and reports the outcome in-chat
    (incl. "already handled" on 409).
  - **`POST /telegram/surface/:id`** — internal relay: reads the action from marionette (the
    lifecycle owner), and if it's still `proposed`, pushes it to the allow-listed chat with
    an inline Approve/Deny keyboard. Optional body `{chat_id}`; defaults to the allow-listed
    user (whose chat id == user id in a DM).
- **M4 Task A — async-completion push — DONE** (`80298a4`/`8ac171c`). Previously
  `executeAction` treated deploy's 202 *accept* as terminal success; now the true-completion
  signal is surfaced. Deploy's job is polled to real finish (reading `deploy.succeeded` /
  rollback in `audit_log`, the authoritative ledger — not the 202) and a ✅/❌ is pushed to
  Telegram via a thin `api` notify endpoint (marionette can't message out itself — §9). So a
  Telegram Approve tap now gets a follow-up confirming the deploy *actually* finished
  healthy, not just that it was accepted.
- **M4 Task B — commit-half of `commit_deploy` — DONE** (`1cdd19f`). `deploy/src/runner.ts`'s
  `commitAndPush()`: fetch origin/main → divergence guard → scoped `git add <SERVICE_PATH>` →
  `git commit` (per-command `-c user.name=/-c user.email=`, no global config write) → `git push
  origin main`. Runs only when `job.commitMessage` is set; any failure aborts before build.
  `docker-compose.yml` bind-mounts Bentley's real `~/.ssh` read-only into `deploy`; Dockerfile
  adds `openssh-client`. `marionette/src/actions.ts` passes `intent.commit_message` through.
  **Verified live end-to-end** (action id=7, service=marionette): real commit `59996a1` landed
  on `origin/main`, scoped correctly to `marionette/` only, build+health succeeded. **Both prior gaps now RESOLVED: Gap 1 (self-deploy watcher stranding actions) closed by moving terminal-write + notify into `deploy`'s `resolveAction` (`0af75f0`, verified live via action id=10); Gap 2 (root-owned git objects) closed by `e54afc4`:** the deploy container now runs as non-root `node (uid 1000), matching host spaghettios`, so git writes from inside the container land with correct host ownership — verified live via object ownership on disk.
- **Commits:** `3a66aef` (propose/approve/deny/execute) + `b13c5ce` (Telegram buttons) +
  `80298a4`/`8ac171c` (Task A, async completion) + `1cdd19f` (Task B, commit+push wiring).

**Milestone 5 — first hand `service-restart` — SHIPPED, verified live (`12b0211`):**
Mari's first homelab "hand" — a `service-restart` action, ridden on the existing M4 action
lifecycle as a new `kind` (NOT a parallel mechanism, per the M5 design in §6/§8). Approval-gated
like every M4 action; this is the FIRST HAND built, not autonomy turned on — an Approve tap is
still required. The auto-execute-low-risk tier (M5 proper) is a later step ON TOP of the hands.
- **Verified end-to-end and committed at `12b0211` on origin/main**, clean tree, all services
  healthy. Verified two ways: contractor path via direct API, and marionette path via a real
  Telegram Approve tap — including the marionette self-teardown edge (a `service-restart`
  targeting `marionette` recreates the container mid-flight), which held because `deploy` owns
  the terminal write per `0af75f0`. ✅ completion push confirmed received in the Telegram app.
- **The 4 committed code changes:**
  - **`deploy/src/runner.ts`** — new **`runRestartJob(job)`**: `docker compose restart <svc>`
    → `pollHealth` → `resolveAction` + audit. **No build, no commit, no rollback** — a restart
    changes nothing on disk, so there's no last-good to roll back to; an unhealthy restart is a
    terminal `failed` + notify (human-intervention, not auto-recover). Reuses `run` / `pollHealth`
    / `audit` / `resolveAction` only. Dispatched in `pump()` by the new `job.kind` field.
    `Job` gained **`kind: 'deploy' | 'restart'`**; `enqueue` gained a `kind` param **defaulting
    to `'deploy'`** (existing deploys unaffected). The restart's `deploy.succeeded` row carries
    current HEAD as `commit` so it stays a valid `lastGoodCommit` rollback baseline for later
    build-deploys.
  - **`deploy/src/index.ts`** — `POST /deploy` reads `body.kind` → passes it to `enqueue`.
  - **`marionette/src/actions.ts`** — `executeAction` forks on `action.kind`: `service-restart`
    → POSTs `{service, kind:'restart', action_id}`; everything else → the existing
    `{service, commit_message, action_id}` path.
  - **`marionette/src/index.ts`** — `POST /actions` validates a `service-restart` target against
    the allow-list `{api, contractor, marionette}` at **propose** time (rejects e.g. `postgres`
    with 400), not only at deploy time.
- **Audit names reused** (`deploy.succeeded` / `deploy.failed`, NOT new `restart.*`) —
  deliberate; the `kind:restart` marker in the payload distinguishes restart rows from
  build-deploy rows on the same action names.
- **Invocation is human-triggered:** Mari proposes → `/telegram/surface/:id` → Approve tap →
  execute. The condition under which Mari self-proposes a restart is still deferred (row shape
  already supports it via `proposed_by`).
- **Commit:** `12b0211` (`service-restart` — Mari's first hand).

**Marionette audit-sight — read endpoint AND `/think` integration both done, live:**
- **`marionette/src/audit-read.ts`** — Mari's read-only "sight" over her own ledger. The
  read side of `audit.ts`: no new state, no shadow table, only SELECTs from `audit_log`
  (§2/§9: the one authoritative ledger). Same connection pattern as `audit.ts`.
- **`auditSummary(windowMinutes=60, recentLimit=15)`** → `{window_minutes, total,
  by_action[], recent[], failures[]}` in one call (four parallel queries: grouped counts by
  action+outcome, recent rows, failure rows, total). **Genuine failure = `outcome = 'error'`
  ONLY** — lifecycle outcomes `queued`/`running` are NOT failures (a prior `outcome <>
  'success'` filter wrongly flagged in-progress rows; that bug is fixed). `bigint id`
  coerced to a real number via `coerceRow` (postgres serializes it as a string).
- **Route:** `GET /audit/summary?window=<min>` in `marionette/src/index.ts` (mounted between
  `/health` and `/think`). Deployed live via audited `POST /deploy` (job `e44b02f7`,
  confirmed by `deploy.succeeded` row), verified on the live `bentley-os-marionette-1`
  container.
- **`/think` now consumes audit-sight — the payoff, done.** A Telegram message like "what
  have you done today?" or "anything failing?" now returns a real narrated summary of
  `audit_log` activity (deploys, think calls, action lifecycle, failures), not the old
  canned "no data" reply. **Design fork resolved: (B) pre-fetch injection**, chosen over
  (A) a tool-call loop — because `deepseek.ts`'s `callDeepSeek` hardcodes
  `response_format: json_object`, sends no `tools` array, and returns only `.content` (no
  `tool_calls` surfaced), so a tool-call loop would have meant a whole second code path and
  a second model call to reconcile with the forced-JSON decision contract. (B) is one call,
  `callDeepSeek`/`normalizeDecision` left untouched.
- **`marionette/src/system-sight.ts`** (new) — the bridge between the raw read
  (`audit-read.ts`) and the reasoning (`/think`). Two pure functions, no DB access of its
  own:
  - `isSystemStatusQuestion(request)` — a **keyword gate** (lowercased substring match
    against a hand-picked phrase list: "what have you done", "done today", "system status",
    "anything failing", "did the deploy", etc.). Conservative by design: a miss just falls
    back to the honest "I can't see that" reply — never a wrong answer, only a missed one.
    Gate does NOT fire on coding/other requests, so they're not polluted with audit noise
    (verified: "what is 2+2?" returns a plain answer).
  - `formatAuditForPrompt(summary)` — turns `auditSummary`'s structured output into a
    **compact** text block (counts by action/outcome + trimmed one-liners per recent/failure
    row, pulling only useful crumbs like `req`/`job_id`/`error` out of `payload` — NOT the
    raw jsonb, which is big and noisy).
- **`/think` wiring** (`marionette/src/index.ts`): builds a `messages` array; if
  `isSystemStatusQuestion(request)`, does an **in-process** `await auditSummary(60)` (not an
  HTTP call to its own `/audit/summary` — the function is right there in-process), formats
  it, and pushes it as a second `system` message before the user turn. **Sight-read failure
  degrades gracefully** — a `try/catch` around the fetch logs and falls through to the
  no-sight path rather than sinking the whole `/think`. `callDeepSeek(messages)` then flows
  into the unchanged `JSON.parse` → `normalizeDecision` path; status questions resolve to
  `reply`, returning before the delegate branch.
- **`prompt.ts` widened** to match the new capability (§ rule: widen the prompt with the
  capability, never ahead of it). Old blanket "you are NOT the source of truth, never
  present yourself as knowing the state of the homelab" narrowed to the owner's *data*
  (email/calendar/docs); added a `WHAT YOU CAN SEE NOW` block telling Mari she CAN observe
  her own audit ledger, and when a `SYSTEM ACTIVITY` block is present she must narrate from
  it as fact (when absent, fall back to honest limits — don't invent activity).
- **Verified end-to-end from the actual Telegram app**, not just a container probe: real
  "what have you done today?" message → narrated reply naming real timestamped events incl.
  the self-deploy that shipped this very change. Second phrasing ("anything failing?", a
  different keyword) confirmed against the production container post-deploy.
- **Commits:** `27f18b3` (`feat(marionette): /think consumes audit-sight — narrates real
  system state`) on top of `9f3f054` (`feat(marionette): audit-sight read endpoint`).

**Ambient sight — ingestion staleness in `/think` — done, live (`465d8d9`):**
The first **ambient-tier** prompt input: always injected, unconditional, tiny, no keyword
gate. Closes the silent-ingestion hole (§8) — ingestion died for 3d 8h while `/health`
stayed green and every drain reported healthy over an empty queue.
- **`marionette/src/ingest-sight.ts`** — deliberately split the way `audit-read.ts` (DB) and
  `system-sight.ts` (pure) are: `readIngestState()` is the ONLY DB touch (one indexed SELECT
  over `sync_state`, whose PK is `source` — 2 rows, in-process, no HTTP hop); 
  `formatIngestForPrompt(rows, now)` is **PURE** — `now` is passed in, which is the only
  reason the stale path is testable without mutating production `sync_state`.
- **Output is one line, per source:** `INGESTION: gmail 3m ago, gcal 4m ago` /
  `INGESTION: gmail 68m ago (STALE), gcal 4m ago`. Sources fail independently, so Mari can
  name WHICH one is dead. `EXPECTED_SOURCES = ['gmail','gcal']` drives display order and
  lets a missing row read as `never synced (STALE)`; unexpected extras are appended, never
  silently dropped. `STALE_AFTER_MIN = 15` (three missed 5-min ticks).
- **Injected whether fresh OR stale** — otherwise Mari could only fail to warn, never
  affirm that data IS current. Pushed immediately after `SYSTEM_PROMPT`, BEFORE both gated
  blocks. Read failure logs and falls through (injects nothing); never sinks `/think`.
- **`prompt.ts` widened AND corrected.** The old `PRESENT LIMITS` opener ("you have NO
  ingested data ... your ontology is empty") was false against 1000+ emails and directly
  contradicted the new line; it now says the homelab HAS the data but Mari holds none of it
  in mind, and can speak only to what a block retrieved into THIS request.
- **Isolation-tested four ways before commit** (throwaway `docker run` on `bentley-os_backend`):
  (a) `what is 2+2?` still answers `4`, unpolluted — line present is not line relevant;
  (b) `"when did my email last sync?"` answered with real minutes AND cited the INGESTION
  line in its reasoning — it matches NO keyword gate, which is what proves the injection is
  unconditional; (c) seven synthetic-row cases through the pure formatter (both fresh, one
  stale, both stale, missing row, sub-minute `<1m`, empty array -> null, and the exact 15m
  boundary), zero writes to `sync_state`; (d) bad `DATABASE_URL` -> throws in 10ms, no hang.
- **Deployed** via audited `POST /deploy {"service":"marionette"}` — job `daf7719e`,
  confirmed by the `deploy.succeeded` row, no rollback; file verified present INSIDE the
  running container afterward.
- **Design note — the three tiers.** Prompt assembly is now: **ambient** (always, tiny, no
  gate — this), **retrieved** (gated, expensive, large — audit-sight, email/document
  retrieval), **history** (last N turns, when a conversation id exists — not built).
  **Host vitals were deliberately EXCLUDED from ambient:** an HTTP hop to `api:3000` on
  every `/think` would put a cross-service dependency on the reasoning path with a hang
  risk when `api` is mid-restart. Host telemetry already surfaces on THE MONITOR.
- **Commit:** `465d8d9`.

**Conversation memory — the history tier — done, live (`e62ff01`):**
The third and last prompt tier the ambient-sight design note named (§4 ambient subsection:
ambient / retrieved / **history**). Closes the "no cross-message memory" hole (§8) — every
Telegram message used to be a cold, stateless `/think`, so "the file I just wrote" meant
nothing.
- **Migration `0009_messages.sql`** (applied live): `messages` — one row per turn. Columns:
  `id` (bigint identity), `conversation_id` (text, NOT NULL), `role` (text, CHECK
  `in ('user','assistant')`), `content` (text), `created_at`. Index
  `idx_messages_conversation (conversation_id, created_at desc)` — the read path exactly.
  **Ontology-correct, not a shadow table:** a turn in a conversation is a durable fact about
  the owner's world (§3a), stored once, and `audit_log` remains the append-only ledger — the
  two do not overlap in role (audit rows record *that* a think happened; `messages` records
  *what was said*).
- **`conversation_id` is OPTIONAL and that is the safety property.** Absent = stateless,
  byte-identical to pre-`0009` behavior. Every non-Telegram caller (direct curl, test
  scripts, contractor) is unaffected without touching a line of their code.
- **`marionette/src/memory.ts`** — deliberately split the way `ingest-sight.ts` is: DB
  functions (`readHistory`, `writeTurn`) plus a PURE formatter
  (`formatHistoryForPrompt`). Same `postgres(DATABASE_URL, {max:2, idle_timeout:20})` client
  as `audit.ts`/`actions.ts`.
  - **Window = 12 turns AND 6000 chars, whichever cap hits first.** Both, deliberately:
    a pure char cap lets one pasted wall of text evict ten short exchanges; a pure turn cap
    lets twelve long ones blow the context. Read newest-first via the index, accumulate until
    a cap trips, then `.reverse()` to chronological.
  - **Stores her `message` only — NEVER `reasoning`.** Reasoning is Mari's scratchpad; feeding
    it back would compound noise turn over turn.
- **`/think` wiring** (`marionette/src/index.ts`): reads an optional `conversation_id` off the
  body (trimmed, empty string treated as absent). History is pushed **last**, after both gated
  blocks and immediately before the user turn, so recency reads naturally to the model. Both
  turns are written **after** a successful decision, so a failed `/think` doesn't poison the
  history with an unanswered turn.
  - **Both directions degrade gracefully.** A history *read* failure logs and falls through to
    the stateless path (never sinks `/think`, same pattern as the ambient/audit-sight reads); a
    memory *write* failure logs and is swallowed (a bookkeeping failure must never fail a
    request that reasoned correctly).
  - `conversation_id` is written into the `marionette.think` audit payload, so a request's
    memory scope is visible in the ledger.
- **api stays a thin relay — the §9 call that matters here.** `apps/api/src/routes/telegram.ts`
  passes `conversation_id: String(chatId)` through and nothing else; it does not read, store,
  or assemble history. **The alternative (api owning the write) was considered and rejected:**
  every future interface — dashboard chat, voice — would reimplement memory (shadow state, §2),
  and api holding conversation state is one step from api doing context assembly, which is
  reasoning. History is an input to reasoning, so it lives with the reasoner. The Telegram
  `chat.id` is used as the conversation key: stable, already in the webhook payload, no new
  state invented to hold it.
- **Isolation-tested three ways** before commit (throwaway `docker run` on `bentley-os_backend`
  + `.env`, probed via in-container `node -e fetch`): (a) no `conversation_id` → `2+2` answered
  `4`, stateless path unregressed; (b) seed turn accepted; (c) follow-up in the same
  conversation correctly recalled the seeded fact; (d) exactly 4 rows in `messages`, alternating
  user/assistant in order. **Caveat, same class as the dashboard `last_seen_at` note:** the
  isolation container uses `.env`, so its test rows land in the LIVE `messages` table — use a
  recognizable `conversation_id` prefix and clean up after.
- **Deployed** marionette (job `7f461124`) then api (job `0576c16b`), both confirmed by
  `deploy.succeeded` rows, no rollback. **Verified live from the actual Telegram app**, not just
  a container probe: a codename asserted in one message was recalled correctly in the next, with
  the four rows confirmed in Postgres under the real chat id.
- **Commit:** `e62ff01` (`feat(0009): conversation memory — messages table + history tier in
  /think, Telegram passes chat id`).

**Whisper — self-hosted speech-to-text, done end-to-end:**
- **Server:** `~/bentley-os/whisper/Dockerfile` builds `whisper.cpp` **v1.7.6** from source
  (`ggerganov/whisper.cpp`, Vulkan backend, `GGML_VULKAN=1`, shared libs installed via
  `cmake --install`) and bundles a `ggml-*.bin` model. Currently **`ggml-small.en.bin`**
  (487MB), GPU-accelerated on the box's AMD RX 5700 XT via Vulkan/RADV — base/CPU was too
  slow, small.en on GPU runs ~1.3s for an 11s clip (~8.5x realtime). `CMD` runs
  `whisper-server -m models/ggml-small.en.bin --host 0.0.0.0 --port 4300`. **v1.7.6 is pinned
  deliberately** — master/v1.8.0+ broke the Vulkan build on bookworm (`vk::LayerSettingEXT`,
  issue #3455); do not bump without re-testing. GPU passthrough: `docker-compose.yml` whisper
  block adds `devices:` (`/dev/dri/renderD128`, `/dev/dri/card1`) + `group_add: ["44","991"]`
  (host video/render GIDs).
- **API contract (confirmed via direct testing, not assumed):** `POST /inference`,
  multipart form, field `file` (audio, wav tested at 16kHz mono), optional
  `response_format=json` → `{"text": " transcribed words\n"}`. No auth of its own — auth is
  entirely Cloudflare Access in front of it.
- **Public route:** `whisper.bentleyos.me` → `http://whisper:4300` (Cloudflare dashboard,
  token-based tunnel — no local `cloudflared` config file exists on the box; routes/policies
  live entirely in the Cloudflare dashboard, not the repo).
- **Access policies on the `whisper` app — two, both required:**
  1. `Me - Self-Hosted Apps` (renamed, ID `63930902-c6ba-4551-bd30-388383443ac0`) — email
     gate (`bentley.lujero@gmail.com`) for browser access, shared with `ssh` and
     `Bentley OS API`.
 2. **`Whisper Service Token`** (Action: **Service Auth**, Include: Service Token
     `whisper-laptop`) — added separately, specifically for the Hammerspoon client. **A
     generated service token is NOT automatically valid against an app** — it must be
     explicitly included in a Service Auth policy on that specific app, or every request
     gets bounced to the login redirect with `service_token_status:false` in the JWT meta,
     even though the token itself is valid. Confirmed the hard way: token worked fine at
     generation time, still got rejected until this policy existed.
- **Service token:** `whisper-laptop-2`, non-expiring, generated for the Hammerspoon
  push-to-talk client. **Rotated 2026-07-18** — the old `whisper-laptop` token (exposed in
  plaintext across multiple sessions) was replaced by `whisper-laptop-2` and revoked; the
  whisper app's `Whisper Service Token` policy (Action: Service Auth) now includes the new
  token. `~/.hammerspoon/whisper_secrets.lua` updated with the new Client ID/Secret. Verified
  push-to-talk end-to-end on the new token.
- **Hammerspoon client (laptop-side, NOT in this repo — lives at `~/.hammerspoon/` on
  Bentley's MacBook):**
  - `~/.hammerspoon/whisper_secrets.lua` — holds the Cloudflare Client ID/Secret, `require`d
    by `init.lua`, kept separate so the token isn't inline in logic that might get pasted
    elsewhere.
  - `~/.hammerspoon/init.lua` — push-to-talk: holding **right Command** (keycode 54, watched
    via `hs.eventtap` `flagsChanged`, distinct from left Command's keycode 55) starts an
    `hs.task` running `sox -d -r 16000 -c 1 <tmp wav>`; releasing stops the task, waits
    300ms, then `hs.task` runs `curl` against `whisper.bentleyos.me/inference`, decodes the
    JSON response, sets the pasteboard, and sends Cmd+V.
  - Requires **Accessibility** permission granted to Hammerspoon (System Settings → Privacy
    & Security) — without it, `hs.eventtap:start()` fails silently at startup with
    `Unable to create eventtap. Is Accessibility enabled?` in the Hammerspoon Console, and
    the hotkey simply never fires. No crash, no obvious error to the user — check the
    Console, not assumptions, when a Hammerspoon hotkey "does nothing."
  - `hs.task` uses absolute binary paths (`/opt/homebrew/bin/sox`, `/usr/bin/curl`) — it does
    not inherit the shell's `$PATH`.
  - Confirmed working end-to-end: hold key → speak → release → real transcribed text pasted
    at cursor.
- **GPU acceleration — DONE (Vulkan).** Box's AMD RX 5700 XT (Navi 10, gfx1010, `amdgpu`)
  now runs whisper via `whisper.cpp`'s Vulkan/RADV backend, not CPU. ROCm was ruled out
  (RDNA1/gfx1010 dropped by ROCm); Vulkan is the supported path. Confirmed on-device:
  `ggml_vulkan: 0 = AMD Radeon RX 5700 XT (RADV NAVI10)`, `using Vulkan0 backend`, full model
  weights on-card. Shipped `72dae3e`. Model bumped base → small.en with the GPU headroom.
  Further headroom exists (8GB VRAM) for medium if wanted.

**Git:** `~/bentley-os` is a git repo, `main` branch, private. Remote:
`git@github.com:bentleylujero/bentley-os.git`. GitHub username `bentleylujero`.
Local in sync with `origin/main` at `465d8d9`, working tree clean (`.claude/` now gitignored
via `9c7978a`). Confirm current HEAD/sync via `bin/session-start`,
never trust a hash pasted in this doc.
Recent commits (newest first): `e62ff01` (feat(0009): conversation memory — messages table +
history tier in /think, Telegram passes chat id) → `1c90a43` (feat(docs): PDF text extraction
via unpdf) → `9700240` (feat(marionette): question-router replaces keyword
gates — flash classify decides retrieval, keyword fallback on failure) → `960116a` (feat(docs):
DOCX text extraction via mammoth + empty-text guard at the extractText seam) → `465d8d9`
(feat(marionette): ambient ingestion-staleness in
`/think` — sync_state freshness, always injected) → `a25074d` (feat(marionette): retrieve
documents alongside emails in grounded Q&A) → `88478e7` (docs: track CLAUDE.md) → `5b49c35`
/ `36ee8ee` / `5ac9ef7` / `448fd8e` (docs: oauth root-cause, whisper token, key rotations) →
`d8342f7` (feat(slice1): api document upload — POST /documents +
dashboard dropzone + embed-doc cron drain) → `1eef3dc` (feat(m3): document embedding pipeline —
Chonkie chunks -> OpenAI 3-small -> Qdrant documents collection, POST /embed-doc) → `8a0f224` /
`5787bd2` / `a1b32f6` / `1de5d79` / `72dae3e` (whisper: Vulkan GPU build v1.7.6 + small.en model —
see the whisper subsection) → `030e2b8` / `58e4d72` / `12b0211` (feat(m5): service-restart —
Mari's first homelab hand, + STATUS) → `9c7978a` (chore: gitignore .claude/) → `f7b6819` /
`a41fa7d` (docs: regen to c0988b1 — CRT dashboard;
**Copilot-agent doc regens, see §8**) → `c0988b1` (feat(dashboard): full-screen CRT shell +
real host vitals, drop fake data — the live monitoring dashboard) → `2a2328f` (feat(monitor):
host-hardware sections — CPU per-core die grid + dual network scope + core-four gauges, fake
data) → `934db8a` (fix(monitor): THE DOCK relative-bytes cargo fill) → `c2c684f`
(feat(monitor): THE DOCK — horizontal berths, cargo-fill load, CRT hover tooltip) → `02516e2`
(fix(monitor): ring labels radial fan-out) → `f896bdd` (feat(monitor): THE PORT station ring —
containers orbit API core) → `47ca146` (feat(monitor): per-container CPU/mem via docker stats
stream) → `a3cd82d` (feat(monitor): THE MONITOR dashboard panel) → `d72cdcf` / `835e673` /
`e589a50` (**Copilot-agent STATUS/Bible regens, see §8**) → `eab7091` (prior verified HEAD) →
… → `2947a9b` (fix(m3): cap embed input at 8k chars) → `a46d8ce`
(feat(m3): email embedding pipeline — OpenAI 3-small -> Qdrant, POST /embed) → `b153b1e`
(merge: DRY_RUN-aware scoped rollback into main — the current rollback impl; supersedes the
`52c3f72` scoped-checkout described in older text, and deleted the redundant
`deploy/src/service-path.ts` since `SERVICE_PATH` already owns service→path mapping) →
`532493a` (feat(m3): priority triage dashboard section — three-tier Clair render) → `091c8e0`
(fix(docs): restore clean THE_BIBLE.md — revert web-UI scrollback corruption) → `449a9b7` +
`e06ed72` (**ROGUE — "Hello"→"Goodbye" print edits from an unidentified actor via the GitHub
web UI; see §8**) → `5d45b8d` (feat(m3): Clair classifier — POST /classify) → `4c39435`
(feat(m3): full-body gmail ingestion + migration 0005) → `79bea75` ('What changed' section) →
`b905e4b` (migration 0004) → `5955d8d` (feat(m2): "what changed") → `7cb895d` (gitignore
whisper/Dockerfile.bak) → `8ac171c` / `80298a4` (feat(m4): async deploy-completion → Telegram)
→ `7d79632` (feat(m2): Today dashboard) → `27f18b3` / `9f3f054` (feat(marionette):
audit-sight) → `b13c5ce` / `3a66aef` (feat(m4): approval gate + Telegram buttons).
(This list is current through the `d8342f7` structural verification — the document-ingestion
slice and Mari's first hand `service-restart` (`12b0211`) are both documented above. Confirm
current HEAD/sync via `bin/session-start`, never trust a hash pasted here.)

**NOTE on the rollback-fix hash:** older text in this doc (§4 deploy subsection, §8) still
refers to `52c3f72` as the rollback fix. The current impl is `b153b1e` (a `DRY_RUN=1` guard
around the scoped git-checkout, plus deletion of `deploy/src/service-path.ts`). The
`52c3f72`-era behavior — unscoped service aborts, no repo-wide checkout — still holds; only
the commit and the DRY_RUN guard are newer. The parked `slice1-image-rollback` branch
(`0cf613e`) remains unmerged/unverified, unchanged.

**Repo-integrity incident — RESOLVED.** Commits `e06ed72`, `449a9b7`, and a third occurrence
`650a7a8` (all "Hello"→"Goodbye" print-statement edits, each also reverting THE_BIBLE.md to a
stale snapshot) landed on `origin/main` via the GitHub web UI. **Root cause confirmed:**
`gh api /repos/bentleylujero/bentley-os/actions/workflows` shows an active workflow named
"Copilot cloud agent" (`dynamic/copilot-swe-agent/copilot`, created 2026-07-13). `gh api
/repos/bentleylujero/bentley-os/commits/650a7a8 --jq '.commit.verification'` confirms
`verified: true`, a real GPG signature under Bentley's identity — this is GitHub's native
Copilot coding agent, not a compromised credential, leaked token, or unknown actor. **Decision:
left enabled** (Bentley likes it) — but it will keep periodically reverting THE_BIBLE.md to
stale content when it runs. **New standing rule: `git fetch origin` + diff `origin/main`
before every push**, not just after a rejected push — treat a stale-content revert on
`origin/main` as expected background behavior of this repo now, not a fresh incident.

**Parked branch — `slice1-image-rollback` (`0cf613e`), UNMERGED / UNVERIFIED. Do NOT build
on it.** An unmerged refactor of `deploy/src/runner.ts` (88+/30−) changing rollback from
git-checkout to Docker-image-preservation. Pushed to its own origin branch, NOT on `main`,
NOT isolation-tested, NOT confirmed running. Testing it means deliberately forcing a failed
deploy — a future dedicated session. Until then, `main`'s deploy still uses the
scoped-git-checkout rollback (`52c3f72`).

**Deploy service** (`~/bentley-os/deploy/`): serialized queue, reads last-good commit from
`audit_log` → build → `up -d` → poll real `/health` over `backend` → success or
auto-rollback, every step audited. **Now dispatches on `job.kind` in `pump()`: `'deploy'`
(the build/commit/deploy + rollback flow via `runJob`) and `'restart'` (Mari's first hand
`service-restart` via `runRestartJob` — `docker compose restart` + health-poll + resolve, no
build/commit/rollback; see the Milestone 5 subsection). `enqueue`'s `kind` param defaults to
`'deploy'`, so existing deploys are unaffected.** `SERVICE_HEALTH` map covers `api`,
`contractor`, `marionette` — **not `whisper`**, which must be rebuilt directly via
`docker compose up -d --build whisper` until it's added to the map. Deploys for covered
services go through `POST /deploy` — never raw compose for those. Most recently used for the
M2 dashboard deploy (job `b3da007c`), isolation-tested first, confirmed via `audit_log`'s
`deploy.succeeded` row rather than trusting the immediate `POST /deploy` response.
- **Rollback-scope bug — RESOLVED** (`52c3f72`). Previously `git checkout <commit> -- .`
  reverted the entire repo tree. Now an unscoped/unknown service **aborts** with an audited
  `deploy.rollback.failed` row instead of running any repo-wide checkout; `SERVICE_PATH`/
  `SERVICE_HEALTH` both cover only api/contractor/marionette. Isolation-tested (bogus service
  rejected). **This unblocks Milestones 4 and 5.**

**Contractor service** (`~/bentley-os/contractor/`): the coding/build layer. `POST /execute`
runs a real `@opencode-ai/sdk` session against the systemd OpenCode server (LAN IP
`172.16.30.4:4096`), audited (`actor='contractor'`). `WORKDIR /app` (outside the bind
mount). Reached as `http://contractor:4100`. Now driven both by direct API testing and live
Telegram-originated tasks — no difference in behavior, since Telegram is purely an inbound
trigger for the same `/think` → `delegate` path.
- **`undici.setGlobalDispatcher`** set at process start: `headersTimeout`/`bodyTimeout` =
  10 min. Node's fetch default (5 min) was killing real multi-step OpenCode tasks before
  they finished — a trivial "reply with pong" prompt (no tool calls) always worked, masking
  the bug until a real file-write task was tested.
- Catch block now captures `err.cause` (not just `err.message`) into the audit payload —
  `"fetch failed"` alone gave zero diagnostic signal; `err.cause` revealed
  `HeadersTimeoutError` immediately.
- Note: `apps/api/src/routes/opencode.ts` (proxy to the real third-party systemd OpenCode
  server) was **deliberately left unrenamed** — "opencode" there is the actual tool
  (`@opencode-ai/sdk`, `opencode.json`), not this container. When the container reaches
  parity, repoint the proxy's `baseUrl` to `http://contractor:4100` in the *same* deploy that
  retires the systemd unit.

**Marionette service** (`~/bentley-os/marionette/`): the orchestrator, DeepSeek reasoning.
- `POST /think {"request":"..."}` → DeepSeek (`deepseek-v4-pro`, JSON mode) → structured
  `Decision {decision, message, reasoning}` → audited (`actor='marionette'`,
  `action='marionette.think'`) → returned. **Response envelope is
  `{"decision": {"decision": ..., "message": ..., "reasoning": ...}}`** — nested one level,
  not flat. Confirmed by direct curl against `http://marionette:4200/think` from inside the
  `backend` network; any new client (Telegram included) must read `.decision.message`, not
  `.message`.
- `delegate` branch — genuinely verified, not just claimed. `schema.ts` allowlists
  `target_service='contractor'` only (`DELEGATABLE_SERVICES = ['contractor']` — model can't
  invent a target). `index.ts` POSTs to `http://contractor:4100/execute`, audits
  `marionette.delegate`. Same `undici` timeout fix applied here (marionette's own fetch to
  contractor had no timeout override before — it would just hang indefinitely on a slow
  contractor call).
- **Confirmed end-to-end with a real task, twice now**: once via direct API testing (file
  written to disk, verified with `cat`), and again via a live Telegram-originated request
  (directory listing, delivered back through `sendMessage`).
- Failed delegation still returns 200 with the decision + error, never 502s a reasoning
  success.
- `MARIONETTE_MODEL` env var (default `deepseek-v4-pro`; set `deepseek-v4-flash` for cheap
  iteration).
- **Owns the M4 action lifecycle incl. the first hand.** `POST /actions` validates a
  `service-restart` target against the `{api, contractor, marionette}` allow-list at propose
  time; `executeAction` forks on `action.kind` (`service-restart` → `{service, kind:'restart',
  action_id}` to deploy; everything else → the existing `{service, commit_message, action_id}`
  path). See the Milestone 5 subsection (`12b0211`).
- **Can now:** narrate her own system activity. `/think` consumes audit-sight — a
  keyword-gated in-process `auditSummary(60)` read is injected into the reasoning prompt for
  system-status questions, so Mari answers "what have you done today?" / "anything failing?"
  from the real `audit_log` (see the audit-sight subsection above). This is *self*-sight over
  the ledger, NOT general memory — see the limit below.
- **Can also:** ground answers in real email AND document content. `retrieve.ts` embeds the
  question and searches BOTH Qdrant collections (`emails` + `documents`) in parallel at
  `TOP_K`=10 each, merges by score desc, truncates to `TOP_K` total, caps chunks at 2 per
  document, and reads the real text back from Postgres (`emails.body` / `document_chunks.text`)
  — never from the Qdrant payload. Gated by `isDataQuestion` in `data-gate.ts`, which also
  owns the formatter (branches on a `kind: 'email' | 'chunk'` discriminated union). A
  documents-side failure is isolated (`.catch -> []`) so email still answers. Grounded Q&A
  shipped `a0ced26`; documents added `a25074d`.
- **Can also:** always see how fresh her ingested data is — the ambient tier (`465d8d9`),
  injected on EVERY `/think` with no gate. See the ambient-sight subsection below.
- **Routing is no longer keyword-based (`9700240`).** `marionette/src/question-router.ts` runs ONE
  cheap classify pass per `/think` on **`deepseek-v4-flash`** (`MARIONETTE_ROUTER_MODEL` env,
  default flash) returning `{needs_data, needs_system}`, which drives both pre-fetch blocks.
  `callDeepSeek` gained an optional second param `modelOverride` — omitted = exactly the previous
  behavior, so every existing caller is unaffected. The router NEVER sees retrieved content and
  writes nothing; it is a routing decision, not a reasoning one.
  - **The keyword gates (`isDataQuestion`, `isSystemStatusQuestion`) REMAIN IN THE TREE as the
    fallback.** `routeQuestion` returns `null` on any failure (network, timeout, unparseable JSON,
    a JSON object carrying neither key) and `/think` degrades to the old gates. Degraded is
    exactly today's prior behavior — never worse than before the router existed.
  - **`route` is written into the `marionette.think` audit payload**, including
    `source: 'router' | 'fallback'`, so a silently-degrading router is visible in the ledger
    instead of quietly reverting to blunt matching.
  - **Booleans are coerced** (`coerceBool`) — a model returning `"true"`, `1`, or `null` must never
    become a truthy object.
  - **Verified 8/8** on a phrasing panel in isolation (three document questions the keyword gate
    missed, two system questions, math, a coding request, and a bare greeting), then end-to-end:
    the exact question that failed pre-router now returns the real Key Promise line cited by
    document title and chunk index, with `2+2` and `what have you done today?` both unregressed.
- **Can also:** remember the conversation. `memory.ts` reads the last 12 turns / 6000 chars of
  a `conversation_id` and injects them as the history tier immediately before the user turn,
  then writes both turns after a successful decision (`e62ff01`). Telegram supplies the chat id,
  so "the file I just wrote" now resolves. Absent a `conversation_id`, `/think` is stateless
  exactly as before.
- **Still cannot:** carry memory ACROSS conversations — history is scoped to one
  `conversation_id`, so a second interface (or a different chat) starts cold; nothing summarizes
  or promotes an old conversation into long-term recall. No delegation targets beyond contractor, no *autonomous* production-zone write
  actions — the M4 approval-gate layer IS built (propose→approve→deny→execute + Telegram
  buttons, see M4 subsection) and the first hand `service-restart` ships on it (`12b0211`),
  but contractor's own writes remain sandbox-only and nothing auto-commits/auto-deploys/
  auto-restarts from a delegated task without the human approval tap.

**OpenCode permission policy** (`~/bentley-os/opencode.json`) — **decided and live**:
- Bentley doesn't use OpenCode interactively; only marionette/contractor call it, always
  headlessly via the API.
- **`"ask"` must never appear anywhere in this config.** It means "pause and show a
  confirmation prompt in the attached terminal" — headless API calls have no terminal to
  answer it, so `"ask"` doesn't degrade gracefully, it hangs indefinitely (confirmed: a
  file-write to `/tmp` hung for the full 10-minute timeout before `external_directory`'s
  default `"ask"` was identified as the cause and changed to `"allow"`).
- Current policy: `"*": "allow"`, `external_directory: "allow"`, `doom_loop: "allow"` — full
  build/filesystem autonomy, matching the sandbox-zone design (§0, §9). `bash` allows
  everything except a short deny-list of catastrophic `rm -rf` patterns
  (`rm -rf /`, `rm -rf ~`, `rm -rf /home*`, etc.) — cheap insurance against accidental
  deletion, acknowledged as a low-probability event.
- No email/messaging/external-comms tool exists in OpenCode's default toolset, so external
  comms are blocked by omission today. **If an MCP connector for email/messaging is ever
  wired to contractor, it must ship behind an explicit deny in this policy — never rely on
  omission again once the capability exists.** This includes Telegram itself — contractor
  has no Telegram-sending capability of its own; only the `api` route's `sendMessage` call
  (a fixed, single-recipient reply-to-sender mechanism, not a general messaging tool) exists.
- Config is loaded at OpenCode startup, not per-request — `sudo systemctl restart opencode`
  required after any change to this file.

**Ingestion — scheduled, running in prod:**
- `apps/api/src/ingestion/scheduler.ts`: `node-cron` job, every 5 minutes, runs
  `runGcalSync()` then `runGmailSync()` sequentially, guarded against overlap with a
  `running` flag.
- OAuth secrets (`client_secret.json`, `token.json`) bind-mounted read-only into the live
  `api` container at `/secrets/` (exact absolute host path, per §7 bind-mount lesson).
- **OAuth token lifecycle (learned the hard way, 2026-07-20).** The Google client is an
  `installed` (Desktop) client, `redirect_uris: ['http://localhost']`, scopes
  `calendar.readonly` + `contacts.readonly` + `gmail.readonly`. **Nothing writes refreshed
  tokens back** — the mount is read-only and refresh happens in-memory per process, so
  `token.json`'s `expiry_date` is frozen at mint time and is **NOT a health signal**. The
  only true ingestion-health signal is `sync_state.updated_at` (see §8's silent-failure
  item). **There is no auth/mint script in the repo** — `token.json` was minted out-of-band;
  the re-mint recipe lives in §8.
- Confirmed live: first tick after deploy ran clean, both syncs incremental
  (`fetched: 0, upserted: 0` — correct, since the isolation test had just consumed the
  delta). The M2 dashboard reads the rows this cron lands.

**Milestone 1 gap — resolved.** `event_attendees` and `organizer_id` population is
**verified live** (organizer_id populated on real rows, event_attendees confirmed via a
real test event). Milestone 1 is complete; see §6.

**Milestone 5 — second hand `update_docs` — SHIPPED, verified live (`dd4d594`).**
Mari's second homelab hand, and the resolution of the long-open generation-source fork (§8).
The fork as written — (A) marionette regenerates prose vs (B) a deterministic box script — was
rejected on both horns. (A) reproduces the exact failure the Copilot cloud agent already caused
(wholesale regen silently deleting hard-won detail); (B) can't touch the narrative, so it
duplicates `bin/session-start` and isn't worth a hand. **Decided: append-only.** Mari never
rewrites existing prose — she emits `{section, markdown}` blocks, deploy inserts them above a
sentinel, and a line-conservation guard aborts the entire job if any pre-existing line would be
lost. Deletion is structurally impossible, not merely discouraged. Corrections to wrong existing
prose stay human — a deliberate trade.
- **Anchors:** HTML-comment append sentinels (`MARI` + `:APPEND` + section) in `THE_BIBLE.md` (§4/§7/§8) and `STATUS.md`
  (NEXT). Mari names a section, never a line number.
- **`deploy/src/runner.ts`** — new `runDocsJob(job)` + `DocsBlock` + `DOC_SENTINELS`. Validates
  every block before touching a file, applies in memory, runs the guard (file must grow AND every
  non-blank pre-existing line must still be present), then fetch/divergence-guard → write →
  scoped `git add THE_BIBLE.md STATUS.md` → commit → push. **No build, no health poll, no
  rollback** — markdown can't affect a running service, and any failure aborts BEFORE the commit.
- **`docs` pseudo-service** added to `SERVICE_HEALTH` with a `null` health URL (the type already
  allowed it), solely to pass `enqueue`'s existing gate — zero logic changes. Deliberately NOT in
  `SERVICE_PATH`; docs jobs scope their own add.
- **`Job.kind`** widened to `'deploy' | 'restart' | 'docs'`; `pump()` dispatches on it. `enqueue`
  gained an optional `docsBlocks` param — existing callers unaffected.
- **`marionette/src/index.ts`** validates block shape at PROPOSE time (non-empty array, known
  section, non-empty markdown, no sentinel injection). **`actions.ts`** forks `executeAction` on
  `kind==='update_docs'`.
- **Audit names reused** (`deploy.*`, target `docs`) — same convention as `service-restart`.
- **Verified live end-to-end** via action 14: propose → approve → guard passed → commit `ad25082`
  pushed → `deploy.succeeded` → action terminal `succeeded` → ✅ Telegram push received.
  Approval-gated like every M4 action; second hand PROVEN, not autonomy turned on.

<!-- appended by Mari 2026-07-21 (action 15) -->

- **PPTX text extraction — SHIPPED (`bddb6b9`).** `extractText()` handles
  `application/vnd.openxmlformats-officedocument.presentationml.presentation` via **`fflate`**
  (in-memory unzip) + **`@xmldom/xmldom`**, in `apps/api/src/extract/pptx.ts`. A .pptx is a zip of
  XML: slide text lives in `ppt/slides/slideN.xml` inside `<a:t>` runs, speaker notes in
  `ppt/notesSlides/notesSlideN.xml`, same shape. Emits slides in numeric order with `## Slide N`
  provenance headers (so Chonkie chunks carry citable slide origin) and speaker notes labeled
  `Notes:`. Runs within a paragraph are joined without a separator (preserves words split across
  formatting boundaries); paragraphs become newlines. Existing `MIN_CHARS` guard applies unchanged.
  Dropzone accepts AND advertises `.pptx` (both filter and label).
- **Verified end-to-end.** Isolation-tested in a throwaway container on `bentley-os_backend`:
  synthetic 3-slide deck -> 201, body confirmed in psql with slide order intact, notes labeled, and
  the note-less slide correctly emitting no empty `Notes:`. Deployed job `cae0d2e0`
  (`deploy.succeeded`, no rollback). Live public path: real deck "June Tip Sneak Peek.pptx" dropped
  at `spaghettios.bentleyos.me` -> 1110 chars -> `documents` row -> cron tick -> 3
  `document_chunks` -> **all 3 Qdrant points retrieved BY ID** (not a collection-level count).
  **The document ingestion format seam is now closed for md/txt/docx/pptx/pdf.**

<!-- appended by Mari 2026-07-21 (action 16) -->

<!-- MARI:APPEND §4 -->

---

## 5. Data model

```
people ──< email_recipients >── emails
people ──< event_attendees  >── calendar_events

audit_log    (append-only ledger: every deploy action, every AI action — reasoning +
              delegation + action lifecycle — regardless of interface: API call or Telegram)
sync_state   (source PK, sync_token, updated_at — incremental ingestion cursors)
actions      (M4: mutable current-state store for proposed side-effecting ops awaiting
              approval; audit_log stays the ledger, target = actions.id)
dashboard_state (M2 "what changed": singleton, one row id=1, holds last_seen_at — the one
              fact of when the owner last viewed the dashboard; not a shadow table)
messages     (0009: conversation memory. One row per turn, keyed on an OPTIONAL
              conversation_id (absent = stateless). role user|assistant, content =
              the turn text — Mari's `message` only, never her `reasoning`. Read
              back as the history tier of the /think prompt, capped 12 turns /
              6000 chars. audit_log stays the ledger; this stores what was SAID)
tasks        (M3 tasks panel / Slice A: owner-created responsibilities. Owner asserts
              priority (high|medium|low); marionette ADDS insight (reason + category)
              via the enrich cron, never overwrites priority. Migration 0007. Its own
              object type — NOT jammed into emails/calendar_events)
```

The M2 dashboard reads `calendar_events` + `emails`; its only owned state is the
`dashboard_state` singleton (one owner fact: last-seen time). Delta computation is a read
over existing ontology rows keyed on `created_at`.

**M3 (Clair) adds NO new tables — it's ontology-correct in-place:** the classifier writes
`importance`/`category`/`reason`/`confidence`/`classified_at` **onto the existing `emails`
rows** (the triage judgement is a fact about the email, so it lives on the email — not in a
parallel "classifications" table). `body` (full message) also lives on `emails`. All added by
migration `0005_email_intelligence.sql`. The priority-triage dashboard section is a pure read
over these columns — no owned state of its own.

**M3 embeddings also add no new table** — `embedded_at` is one more column on `emails`
(migration `0006`), the same in-place, ontology-correct pattern. The vectors live in the
**Qdrant `emails` collection** (1536-dim cosine, one point per email keyed on the email's
uuid) — a derived index over `emails.body`, a utility store (§3a), NOT a source of truth. The
body stays in Postgres; Qdrant holds only the vector + a light display payload
(subject/received_at/sender_id).

**M3 tasks panel (Slice A) adds ONE new table, `tasks` (migration `0007`)** — its own object
type, correctly NOT jammed onto `emails`/`calendar_events` (a task is a distinct fact about
the owner's responsibilities, not a property of a message or event). Columns: `id` (uuid),
`title`, `notes`, `source` ('manual'), `source_id`, `status` ('open'|'done'), `priority`
(high|medium|low), `reason`, `category`, `enriched_at`, `created_at`, `updated_at`. Work-queue
index `idx_tasks_unenriched` WHERE `enriched_at IS NULL`. **The priority/insight split is the
key design fact:** the OWNER asserts `priority` on creation (a fact they assert); marionette's
enrich pass writes ONLY `reason`/`category`/`enriched_at` and is prompt-instructed NOT to judge
or overwrite priority (insight the AI adds). The dashboard "Right Now" card is a pure read over
`tasks` + classified `emails` + `calendar_events` — no owned state of its own beyond the table.

---

## 6. Roadmap (ordered by what unblocks what)

**Milestone 0 — Clean the base: ✅ Done.** Embedder removed, ontology schema loaded,
Cloudflare Access email-locked + MFA on.

**Orchestrator build-order (precedes Milestone 1's remaining work): ✅ Done, and now
actually proven — including from a live external interface.**
- Deploy service — ✅ built, rollback-tested + scope bug FIXED (`52c3f72`, see §4).
- Contractor (OpenCode container) — ✅ built, `/execute` wired to real OpenCode, live in
  prod, undici-timeout-hardened.
- Marionette — ✅ built, `/think` reasoning + `delegate` branch to contractor. The
  build-machine keystone — marionette can direct contractor to write code, not just reason
  about it — verified against real multi-step tool-call tasks both via direct API testing
  and via a live Telegram-originated request.
- **Telegram interface — ✅ built and verified end-to-end.** First working command channel
  to marionette outside of direct API calls. Single-user allow-listed, webhook-secret
  gated, Cloudflare-Access-bypassed on its specific path only.
- Wolverine (fixer) — not built.
- Local Whisper — ✅ done (self-hosted `whisper.cpp`, `small.en` model, Vulkan GPU, Cloudflare
  Access-gated, Hammerspoon push-to-talk client on laptop). Local embeddings — not built.

**Milestone 1 — Data in (Gmail + Calendar): ✅ Done.**
| Step | Status |
|---|---|
| `sync_state` migration | ✅ applied |
| `gcal.ts` DB writes + token wiring | ✅ isolation-tested |
| `gmail.ts` (same pattern) | ✅ isolation-tested |
| Rebuild api image with `googleapis` | ✅ done |
| node-cron schedule in api | ✅ done, live in prod |
| Wire `gcal.ts` + `gmail.ts` into running api | ✅ done, live in prod |
| `event_attendees` / `organizer_id` population | ✅ verified live |

- **Done when:** new events + emails land in Postgres automatically, with provenance, and
  `event_attendees`/`organizer_id` are populated. **All conditions met.**

**Milestone 2 — Insight out. ✅ Done.**
- ✅ **"Today" slice shipped** (`7d79632`): `apps/api/src/routes/dashboard.ts` replaced the
  static status card with a server-rendered dashboard reading `calendar_events` / `emails`
  directly via api's `pg` pool. "Today" = today's events (Central tz, ordered); "Recent
  email" = last 15 by `received_at`, unread-flagged. DB-field escaping, graceful empty/error
  states, `/health` untouched. Isolation-tested, deployed via audited `POST /deploy` (job
  `b3da007c`, confirmed `deploy.succeeded`). See §4.
- ✅ **"What changed" slice shipped** (`5955d8d` + migration `0004`, `b905e4b`): renders
  FIRST, above Today, with a count badge; shows emails/events ingested since the owner last
  looked, keyed on `created_at`, backed by the `dashboard_state` singleton (`last_seen_at`,
  advanced fire-and-forget after computing deltas). Isolation-tested, deployed via audited
  `POST /deploy` (job `63e689a8`, confirmed `deploy.succeeded`), verified live. See §4.
- ⏳ **Snippet polish** (optional, cosmetic) — strip Gmail zero-width padding (`‌`) from
  rendered snippets. Still open; not milestone-blocking.
- **Done when:** the dashboard shows today's real events + email at a glance AND a "what
  changed" view surfaces recent deltas. **Both conditions met.**

**Milestone 3 — AI layer, read-only. ✅ DONE — classifier + triage render + embeddings +
auto-drain + grounded Q&A + tasks panel all shipped.** In **marionette**, not api
(reasoning), rendered by **api** (read-only views).
- ✅ **Email classification shipped** (`4c39435` + `5d45b8d`): Clair two-pass consequence
  classifier writing `importance`/`category`/`reason`/`confidence`/`classified_at`, backed by
  migration `0005`. `POST /classify` batch endpoint, audited per-email. See §4.
- ✅ **Triage render shipped** (`532493a`): the M2 dashboard now surfaces classifier output —
  three-tier priority section (Think about first / Peripheral / Noise), reason-led, in api as
  a pure read view. Isolation-tested, deployed via audited `POST /deploy`, verified live. See §4.
- ✅ **Embedding pipeline shipped** (`a46d8ce` + `2947a9b`): OpenAI `text-embedding-3-small`
  → Qdrant, via `marionette/src/embed.ts` + `POST /embed`, migration `0006`
  (`embedded_at` + `idx_emails_unembedded`). Full backlog embedded, Qdrant
  `emails` collection populated one point per email (counts: see STATUS header). Embeddings-provider decision RESOLVED = OpenAI (§8).
  Isolation-tested, deployed via audited `POST /deploy` (`deploy.succeeded`). See §4.
- ⏳ **Grounded Q&A** — now **UNBLOCKED** (embeddings done). Next slice: `retrieve.ts` (embed
  query → Qdrant top-k → SELECT bodies from Postgres → inject as grounding via the pre-fetch
  injection pattern, same shape as audit-sight) + a `/think` data-question gate + a
  prompt.ts widen. NOT built.
- ✅ **Auto-drain shipped** (`a9e7bc1`): the 5-min ingestion cron POSTs marionette
  `/classify` then `/embed` (limit 50 each) after every sync, so new mail self-triages and
  self-embeds; backlog drains 50+50/tick until caught up. Thin HTTP forward (§9-clean),
  `try/finally` guard fix. Isolation-tested, deployed job `4c205049` (`deploy.succeeded`).
- ✅ **Grounded Q&A shipped** (`a0ced26`): retrieval + data-gate wired into `/think`, live and
  verified end-to-end against production (real cited invoice/receipt query tested).
- ✅ **Tasks panel shipped (Slice A)** — the old "morning brief" idea, redefined with the
  owner into a "breathing" responsibilities dashboard (Clair). New `tasks` object type
  (migration `0007`), owner-set priority + marionette-added insight (`reason`/`category`) via
  a `/enrich-task` cron drain (thin api forward, reasoning in marionette — §9-clean). The
  dashboard `/` was rewritten: a **Right Now** card (owner-priority tasks + think-first email
  ≥70 + upcoming events) plus a collapsible **Everything else** `<details>` (peripheral email
  40–69 + past events + what-changed); **noise-tier email (<40) dropped from the page
  entirely**. Manual tasks create/complete in-place via ~20 lines vanilla JS, no reload.
  Backend live (`29d53d4` — owner-priority model); dashboard render live (`88df75c`/`5ab35ad`,
  `deploy.succeeded`). Verified live in-browser: a real high-priority task renders in the Right
  Now card. Slice B (self-email → task) and Slice C (insight/help layer) are LATER.
- ✅ **Document ingestion pipeline shipped** (`1eef3dc` + `d8342f7`) — the first long-form RAG
  source the email pipeline deferred chunking to. Marionette `POST /embed-doc` chunks each
  document via Chonkie `RecursiveChunker` (512-token) → shared `embedText()` → Qdrant `documents`
  collection, migration `0008` (`documents` + `document_chunks`). api `POST /documents` (multipart,
  `extractText()` md/txt seam, DOCX/PDF → 415) + dashboard dropzone + `/embed-doc` cron drain.
  Deployed via audited `POST /deploy` (`deploy.succeeded`), verified end-to-end with both
  downstream effects (`embedded_at` timestamp + Qdrant point count) checked directly. See §4.
  **DOCX extraction SHIPPED (`960116a`) via mammoth and PDF extraction SHIPPED (`1c90a43`) via
  unpdf, both behind the same `MIN_CHARS` empty-text guard — the format seam is closed for the
  common cases. OCR for scanned PDFs remains a deliberate later slice (§8).**
- **Done when:** email is auto-classified + auto-embedded on ingest AND grounded Q&A is live
  AND the tasks/responsibilities panel is live. **All conditions met — M3 is CLOSED** (the
  document-ingestion pipeline extends M3's read-only AI layer to long-form sources).

**Milestone 4 — Action layer, approval-gated. ✅ Done — gate slice, Task A, and Task B all
shipped.**
- ✅ Gate slice (`3a66aef`+`b13c5ce`): `actions` table, strict lifecycle, Telegram
  Approve/Deny buttons. See §4.
- ✅ Task A (`80298a4`/`8ac171c`): deploy polled to true completion via `audit_log`, ✅/❌
  pushed to Telegram. See §4.
- ✅ Task B (`1cdd19f`): `commit_deploy` now really commits + pushes the scoped path before
  building, gated by a fetch-first divergence check. Verified live (action 7). See §4.
- **No open gaps.** Gap 1 (self-deploy watcher) and Gap 2 (root-owned git
  objects) both resolved. See §4, §8.
- Additional action types (create event, draft reply) remain future work within this
  milestone — no design started.

**Milestone 5 — Earned autonomy.** Auto-execute low-risk tier only. **Rollback-scope fix
done (`52c3f72`) — no longer blocked.**
- **Design decided (2026-07-17): Mari's "hands" = fixed named actions via the M4 lifecycle,
  Option C.**
- ✅ **First hand `service-restart` — SHIPPED, verified live (`12b0211`).** Production-zone,
  allow-listed (`{api, contractor, marionette}`), approval-gated (M4 tap — still requires a
  human Approve). Built as a sibling `runRestartJob` in deploy, dispatched by a new `job.kind`
  field; propose-time allow-list validation in marionette. Verified end-to-end via contractor
  (direct API) and marionette (real Telegram Approve tap, incl. the self-teardown edge held by
  `0af75f0`). This is the DESIGN of the hands proven with a real hand — NOT autonomy turned on.
  See the Milestone 5 subsection in §4 and the hands entry in §8.
- ✅ **Hand #2 = `update_docs`** — SHIPPED (`dd4d594`). The generation-source fork was resolved
  by rejecting BOTH original horns (A: marionette generates prose from box state; B: a
  deterministic box script) in favor of append-only insertion above `<!-- MARI:APPEND §N -->`
  sentinels, plus a line-conservation guard in `deploy` asserting no pre-existing non-blank
  line is lost. Still approval-gated. See §8.
- ⬜ **M5 proper — auto-execute the low-risk action tier** — a step ON TOP of the hands, NOT
  started. The hands stay approval-gated until this lands.

**Milestone 6 — Self-extension.** Tool registry + isolated test + approval + git automation +
rollback, **reusing `deploy`'s** job/audit machinery — not a parallel build-and-rollback
system.

---

## 7. Hard-won lessons (don't relearn these)

- **Bind-mount path must be exact.** Use `/home/spaghettios/bentley-os`, never an alias or
  `/repo`. A mismatched path made `docker compose config --hash` compute different hashes
  for *every* service, so deploying one service alone recreated others mid-deploy. Verify
  with `docker compose config --hash='*'` after any change.
- **`COMPOSE_PROJECT_NAME=bentley-os` must be pinned** — default basename spawned a
  duplicate stack.
- **`WORKDIR` must be `/app`** (not the bind-mounted repo path) or the bind mount overwrites
  `node_modules` at runtime.
- **`.js` vs `.ts` imports:** strip-types services (`node --experimental-strip-types`) MUST
  import internal modules with `.ts` extensions — `.js` throws `ERR_MODULE_NOT_FOUND` at
  startup. Applies to `deploy`, `contractor`, `marionette`. `api` uses real `tsc` + `.js` —
  opposite convention, easy to get wrong. (The M2 dashboard change stayed in `api`, so
  `import { pool } from '../db/pool.js'` — `.js`, correct for compiled-TS.)
- **Node/npm live only inside Docker** — host has neither. Dependency changes = hand-edit
  `package.json`, let the build install. **`npx tsc --noEmit` isn't available on the host
  for the same reason** — the closest pre-deploy check is a full isolation build
  (`docker build` + throwaway `docker run` + `/health` hit), not a host-side typecheck.
- **Isolation-test before any commit** — throwaway `docker run`, confirm the real path and
  audit row before deploying.
- **audit_log is authoritative** for deployment and orchestration state — not raw git
  history, and not stdout logs (services here don't log per-request at all; `audit_log` is
  the only place to see what actually happened).
- **Incognito required** for accurate Cloudflare Access verification.
- **`-h 127.0.0.1`** required for `psql` TCP auth inside the postgres container; **`-P
  pager=off`** required too — no `less` in the container image.
- **Contractor reaches OpenCode via LAN IP, never `127.0.0.1`** — a loopback-bound service
  is unreachable from any other container regardless of shared network.
- **`undici`'s default fetch timeout (5 min headers/body) is too short for real OpenCode
  agent tasks.** A trivial no-tool-call prompt ("reply with pong") always finishes in
  seconds and will mask this bug — only a real multi-step task (file write, bash command)
  exposes it. Set `setGlobalDispatcher(new Agent({ headersTimeout, bodyTimeout }))`
  explicitly in any service that calls one that can run long.
- **Always capture `err.cause` in catch blocks that audit-log a fetch failure**, not just
  `err.message`. `"fetch failed"` alone is undiagnosable; `err.cause` (e.g.
  `HeadersTimeoutError`) tells you what actually happened.
- **OpenCode's `"ask"` permission hangs forever in headless/API contexts** — there's no
  attached terminal to answer the prompt. `external_directory` and `doom_loop` default to
  `"ask"`; any tool call that trips them from an API caller will hang until the client's own
  timeout fires, with a generic, undiagnosable error. Any headless OpenCode caller's config
  must resolve every permission to `allow` or `deny` only.
- **Long file pastes break the browser terminal.** Beyond a short heredoc, generate the file
  in Claude's sandbox and commit it via the GitHub web UI (paste into the online editor, or
  drag-and-drop upload to replace the file) rather than fighting heredoc/scp limits.
- **The api image's build context is `apps/api/`, not the repo root.** `apps/api/Dockerfile`
  does `COPY package.json ./` / `COPY . .` with no monorepo pathing — there is NO
  `package.json` at repo root (it's a monorepo; api's lives at `apps/api/package.json`). So
  to build it by hand for an isolation test, the command is `docker build -t <tag> apps/api`
  (context = the directory), NOT `docker build -f apps/api/Dockerfile .` (which sets context
  to root and fails at `COPY package.json ./` with "not found"). The deploy service already
  gets this right; it only bites manual/isolation builds.
- **Cap embedding input by TOKEN budget, not char count — and short test emails won't catch
  the mistake.** OpenAI `text-embedding-3-small` has an 8192-*token* input limit. The embed
  pipeline first capped at 24000 *chars*, conflating the two; token-dense bodies (marketing
  HTML, quoted mail threads) ran ~4+ chars/token and blew past 8192 tokens → HTTP 400
  ("maximum context length is 8192 tokens") on ~25 of the first 200 emails. The 3-email
  isolation smoke test used short emails and passed clean — the bug only surfaced on the real
  drain. Fix: 8000 chars (~2k tokens worst-case, safely under). Lesson doubles as: **when the
  isolation sample can't exercise the failure mode (size, encoding, edge content), the real
  batch is the first true test — watch its first run closely, and design per-row isolation so
  a mid-batch failure is recoverable (failed rows stayed unembedded and were re-picked on
  retry, losing nothing).**
- **`node:22-alpine` (the api base image) has no curl** — same class as the `node:22-slim`
  no-curl/no-apk lesson. Isolation-probe a running api container via
  `docker exec <c> node -e "fetch('http://localhost:3000/...').then(r=>r.text()).then(console.log)"`,
  not curl.
- **Don't paste prior terminal output back into the shell.** Twice this session, previous
  command output (prompt lines + build log) was accidentally pasted into bash, which tried
  to execute each line — harmless (`command not found` noise) but it also created stray
  files named for tokens in the output (`=`, `CACHED`, `[internal]`, `exporting`, etc.) that
  had to be `rm`'d before the tree was clean. When copy-pasting a command, copy only the
  command line, not the leading `spaghettios@…$` prompt or the output above it.
- **A Cloudflare Access service token is not automatically valid against an app just because
  it was generated.** It must be explicitly attached via a separate **Service Auth** policy
  on that specific application (Action: Service Auth, Include: Service Token). Without it,
  every request bounces to the login redirect with `service_token_status:false` buried in
  the JWT `meta` payload — the token itself can be completely valid and still get rejected.
  Confirmed by testing: generating the token and using correct headers still failed until
  this policy existed.
- **A path-scoped Cloudflare Access Application is not the same as a new subdomain, and it's
  easy to create the wrong one by accident.** When adding an app meant to carve an exception
  into an existing hostname's Access policy (e.g. a webhook endpoint that can't complete an
  Access login), the domain field must be set to the *exact same hostname* as the existing
  app, with the narrower scope coming from the **path** field — not a different subdomain
  typed into the domain box. Symptom of getting it wrong: the new app's Destinations column
  shows an unexpected/truncated hostname, and the target endpoint keeps 302-redirecting to
  Access login exactly as before. Always confirm the Destinations column (or a screenshot of
  the edit form) shows the intended full hostname + path before relying on it.
- **Bypass and Allow are different Cloudflare Access policy actions.** Allow still requires
  passing an identity check; only **Bypass** skips the Access challenge entirely. A
  webhook-style caller (Telegram, or any other server-to-server POST with no browser/login
  flow available) needs Bypass, not Allow.
- **A downstream JSON response shape should never be assumed from a route name or a "looks
  about right" guess — confirm it with a real curl.** `marionette`'s `/think` response is
  nested (`{decision: {decision, message, reasoning}}`), not flat. The bug this caused
  (`sendMessage` silently sent `undefined` as the message text) produced no error anywhere
  in the stack — Telegram's API happily accepted and "delivered" a message, it just had no
  visible content. The only way this surfaced was noticing the user received nothing,
  which is a much slower feedback loop than just curling the endpoint first.
- **HTML rendered from DB fields must be escaped.** The M2 dashboard interpolates email
  subjects/snippets and event titles — all third-party content — into an HTML template. An
  `esc()` helper escapes `& < > "` on every DB-derived value. Skipping this is a stored-XSS
  vector even at single-user scale (a crafted email subject could inject markup). Any new
  server-rendered view does the same.
- **Postgres `AT TIME ZONE` is the right place to compute "today", not the app layer.** The
  dashboard's "today" window is computed in SQL with `AT TIME ZONE 'America/Chicago'` so the
  day boundary is Central, not UTC — computing it from `new Date()` in Node would have keyed
  off the container's clock/tz and drifted the boundary. Be explicit about tz; don't rely on
  the container defaulting to anything.
- **`sed -i` syntax is platform-specific.** GNU sed (Linux/the box) takes no argument after
  `-i` for in-place editing without a backup. BSD/macOS sed requires an explicit (even if
  empty) backup-suffix argument: `sed -i '' 's/x/y/'`. Using the Linux form on macOS or vice
  versa either errors outright or silently no-ops — always confirm which machine a command
  is about to run on.
- **A Docker build sitting at "exporting to image" / "unpacking" for 10+ minutes isn't
  necessarily hung.** On slow disk I/O, large layers (e.g. a ~500MB model file) can take
  a very long time to unpack with the progress line appearing frozen. Before assuming
  `dockerd` is stuck: check `docker info` responds within a timeout, check `uptime`/load
  average, check for processes in D-state (`ps aux | awk '$8 ~ /D/'`). If the daemon itself
  is responsive and load is low, it's probably just slow — the build in this repo's history
  took ~800s longer than expected and completed successfully once left alone.
- **Interrupting a `docker compose up --build` with Ctrl+C after the image has already built
  but before the container swap can leave the new image sitting unused.** Check
  `docker images` for the freshly-built image and `docker compose ps` for what's actually
  running — if the image exists but the running container's `CREATED` timestamp predates it,
  a plain `docker compose up -d <service>` (no `--build`) will pick up the already-built
  image quickly, no rebuild needed.
- **An exported shell var silently overrides `.env` in `docker compose` interpolation.** A
  stale `export POSTGRES_PASSWORD=...` in the interactive shell beat the `.env` value for
  every `${POSTGRES_PASSWORD}` compose interpolates — poisoning the built `DATABASE_URL` for
  services whose URL is composed from it, while the plain `POSTGRES_PASSWORD` env stayed
  correct, producing a baffling per-service split. Symptom: `docker compose config | grep
  DATABASE_URL` shows a password string that isn't in `.env`. **`docker compose config` is
  the interpolation truth check** — always diff it against `.env` before touching the DB
  role. This masqueraded as "password drift" across two sessions; the DB role was always the
  real `.env` value, and the attempted "fix" (`ALTER ROLE` to the phantom value) was the
  actual damage each time. Fix: `unset POSTGRES_PASSWORD`, restore the role to the true
  `.env` value, recreate. Corollaries: (1) a `trust`-path `psql` (`-h 127.0.0.1`)
  authenticates regardless of the password sent — only `-h postgres` (the scram network
  path) actually proves a password matches; a loopback `select 1` is a false positive. (2)
  `.env.bak` sitting in the working tree is a reinfection hazard (holds the stale secret) —
  deleted.
- **A single-FILE bind mount is pinned to an inode — replace it in place or the container
  silently serves the old content.** `token.json` and `client_secret.json` are bind-mounted
  as individual files, not a directory. `mv new old` or `rm old && cp new old` creates a NEW
  inode; the running container keeps the old one mapped and serves stale content with zero
  error anywhere. Correct form is in-place truncation: `cat new > old`. **Verify by reading
  the value back from INSIDE the container**, never from the host — the host read is not the
  same file the container sees. (Directory mounts don't have this problem; file mounts do.)
- **An ESM script resolves `node_modules` from its OWN directory, not the cwd.** A helper
  script `docker cp`'d to `/tmp` and run with `-w /usr/src/app` still throws
  `ERR_MODULE_NOT_FOUND` for app dependencies — `-w` sets cwd, which ESM ignores for
  resolution, and `NODE_PATH` doesn't apply to ESM either. Put one-off scripts INSIDE the app
  tree (`/usr/src/app/x.mjs`), run, then delete.
- **`docker compose up -d --force-recreate <svc>` also recreates postgres on an
  initialized-volume cluster.** Postgres's env interpolates `${POSTGRES_PASSWORD}`, so
  rotating that value changes postgres's config hash — and `--force-recreate` on any service
  whose stack shares that interpolation triggers dependency convergence that bounces the DB
  too. Symptom: recreating `api`/`contractor`/`marionette`/`deploy` after a password rotation
  also restarts postgres (a brief full-DB blip; harmless — named volume persists, ledger
  intact). Use `--no-deps` to recreate only the named services and avoid the blip. Complements
  the trust-vs-scram / `.env.bak` lesson above — same rotation context, different failure mode.
- **macOS default audio input can be silently hijacked by a virtual audio device.** A
  Microsoft Teams "Teams Audio Device" made itself the default input; `sox -d` then recorded
  pure silence (`Maximum amplitude: 0.000000`) and whisper hallucinated "Thank you." on the
  empty clip — looking exactly like an auth/token failure when it wasn't. Tells: the default
  input's `Current SampleRate` (24000) didn't match the real MacBook mic (48000), and sox's
  `[ | ]` meter stayed flat while speaking. Fix: force the real device in System Settings →
  Sound → Input (not "default"). When push-to-talk returns "thank you", suspect a silent mic,
  not the token.
- **A write-side pipeline can ship "verified end-to-end" and still be unreachable.** The
  document pipeline (`1eef3dc`/`d8342f7`) correctly verified its own downstream effects —
  `documents.embedded_at` stamped, Qdrant `points_count` matching — and was still invisible
  to Mari for weeks, because `retrieve.ts` (written first, for email) hardcoded
  `QDRANT_COLLECTION = 'emails'`. The `documents` collection was write-only. **When adding a
  source to a system that already has one, grep the READ path** — the write path's own test
  passes regardless. Fixed in `a25074d`.
- **A coding agent reporting "done" is not a commit.** An agent session wrote
  `ingest-sight.ts` + edits to `index.ts`/`prompt.ts`, then stopped: nothing committed,
  nothing deployed, and a `deploy.succeeded` row in `audit_log` from 13 minutes BEFORE the
  files were written made it briefly look shipped. Three checks settled it in seconds —
  `git status -sb` (uncommitted), `git log --oneline` (HEAD unmoved), and
  `docker exec <c> ls /app/src/<newfile>` (NOT PRESENT IN CONTAINER). **Verify a hand-off
  against the box, never against the session summary.** Corollary: compare file mtimes to
  audit-row timestamps — a deploy that predates the code it supposedly shipped is the tell.
- **A 201 from an upload route proves the ROUTE ran, not that extraction produced text.** The DOCX
  slice returned `201 Created` on the first try; that said nothing about whether mammoth pulled
  real words or an empty string. The row itself is the proof: `char_count` plus
  `left(body, 600)` in psql. **And a synthetic fixture can't tell you whether REAL documents
  survive** — three generated clean paragraphs passed while revealing nothing about tables,
  headings, headers/footers, or bullets. The first real file of your own is the actual test; run
  it before trusting the extractor on a corpus.
- **Qdrant's `points_count` is not authoritative for a just-written point — retrieve by ID.**
  After the live PDF embedded (2 `document_chunks` rows, `marionette.embed_doc` audited success,
  `documents.embedded_at` stamped), `points_count` still read 20 — unchanged — which looked
  exactly like a silently-failed upsert. Both points were in fact present, returned immediately by
  `POST /collections/documents/points` with their ids. The collection showed
  `indexed_vectors_count: 0` across 8 segments: the counter lags until optimization runs. **The
  authoritative check for "did this specific write land" is fetching the point by id**, never a
  collection-level count. (Earlier slices got away with counting because they checked long after
  the write, or checked a delta big enough to cross a segment flush.)
- **A retrieval feature can ship "verified" with its TRIGGER untested — check the whole path.**
  `a25074d` made the Qdrant `documents` collection searchable and taught the formatter to render
  chunks, and was correct on both counts. But `data-gate.ts`'s `DATA_PATTERNS` stayed 100%
  email-vocabulary and `prompt.ts` still described an email-only capability — so a question
  phrased in document language ("what's the key promise in the chickens creative brief?") matched
  no pattern, retrieval never ran, and Mari claimed blindness while holding the answer in Qdrant.
  `prompt.ts` had also drifted to naming a block (`RETRIEVED EMAIL CONTEXT`) that the formatter
  never actually emits (`RETRIEVED CONTEXT`) — Mari was told to look for a heading that didn't
  exist. **The path is trigger → fetch → format → prompt, and each half tests green in
  isolation.** Same class as the write-only-collection lesson above, one layer up. Corollary:
  widening a hand-written keyword list is a guess, and it will be wrong again — 3 of 4 natural
  phrasings still missed after a deliberate widening pass, which is what finally justified the
  question-router (`9700240`).
- **An isolation container using `.env` writes to PRODUCTION tables, not a sandbox.** The
  conversation-memory test ran in a throwaway container on `bentley-os_backend` with
  `--env-file .env` — which is the whole point (it exercises the real DB), but it means every
  test turn landed as a real row in the live `messages` table. Same class as the dashboard
  `last_seen_at` note, generalized: **isolation isolates the CODE, never the DATA.** For any
  slice that WRITES, use a recognizable key prefix (`isotest-<epoch>`) so the rows can be
  identified and deleted afterward, and check the table before assuming a clean tree.
- **Make the new capability OPTIONAL at the field level and the regression surface collapses to
  zero.** `conversation_id` is optional on `/think`: absent means byte-identical prior behavior,
  so direct API callers, test scripts, and contractor needed no changes and could not break.
  The isolation test then only had to prove two things — that the old path still works untouched
  and that the new path works — rather than re-verifying every existing caller. Cheaper to test,
  and it makes rollback a matter of not sending a field.
- **`audit_log`'s timestamp column is `at`, not `created_at`.** `actions` uses
  `created_at`/`updated_at`; `audit_log` uses `at` (indexed `idx_audit_at`). Querying the ledger
  with `created_at` throws `column does not exist`.
- **A throwaway `docker run` does NOT inherit compose bind mounts.** An isolation container for
  `deploy` started without `-v /home/spaghettios/bentley-os:/home/spaghettios/bentley-os` sees no
  repo at all — `ENOENT` on the first read. Copy the `volumes:` block from `docker-compose.yml`
  into the isolation run, or the test proves less than it appears to.
- **`deploy` cannot deploy itself** — absent from `SERVICE_HEALTH` by design (nothing can target
  it, which is what makes it immune to being torn down by a job it runs, per `0af75f0`). Changes
  to `deploy` need a manual `docker compose up -d --build --no-deps deploy`. Corollary: until that
  recreate happens the OLD container is still serving, so a freshly-committed allow-list change
  won't appear — verify against the running container, not the source file.
- **Append-only beats regenerate for machine-written docs.** The valuable content here is
  accumulated detail no amount of box state can reconstruct. Any mechanism that lets a model
  rewrite existing lines will eventually delete some, silently. Constrain the mechanism
  (insert-above-sentinel + line-conservation guard) rather than trusting the prompt.
- **Large JSON payloads must be written by script, never heredoc-pasted.** The browser terminal's
  bracketed-paste mangled a multi-KB `update_docs` body mid-string. Build the payload with a
  Python heredoc writing to a file, then `curl -d @file`.

<!-- appended by Mari 2026-07-21 (action 15) -->

- **`audit_log` columns are `at` and `payload`** — NOT `created_at`/`detail`. Also `target` and
  `outcome`. `\d audit_log` is the one command; don't guess.
- **`docker compose exec postgres psql` without `-h postgres` hits the local socket** and fails
  with peer authentication for user `bentley`. Always pass `-h postgres` (scram, real verification)
  — same trap as the `-h 127.0.0.1` trust-auth false positive already logged.
- **marionette is NOT reachable from the host.** It publishes no port (backend network only, :4200).
  `curl 127.0.0.1:4200` gives connection refused. Reach it from a container on
  `bentley-os_backend`, unlike deploy which IS on the host at :4000.

<!-- appended by Mari 2026-07-21 (action 16) -->

<!-- MARI:APPEND §7 -->

---

## 8. Open questions (decided-when-we-get-there, not blocking)

- **Rogue auto-committing actor — RESOLVED, and the agent is now DISABLED (2026-07-20).**
  The Copilot cloud agent was turned off after reverting `THE_BIBLE.md` to stale snapshots
  three times. First post-disable push survived clean. **The `git fetch origin` + diff
  before EVERY push rule is relaxed to normal hygiene** — fetch before pushing because it
  is good practice, not because a bot is racing you. **Incident history:**
  `e06ed72`/`449a9b7` (and a third recurrence,
  `650a7a8`, caught live in a later session) are GitHub's native **Copilot coding agent**
  (workflow `dynamic/copilot-swe-agent/copilot`, confirmed via `gh api
  .../actions/workflows`, `state: active`), producing genuinely GPG-signed/verified commits
  under Bentley's identity — not a leaked credential, rogue app, or unknown actor. No repo
  webhooks (`gh api .../hooks` → `[]`) or deploy keys (`gh api .../keys` → `[]`) were
  involved. **Decision: left enabled deliberately.** Known side effect: it periodically
  reverts THE_BIBLE.md to a stale cached snapshot when it runs (seen 3 times now) — so
  **`git fetch` + diff `origin/main` before every push is now standing practice**, not a
  one-off precaution.
  - **Update (2026-07-17): the agent also regenerates *docs*, not just code.** Commits
    `e589a50` ("Update STATUS.md with new counts"), `835e673` ("Revise THE_BIBLE.md"),
    `d72cdcf` ("Refactor STATUS.md"), and the two terse `docs: regen to c0988b1`
    (`a41fa7d`/`f7b6819`) are all agent-authored doc rewrites (terse capitalized messages are
    its signature). **This is the confirmed root cause of the STATUS/Bible drift** that
    prompted the two-file split: an agent was writing the docs to its own (stale) model of
    state. The structural mitigation is now in place — **`bin/session-start`** regenerates
    STATUS's fact header from the box (a human/agent never types the counts), and this Bible
    carries no live counts to rot. If the agent starts reverting STATUS.md's header too,
    revisit with a pre-push guard; until then the split + `git fetch`-before-push is enough.
- **Docs cleanup:** old `.md` files (`00_NORTH_STAR`, `01_CURRENT_STATE`, `02_DECISIONS`,
  `03_ROADMAP`) retired in favor of this Bible. Remove from the project once trusted.
- **Rollback scope — RESOLVED** (current impl `b153b1e`, supersedes `52c3f72`): unscoped
  service aborts, no repo-wide checkout; the scoped git-checkout is now wrapped in a `DRY_RUN=1`
  guard, and the redundant `deploy/src/service-path.ts` was deleted (`SERVICE_PATH` already
  owns service→path mapping). Unblocks Milestones 4 and 5. (Older §4 text still cites
  `52c3f72` — behavior unchanged, only the commit + DRY_RUN guard are newer.)
- **OpenCode duplication:** the systemd OpenCode server and the `contractor` container are
  **not the same thing yet** — contractor calls the systemd server via SDK, doesn't replace
  it. When the container reaches parity, repoint `apps/api/src/routes/opencode.ts`'s
  `baseUrl` to `http://contractor:4100` in the *same* deploy that retires the systemd unit.
- **Postgres password rotation — RESOLVED (2026-07-17).** The live `POSTGRES_PASSWORD`
  (previously leaked in chat) was rotated via an atomic script: backup → prove old value via
  scram → `ALTER` over the trust path → prove new value via scram → rewrite both `.env` lines
  → recreate the 4 consumers (`api`/`contractor`/`marionette`/`deploy`). New value is
  `openssl rand -hex 24`, lives only in `.env` on the box (gitignored, never committed). The
  old plaintext value is dead (rejected on scram). Verified live: `.env` authenticates via
  `-h postgres`, deploy `/health` → `db:connected`, a fresh `deploy.succeeded` row landed on
  the new creds (full lifecycle — proves the ledger writes, not just reads, post-rotation),
  ledger intact. Timestamped backup was taken at `$HOME/.env.rotation-backup-<ts>` (chmod
  600, outside the tree) and retired after this commit landed.
- **DeepSeek API key rotation — RESOLVED (2026-07-18).** Rotated in the DeepSeek dashboard,
  swapped in `.env` (only `marionette` consumes it), redeployed marionette via `POST /deploy`
  (confirmed `deploy.succeeded`), and verified Mari reasons end-to-end via a Telegram
  round-trip. Both prior key values are revoked dashboard-side. `.env` holds the live key
  (gitignored, never committed). Temp backups wiped post-rotation.
- **Shared audit module** — deploy + marionette + contractor each duplicate `audit_log`
  write logic; unify eventually. Ingestion (gcal/gmail) still doesn't write to `audit_log`
  at all — not a blocker for the shipped "what changed" view (it keys off each row's own
  `created_at` ingest timestamp, not an audit trail), but revisit if a future view needs a
  true "last synced" signal.
- **Embeddings provider — RESOLVED = OpenAI `text-embedding-3-small`** (1536-dim, cosine),
  external API, consistent with §2.4. The embed pipeline (`marionette/src/embed.ts`,
  `POST /embed`, migration `0006`) is live and the full backlog is embedded; Qdrant
  is now used. **Local-model alternative deliberately deferred, not foreclosed:** a small
  local model on the box's idle AMD RX 5700 XT would plausibly fit the whisper-class exception
  and keep email bodies off OpenAI (privacy), but cost is a non-argument (~2¢ one-time, <$1/yr)
  and it carries the same unfinished ROCm/HIP setup parked for whisper. `embedText()` in
  `embed.ts` is a clean single-function swap seam if privacy ever wins.
- **Chunking — RESOLVED = Chonkie `RecursiveChunker`; documents are now RETRIEVABLE too (`a25074d`)**. Chunking landed in `1eef3dc`. The first long-form
  ingestion source (uploaded documents) landed, so chunking is no longer deferred. `@chonkiejs/core`'s
  `RecursiveChunker` at a 512-token target (safely under 3-small's 8191-token cap) chunks each
  document body in `marionette/src/embed-doc.ts`; one `document_chunks` row + one Qdrant `documents`
  point per chunk. **TypeScript, not a Python service (§2 held)** — of the candidate libs
  (Chonkie/llm-chunk) noted earlier, Chonkie was chosen. Email stays one-vector, no chunker; the
  document pipeline is where chunking lives. Web pages remain a future source that will reuse the
  same chunker.
- **DOCX extraction — RESOLVED (`960116a`).** `extractText()` handles DOCX via `mammoth`; a
  `MIN_CHARS = 20` guard now rejects empty/image-only extraction as a clean 415 for every format.
  Verified end-to-end with a real work document on the live path. See §4.
- **PDF text extraction — RESOLVED (`1c90a43`).** `unpdf` chosen over `pdf-parse` (pure ESM,
  bundled serverless pdf.js, own types, no native deps, no import-time `test/data` read). Text
  layer only; `MIN_CHARS` rejects scanned/image-only as a clean 415. `/embed-doc` unchanged,
  §9-clean, extractor stays TS (§2). Verified end-to-end through retrieval. See §4.
- **OCR for scanned PDFs — STILL OPEN, deliberately deferred.** Tesseract means a new ~200MB+
  binary in the api image, noticeably slow, imperfect output. The `extractText()` seam
  accommodates it without rework, and the `MIN_CHARS` 415 makes the gap loud rather than silent.
  No design started; only worth doing if scanned documents actually show up.
- **Drains not automated (M3) — RESOLVED** (`a9e7bc1`, this session). The 5-min ingestion
  cron now auto-runs BOTH classification and embedding on new mail: after each gcal+gmail
  sync, `apps/api/src/ingestion/scheduler.ts` POSTs marionette `/classify` (limit 50) then
  `/embed` (limit 50) — a thin HTTP forward reusing the same `MARIONETTE` base URL as the
  Telegram route (§9-clean, no reasoning in api). Each drain has its own try/catch; the whole
  `runAllSyncs` body is now `try/finally`-wrapped so the `running` guard can't strand `true`.
  Isolation-tested on `bentley-os_backend`, deployed job `4c205049` (`deploy.succeeded`). New
  mail self-triages and self-embeds; backlog also drains 50+50/tick until caught up. (Note:
  any hardcoded email-count figures in older revisions of this doc are stale —
  check live counts before relying on them.)
- **`whisper-laptop` Cloudflare service token — ROTATED (2026-07-18).** Replaced by
  `whisper-laptop-2` (new Service Auth policy include on the whisper app) and the old token
  revoked; new token proven working end-to-end. `~/.hammerspoon/whisper_secrets.lua` updated
  with the new Client ID/Secret. **Still worth doing:** move the laptop script's credentials
  to macOS Keychain instead of a plaintext Lua file.
- **Whisper deploy path** — `whisper` isn't in `deploy`'s `SERVICE_HEALTH` map, so it has no
  audited deploy/rollback path and must be rebuilt via raw `docker compose up -d --build`.
  Decide whether it's worth adding, given it's a low-churn service.
- **Whisper GPU acceleration — RESOLVED** (`72dae3e`). RX 5700 XT now runs whisper via the
  Vulkan/RADV backend (whisper.cpp v1.7.6 pinned — master broke Vulkan on bookworm). ROCm
  ruled out (gfx1010 unsupported). `/dev/dri` passthrough + video/render `group_add` in
  compose. Model moved base → small.en with the freed headroom. Verified on-device.
- **Google OAuth refresh-token death — RESOLVED (2026-07-20).** Ingestion was fully down
  from 2026-07-17 06:30 UTC to 2026-07-20 14:25 UTC (~3d 8h) — every 5-min tick failed with
  `invalid_grant` / "Token has been expired or revoked."
  - **Root cause:** the Google Cloud OAuth consent screen was in **Testing** publishing
    status. Google expires refresh tokens for Testing apps after **7 days**, unconditionally
    — nothing to do with the code. **Fix: Publish app** (User type stays External; "Make
    internal" is unavailable on a personal gmail.com account). The app remains **unverified**
    by choice — the consent screen shows "Google hasn't verified this app", proceed via
    **Advanced → Go to <app> (unsafe)**. The 100-user cap is irrelevant at n=1.
  - **The diagnostic tell:** a Testing-issued `token.json` carries a
    `refresh_token_expires_in` key; a published-app token does NOT. Its absence is the
    confirmation the fuse is gone. Check keys, never values.
  - **Re-mint recipe** (no auth script exists in the repo): write a short mjs using
    `google.auth.OAuth2(client_id, client_secret, 'http://localhost')` +
    `generateAuthUrl({access_type:'offline', prompt:'consent', scope:[...]})`. **The script
    must live inside the app tree** (`/usr/src/app/`), not `/tmp` — see the ESM resolution
    lesson in §7. **No local listener is needed:** open the consent URL in a laptop browser,
    approve, and the redirect to `http://localhost/?code=...` will fail to connect — lift the
    `code` value out of the URL bar and pass it back to the script. Auth codes are
    single-use and short-lived. Copy the new token back with `cat new > token.json`
    (in-place — see the inode lesson in §7), verify the expiry from INSIDE the container,
    `docker compose restart api`, then delete the `.bak` (plaintext refresh token in the
    tree is exactly the `.env.bak` hazard).
  - **Verified recovered:** `sync_state.age` < 2 min, 79 emails caught up in one tick,
    0 unclassified. The outage is legible in the data — 7/18 and 7/19 have zero rows.
- **Ingestion failure is SILENT — RESOLVED (`465d8d9`, 2026-07-20).** Closed by the ambient
  tier: `marionette/src/ingest-sight.ts` reads `sync_state` on EVERY `/think` (no keyword
  gate) and injects a one-line `INGESTION: gmail Nm ago, gcal Nm ago` block, flagging any
  source past 15 min as `(STALE)`. `prompt.ts` instructs Mari to warn plainly rather than
  answer over stale data. No new table, no migration — `sync_state` already owned the fact.
  See the ambient-tier subsection in §4. **Original description of the defect:** For three days the
  dashboard rendered normally, `/health` stayed green, and the classify/embed/enrich drains
  all reported healthy (processing an empty queue). Nothing anywhere surfaced that no data
  had entered the system. Ingestion still doesn't write to `audit_log` (see the shared-audit
  item above), so the ledger showed nothing either. **`sync_state.updated_at` held the truth
  the entire time and nothing read it.** Fix is small and §9-clean: a staleness read on the
  CRT dashboard — `sync_state` already owns the fact, so it's a pure read in `api`, no new
  state, no migration. Suggested threshold ~15 min (three missed ticks) to avoid false
  alarms on a slow tick. **This should rank above new features** — every layer above
  ingestion silently degrades to confident answers over stale data when it breaks.
- **Gmail pagination untested.** `apps/api/src/ingestion/gmail.ts` sets `maxResults: 100`
  (list) and `500` (batch). The 3-day catch-up landed 79 in one tick, under the page size, so
  the pagination path has still never been exercised. If a future large catch-up appears
  capped at exactly 100, that's the first suspect. Not chased.
- **Log aggregation** specifics — not decided.
- **`marionette/src/schema.ts`** has one leftover comment mentioning "opencode"
  conceptually — cosmetic, not fixed.
- **`whisper/Dockerfile.bak` — RESOLVED** (`7cb895d`): now gitignored, so it can't sneak
  into a commit. The broader discipline still holds — **`git add` by explicit path, never
  `-A`** — but this specific reinfection hazard is defused.
- **Telegram bot token — rotated once already, mid-build.** The first-issued token was
  pasted in plaintext in chat before the integration was even wired up; it was rotated
  immediately via BotFather and the new token went straight into `.env` without being
  pasted here. Worth normalizing this reflex (rotate-on-exposure, never wait) for any future
  credential handling.
- **`audit_log` doesn't tag request origin/interface.** A `marionette.think` row looks
  identical whether it came from a direct API call, a test script, or a Telegram message.
  Not a problem yet at single-user scale, but worth a `source` or `channel` field in the
  audit payload before there's ever more than one command interface or user to disambiguate.
- **No conversation memory across Telegram messages — RESOLVED (`e62ff01`, migration
  `0009`).** The history tier ships: `messages` table + `marionette/src/memory.ts`, last
  12 turns / 6000 chars injected before the user turn on any `/think` carrying a
  `conversation_id`; Telegram passes `String(chatId)`. **Not Qdrant** — the earlier guess
  that this would need vector recall was wrong for the actual need; a recent-window read off
  an indexed Postgres table is simpler, exact, and cheap. Marionette owns the write (§9 —
  history is an input to reasoning); api relays the id only, so a future interface gets
  memory without reimplementing it. Absent id = stateless, byte-identical to before. See the
  conversation-memory subsection in §4.
  - **Follow-on, NOT built:** memory is scoped to a single `conversation_id`. There is no
    cross-conversation recall, no summarization of old turns, and no eviction/retention
    policy — `messages` grows unbounded. None of these bite at single-user scale; revisit
    when a second interface exists or the table gets large enough to notice.
- **Telegram webhook has no rate limiting or replay protection beyond the secret-token
  header and user-ID allow-list.** Low risk at single-user scale with a Bypass-scoped path,
  but worth revisiting if this interface's trust boundary ever expands.
- **`/think` audit-sight integration — RESOLVED** (`27f18b3`). Design fork decided in favor
  of **(B) pre-fetch injection** over (A) a tool-call loop, because `deepseek.ts`'s
  `callDeepSeek` hardcodes `response_format: json_object`, sends no `tools` array, and
  surfaces no `tool_calls` — (A) would have needed a whole second code path + a second model
  call. Keyword gate (`system-sight.ts`) → in-process `auditSummary(60)` → compact injected
  block → single `callDeepSeek`, existing `normalizeDecision` untouched, sight-read failure
  degrades gracefully. Verified end-to-end from the Telegram app. See §4. **Follow-on worth
  noting** (not blocking): the keyword gate is blunt — a system-status question phrased
  outside the pattern list falls back to the honest "can't see" reply. Widen the list or
  revisit (A) if that becomes annoying. (A) remains a clean future upgrade if Mari should
  ever decide *for herself* when to look — nothing here forecloses it.
- **M4 action `succeeded` = deploy 202 accept — RESOLVED** (M4 Task A, `80298a4`/`8ac171c`).
  Deploy job now polled to true completion via `audit_log`; ✅/❌ pushed to Telegram via a
  thin `api` notify endpoint. The confirmation now reflects real deploy finish, not just
  acceptance.
- **M4 `commit_deploy` git-commit half unwired.** (M4 Task B — STILL OPEN.) Execute deploys
  current repo state; contractor doesn't commit first (`TODO(steering/commit)` in
  `actions.ts`).
  - **M4 Task B — commit_deploy git-commit/push — RESOLVED** (`1cdd19f`). See §4, §6.
- **Self-deploy watcher gap — RESOLVED (`0af75f0`).** A `commit_deploy`
  targeting `service:"marionette"` used to tear down the marionette container
  mid-`watchDeploy`-poll, stranding the action `executing` forever (hit by
  actions 7 and 9, both manually resolved). Fixed by deleting the in-marionette
  watcher/poll entirely and moving the terminal action-state write + Telegram
  notify into `deploy`'s runner (`resolveAction`), called at all six terminal
  branches of `runJob`. `deploy` can't be targeted by a job, so it's immune to
  the teardown, and it has the outcome firsthand (no polling). Gated on
  `job.actionId` (raw deploys touch nothing) and strict-guarded
  `WHERE id=$1 AND status='executing'` (idempotent). `rolled_back` maps to
  action `failed`. Verified live: action id=10 self-resolved to `succeeded` +
  Telegram push, after marionette was recreated mid-flight.
- **deploy's root-owned git objects — RESOLVED (`e54afc4`).**
  This issue is now resolved by commit `e54afc4` ("fix(m4): run deploy container as non-root node user, joined to docker gid 983"). The deploy container was updated to use `USER node` in its Dockerfile, so it runs with uid=1000, matching the host user `spaghettios`. As a result, any git operations inside the container (like `git commit`) write objects with host ownership `spaghettios:spaghettios`, not root. Verified live: all `.git/objects/*` entries on the host are owned by `spaghettios`. No manual `chown` needed anymore.
- **M2 "what changed" view — RESOLVED** (`5955d8d` + `0004`/`b905e4b`, M2 now complete). The
  Gmail zero-width-padding **snippet polish still remains** — cosmetic, not blocking, applies
  to both the "Recent email" and "What changed" feeds.
- **Parked branch `slice1-image-rollback` (`0cf613e`) — UNMERGED, UNVERIFIED.** Refactor of
  `deploy/src/runner.ts` swapping git-checkout rollback for Docker-image-preservation. On its
  own origin branch, not `main`, not isolation-tested, not confirmed running. Do NOT build on
  it. Verifying it requires deliberately forcing a failed deploy — a future dedicated
  session. `main` still uses the scoped-git-checkout rollback (`52c3f72`).
- **Audit-sight Tier 2 (DB/ingestion influx detection) and Tier 3 (host CPU/mem/disk
  metrics) not built.** Tier 2 reads `emails`/`calendar_events`/`sync_state` directly (note:
  ingestion still doesn't write to `audit_log`, so counts come from tables) — same read-tool
  pattern as Tier 1, and overlaps naturally with the M2 "what changed" view. Tier 3 needs
  host access, which lives in `api` not marionette (backend-only) — so a thin api-side read
  endpoint marionette calls, or proper metrics infra (cAdvisor/node-exporter). Decide
  cheap-path vs proper-infra when reached.
  - **Mari's homelab "hands" — hand #1 SHIPPED, hand #2 blocked.** Option C: a small set of
  fixed, named actions Mari can propose/execute, each a new `kind` in the existing M4
  `actions` lifecycle (NOT a parallel mechanism), widened deliberately. Reading real
  `runner.ts` (`d5c033f`) settled the shape:
  - ✅ **First hand = `service-restart` — SHIPPED, verified live (`12b0211`).** (chosen over
    `update_docs` for #1 — it has zero generation step, so it proves the whole new muscle with
    nothing unresolved in the middle). Fixed intent `{service}`, target constrained to the
    `{api, contractor, marionette}` allow-list at propose time (never postgres/qdrant/
    cloudflared). Production zone, approval-gated (M4 tap), no auto-execute. Built as
    `runRestartJob` dispatched by `job.kind` in deploy; verified end-to-end via contractor
    (direct API) and marionette (real Telegram Approve tap, incl. the self-teardown edge held
    by `0af75f0`). See the Milestone 5 subsection in §4 for the 4 committed changes.
  - **Deploy-side shape (as built):** a SEPARATE `runRestartJob(job)` beside `runJob`,
    dispatched in `pump()` by the `job.kind` field (existing enqueues default to `'deploy'`).
    Reuses the primitives (`run`, `pollHealth`, `audit`, `resolveAction`) but owns its short
    flow — `runJob`'s build→health→rollback assumptions don't fit a restart, and threading
    guards through it would risk the trusted `commit_deploy` path. `enqueue`'s `SERVICE_HEALTH`
    gate still applies, so the allow-list guardrail is free.
  - **Restart health semantics (as built):** a restart that comes back unhealthy has NO
    last-good to roll back to (nothing changed on disk) — terminal state is just `failed` +
    notify, a human-intervention event, not auto-recover. Confirmed and shipped as designed.
  - **api-restart notify edge (held):** restarting `api` kills the notify relay mid-push, but
    `notifyTelegram`'s ~40s retry already covers exactly this case (the commit_deploy-of-api
    scenario). No new stranding risk; `marionette` restart is fine (deploy owns the terminal
    write per `0af75f0`).
  - **Invocation (as built):** human-triggered — Mari proposes → `/telegram/surface/:id` →
    Approve tap → execute. The CONDITION under which Mari self-proposes a restart is
    deferred; row shape already supports it via `proposed_by`.
- **`update_docs` generation source — OPEN, now the thing blocking hand #2.** With hand #1
  (`service-restart`) shipped, this fork is the immediate blocker on hand #2. The valuable
  part (regenerating Bible/STATUS *prose* to match reality) is the part that needs Mari's
  reasoning (§9) — and also the part most likely to LOSE hard-won detail (the exact failure
  the Copilot agent already causes). Two paths: (A) marionette generates the prose from
  box state (§9-pure, architecturally right, operationally risky — wholesale LLM regen can
  hallucinate away detail); (B) a deterministic box script templates the mechanical parts
  (counts/HEAD/service table) and deploy just commits it (no §9 concern, but can't touch
  the narrative — which is basically what `bin/session-start` already does for STATUS's
  header). Decide in its own session before hand #2 starts.
- **Question-router — RESOLVED (`9700240`).** The (A) tool-call loop vs (B) pre-fetch injection
  fork, which had surfaced three times (audit-sight, MCP, grounded Q&A), is **settled permanently
  as (B)** — but the *gate* in front of (B) is now a model, not a keyword list. One
  `deepseek-v4-flash` classify per `/think` returns `{needs_data, needs_system}`; both hand-written
  gates are demoted to fallback. This is NOT a tool-call loop: the router runs BEFORE reasoning,
  never sees retrieved content, and Mari still does not choose for herself when to look — a clean
  future upgrade if she ever should, and nothing here forecloses it. Cost is one extra flash call
  per `/think` (sub-second, cents/month). **What justified it:** the keyword gate missed a
  document question outright, and a deliberate widening pass STILL missed 3 of 4 natural
  phrasings — the failure was structural, not a bad list. See §4 (marionette) and the §7 lesson.
- **`job.kind` dispatch default — RESOLVED (shipped, `12b0211`).** `job.kind` was introduced
  in deploy with `enqueue` defaulting to `'deploy'`, so every existing enqueue path is
  unaffected; `pump()` dispatches `'restart'` to `runRestartJob` and `'deploy'` to `runJob`.
  Confirmed live via the `service-restart` end-to-end runs.

- **`update_docs` generation source — RESOLVED (`dd4d594`).** Neither horn of the original A/B
  fork was taken; see the §4 hand-#2 subsection. Append-only with a line-conservation guard in
  deploy. The remaining limitation is deliberate: **Mari can add to the docs but cannot correct
  them.** Wrong or stale prose still needs a human edit. If that becomes the dominant failure
  mode, the next move is a *supersede* pattern (append a correction block referencing the stale
  one) — NOT unlocking in-place rewrite.
- **Doc drift is measurable and was worse than assumed.** As of this session the Bible had no
  mention of `marionette/src/memory.ts`, `data-gate.ts`, `question-router.ts`, or
  `ingest-sight.ts` — four files shipped and live. Hand #2 exists to shorten that gap; whether
  Mari should self-propose an `update_docs` on a schedule (vs. only when asked) is still open, and
  is really the same question as M5 auto-execute.

<!-- appended by Mari 2026-07-21 (action 15) -->

- **`officeParser` evaluated for pptx/xlsx and REJECTED (2026-07-21).** Handles docx/pptx/xlsx/pdf in
  one dependency, but installs at **128M**: a duplicate `pdfjs-dist` (35.8M, exact-pinned) alongside
  the `unpdf` already in use, plus hard deps on `tesseract.js`, `file-type`, and `@xmldom/xmldom`.
  xlsx was scoped out and pdf/docx stay on unpdf/mammoth (both verified live), so officeParser's
  value was breadth already scoped away. **`fflate` + `@xmldom/xmldom` chosen instead at ~2M.** OCR
  remains a deliberate later slice; do not relitigate without a new reason.
- **Mari reasoned to "propose" but emitted `decision: "reply"` — RESOLVED (`056fb97`).**
  Originally logged 2026-07-21 as an undiagnosed "silent proposal-drop" bug. That diagnosis was
  WRONG. There was no drop: there was no path. `SUPPORTED_DECISIONS` held only
  `reply|delegate`, so any model output of `propose` was coerced to `reply` by
  `normalizeDecision`, narrated into `message`, and no `actions` row was ever written. Action
  rows were reachable only via `POST /actions`, which `/think` never called. Fixed by adding
  `propose` as a third decision kind: `validateActionIntent` extracted into `actions.ts` and
  called from BOTH doors (one rule, one place — rejected `/think` self-`fetch`ing its own
  `POST /actions`, which adds an HTTP hop and an audit row that lies about the caller);
  `PROPOSABLE_KINDS = ['service-restart','update_docs']` deliberately separate from deploy's
  own list (it is what the MODEL may reach for, not what the system can execute); malformed
  propose degrades to reply and never 502s, mirroring the delegate contract. Propose ≠ execute:
  `createAction` writes status `proposed` and nothing in `/think` executes. **The row is the
  truth, the prose is not — verify every proposal against the `actions` table, never against
  Mari's reply text.**

- **Action terminal status is written from the 202, not the ledger — OPEN (2026-07-22).**
  `actions.status` reaches `succeeded` on the strength of deploy's HTTP `202 Accepted`, not on a
  `deploy.succeeded` audit row. Evidence: rows 10–16 have `result` holding only
  `{"accepted": 202, "status": "running"}` — the accept envelope. Only rows 4/5/6 carry a real
  `outcome.state: succeeded` plus a commit SHA. **And the terminal transition is never audited:**
  `action.proposed` / `approved` / `executing` / `deploy_accepted` / `denied` all emit audit rows;
  there is NO `action.succeeded`. For action 14 the ledger runs 2679→2688 and simply stops after
  `deploy.succeeded`, while the table says `succeeded` with `updated_at` matching that audit row
  to the microsecond — the write happened, it just left no trace in the one ledger.
  **Consequence:** a deploy that 202s and then fails leaves a row reading `succeeded` next to a
  `deploy.failed` in `audit_log`. Audit id 2678 is exactly that failure (`docs`, reason
  `no blocks supplied`) and escaped only because its `action_id` was null. Actions 7 and 9 already
  carry hand-written `"note": "manually resolved"` in `result` — this class was patched twice by
  hand before it was named.
  **Same failure class as the propose gap (`056fb97`): state written from an assumed signal rather
  than the authoritative one.** Fix direction (not yet built): the action row's terminal status
  must be set by the deploy outcome watcher keyed on `action_id`, and must emit
  `action.succeeded` / `action.failed` so the ledger is complete. Until then, never trust
  `actions.status` alone — join it against `deploy.succeeded`/`deploy.failed` on `job_id`.

<!-- appended by Mari 2026-07-21 (action 16) -->

<!-- MARI:APPEND §8 -->

---

## 9. Guardrails to prevent contradiction/duplication

1. **One AI brain.** All classification/reasoning/generation goes in `marionette`. A
   prompt-calling function in `apps/api` belongs in marionette instead, with api calling
   marionette's HTTP endpoint. **Whisper is not an exception** — it does pure transcription
   only, no interpretation; any future step that reasons about transcribed text belongs in
   marionette, not in the whisper service or the Hammerspoon client. **Telegram is not an
   exception either** — the webhook route in `api` does no reasoning of its own; it's a thin
   forward-and-relay to marionette's existing `/think`, identical in spirit to how
   `opencode.ts` proxies to the OpenCode server rather than reimplementing anything. **The
   M2 dashboard is not an exception** — it's a pure read/render over Postgres; the moment a
   view needs classification or a generated summary, that logic lives in marionette and the
   dashboard calls it, never a prompt-caller in `api`.
2. **One build/deploy system.** `deploy` already has queueing, health polling, audit-backed
   rollback. Milestone 6's git automation is an *extension* of `deploy`, not a parallel
   service.
3. **Schema before code.** Check `0001_secretary_ontology.sql` before adding a column —
   `emails.category`/`importance` already exist. (The M2 dashboard added no columns — pure
   read.)
4. **`audit_log` is the one ledger.** Deploy actions and AI actions both write here — this
   includes Telegram-originated requests, since they flow through the same
   `marionette.think`/`marionette.delegate` audit points as any other caller. No second "AI
   decisions" table, and no separate "Telegram log."
5. **Local vs. pushed state.** `git status` at the start of every session.
6. **Two-zone autonomy, refined:**
   - **Sandbox zone** (marionette → contractor → OpenCode): full filesystem/build autonomy
     by design. Bentley doesn't use OpenCode interactively, so there's no
     human-in-the-loop cost to preserving. Enforced today via `opencode.json`'s permission
     policy (§4) — allow everything except a short deny-list of catastrophic `rm -rf`
     patterns. **Telegram is a new front door into this same zone, not a new zone** — a
     message from the allow-listed user has exactly the same reach as a direct `/think` API
     call, no more, no less.
   - **Production zone** (real Gmail, real deploys, anything outside the sandbox):
     default-deny for side-effecting actions, governed by an explicit allow/deny list
     (Milestone 4). Contractor writing a file today is sandbox; nothing auto-promotes that
     to production without the Milestone 4 approval gate. This is unaffected by the
     Telegram interface — commanding marionette from Telegram doesn't unlock any
     production-zone capability that didn't already exist. **The M2 dashboard is read-only —
     it surfaces production data but takes no side-effecting action, so it sits outside the
     autonomy question entirely.**
   - **External comms are never in scope for autonomy, in either zone.** No
     email/messaging/external-comms MCP or tool is wired to contractor. If one ever is, it
     ships with an explicit deny in the permission policy from day one — never relying on
     "it just doesn't have that tool" once the tool exists. **Telegram's `sendMessage` call
     in `api` is not an exception to this rule** — it is a fixed, single-recipient
     reply-to-the-allow-listed-sender mechanism embedded in one route, not a general-purpose
     messaging capability exposed to contractor or marionette's decision-making. Marionette
     cannot choose to message anyone; it can only return a `message` string that `api`
     relays back to whoever sent the original request.
