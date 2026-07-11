# Bentley OS — The Bible

*The single source of truth. Rules, architecture, project map, current state — all here.
When this conflicts with anything older, this wins. Regenerate from the repo whenever it
drifts; don't hand-edit it into staleness.*

*Last verified: 2026-07-11 (keystone hardened — undici timeout + OpenCode headless
permissions fixed and verified with a real multi-step tool-call task, not just a trivial
reply).*

---

## 0. North Star (the destination, not the current state)

**One-sentence vision:** a personal, self-hosted data hub with an AI layer on top that
unifies my digital life (starting with Gmail + Calendar), derives insight from it, and —
increasingly on its own — classifies, briefs, and acts on my behalf, all commanded from a
single web dashboard (`bentleyos.me`).

**Three principles that don't bend:**
1. **Host locally by default.** Everything runs on my box except the AI models themselves
   (API-only, no local inference — for now).
2. **One source of truth.** Every fact lives once, attached to the right object, related
   through typed links. No shadow tables, no duplicated state.
3. **Autonomy is earned, not assumed.** The path is guardrail-first: suggest → approve →
   auto, loosened deliberately, never by accident. **Exception, deliberately made:** inside
   the sandbox zone (contractor/OpenCode), autonomy over the filesystem and build actions is
   full by design — Bentley doesn't use OpenCode interactively, so there's no
   human-in-the-loop value to preserve there. Guardrail-first applies to the *production*
   zone and to anything touching the outside world (see §9).

**North-star sequencing:** data in (Gmail + Calendar) → insight out (real dashboard) → AI
layer (classify, brief, grounded Q&A) → action layer (approval-gated) → earned autonomy
(low-risk auto) → self-extension (system ships its own tools).

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
actually tested.

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
  the server-side call can still be running after the test client gives up.

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
4. **Host locally; AI is API-only.** No local model inference. Do not reintroduce a local
   embeddings/LLM service.
5. **Autonomy is earned — except inside the sandbox, and never for external comms.** Any AI
   action capability that touches the *production* zone or the outside world ships
   approval-gated first. Never wire autonomous actions onto real Gmail without a guardrail.
   Inside the sandbox zone, contractor/OpenCode gets full filesystem/build autonomy by
   design (see §9) — but no email/messaging/external-comms tool is ever wired to contractor,
   full stop, regardless of zone.

**Code conventions:**
- TypeScript + Hono for the API/app. Python only if genuinely unavoidable (basically never).
- Match the codebase: named Hono route exports, mounted via `routes.route('/', x)`.
- **Import extensions depend on the service** — see the strip-types lesson (§7). Compiled-TS
  services (`api`) use `.js`; strip-types services (`deploy`, `contractor`, `marionette`) use
  `.ts`.
- After any api code change: `cd ~/bentley-os && docker compose up -d --build api` (running
  container keeps serving until the new build succeeds). For known services, prefer the
  deploy service (`POST /deploy {"service":"api"}`) over raw compose.
- Never ship a change that could take down `/health` without saying so and giving the
  rollback.
- **Any process making outbound calls to a service that can legitimately run long (OpenCode
  agent tasks) must set an explicit timeout via `undici`'s `setGlobalDispatcher`** — Node's
  fetch default (5 min headers/body timeout) is too short and fails silently as a generic
  `fetch failed` with no diagnosable cause unless `err.cause` is explicitly captured.

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
| **api** | 3000 | HTTP surface: `/health`, dashboard (`/`), ingestion (gcal/gmail → Postgres, scheduled via node-cron every 5 min), OpenCode proxy (`/opencode/*`) | Build/deploy logic, AI reasoning |
| **deploy** | 4000 (127.0.0.1) | Build + restart + health-check + auto-rollback for `api`, `contractor`, `marionette`; writes every action to `audit_log` | *What* code does — purely CI/CD operator |
| **contractor** | 4100 (`backend` only) | The coding/build layer. `POST /execute` — real `@opencode-ai/sdk` session + prompt against the systemd OpenCode server, audited. Full sandbox-zone autonomy (see §9) | Orchestration, ingestion, deploy |
| **marionette** | 4200 (`backend` only) | The orchestrator. `POST /think` — DeepSeek reasoning, structured decision, audited. Can `reply` or `delegate` to contractor — **the build-machine keystone, now verified working end-to-end including real multi-step tool-call tasks** | Ingestion (api's job), deploy (deploy's job) |
| **cloudflared** | — | Public tunnel, gated on `api` health | — |
| **portainer / dozzle / uptime-kuma** | 9000 / 8080 / 3001 | Ops visibility | Nothing app-level |

