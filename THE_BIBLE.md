# Bentley OS — The Bible

*The single source of truth. Rules, architecture, project map, current state — all here.
When this conflicts with anything older, this wins. Regenerate from the repo whenever it
drifts; don't hand-edit it into staleness.*

*Last verified: 2026-07-13 (HEAD `a0ced26`. **Milestone 3's AI layer now has four slices
live: the Clair email classifier, the priority-triage dashboard render, the email embedding
pipeline, AND grounded Q&A.** This session shipped **grounded Q&A**: a keyword gate
(`marionette/src/data-gate.ts`, `isDataQuestion()`, mirrors `system-sight.ts`'s
`isSystemStatusQuestion` pattern) detects data questions ("email about", "did i get",
"invoice", "receipt", etc.), triggering `marionette/src/retrieve.ts`'s `retrieveContext()`:
embeds the request via the now-exported `embedText()` (reused from `embed.ts` — same model,
same embedding space as the stored vectors), searches Qdrant top-10, then SELECTs real
bodies back from Postgres by id. Wired into `/think` as a second pre-fetch injection block
(same shape as audit-sight), degrading gracefully on failure. **Confirmed working
end-to-end against the live production container** — a real question ("did I get any email
about an invoice or receipt recently?") returned a grounded answer citing real subjects/
amounts/dates (Cloudflare, Anthropic, DigitalOcean, Nous Research, Rentec Direct), and a
sanity check ("what is 2+2?") confirmed the gate correctly does NOT fire on non-data
questions. **A separate, previously-hidden bug was also fixed this session:** DeepSeek's
`deepseek-v4-pro` sometimes leaks a `<think>...</think>` reasoning trace (and occasionally a
stray `<｜end▁of▁thinking｜>` token, sometimes with the JSON object duplicated) even in
`response_format: json_object` mode — this silently broke `index.ts`'s `JSON.parse` and fell
through to the raw-string fallback, delivering garbled text as `message`. Never surfaced
before because no prior `/think` response was complex enough to trigger the leak; the
retrieval feature's longer context finally exposed it. Fixed at the source in
`marionette/src/deepseek.ts`: `callDeepSeek` now strips `<think>` blocks and stray special
tokens, then extracts the first balanced `{...}` object before returning `content` — the
function's contract (a clean JSON string) is unchanged, so no caller needed to change.
**Qdrant `emails` collection now holds 766 points** (up from 755 at last verification — new
mail has been ingested/embedded since; the embed backlog-drain is still not automated, see
§8). Deployed via audited `POST /deploy {"service":"marionette"}` (job `97b27e56`, confirmed
`deploy.succeeded`, commit `a0ced26`, no rollback), verified end-to-end against the real
running container post-deploy. Clair (`marionette/src/classify.ts`, `5d45b8d`) remains the
two-pass consequence classifier (`POST /classify`); the priority-triage dashboard render
(`532493a`) is live. Milestone 2 remains COMPLETE. Milestone 4 Task A DONE (async
deploy-completion → Telegram, `80298a4`/`8ac171c`); M4 gate slice + marionette audit-sight
live. **Open incident carried forward:** two unidentified commits (`e06ed72`/`449a9b7`,
"Hello"→"Goodbye" print edits) landed on `origin/main` via the GitHub web UI from an
unidentified actor; `091c8e0` restored the corrupted Bible file, but the SOURCE was never run
down — see §8.)*

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
**And again during the grounded-Q&A build:** the retrieval pipeline looked done (real,
correctly-cited answers) while a completely separate bug — DeepSeek's thinking-trace leak —
was silently corrupting the delivered `message` field; only reading the actual JSON response
end-to-end (not just checking that retrieval ran) caught it.

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
  Don't guess a response shape from a route name; hit the real endpoint and look. **Same
  discipline caught the retrieve.ts SQL bugs and the DeepSeek thinking-trace bug** — neither
  surfaced until the real end-to-end output was actually read, not just the "did it run
  without throwing" check.

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
   to-text) is a deliberate, narrow exception — see §0. **Grounded Q&A's retrieval-time
   embedding call reuses the same OpenAI `embedText()` as the storage-time pipeline — no new
   embedding model or local inference was introduced to build it.** An earlier plan to gate
   data-questions via a local `all-minilm` embedding model (a new `local-ai` service, Vulkan
   on the RX 5700 XT) was explicitly abandoned in favor of a plain keyword gate — simpler, no
   new service, no exception to this rule needed, no untested GPU/Vulkan risk. See §8.
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
- **A model's JSON-mode output still isn't guaranteed clean JSON.** DeepSeek's
  `response_format: json_object` can still leak a `<think>...</think>` reasoning trace or
  stray special tokens around the real JSON object, and can duplicate it. Any code that
  calls a reasoning-capable model in JSON mode should sanitize/extract the JSON object
  before parsing, not assume `response_format` alone guarantees a clean parse. See §7.

---

## 3. System map — who does what

One `docker-compose.yml`, two networks (`backend` for services, `monitoring` for ops
tooling). Every service has exactly one job. **If a new feature doesn't obviously belong to
one row, stop and decide before coding — don't let it leak into two services.**

