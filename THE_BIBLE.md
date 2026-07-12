# Bentley OS — The Bible

*The single source of truth. Rules, architecture, project map, current state — all here.
When this conflicts with anything older, this wins. Regenerate from the repo whenever it
drifts; don't hand-edit it into staleness.*

*Last verified: 2026-07-12 (Milestone 4 approval-gated action layer shipped — `actions`
table + lifecycle + 5 marionette routes + Telegram Approve/Deny buttons; marionette
audit-sight read endpoint `GET /audit/summary` shipped; AND `/think` now consumes
audit-sight — Mari narrates real system state from her own ledger in response to
system-status questions (keyword-gated pre-fetch injection, chosen over a tool-call loop).
All live, confirmed via audited `POST /deploy`, verified end-to-end from the Telegram app.)*

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

---

## 3. System map — who does what

One `docker-compose.yml`, two networks (`backend` for services, `monitoring` for ops
tooling). Every service has exactly one job. **If a new feature doesn't obviously belong to
one row, stop and decide before coding — don't let it leak into two services.**

| Service | Port | Owns | Does NOT own |
|---|---|---|---|
| **postgres** | 5432 (LAN only) | All persisted state — ontology, sync tokens, audit log | Vector search (qdrant) |
| **qdrant** | 6333 (LAN only) | Vector storage for embeddings (Milestone 3+) | Currently **unused** — nothing writes to it |
| **redis** | 6379 (LAN only) | Caching / ephemeral state | Unused by any service yet |
| **api** | 3000 | HTTP surface: `/health`, dashboard (`/`), ingestion (gcal/gmail → Postgres, scheduled via node-cron every 5 min), OpenCode proxy (`/opencode/*`), **Telegram webhook (`/telegram/webhook`) → handles both text messages (→ marionette `/think`) AND button taps (`callback_query` → marionette `/actions/:id/approve|deny`); plus internal relay `POST /telegram/surface/:id` that pushes a proposed action to the allow-listed chat with inline Approve/Deny buttons** | Build/deploy logic, AI reasoning, action lifecycle state (marionette owns that) |
| **deploy** | 4000 (127.0.0.1) | Build + restart + health-check + auto-rollback for `api`, `contractor`, `marionette`; writes every action to `audit_log` | *What* code does — purely CI/CD operator. **Does not cover `whisper`** (see §4) |
| **contractor** | 4100 (`backend` only) | The coding/build layer. `POST /execute` — real `@opencode-ai/sdk` session + prompt against the systemd OpenCode server, audited. Full sandbox-zone autonomy (see §9) | Orchestration, ingestion, deploy |
| **marionette** | 4200 (`backend` only) | The orchestrator. `POST /think` — DeepSeek reasoning, structured decision (**response shape: `{decision: {decision, message, reasoning}}`, nested — not flat**), audited. Can `reply` or `delegate` to contractor — build-machine keystone, verified end-to-end incl. real multi-step tool-call tasks, driven live from Telegram. **Also owns the M4 action lifecycle: `actions` table state transitions via `POST /actions`, `GET /actions[?status=]`, `GET /actions/:id`, `POST /actions/:id/approve`, `POST /actions/:id/deny`. And `GET /audit/summary?window=<min>` — Mari's read-only "sight" over her own `audit_log`, **now consumed by `/think`**: system-status questions trigger an in-process `auditSummary(60)` read, injected into the reasoning prompt so Mari narrates real activity instead of claiming blindness** | Ingestion (api's job), deploy (deploy's job) |
| **whisper** | 4300 (`backend` only, exposed publicly via `whisper.bentleyos.me`) | Self-hosted speech-to-text. `whisper.cpp`'s `whisper-server` binary, `POST /inference` (multipart, field `file`) → `{"text": "..."}`. Currently running the `base` model | AI reasoning (that's marionette's job) — whisper is pure transcription, no interpretation |
| **cloudflared** | — | Public tunnel, gated on `api` health | — |
| **portainer / dozzle / uptime-kuma** | 9000 / 8080 / 3001 | Ops visibility | Nothing app-level |

**Rule of thumb:** ingestion + read APIs live in `api`; AI reasoning lives in `marionette`;
anything touching `docker compose` or git lives in `deploy`. Task mentions two of these →
split the ticket. **Telegram fits this rule cleanly: it's just another HTTP surface on
`api`, forwarding to marionette's existing reasoning endpoint — no new reasoning logic was
added anywhere.**

**Cloudflare/networking gotcha:** `cloudflared` runs in a container on `backend`. It reaches
app services by container name (`http://api:3000`), host services (SSH) by LAN IP
(`172.16.30.4:22`). It **cannot** use `localhost` to mean the host.

**Same gotcha class:** `contractor` reaches the real systemd OpenCode server via LAN IP
`172.16.30.4:4096`, never `127.0.0.1` — a service bound to loopback only is unreachable from
any other container regardless of shared network.

---

## 4. Current state (living — what actually exists on the box right now)

Running on the box at `~/bentley-os` (Ubuntu, LAN IP `172.16.30.4`). Absolute path is
`/home/spaghettios/bentley-os` — always exact, never an alias (see §7 bind-mount lesson).

**Infrastructure — all up:** api (healthy, 3000), postgres (healthy, 5432), redis (6379),
qdrant (6333/6334 — reachable, zero collections, unused), cloudflared, dozzle (8080),
portainer (9000/8000/9443), uptime-kuma (healthy, 3001), deploy (healthy, 4000 /
127.0.0.1), contractor (healthy, 4100, backend only), marionette (healthy, 4200, backend
only), whisper (healthy, 4300, backend only, `base` model).

**No `embedder` service exists** — confirmed absent. Embeddings deferred to a local model
(not yet built).

**Repo:** private, confirmed via `gh repo view`. `.env`/`client_secret.json`/`token.json`
confirmed never tracked (checked full git history for leaked values, not just current
state).

**Database (Postgres `bentley` db):** ontology schema loaded. Tables: `people`, `emails`,
`email_recipients`, `calendar_events`, `event_attendees`, `audit_log`, plus `sync_state`
(from `0002_sync_state.sql`) and `actions` (from `0003_actions.sql`, M4 — see below), both
applied live.
- `emails` **already has** unused `category` + `importance` columns — the future classifier
  writes to these, no new migration needed. Don't recreate them.
- `calendar_events.organizer_id` and `event_attendees` are now **populated** — see Milestone
  1 status below.
- `audit_log` columns: `id` (bigint identity), `at` (timestamptz, default now()), `actor`,
  `action`, `target` (nullable), `outcome` (nullable), `payload` (jsonb, default `{}`).
  Indexes on `action` and `at DESC`. Real rows now exist from deploy activity,
  `marionette.think`, `marionette.delegate`, and `contractor.execute` — **including rows
  originating from Telegram messages**, indistinguishable in `audit_log` from any other
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
- **New: `Telegram Webhook Bypass` Access Application** — scoped to
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
- **KNOWN GAP — `action.succeeded` = deploy ACCEPTED (202), not finished.** `executeAction`
  fires `POST deploy:4000/deploy` and treats a 2xx *accept* as success — but deploy is
  async (202, then builds/health-checks/rolls-back on its own timeline). So a `succeeded`
  action row means "deploy accepted the job", NOT "deploy completed and is healthy." The
  real-completion signal still lives only in deploy's own `deploy.succeeded` audit row. An
  async-completion push (poll deploy to true finish → "✅/❌" to Telegram via a thin `api`
  notify endpoint, since marionette can't message out — §9) is the open M4 task B.
- **Also unwired:** the git-commit half of `commit_deploy` — execute currently just deploys
  from current repo state; contractor doesn't commit first yet (`TODO(steering/commit)` in
  `actions.ts`).
- **Commits:** `3a66aef` (propose/approve/deny/execute lifecycle) + `b13c5ce` (Telegram
  buttons + surface endpoint).

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
Local in sync with `origin/main` at `27f18b3`.
Recent commits: `27f18b3` (feat(marionette): /think consumes audit-sight — narrates real
system state) → `125de94` (docs: revise for Milestone 4 + Telegram — the regenerated Bible,
committed via GitHub web UI) → `9f3f054` (feat(marionette): audit-sight read endpoint — `GET
/audit/summary`) → `b13c5ce` (feat(m4): Telegram approve/deny buttons + surface endpoint) →
`3a66aef` (feat(m4): approval-gated action layer — propose/approve/deny/execute lifecycle) →
`5862496` (docs(bible): rollback-scope resolved; password 'drift' → stale shell-var
override) → `52c3f72` (fix(deploy): abort rollback for unscoped service instead of repo-wide
checkout) → `5480fa5` (docs: Telegram integration) → `c97ba37` (feat: Telegram webhook →
marionette, Access-bypassed on `/telegram/webhook` path).

**Deploy service** (`~/bentley-os/deploy/`): serialized queue, reads last-good commit from
`audit_log` → build → `up -d` → poll real `/health` over `backend` → success or
auto-rollback, every step audited. `SERVICE_HEALTH` map covers `api`, `contractor`,
`marionette` — **not `whisper`**, which must be rebuilt directly via
`docker compose up -d --build whisper` until it's added to the map. Deploys for covered
services go through `POST /deploy` — never raw compose for those. Used twice during the
Telegram build (initial route addition, then the response-shape bugfix), both isolation-
tested first, both confirmed via `audit_log`'s `deploy.succeeded` row rather than trusting
the immediate `POST /deploy` response.
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
- **Can now:** narrate her own system activity. `/think` consumes audit-sight — a
  keyword-gated in-process `auditSummary(60)` read is injected into the reasoning prompt for
  system-status questions, so Mari answers "what have you done today?" / "anything failing?"
  from the real `audit_log` (see the audit-sight subsection above). This is *self*-sight over
  the ledger, NOT general memory — see the limit below.
- **Still cannot:** no cross-message conversation memory (Qdrant unused, `/think` otherwise
  stateless — each Telegram message is a fresh request; audit-sight lets her see the *ledger*
  but not recall what the owner said two messages ago — "the file I just wrote" still means
  nothing), no delegation targets beyond contractor, no *autonomous* production-zone write
  actions — the M4 approval-gate layer IS built (propose→approve→deny→execute + Telegram
  buttons, see M4 subsection), but contractor's own writes remain sandbox-only and nothing
  auto-commits/auto-deploys from a delegated task without the human approval tap.

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
  delta).

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
```

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

**Milestone 2 — Insight out.** Replace `apps/api/src/routes/dashboard.ts` (static status
card) with server-rendered views reading `calendar_events` / `emails` directly. "Today" +
"what changed" first. **Not started — deferred by choice this session in favor of the
Telegram interface.**

**Milestone 3 — AI layer, read-only.** In **marionette**, not api. Classify email → the
existing `category`/`importance` columns. Morning brief. Grounded Q&A. This is where the
qdrant/embeddings decision can no longer be deferred. **Telegram is a natural delivery
channel for the morning brief once this is built** — worth keeping in mind when designing
it, though not yet scoped.

**Milestone 4 — Action layer, approval-gated. 🔨 Gate slice done; two tasks remain.**
- ✅ **Gate slice shipped** (`3a66aef` + `b13c5ce`): `actions` table + strict lifecycle
  (`marionette/src/actions.ts`), 5 marionette routes, and **Telegram IS the approval
  channel** — inline Approve/Deny buttons via `callback_query`, plus `POST
  /telegram/surface/:id` to push a proposed action to chat. Fire-and-report execute with a
  hard guarantee of a terminal transition. `kind='commit_deploy'` is the only action type so
  far; all writes audit through `audit_log` (target = action id). See §4.
- ⏳ **Task A — async-completion push:** `action.succeeded` currently fires on deploy's 202
  *accept*, not real finish. Poll deploy's job to true completion, push "✅/❌" to Telegram
  via a thin `api` notify endpoint (marionette can't message out — §9).
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
  opposite convention, easy to get wrong.
- **Node/npm live only inside Docker** — host has neither. Dependency changes = hand-edit
  `package.json`, let the build install. **`npx tsc --noEmit` isn't available on the host
  for the same reason** — the closest pre-deploy check is a full isolation build
  (`docker build` + throwaway `docker run` + `/health` hit), not a host-side typecheck.
- **Isolation-test before any commit** — throwaway `docker run`, confirm the real path and
  audit row before deploying.
- **`audit_log` is authoritative** for deployment and orchestration state — not raw git
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

---

## 8. Open questions (decided-when-we-get-there, not blocking)

- **Docs cleanup:** old `.md` files (`00_NORTH_STAR`, `01_CURRENT_STATE`, `02_DECISIONS`,
  `03_ROADMAP`) retired in favor of this Bible. Remove from the project once trusted.
- **Rollback scope — RESOLVED** (`52c3f72`): unscoped service aborts, no repo-wide checkout.
  Unblocks Milestones 4 and 5.
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
  write logic; unify eventually. Ingestion (gcal/gmail) doesn't write to `audit_log` at
  all yet — decide whether it should before Milestone 2 dashboards need "last synced."
- **Embeddings provider** — resolved to "local model" but not built.
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
  use.
- **Log aggregation** specifics — not decided.
- **`marionette/src/schema.ts`** has one leftover comment mentioning "opencode"
  conceptually — cosmetic, not fixed.
- **`whisper/Dockerfile.bak`** — stray untracked backup file sitting in the repo working
  tree (noticed during the Telegram commit's `git status`). Harmless but should be deleted
  or gitignored rather than left loose.
- **Telegram bot token — rotated once already, mid-build.** The first-issued token was
  pasted in plaintext in chat before the integration was even wired up; it was rotated
  immediately via BotFather and the new token went straight into `.env` without being
  pasted here. Worth normalizing this reflex (rotate-on-exposure, never wait) for any future
  credential handling.
- **`audit_log` doesn't tag request origin/interface.** A `marionette.think` row looks
  identical whether it came from a direct API call, a test script, or a Telegram message.
  Not a problem yet at single-user scale, but worth a `source` or `channel` field in the
  audit payload before there's ever more than one command interface or user to disambiguate.
- **No conversation memory across Telegram messages.** Each message is a fresh, stateless
  `/think` call — marionette has no way to know "the file I just wrote" refers to something
  from two messages ago. Fine for one-shot commands today; will need addressing (likely via
  Qdrant, already deferred to Milestone 3) before Telegram can support multi-turn tasks.
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
- **M4 action `succeeded` = deploy 202 accept, not real completion.** (Task A above.) The
  true finish signal lives only in deploy's own `deploy.succeeded` audit row. Needs an
  async poll → Telegram "✅/❌" push via a thin `api` notify endpoint.
- **M4 `commit_deploy` git-commit half unwired.** (Task B above.) Execute deploys current
  repo state; contractor doesn't commit first (`TODO(steering/commit)` in `actions.ts`).
- **Audit-sight Tier 2 (DB/ingestion influx detection) and Tier 3 (host CPU/mem/disk
  metrics) not built.** Tier 2 reads `emails`/`calendar_events`/`sync_state` directly (note:
  ingestion still doesn't write to `audit_log`, so counts come from tables). Tier 3 needs
  host access, which lives in `api` not marionette (backend-only) — so a thin api-side read
  endpoint marionette calls, or proper metrics infra (cAdvisor/node-exporter). Decide
  cheap-path vs proper-infra when reached. Same read-tool pattern as Tier 1.

---

## 9. Guardrails to prevent contradiction/duplication

1. **One AI brain.** All classification/reasoning/generation goes in `marionette`. A
   prompt-calling function in `apps/api` belongs in marionette instead, with api calling
   marionette's HTTP endpoint. **Whisper is not an exception** — it does pure transcription
   only, no interpretation; any future step that reasons about transcribed text belongs in
   marionette, not in the whisper service or the Hammerspoon client. **Telegram is not an
   exception either** — the webhook route in `api` does no reasoning of its own; it's a thin
   forward-and-relay to marionette's existing `/think`, identical in spirit to how
   `opencode.ts` proxies to the OpenCode server rather than reimplementing anything.
2. **One build/deploy system.** `deploy` already has queueing, health polling, audit-backed
   rollback. Milestone 6's git automation is an *extension* of `deploy`, not a parallel
   service.
3. **Schema before code.** Check `0001_secretary_ontology.sql` before adding a column —
   `emails.category`/`importance` already exist.
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
     production-zone capability that didn't already exist.
   - **External comms are never in scope for autonomy, in either zone.** No
     email/messaging/external-comms MCP or tool is wired to contractor. If one ever is, it
     ships with an explicit deny in the permission policy from day one — never relying on
     "it just doesn't have that tool" once the tool exists. **Telegram's `sendMessage` call
     in `api` is not an exception to this rule** — it is a fixed, single-recipient
     reply-to-the-allow-listed-sender mechanism embedded in one route, not a general-purpose
     messaging capability exposed to contractor or marionette's decision-making. Marionette
     cannot choose to message anyone; it can only return a `message` string that `api`
     relays back to whoever sent the original request.