**Rule of thumb:** ingestion + read APIs live in `api`; AI reasoning lives in `marionette`;
anything touching `docker compose` or git lives in `deploy`. Task mentions two of these →
split the ticket.

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
only).

**No `embedder` service exists** — confirmed absent. Embeddings deferred to a local model
(not yet built).

**Repo:** private, confirmed via `gh repo view`. `.env`/`client_secret.json`/`token.json`
confirmed never tracked (checked full git history for leaked values, not just current
state).

**Database (Postgres `bentley` db):** ontology schema loaded. Tables: `people`, `emails`,
`email_recipients`, `calendar_events`, `event_attendees`, `audit_log`, plus `sync_state`
(from `0002_sync_state.sql`, applied live).
- `emails` **already has** unused `category` + `importance` columns — the future classifier
  writes to these, no new migration needed. Don't recreate them.
- `calendar_events.organizer_id` and the whole `event_attendees` table are **still
  unpopulated** — current `gcal.ts` upsert doesn't populate people. **This is the last open
  item in Milestone 1** — close before Milestone 3 Q&A needs "who's coming to X."
- `audit_log` columns: `id` (bigint identity), `at` (timestamptz, default now()), `actor`,
  `action`, `target` (nullable), `outcome` (nullable), `payload` (jsonb, default `{}`).
  Indexes on `action` and `at DESC`. Real rows now exist from deploy activity,
  `marionette.think`, `marionette.delegate`, and `contractor.execute`. Ingestion (gcal/gmail)
  does **not** currently write to `audit_log` — stdout only. Open item.
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
  **Whisper remote access — done:**
- Published application route added: `whisper.bentleyos.me` → `http://whisper:4300`
  (Cloudflare dashboard, token-based tunnel — no local `cloudflared` config file exists
  on the box; routes/policies live entirely in the Cloudflare dashboard, not the repo).
- Access policy: reused existing policy (renamed `Me - Self-Hosted Apps`, ID
  `63930902-c6ba-4551-bd30-388383443ac0`), same email gate (`bentley.lujero@gmail.com`)
  as `ssh` and `Bentley OS API`. Confirmed via `curl -I` returning `302` to
  `cloudflareaccess.com` login — Access is actually gating the endpoint.
- Second pre-existing "Me" policy (App-Launcher-only, ID `0544c4e3-...`) renamed
  `Me - App Launcher` to disambiguate.
- Service token generated (`whisper-laptop`, non-expiring) for scripted/off-browser
  access — used by a Hammerspoon push-to-talk script on Bentley's laptop
  (`~/.hammerspoon/init.lua`, not in this repo) that hits `/inference` directly.
- **Not yet done:** rotating this service token off plaintext in chat (see Open
  Questions) or moving it to macOS Keychain in the laptop script.

**Git:** `~/bentley-os` is a git repo, `main` branch, private. Remote:
`git@github.com:bentleylujero/bentley-os.git`. GitHub username `bentleylujero`.
Local in sync with `origin/main` at `5f28f3f`.
Recent commits: `369e256` (gcal + gmail ingestion wired into live api via node-cron) →
`5c020cc` (gcal: populate organizer_id and event_attendees) → `5f28f3f` (fix: keystone
end-to-end — undici timeout + OpenCode headless permissions).

**Deploy service** (`~/bentley-os/deploy/`): serialized queue, reads last-good commit from
`audit_log` → build → `up -d` → poll real `/health` over `backend` → success or
auto-rollback, every step audited. `SERVICE_HEALTH` map covers `api`, `contractor`,
`marionette`. Deploys go through `POST /deploy` — never raw compose for known services.
- **Known open bug:** rollback runs `git checkout <commit> -- .` — reverts the **entire repo
  tree**, not just the failed service's files. **Blocks Milestone 5** — must fix before any
  auto-executed AI action, since the blast radius of a bad auto-rollback is the same
  mechanism that must contain a bad AI action.