| Service | Port | Owns | Does NOT own |
|---|---|---|---|
| **postgres** | 5432 (LAN only) | All persisted state — ontology, sync tokens, audit log | Vector search (qdrant) |
| **qdrant** | 6333 (LAN only) | Vector storage for embeddings — **`emails` collection, 1536-dim cosine, 766 points, written by `marionette/src/embed.ts`, read by `marionette/src/retrieve.ts`** (derived index over `emails.body`, keyed on email id) | Reasoning (marionette's job); the source-of-truth body (that stays in Postgres) |
| **redis** | 6379 (LAN only) | Caching / ephemeral state | Unused by any service yet |
| **api** | 3000 | HTTP surface: `/health`, **dashboard (`/` — server-rendered "What changed" (deltas since last look) + "Today" (today's calendar events) + recent email, reads Postgres directly via the `pg` pool)**, ingestion (gcal/gmail → Postgres, scheduled via node-cron every 5 min), OpenCode proxy (`/opencode/*`), **Telegram webhook (`/telegram/webhook`) → handles both text messages (→ marionette `/think`) AND button taps (`callback_query` → marionette `/actions/:id/approve|deny`); plus internal relay `POST /telegram/surface/:id` that pushes a proposed action to the allow-listed chat with inline Approve/Deny buttons** | Build/deploy logic, AI reasoning, action lifecycle state (marionette owns that) |
| **deploy** | 4000 (127.0.0.1) | Build + restart + health-check + auto-rollback for `api`, `contractor`, `marionette`; writes every action to `audit_log` | *What* code does — purely CI/CD operator. **Does not cover `whisper`** (see §4) |
| **contractor** | 4100 (`backend` only) | The coding/build layer. `POST /execute` — real `@opencode-ai/sdk` session + prompt against the systemd OpenCode server, audited. Full sandbox-zone autonomy (see §9) | Orchestration, ingestion, deploy |
| **marionette** | 4200 (`backend` only) | The orchestrator. `POST /think` — DeepSeek reasoning, structured decision (**response shape: `{decision: {decision, message, reasoning}}`, nested — not flat**), audited. Can `reply` or `delegate` to contractor — build-machine keystone, verified end-to-end incl. real multi-step tool-call tasks, driven live from Telegram. **Also owns the M4 action lifecycle: `actions` table state transitions via `POST /actions`, `GET /actions[?status=]`, `GET /actions/:id`, `POST /actions/:id/approve`, `POST /actions/:id/deny`. And `GET /audit/summary?window=<min>` — Mari's read-only "sight" over her own `audit_log`, consumed by `/think` for system-status questions. AND `retrieve.ts`/`data-gate.ts` — grounded Q&A over real email content via Qdrant retrieval, consumed by `/think` for data questions ("did I get an email about...")** | Ingestion (api's job), deploy (deploy's job) |
| **whisper** | 4300 (`backend` only, exposed publicly via `whisper.bentleyos.me`) | Self-hosted speech-to-text. `whisper.cpp`'s `whisper-server` binary, `POST /inference` (multipart, field `file`) → `{"text": "..."}`. Currently running the `base` model | AI reasoning (that's marionette's job) — whisper is pure transcription, no interpretation |
| **cloudflared** | — | Public tunnel, gated on `api` health | — |
| **portainer / dozzle / uptime-kuma** | 9000 / 8080 / 3001 | Ops visibility | Nothing app-level |

**Rule of thumb:** ingestion + read APIs (incl. dashboard views) live in `api`; AI reasoning
lives in `marionette`; anything touching `docker compose` or git lives in `deploy`. Task
mentions two of these → split the ticket. **Telegram fits this rule cleanly: it's just
another HTTP surface on `api`, forwarding to marionette's existing reasoning endpoint — no
new reasoning logic was added anywhere.** **The dashboard fits it cleanly too: it's a pure
read view over Postgres in `api`, no reasoning — any future "insight" that requires
classification/generation belongs in marionette, not the dashboard route.** **Grounded Q&A
fits it too: retrieval (embed query, search Qdrant, pull bodies) and the keyword gate both
live in marionette; api never touches email content directly for this feature.**

**Cloudflare/networking gotcha:** `cloudflared` runs in a container on `backend`. It reaches
app services by container name (`http://api:3000`), host services (SSH) by LAN IP
(`172.16.30.4:22`). It **cannot** use `localhost` to mean the host.

**Same gotcha class:** `contractor` reaches the real systemd OpenCode server via LAN IP
`172.16.30.4:4096`, never `127.0.0.1` — a service bound to loopback only is unreachable from
any other container regardless of shared network. **Qdrant is bound to `127.0.0.1:6333` on
the host** — not LAN-reachable at `172.16.30.4:6333` despite earlier doc wording; test it
only from inside the `backend` docker network (`http://qdrant:6333`), matching how the real
services reach it.
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

**Current utility services:** `redis` (cache), `qdrant` (vector index — now populated AND
actively queried: the `emails` collection holds one 1536-dim vector per embedded email
(766 points), a derived index over `emails.body`; the body itself stays in Postgres, the one
source of truth; retrieval SELECTs it back by id at query time), `portainer` / `dozzle` /
`uptime-kuma` (ops visibility), `deploy` (build/rollback — audits *to* `audit_log`, doesn't
own a fact of its own).
---

## 4. Current state (living — what actually exists on the box right now)

Running on the box at `~/bentley-os` (Ubuntu, LAN IP `172.16.30.4`). Absolute path is
`/home/spaghettios/bentley-os` — always exact, never an alias (see §7 bind-mount lesson).

**Infrastructure — all up:** api (healthy, 3000), postgres (healthy, 5432), redis (6379),
qdrant (6333/6334 — reachable from `backend` network, `emails` collection with 766 points,
actively used by both the embed pipeline and the retrieval query path), cloudflared, dozzle
(8080), portainer (9000/8000/9443), uptime-kuma (healthy, 3001), deploy (healthy, 4000 /
127.0.0.1), contractor (healthy, 4100, backend only), marionette (healthy, 4200, backend
only), whisper (healthy, 4300, backend only, `base` model).

**No local `embedder` service exists, by design — embeddings are an external API call.**
The embeddings-provider decision is **RESOLVED = OpenAI `text-embedding-3-small`** (1536-dim,
cosine), consistent with §2.4 (API-only, no local inference). `OPENAI_API_KEY` in `.env`.
The pipeline lives in `marionette/src/embed.ts` (`POST /embed`) — see the embed subsection
below. `embedText()` is now **exported** (previously private) so `retrieve.ts` can reuse the
exact same embedding call/model for query-time embedding — query and stored vectors share one
embedding space by construction, not by convention. **Local embeddings were considered and
deliberately deferred:** a small local model (BGE-M3/Jina on the box's idle AMD RX 5700 XT)
would arguably fit the whisper-class exception (small, mature, no frontier need) and keep
email bodies off OpenAI's servers (privacy). But cost is a non-argument — embedding all 755+
emails is ~2¢ one-time, well under $1/yr ongoing — so the only real driver for local would be
privacy, and it carries the same unfinished ROCm/HIP GPU-setup cost parked for whisper (§8).
Chose OpenAI to ship a working pipeline now; `embedText()` in `embed.ts` is a clean
single-function swap seam if privacy ever wins. See §8.

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
M3 — `embedded_at` on `emails` + `idx_emails_unembedded`), all applied live. Migrations live
at `supabase/migrations/` (six files, `0001`–`0006`). **Grounded Q&A (this session) added NO
new migration** — retrieval is a pure read over existing `emails` rows (SELECT by id), no new
column or table; see §5.
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
  `0006`). **766 points now live in Qdrant (up from 755) — new mail has been ingested and
  embedded since the last full-backlog verification; live counts should be re-checked
  whenever they matter, not assumed from this doc.**
  (Classification is a separate axis from embedding and from retrieval — retrieval reads
  `body` directly, does not depend on `classified_at`/`importance`/`category` being set.)
- `calendar_events` live columns confirmed: `id` (uuid), `source`, `source_id`, `title`,
  `description`, `location`, `starts_at` (indexed), `ends_at`, `organizer_id` (→ people),
  `status`, `created_at`, `updated_at`. `organizer_id` and `event_attendees` are now
  **populated** — see Milestone 1 status below.
- `audit_log` columns: `id` (bigint identity), `at` (timestamptz, default now()), `actor`,
  `action`, `target` (nullable), `outcome` (nullable), `payload` (jsonb, default `{}`).
  Indexes on `action` and `at DESC`. Real rows now exist from deploy activity,
  `marionette.think`, `marionette.delegate`, `marionette.classify` (Clair — one row per
  email classified, `target` = email id, `payload` = importance/category/confidence/passes),
  `marionette.embed` (one row per email embedded, `target` = email id, `payload` = model/dim),
  and `contractor.execute` — **including rows originating from Telegram messages**,
  indistinguishable in `audit_log` from any other `/think` caller (the audit trail doesn't
  currently tag which interface originated a request — see §8). **Retrieval itself does not
  write its own audit rows** — a data-question `/think` call still produces exactly one
  `marionette.think` row (same as any other `/think` call); the retrieval step is an
  in-process pre-fetch, not a separately-audited action, matching how audit-sight's
  `auditSummary` read is also unaudited-in-itself. Ingestion (gcal/gmail) does **not**
  currently write to `audit_log` — stdout only. Open item.
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

**Milestone 3 — AI layer (read-only) — classifier + triage render + embeddings + grounded
Q&A all done, live:**
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
  - **Live data (last checked in an earlier session — re-verify counts before relying on
    them, per §8):** 93 of 778 emails classified. Tier spread over the classified set: ~3
    high (≥70) / ~11 mid (40–69) / rest noise (<40), with natural score gaps at the 70 and 40
    boundaries. Top items correctly float up: GitHub token-expiry (90), Google security
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
- **Email embedding pipeline** (`a46d8ce` + `2947a9b`, migration `0006`) — OpenAI
  `text-embedding-3-small` (1536-dim, cosine) → Qdrant `emails` collection, via
  `marionette/src/embed.ts` + `POST /embed {"limit":N}`. Mirrors the classify pattern
  exactly: batch-bounded, per-row independent audit (`marionette.embed`), one bad row can't
  sink the batch. Input cap = 8000 chars (`MAX_INPUT_CHARS`) — a prior 24000-char cap
  conflated *chars* with 3-small's *8192-token* limit, 400'ing on token-dense emails; fixed
  in `2947a9b`. Embeddings-provider decision **RESOLVED = OpenAI 3-small** (§8). Backlog
  fully drained as of last full check (755/755); **766 points live now** — new mail keeps
  arriving and getting embedded, though the cron doesn't auto-embed yet (see below).
- **Grounded Q&A — shipped THIS SESSION, done, live:**
  - **`marionette/src/data-gate.ts`** (new) — `isDataQuestion(request)`, a keyword gate
    mirroring `system-sight.ts`'s `isSystemStatusQuestion` exactly in shape (lowercased
    substring match against a hand-picked phrase list: "email about", "did i get",
    "invoice", "receipt", etc.). Conservative by design — a miss just means the honest "I
    don't have that" fallback rather than a wrong answer. Also exports
    `formatRetrievalForPrompt(hits)`, which turns retrieval hits into a compact system-prompt
    block (subject + truncated body per hit).
  - **`marionette/src/retrieve.ts`** (new) — `retrieveContext(request)`: embeds the request
    via the now-exported `embedText()` (same model/space as stored vectors), searches Qdrant
    `POST /collections/emails/points/search` (top-10, `with_payload:false`), then SELECTs the
    real bodies back from Postgres by id, capped ~1200 chars per email in the formatted
    block (mirrors classify.ts/embed.ts's "stakes near the top" truncation reasoning). **The
    working Postgres IN-list pattern is `where id in ${sql(ids)}`** — NOT
    `sql.array(ids)::uuid[]` with `any()` (that produced a malformed-array error, then a
    `uuid = any(text[])` type mismatch, error 42809). See §7.
  - **`marionette/src/index.ts`** — new gate block in `/think`, mirrors the audit-sight
    block exactly: if `isDataQuestion(request)`, `await retrieveContext(request)`, push the
    formatted result as a `system` message. Wrapped in try/catch — a retrieval failure logs
    and falls through, never sinks `/think`.
  - **`marionette/src/prompt.ts`** — widened with a `RETRIEVED EMAIL CONTEXT` block
    instructing Mari to use it as the sole source when present, say plainly when it's
    empty/absent, and never invent email content beyond it (same "widen the prompt with the
    capability" rule as audit-sight).
  - **`marionette/src/embed.ts`** — `embedText` changed from a private helper to an
    **exported** function so `retrieve.ts` can call the exact same embedding logic — one
    embedding space, one code path, no drift risk between storage-time and query-time
    vectors.
  - **A separate, previously-hidden bug was found and fixed in the same session:**
    `marionette/src/deepseek.ts`'s `callDeepSeek` now strips `<think>...</think>` reasoning
    traces and stray `<｜...｜>` tokens, then extracts the first balanced `{...}` object,
    before returning `content` — DeepSeek's `deepseek-v4-pro` was leaking thinking traces
    (and occasionally duplicated JSON) even in `response_format: json_object` mode, which
    silently broke `JSON.parse` and fell through to a raw-string fallback that delivered
    garbled text as the `message` field. Never surfaced before this feature because no prior
    `/think` call was complex/long enough to trigger the leak. Fix is fully contained in
    `deepseek.ts` — the function's contract (clean JSON string) is unchanged, so `index.ts`
    and `schema.ts` needed zero changes. See §7.
  - **Isolation-tested twice** (throwaway `docker build -t marionette-retrieve-test
    marionette` + `docker run` on `bentley-os_backend` + `.env`, probed via in-container
    `node -e fetch` — no curl in `node:22-slim`): once before the DeepSeek fix (retrieval
    correct, but `message` field garbled — this is how the DeepSeek bug was caught), once
    after (both the invoice-query test AND a "what is 2+2?" sanity check — confirming the
    gate correctly does NOT fire on non-data questions — came back clean).
  - **Deployed** via audited `POST /deploy {"service":"marionette"}` (job `97b27e56e`,
    confirmed by `deploy.succeeded` audit row, commit `a0ced26`, no rollback). **Re-verified
    against the real running production container post-deploy** with the same invoice-query
    question — confirmed clean, correctly-cited real answer.
  - **Commit:** `a0ced26` (`feat(m3): grounded Q&A — Qdrant retrieval + fix DeepSeek
    thinking-trace JSON parsing`).
- **Still open in M3:** (1) **backlog drains not automated** — the 5-min ingestion cron does
  NOT auto-classify or auto-embed new mail; wiring `classifyBatch` AND `embedBatch` into the
  cron is the natural next slice. (2) **Morning brief** — not built. (3) **Chunking**
  deferred to first long-form ingestion source (PDFs/web) — email is one vector, no chunk
  needed. (4) **Snippet zero-width-padding polish** (cosmetic, carried from M2) still open.
  (5) Grounded Q&A currently has **no conversation memory** — each `/think` call, including
  data questions, is stateless; "what about that one" as a follow-up means nothing yet (same
  limit noted for Telegram generally, see §8).

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
- **Live rows:** id=1 (`commit_deploy`, succeeded), id=2 (denied), id=3 (succeeded) — all
  terminal. Next new action = id=4.
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
- **Still unwired — M4 Task B:** the git-commit half of `commit_deploy` — execute currently
  just deploys from current repo state; contractor doesn't commit first yet
  (`TODO(steering/commit)` in `actions.ts`).
- **Commits:** `3a66aef` (propose/approve/deny/execute lifecycle) + `b13c5ce` (Telegram
  buttons + surface endpoint) + `80298a4`/`8ac171c` (async completion → Telegram push).

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
  `callDeepSeek`/`normalizeDecision` left untouched. **Grounded Q&A's retrieval gate reuses
  this exact same (B) pre-fetch-injection shape** — a second independent proof the pattern
  generalizes cleanly to new "give Mari sight over X" features.
- **`marionette/src/system-sight.ts`** — the bridge between the raw read
  (`audit-read.ts`) and the reasoning (`/think`). Two pure functions, no DB access of its
  own:
  - `isSystemStatusQuestion(request)` — a **keyword gate** (lowercased substring match
    against a hand-picked phrase list: "what have you done", "done today", "system status",
    "anything failing", "did the deploy", etc.). Conservative by design: a miss just falls
    back to the honest "I can't see that" reply — never a wrong answer, only a missed one.
    Gate does NOT fire on coding/other requests, so they're not polluted with audit noise
    (verified: "what is 2+2?" returns a plain answer). **`data-gate.ts`'s
    `isDataQuestion()` is a sibling gate, same shape, for email-content questions instead of
    system-activity questions — the two gates fire independently and can both be silent on
    the same request (e.g. "what is 2+2?" triggers neither).**
  - `formatAuditForPrompt(summary)` — turns `auditSummary`'s structured output into a
    **compact** text block (counts by action/outcome + trimmed one-liners per recent/failure
    row, pulling only useful crumbs like `req`/`job_id`/`error` out of `payload` — NOT the
    raw jsonb, which is big and noisy).
- **`/think` wiring** (`marionette/src/index.ts`): builds a `messages` array; if
  `isSystemStatusQuestion(request)`, does an **in-process** `await auditSummary(60)` (not an
  HTTP call to its own `/audit/summary` — the function is right there in-process), formats
  it, and pushes it as a second `system` message before the user turn. **Sight-read failure
  degrades gracefully** — a `try/catch` around the fetch logs and falls through to the
  no-sight path rather than sinking the whole `/think`. **Immediately after this block, a
  second, independent gate block does the same for `isDataQuestion(request)` →
  `retrieveContext` → `formatRetrievalForPrompt`** (grounded Q&A, this session) — both gates
  can fire on the same request in principle, though no real query has triggered both yet.
  `callDeepSeek(messages)` then flows into the unchanged `JSON.parse` → `normalizeDecision`
  path (with `deepseek.ts`'s new thinking-trace sanitization now happening inside
  `callDeepSeek` itself, before `content` is even returned) — status/data questions resolve
  to `reply`, returning before the delegate branch.
- **`prompt.ts` widened** to match the new capability (§ rule: widen the prompt with the
  capability, never ahead of it). Old blanket "you are NOT the source of truth, never
  present yourself as knowing the state of the homelab" narrowed to the owner's *data*
  (email/calendar/docs); added a `WHAT YOU CAN SEE NOW` block telling Mari she CAN observe
  her own audit ledger, and when a `SYSTEM ACTIVITY` block is present she must narrate from
  it as fact (when absent, fall back to honest limits — don't invent activity). **This
  session added a second block, `RETRIEVED EMAIL CONTEXT`**, with the same "use it as sole
  source when present, admit absence honestly, never invent" discipline.
- **Verified end-to-end from the actual Telegram app**, not just a container probe: real
  "what have you done today?" message → narrated reply naming real timestamped events incl.
  the self-deploy that shipped this very change. Second phrasing ("anything failing?", a
  different keyword) confirmed against the production container post-deploy. **Grounded
  Q&A separately verified against the live production marionette container** (not just
  Telegram) — see the M3 grounded-Q&A subsection above.
- **Commits:** `27f18b3` (`feat(marionette): /think consumes audit-sight — narrates real
  system state`) on top of `9f3f054` (`feat(marionette): audit-sight read endpoint`).

**Whisper — self-hosted speech-to-text, done end-to-end:**
- **Server:** `~/bentley-os/whisper/Dockerfile` builds `whisper.cpp` from source
  (`ggerganov/whisper.cpp`, `whisper-server` target) and bundles a `ggml-*.bin` model.
  Currently **`ggml-base.bin`** (74MB) — reverted from `ggml-small.en.bin` (487MB) after
  small.en proved too slow for daily push-to-talk use on CPU-only inference. `CMD` runs
  `whisper-server -m models/ggml-base.bin --host 0.0.0.0 --port 4300`.
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
- **Service token:** `whisper-laptop`, non-expiring, generated for the Hammerspoon
  push-to-talk client. **Exposed in plaintext in chat multiple times across sessions —
  rotation still not done** (see §8).
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
- **GPU acceleration — not yet explored.** Box has an AMD Radeon RX 5700 XT (confirmed via
  `lspci`), currently running whisper on CPU only. `whisper.cpp` supports a Vulkan backend
  (broader compatibility) or ROCm/HIP (better perf, heavier setup — kernel driver + device
  passthrough + different cmake target) for AMD acceleration. Scoped as a future task, not
  started.

**Git:** `~/bentley-os` is a git repo, `main` branch, private. Remote:
`git@github.com:bentleylujero/bentley-os.git`. GitHub username `bentleylujero`.
Local in sync with `origin/main` at `a0ced26`, working tree clean.
Recent commits (newest first): `a0ced26` (feat(m3): grounded Q&A — Qdrant retrieval + fix
DeepSeek thinking-trace JSON parsing) → `b8780ba` (docs: Bible update w/ Copilot note) →
`2947a9b` (fix(m3): cap embed input at 8k chars) → `a46d8ce`
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

**NOTE on the rollback-fix hash:** older text in this doc (§4 deploy subsection, §8) still
refers to `52c3f72` as the rollback fix. The current impl is `b153b1e` (a `DRY_RUN=1` guard
around the scoped git-checkout, plus deletion of `deploy/src/service-path.ts`). The
`52c3f72`-era behavior — unscoped service aborts, no repo-wide checkout — still holds; only
the commit and the DRY_RUN guard are newer. The parked `slice1-image-rollback` branch
(`0cf613e`) remains unmerged/unverified, unchanged.

**⚠ Unresolved repo-integrity incident:** commits `e06ed72` and `449a9b7` (both "Update print
statement from 'Hello' to 'Goodbye'") landed on `origin/main` via the **GitHub web UI** from
an **unidentified actor** — classic bot/agent smoke-test signature. They also carried
THE_BIBLE.md scrollback corruption, cleaned up by `091c8e0`. **The file was restored but the
SOURCE was never run down** — something was auto-committing through Bentley's GitHub web
session. Cheapest lead not yet pulled: `git log --format='%h %an <%ae> %cn %ci %s'
e06ed72~1..091c8e0` to read the author/committer identity (a `web-flow` committer = GitHub web
editor; any other identity = the culprit). Tracked as OPEN in §8.

**Parked branch — `slice1-image-rollback` (`0cf613e`), UNMERGED / UNVERIFIED. Do NOT build
on it.** An unmerged refactor of `deploy/src/runner.ts` (88+/30−) changing rollback from
git-checkout to Docker-image-preservation. Pushed to its own origin branch, NOT on `main`,
NOT isolation-tested, NOT confirmed running. Testing it means deliberately forcing a failed
deploy — a future dedicated session. Until then, `main`'s deploy still uses the
scoped-git-checkout rollback (`52c3f72`).

**Deploy service** (`~/bentley-os/deploy/`): serialized queue, reads last-good commit from
`audit_log` → build → `up -d` → poll real `/health` over `backend` → success or
auto-rollback, every step audited. `SERVICE_HEALTH` map covers `api`, `contractor`,
`marionette` — **not `whisper`**, which must be rebuilt directly via
`docker compose up -d --build whisper` until it's added to the map. Deploys for covered
services go through `POST /deploy` — never raw compose for those. Most recently used for the
grounded-Q&A + DeepSeek-fix deploy (job `97b27e56`, `deploy.succeeded`, commit `a0ced26`).
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
- **`callDeepSeek` (in `deepseek.ts`) now sanitizes its own output before returning it** —
  strips `<think>` blocks and stray special tokens, extracts the first balanced JSON object.
  Fixes a previously-hidden bug where `deepseek-v4-pro`'s occasional thinking-trace leak
  broke `JSON.parse` downstream and delivered garbled text as `message`. See §7.
- **Can now:** narrate her own system activity (audit-sight) AND ground answers in real
  email content (grounded Q&A, this session). `/think` runs two independent, gracefully-
  degrading pre-fetch gates — `isSystemStatusQuestion` → `auditSummary` for system-activity
  questions, `isDataQuestion` → `retrieveContext` for email-content questions — either,
  both, or neither can fire per request.
- **Still cannot:** chunked/long-form retrieval (email is one vector each; PDFs/web pages
  will need chunking when added, see §8), cross-message conversation memory (`/think` is
  stateless — each Telegram message, including data questions, is a fresh request; "that
  one" as a follow-up means nothing yet), delegation targets beyond contractor, or
  *autonomous* production-zone write actions — the M4 approval-gate layer IS built
  (propose→approve→deny→execute + Telegram buttons, see M4 subsection), but contractor's own
  writes remain sandbox-only and nothing auto-commits/auto-deploys from a delegated task
  without the human approval tap.

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
- Confirmed live: first tick after deploy ran clean, both syncs incremental
  (`fetched: 0, upserted: 0` — correct, since the isolation test had just consumed the
  delta). The M2 dashboard reads the rows this cron lands. **Still does not auto-classify or
  auto-embed new mail** — see M3 open items.

**Milestone 1 gap — resolved.** `event_attendees` and `organizer_id` population is
**verified live** (organizer_id populated on real rows, event_attendees confirmed via a
real test event). Milestone 1 is complete; see §6.

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

**M3 grounded Q&A adds NO new table and NO new migration either** — retrieval is a pure read:
embed the question, search Qdrant (existing collection, no schema change), SELECT `body`
back from Postgres by id (existing column). Nothing new is stored anywhere; the feature is
100% derived from data that already existed before this session. This is the same "read,
don't duplicate" shape as audit-sight — a new *capability* to see existing facts, not a new
fact.

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
- Local Whisper — ✅ done (self-hosted `whisper.cpp`, `base` model, Cloudflare
  Access-gated, Hammerspoon push-to-talk client on laptop). Local embeddings — not built,
  and not planned for the retrieval-gate use case either (see §2.4, §8 — the local-AI gate
  plan was abandoned in favor of a keyword gate).

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

**Milestone 3 — AI layer, read-only. 🔨 UNDERWAY — classifier + triage render + embeddings +
grounded Q&A all done; brief + cron automation remain.** In **marionette**, not api
(reasoning), rendered by **api** (read-only views).
- ✅ **Email classification shipped** (`4c39435` + `5d45b8d`): Clair two-pass consequence
  classifier writing `importance`/`category`/`reason`/`confidence`/`classified_at`, backed by
  migration `0005`. `POST /classify` batch endpoint, audited per-email. See §4.
- ✅ **Triage render shipped** (`532493a`): the M2 dashboard now surfaces classifier output —
  three-tier priority section (Think about first / Peripheral / Noise), reason-led, in api as
  a pure read view. Isolation-tested, deployed via audited `POST /deploy`, verified live. See §4.
- ✅ **Embedding pipeline shipped** (`a46d8ce` + `2947a9b`): OpenAI `text-embedding-3-small`
  → Qdrant, via `marionette/src/embed.ts` + `POST /embed`, migration `0006`
  (`embedded_at` + `idx_emails_unembedded`). Embeddings-provider decision RESOLVED = OpenAI
  (§8). Qdrant `emails` collection now at 766 points (live count, growing as new mail is
  embedded). Isolation-tested, deployed via audited `POST /deploy` (`deploy.succeeded`). See §4.
- ✅ **Grounded Q&A shipped** (`a0ced26`, this session): `retrieve.ts` + `data-gate.ts` —
  embed query → Qdrant top-10 → SELECT bodies from Postgres → inject as grounding via the
  pre-fetch injection pattern (same shape as audit-sight), gated by a keyword check, wired
  into `/think` and `prompt.ts`. Fixed a co-discovered DeepSeek thinking-trace JSON-parsing
  bug in the same commit. Isolation-tested twice, deployed via audited `POST /deploy` (job
  `97b27e56`, confirmed `deploy.succeeded`), re-verified against the live production
  container. See §4.
- ⏳ **Automate the drains:** wire `classifyBatch` AND `embedBatch` into the 5-min ingestion
  cron so new mail self-triages and self-embeds. Not built.
- ⏳ **Morning brief** — not built. Telegram is the natural delivery channel once it exists.
- **Done when:** email is auto-classified + auto-embedded on ingest AND a morning brief +
  grounded Q&A are live. Classification, its render, embeddings, and grounded Q&A are done;
  the brief and the cron automation remain.

**Milestone 4 — Action layer, approval-gated. 🔨 Gate slice + Task A done; Task B remains.**
- ✅ **Gate slice shipped** (`3a66aef` + `b13c5ce`): `actions` table + strict lifecycle
  (`marionette/src/actions.ts`), 5 marionette routes, and **Telegram IS the approval
  channel** — inline Approve/Deny buttons via `callback_query`, plus `POST
  /telegram/surface/:id` to push a proposed action to chat. Fire-and-report execute with a
  hard guarantee of a terminal transition. `kind='commit_deploy'` is the only action type so
  far; all writes audit through `audit_log` (target = action id). See §4.
- ✅ **Task A — async-completion push — DONE** (`80298a4`/`8ac171c`): deploy job polled to
  true completion via `audit_log`, ✅/❌ pushed to Telegram through a thin `api` notify
  endpoint. An Approve tap now gets a follow-up confirming the deploy actually finished
  healthy, not just that it was accepted (202). See §4.
- ⏳ **Task B — commit half of `commit_deploy`:** execute deploys from current repo state;
  contractor doesn't git-commit first yet (`TODO(steering/commit)` in `actions.ts`).
- Additional action types (create event, draft reply) are future work within this milestone.

**Milestone 5 — Earned autonomy.** Auto-execute low-risk tier only. **Rollback-scope fix
done (`52c3f72`) — no longer blocked.**

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
  gets this right; it only bites manual/isolation builds. **`marionette`'s Dockerfile is the
  same shape but simpler — it has no monorepo nesting, so `docker build -t <tag> marionette`
  from the repo root just works** (confirmed building the grounded-Q&A isolation image).
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
  command line, not the leading `spaghettios@…$` prompt or the output above it. **Recurred
  again in the grounded-Q&A session** — same failure mode, harmless again, but worth
  restating: give one clean command block at a time and say explicitly "copy only this."
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
- **A postgres.js IN-list over an array of uuids needs `sql(ids)` inside a template
  literal (`where id in ${sql(ids)}`), not `sql.array(ids)` + `any()`.** The `sql.array` +
  `any` combination failed twice in sequence while building `retrieve.ts`: first a
  malformed-array error from a dropped `<` in the query template, then — once that was
  fixed — a genuine `uuid = any(text[])` type mismatch (Postgres error 42809), since
  `sql.array` produces a `text[]` by default and `any()` doesn't auto-cast it against a
  `uuid` column. `sql(ids)` (postgres.js's list-helper, which expands to a parenthesized,
  correctly-typed list for `IN`) is the confirmed-working form for this exact shape
  (`emails.id uuid` column, array of uuid strings from a Qdrant search result).
- **A model's `response_format: json_object` doesn't guarantee `content` is nothing but the
  JSON object.** `deepseek-v4-pro` can leak a `<think>...</think>` reasoning trace (and a
  stray `<｜end▁of▁thinking｜>`-style special token) around or before the real JSON, and can
  occasionally emit the JSON object twice. This broke `JSON.parse` silently — no thrown
  error surfaced anywhere except the code's own `try/catch`, which fell through to a
  "treat the raw string as the message" fallback that then delivered garbled text to the
  end user. It went unnoticed for as long as it did because every previous manual test used
  short/simple `/think` requests that didn't trigger the model's internal reasoning trace at
  meaningful length — the bug only appeared once a longer, retrieval-grounded prompt gave
  the model enough to "think out loud" about. Fix: sanitize at the source, inside
  `callDeepSeek` itself (strip `<think>` blocks + stray special tokens via regex, then
  extract the first balanced `{...}` by brace-depth-counting) — never assume a
  reasoning-capable model's JSON mode is clean without an explicit extraction step.

---

## 8. Open questions (decided-when-we-get-there, not blocking)

- **⚠ Unidentified actor auto-committing to the repo — OPEN, security-relevant.** Commits
  `e06ed72` + `449a9b7` ("Hello"→"Goodbye" print-statement edits) landed on `origin/main`
  via the GitHub web UI from an unknown source, and rewrote THE_BIBLE.md with terminal
  scrollback junk. `091c8e0` restored the file, but **what made the commits was never
  identified** — something is/was acting through Bentley's GitHub web session (the "Hello"→
  "Goodbye" pattern is a classic agent/integration smoke-test). Deferred during the M3-render
  session (chose to proceed with the file restored), but NOT resolved. Cheapest next step,
  costs nothing: `git log --format='%h %an <%ae> %cn %ci %s' e06ed72~1..091c8e0` to read the
  author/committer identity — `web-flow` = GitHub web editor (consistent with the web-session
  theory); any other identity names the culprit. Then audit GitHub → Settings → Applications
  (authorized OAuth apps / installed GitHub Apps) and repo deploy keys / webhooks for anything
  unexpected, and rotate the token if one is found.
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
- **Postgres password rotation** — flagged (pasted plaintext into a chat), still not done.
  **Re-exposed again during the shell-var/`ALTER ROLE` debugging session** — the real
  `b08a...` value was pasted multiple times. Rotate whenever the batch rotation happens.
- **DeepSeek API key fragment** — a masked fragment printed into a chat, not usable alone,
  noted alongside the Postgres rotation. Both still pending.
- **Shared audit module** — deploy + marionette + contractor each duplicate `audit_log`
  write logic; unify eventually. Ingestion (gcal/gmail) still doesn't write to `audit_log`
  at all — not a blocker for the shipped "what changed" view (it keys off each row's own
  `created_at` ingest timestamp, not an audit trail), but revisit if a future view needs a
  true "last synced" signal.
- **Embeddings provider — RESOLVED = OpenAI `text-embedding-3-small`** (1536-dim, cosine),
  external API, consistent with §2.4. The embed pipeline (`marionette/src/embed.ts`,
  `POST /embed`, migration `0006`) is live; Qdrant `emails` collection is at 766 points and
  growing. **Local-model alternative deliberately deferred, not foreclosed:** a small
  local model on the box's idle AMD RX 5700 XT would plausibly fit the whisper-class exception
  and keep email bodies off OpenAI (privacy), but cost is a non-argument (~2¢ one-time, <$1/yr)
  and it carries the same unfinished ROCm/HIP setup parked for whisper. `embedText()` in
  `embed.ts` is a clean single-function swap seam if privacy ever wins.
- **Grounded Q&A intent-gate design — RESOLVED = plain keyword gate, not local-AI.** An
  earlier plan called for a new `local-ai` service running a small local embedding model
  (`all-minilm`) on the RX 5700 XT via Vulkan, used to semantically detect data-questions
  before retrieving. Explicitly abandoned mid-planning in favor of `data-gate.ts`'s plain
  keyword gate (mirrors `system-sight.ts`'s pattern exactly) — simpler, no new service, no
  §2.4 exception needed, and no untested GPU/Vulkan risk taken on for an intent-detection
  problem a keyword list already solves adequately. Retrieval's actual embedding call still
  uses OpenAI (`embedText()`, reused from `embed.ts`) — the local-AI idea was specifically
  about the *gate*, not the retrieval embedding itself. If the keyword gate proves too blunt
  in practice (misses phrasings), widening the keyword list is the first fix to try before
  reconsidering a model-based gate.
- **Grounded Q&A shipped — RESOLVED.** `retrieve.ts` + `data-gate.ts`, wired into `/think`
  and `prompt.ts`, deployed (`a0ced26`, job `97b27e56`), verified against the live production
  container with a real invoice/receipt query and a "what is 2+2?" sanity check. See §4, §6.
- **DeepSeek thinking-trace JSON-parsing bug — RESOLVED.** `deepseek.ts`'s `callDeepSeek` now
  strips `<think>` blocks/stray tokens and extracts the first balanced JSON object before
  returning `content`. Found and fixed in the same session as grounded Q&A (the longer
  retrieval-grounded prompts were what finally triggered the leak reliably enough to notice).
  See §4, §7.
- **Chunking — deferred to the first long-form ingestion source** (PDFs / web pages, the
  ontology-bound sources in §3a). Email is short: one email = one vector, no chunking, and
  `retrieve.ts` (shipped this session) confirmed that assumption holds — no chunk-ready seam
  was even needed yet since nothing so far requires it. When a long-form source is added, it
  must be TS (§2 — Python basically never), not a Python service. Candidate libs
  (Chonkie/llm-chunk) noted but not chosen.
- **Drains not automated (M3).** The 5-min ingestion cron auto-runs neither classification
  nor embedding on new mail — both only run on manual `POST /classify` / `POST /embed`
  batches. Qdrant's live point count (766, up from 755) confirms new mail keeps getting
  embedded via manual/session-driven batches, not the cron; the **classify** backlog was
  last drained partially in an earlier session and new mail similarly won't self-classify.
  Natural next slice: call both `classifyBatch` and `embedBatch` from the cron. (Note: the
  historical "685 unclassified / 778 total" figures elsewhere in this doc are stale — check
  live counts before relying on them.)
- **`whisper-laptop` Cloudflare service token exposed in plaintext in chat multiple times
  across sessions** (initial setup, then again during the Service Auth policy debugging).
  Not rotated yet — same pattern as the Postgres/DeepSeek leaks, now the most-repeated
  instance of this issue. Rotate in the Cloudflare dashboard and update
  `~/.hammerspoon/whisper_secrets.lua` on the laptop when done. Consider moving the laptop
  script's credentials to macOS Keychain instead of a plaintext Lua file while at it.
- **Whisper deploy path** — `whisper` isn't in `deploy`'s `SERVICE_HEALTH` map, so it has no
  audited deploy/rollback path and must be rebuilt via raw `docker compose up -d --build`.
  Decide whether it's worth adding, given it's a low-churn service.
- **Whisper GPU acceleration** — box has an AMD RX 5700 XT, currently unused; whisper runs
  CPU-only. Vulkan or ROCm/HIP backend would speed up larger models significantly. Not
  started — scoped as a future task if `base`'s CPU latency becomes annoying in daily
  use. **Also newly relevant to the abandoned local-AI gate plan** — if a model-based gate
  is ever reconsidered, this same unfinished GPU work is the blocker either way.
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
- **No conversation memory across Telegram messages, including grounded Q&A.** Each message
  is a fresh, stateless `/think` call — marionette has no way to know "the file I just wrote"
  or "that email you mentioned" refers to something from a prior message. Retrieval re-runs
  fresh on every data question rather than building on a prior answer. Fine for one-shot
  commands/questions today; will need addressing (likely building on the same Qdrant
  infrastructure grounded Q&A now uses) before Telegram can support true multi-turn tasks.
- **Telegram webhook has no rate limiting or replay protection beyond the secret-token
  header and user-ID allow-list.** Low risk at single-user scale with a Bypass-scoped path,
  but worth revisiting if this interface's trust boundary ever expands.
- **`/think` audit-sight integration — RESOLVED** (`27f18b3`). Design fork decided in favor
  of **(B) pre-fetch injection** over (A) a tool-call loop, because `deepseek.ts`'s
  `callDeepSeek` hardcodes `response_format: json_object`, sends no `tools` array, and
  surfaces no `tool_calls` — (A) would have needed a whole second code path + a second model
  call. Keyword gate (`system-sight.ts`) → in-process `auditSummary(60)` → compact injected
  block → single `callDeepSeek`, existing `normalizeDecision` untouched, sight-read failure
  degrades gracefully. Verified end-to-end from the Telegram app. **Grounded Q&A's
  `data-gate.ts`/`retrieve.ts` reused this exact (B) shape a second time**, confirming the
  pattern generalizes cleanly. See §4. **Follow-on worth noting** (not blocking): the
  keyword gate is blunt — a system-status question (or, now, a data question) phrased
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
   dashboard calls it, never a prompt-caller in `api`. **Grounded Q&A's retrieval is not an
   exception either** — embedding the query, searching Qdrant, and formatting the retrieved
   context all live in `marionette` (`retrieve.ts`/`data-gate.ts`); `api` never touches email
   content for this feature, same as it never touches audit-sight's ledger read directly.
2. **One build/deploy system.** `deploy` already has queueing, health polling, audit-backed
   rollback. Milestone 6's git automation is an *extension* of `deploy`, not a parallel
   service.
3. **Schema before code.** Check `0001_secretary_ontology.sql` before adding a column —
   `emails.category`/`importance` already exist. (The M2 dashboard added no columns — pure
   read. Grounded Q&A added no columns either — pure read over `emails.body` + the existing
   Qdrant collection.)
4. **`audit_log` is the one ledger.** Deploy actions and AI actions both write here — this
   includes Telegram-originated requests, since they flow through the same
   `marionette.think`/`marionette.delegate` audit points as any other caller. No second "AI
   decisions" table, and no separate "Telegram log." **Retrieval reads (audit-sight and
   grounded Q&A alike) don't get their own audit rows** — they're in-process pre-fetch steps
   feeding a single `marionette.think` call, which is what actually gets audited.
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
     autonomy question entirely. Grounded Q&A is the same** — it reads existing email
     content and answers a question; it takes no side-effecting action and unlocks nothing.
   - **External comms are never in scope for autonomy, in either zone.** No
     email/messaging/external-comms MCP or tool is wired to contractor. If one ever is, it
     ships with an explicit deny in the permission policy from day one — never relying on
     "it just doesn't have that tool" once the tool exists. **Telegram's `sendMessage` call
     in `api` is not an exception to this rule** — it is a fixed, single-recipient
     reply-to-the-allow-listed-sender mechanism embedded in one route, not a general-purpose
     messaging capability exposed to contractor or marionette's decision-making. Marionette
     cannot choose to message anyone; it can only return a `message` string that `api`
     relays back to whoever sent the original request.