**Contractor service** (`~/bentley-os/contractor/`): the coding/build layer. `POST /execute`
runs a real `@opencode-ai/sdk` session against the systemd OpenCode server (LAN IP
`172.16.30.4:4096`), audited (`actor='contractor'`). `WORKDIR /app` (outside the bind
mount). Reached as `http://contractor:4100`.
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
  `action='marionette.think'`) → returned.
- **`delegate` branch — now genuinely verified**, not just claimed. `schema.ts` allowlists
  `target_service='contractor'` only (`DELEGATABLE_SERVICES = ['contractor']` — model can't
  invent a target). `index.ts` POSTs to `http://contractor:4100/execute`, audits
  `marionette.delegate`. Same `undici` timeout fix applied here (marionette's own fetch to
  contractor had no timeout override before — it would just hang indefinitely on a slow
  contractor call).
- **Confirmed end-to-end with a real task**: `/think` → delegate → contractor → OpenCode →
  actual file written to disk, verified with a direct `cat` (not just trusting the JSON
  response body, which can plausibly claim success without it being true).
- Failed delegation still returns 200 with the decision + error, never 502s a reasoning
  success.
- `MARIONETTE_MODEL` env var (default `deepseek-v4-pro`; set `deepseek-v4-flash` for cheap
  iteration).
- **Still cannot:** no memory (Qdrant unused, `/think` stateless), no delegation targets
  beyond contractor, no production-zone write actions (approval-gate layer is Milestone 4,
  not built) — contractor's writes are sandbox-only today, nothing auto-commits or
  auto-deploys from a delegated task.

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
  omission again once the capability exists.**
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

---

## 5. Data model

```
people ──< email_recipients >── emails
people ──< event_attendees  >── calendar_events
                                       │
                                   audit_log   (every deploy action, eventually every AI action)
sync_state   (source PK, sync_token, updated_at — incremental ingestion cursors)
```

---

## 6. Roadmap (ordered by what unblocks what)

**Milestone 0 — Clean the base: ✅ Done.** Embedder removed, ontology schema loaded,
Cloudflare Access email-locked + MFA on.

**Orchestrator build-order (precedes Milestone 1's remaining work): ✅ Done, and now
actually proven.**
- Deploy service — ✅ built, rollback-tested + fixed (scope bug still open, see §4/§8).
- Contractor (OpenCode container) — ✅ built, `/execute` wired to real OpenCode, live in
  prod, undici-timeout-hardened.
- Marionette — ✅ built, `/think` reasoning + `delegate` branch to contractor. **This is the
  build-machine keystone — marionette can direct contractor to write code, not just reason
  about it — and it's now verified against a real multi-step tool-call task, not just a
  trivial reply that happened to avoid the two bugs that were actually blocking it.**
- Wolverine (fixer) — not built.
- Local Whisper + embeddings — not built.

**Milestone 1 — Data in (Gmail + Calendar): 🔶 nearly done, one gap left**
| Step | Status |
|---|---|
| `sync_state` migration | ✅ applied |
| `gcal.ts` DB writes + token wiring | ✅ isolation-tested |
| `gmail.ts` (same pattern) | ✅ isolation-tested |
| Rebuild api image with `googleapis` | ✅ done |
| node-cron schedule in api | ✅ done, live in prod |
| Wire `gcal.ts` + `gmail.ts` into running api | ✅ done, live in prod |
| `event_attendees` / `organizer_id` population | ⬜ **last Milestone 1 gap** |

- **Done when:** new events + emails land in Postgres automatically, with provenance, **and**
  `event_attendees`/`organizer_id` are populated. First two conditions met; third is the
  remaining gap.

**Milestone 2 — Insight out.** Replace `apps/api/src/routes/dashboard.ts` (static status
card) with server-rendered views reading `calendar_events` / `emails` directly. "Today" +
"what changed" first.

**Milestone 3 — AI layer, read-only.** In **marionette**, not api. Classify email → the
existing `category`/`importance` columns. Morning brief. Grounded Q&A. This is where the
qdrant/embeddings decision can no longer be deferred.

**Milestone 4 — Action layer, approval-gated.** New action types (create event, draft reply,
commit + deploy via contractor) behind one-click approval, all writes through `audit_log`.
Contractor can already write sandbox code via delegation, but nothing auto-commits,
isolation-tests, or deploys yet from a delegated task — that pipeline is this milestone's
job.

**Milestone 5 — Earned autonomy.** Auto-execute low-risk tier only. **Blocked on the
rollback-scope fix (§4).**

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
  `package.json`, let the build install.
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

---

## 8. Open questions (decided-when-we-get-there, not blocking)

- **Docs cleanup:** old `.md` files (`00_NORTH_STAR`, `01_CURRENT_STATE`, `02_DECISIONS`,
  `03_ROADMAP`) retired in favor of this Bible. Remove from the project once trusted.
- **Rollback scope** (`git checkout -- .` is repo-wide, not per-service) — narrow before any
  real rollback test on `contractor`/`marionette`. **Blocks Milestone 5.**
- **OpenCode duplication:** the systemd OpenCode server and the `contractor` container are
  **not the same thing yet** — contractor calls the systemd server via SDK, doesn't replace
  it. When the container reaches parity, repoint `apps/api/src/routes/opencode.ts`'s
  `baseUrl` to `http://contractor:4100` in the *same* deploy that retires the systemd unit.
- **Postgres password rotation** — flagged (pasted plaintext into a chat), still not done.
- **DeepSeek API key fragment** — a masked fragment printed into a chat, not usable alone,
  noted alongside the Postgres rotation. Both still pending.
- **Shared audit module** — deploy + marionette + contractor each duplicate `audit_log`
  write logic; unify eventually. Ingestion (gcal/gmail) doesn't write to `audit_log` at
  all yet — decide whether it should before Milestone 2 dashboards need "last synced."
- **Embeddings provider** — resolved to "local model" but not built.
- **Whisper model size** — not decided.
- **Whisper service token exposed in chat** — `whisper-laptop` Client ID/Secret pasted
  in plaintext during setup (2026-07-11), same pattern as the Postgres/DeepSeek leaks.
  Not rotated yet. Consider moving the laptop-side Hammerspoon script's credentials to
  macOS Keychain instead of the plaintext `init.lua` file.
- **Log aggregation** specifics — not decided.
- **`event_attendees` / `organizer_id` gap** — last item blocking Milestone 1 completion.
- **`marionette/src/schema.ts`** has one leftover comment mentioning "opencode"
  conceptually — cosmetic, not fixed.

---

## 9. Guardrails to prevent contradiction/duplication

1. **One AI brain.** All classification/reasoning/generation goes in `marionette`. A
   prompt-calling function in `apps/api` belongs in marionette instead, with api calling
   marionette's HTTP endpoint.
2. **One build/deploy system.** `deploy` already has queueing, health polling, audit-backed
   rollback. Milestone 6's git automation is an *extension* of `deploy`, not a parallel
   service.
3. **Schema before code.** Check `0001_secretary_ontology.sql` before adding a column —
   `emails.category`/`importance` already exist.
4. **`audit_log` is the one ledger.** Deploy actions and AI actions both write here. No
   second "AI decisions" table.
5. **Local vs. pushed state.** `git status` at the start of every session.
6. **Two-zone autonomy, refined:**
   - **Sandbox zone** (marionette → contractor → OpenCode): full filesystem/build autonomy
     by design. Bentley doesn't use OpenCode interactively, so there's no
     human-in-the-loop cost to preserving. Enforced today via `opencode.json`'s permission
     policy (§4) — allow everything except a short deny-list of catastrophic `rm -rf`
     patterns.
   - **Production zone** (real Gmail, real deploys, anything outside the sandbox):
     default-deny for side-effecting actions, governed by an explicit allow/deny list
     (Milestone 4). Contractor writing a file today is sandbox; nothing auto-promotes that
     to production without the Milestone 4 approval gate.
   - **External comms are never in scope for autonomy, in either zone.** No
     email/messaging/external-comms MCP or tool is wired to contractor. If one ever is, it
     ships with an explicit deny in the permission policy from day one — never relying on
     "it just doesn't have that tool" once the tool exists.
