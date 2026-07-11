# Bentley OS — The Bible

*The single source of truth. Rules, architecture, project map, current state — all here.
When this conflicts with anything older, this wins. Regenerate from the repo whenever it
drifts; don't hand-edit it into staleness.*

*Last verified: 2026-07-11 (gcal + gmail ingestion wired into live api via node-cron).*

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
   auto, loosened deliberately, never by accident.

**North-star sequencing:** data in (Gmail + Calendar) → insight out (real dashboard) → AI
layer (classify, brief, grounded Q&A) → action layer (approval-gated) → earned autonomy
(low-risk auto) → self-extension (system ships its own tools).

---

## 1. Operating rules (how we work together)

**The most important fact:** I run everything on the server; Claude cannot. No network
access to the box (private LAN, `172.16.30.4`). The loop:
1. Claude gives exact, copy-pasteable commands or files.
2. I run them (SSH or browser terminal at `ssh.bentleyos.me`) and paste back raw output.
3. Claude reads the actual output — never assumes it worked — and gives the next step.

**Believe the output, not the prior.** If pasted output contradicts expectation, the output
is truth.

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

**File-creation quirk:** browser terminal has bracketed-paste issues — create files via
`cat > file << 'EOF'` heredoc, or scp from another machine for long files. Prefer fully
regenerated files over inline edits for small files.

---

## 2. Non-negotiable design rules

1. **Ontology-first.** Every feature maps to an object type, a link type, or an action —
   never a parallel ad-hoc table. Flag anything (mine included) that duplicates a fact or
   creates shadow state.
2. **Store each fact once.**
3. **Schema changes are versioned migrations** in `supabase/migrations/` (sequential numeric
   prefix, plain SQL, e.g. `0001_secretary_ontology.sql`) — never ad-hoc production edits.
4. **Host locally; AI is API-only.** No local model inference. Do not reintroduce a local
   embeddings/LLM service.
5. **Autonomy is earned.** Any AI action capability ships approval-gated first. Never wire
   autonomous actions onto real Gmail without a guardrail.

**Code conventions:**
- TypeScript + Hono for the API/app. Python only if genuinely unavoidable (we're removing the
  one Python service — so basically never).
- Match the codebase: named Hono route exports, mounted via `routes.route('/', x)`.
- **Import extensions depend on the service** — see the strip-types lesson (§7). Compiled-TS
  services (`api`) use `.js`; strip-types services (`deploy`, `contractor`, `marionette`) use
  `.ts`.
- After any api code change: `cd ~/bentley-os && docker compose up -d --build api` (running
  container keeps serving until the new build succeeds). For known services, prefer the deploy
  service (`POST /deploy {"service":"api"}`) over raw compose.
- Never ship a change that could take down `/health` without saying so and giving the rollback.

---

## 3. System map — who does what

One `docker-compose.yml`, two networks (`backend` for services, `monitoring` for ops tooling).
Every service has exactly one job. **If a new feature doesn't obviously belong to one row,
stop and decide before coding — don't let it leak into two services.**

| Service | Port | Owns | Does NOT own |
|---|---|---|---|
| **postgres** | 5432 (LAN only) | All persisted state — ontology, sync tokens, audit log | Vector search (qdrant) |
| **qdrant** | 6333 (LAN only) | Vector storage for embeddings (Milestone 3+) | Currently **unused** — nothing writes to it |
| **redis** | 6379 (LAN only) | Caching / ephemeral state | Unused by any service yet |
| **api** | 3000 | HTTP surface: `/health`, dashboard (`/`), ingestion (gcal/gmail → Postgres, now scheduled via node-cron every 5 min), OpenCode proxy (`/opencode/*`) | Build/deploy logic, AI reasoning |
| **deploy** | 4000 (127.0.0.1) | Build + restart + health-check + auto-rollback for `api`, `contractor`, `marionette`; writes every action to `audit_log` | *What* code does — purely CI/CD operator |
| **contractor** | 4100 (`backend` only) | The coding/build layer. `POST /execute` — real `@opencode-ai/sdk` session + prompt, audited | Orchestration, ingestion, deploy |
| **marionette** | 4200 (`backend` only) | The orchestrator. `POST /think` — DeepSeek reasoning, structured decision, audited. Can `reply` or `delegate` to contractor. AI reasoning/classification/brief/Q&A lives here | Ingestion (api's job), deploy (deploy's job) |
| **cloudflared** | — | Public tunnel, gated on `api` health | — |
| **portainer / dozzle / uptime-kuma** | 9000 / 8080 / 3001 | Ops visibility | Nothing app-level |

**Rule of thumb:** ingestion + read APIs live in `api`; AI reasoning lives in `marionette`;
anything touching `docker compose` or git lives in `deploy`. Task mentions two of these →
split the ticket.

**Cloudflare/networking gotcha:** `cloudflared` runs in a container on `backend`. It reaches
app services by container name (`http://api:3000`), host services (SSH) by LAN IP
(`172.16.30.4:22`). It **cannot** use `localhost` to mean the host.

**Same gotcha class:** `contractor` reaches the real systemd OpenCode server via LAN IP
`172.16.30.4:4096`, never `127.0.0.1` — the systemd service was originally bound to
`127.0.0.1` only (unreachable from any container) until fixed and rebound to `0.0.0.0:4096`,
still Basic Auth-gated.

---

## 4. Current state (living — what actually exists on the box right now)

Running on the box at `~/bentley-os` (Ubuntu, LAN IP `172.16.30.4`). Absolute path is
`/home/spaghettios/bentley-os` — always exact, never an alias (see §7 bind-mount lesson).

**Infrastructure — all up:** api (healthy, 3000), postgres (healthy, 5432), redis (6379),
qdrant (6333/6334 — reachable, zero collections, unused), cloudflared, dozzle (8080),
portainer (9000/8000/9443), uptime-kuma (healthy, 3001), deploy (healthy, 4000 / 127.0.0.1),
contractor (healthy, 4100, backend only), marionette (healthy, 4200, backend only).

**No `embedder` service exists** — confirmed absent. Embeddings deferred to a local model
(not yet built).

**Repo visibility:** confirmed **private** (`gh repo view` → `"visibility":"PRIVATE"`) as of
2026-07-11, after being discovered public despite this doc previously claiming private.
Grepped full git history for leaked secret values — only variable names/`${VAR}`
interpolation found, no actual values tracked. `.env`/`client_secret.json`/`token.json`
confirmed never tracked.

**Database (Postgres `bentley` db):** ontology schema loaded. Tables: `people`, `emails`,
`email_recipients`, `calendar_events`, `event_attendees`, `audit_log`, plus `sync_state`
(from `0002_sync_state.sql`, applied live).
- `emails` **already has** unused `category` + `importance` columns — the future classifier
  writes to these, no new migration needed. Don't recreate them.
- `calendar_events.organizer_id` and the whole `event_attendees` table are **still
  unpopulated** — current `gcal.ts` upsert doesn't populate people. Real gap to close before
  Milestone 3 Q&A. **This is now the last open item in Milestone 1.**
- `audit_log` columns: `id` (bigint identity), `at` (timestamptz, default now()), `actor`,
  `action`, `target` (nullable), `outcome` (nullable), `payload` (jsonb, default `{}`).
  Indexes on `action` and `at DESC`. Has real rows from deploy activity + `marionette.think`
  + `marionette.delegate`. Note: gcal/gmail ingestion runs do **not** currently write to
  `audit_log` — logged to container stdout only. Open item, not yet flagged as a gap.
- **psql inside the container:** use `-h 127.0.0.1` to force TCP+password auth (peer auth fails
  on the Unix socket):
```bash
  docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -c "..."
```

**Access / security:**
- `ssh.bentleyos.me` + `spaghettios.bentleyos.me` behind Cloudflare Access, policy **"Me"**
  (email = `bentley.lujero@gmail.com`).
- MFA enforced on the `ssh` app (TOTP via Apple Passwords), configured on that app's own MFA
  tab, not the global org toggle. App Launcher had to be enabled for enrollment redirect.
- Verify Access changes in **incognito** — existing sessions give false "still open" readings.

**Git:** `~/bentley-os` is a git repo, `main` branch, **private**. Remote:
`git@github.com:bentleylujero/bentley-os.git`. GitHub username `bentleylujero`.
Local in sync with `origin/main` at `369e256`.
Recent commits: `355e21b` (contractor /execute wired to OpenCode) → `8ab47d6` (marionette
delegate branch wired to contractor) → `0bb4f6c` (Bible: keystone update) → `369e256`
(gcal + gmail ingestion wired into live api via node-cron).

**Deploy service** (`~/bentley-os/deploy/`): serialized queue, reads last-good commit from
`audit_log` → build → `up -d` → poll real `/health` over `backend` → success or auto-rollback,
every step audited. `SERVICE_HEALTH` map covers `api`, `contractor`, `marionette`. Deploys go
through `POST /deploy` — never raw compose for known services.
- **Known open bug:** rollback runs `git checkout <commit> -- .` — reverts the **entire repo
  tree**, not just the failed service's files. Once briefly wiped the `deploy` block from
  `docker-compose.yml` on disk during testing. **Do not force a real rollback test on
  `contractor`/`marionette` until scoped per-service.** Keep service code and shared files
  (e.g. `docker-compose.yml`) in separate commits so this stays dormant. **This bug blocks
  Milestone 5 (earned autonomy)** — must fix before any auto-executed AI action.

**Contractor service** (`~/bentley-os/contractor/`): the coding/build layer. `POST /execute`
runs a real `@opencode-ai/sdk` session against the systemd OpenCode server (LAN IP
`172.16.30.4:4096`), audited (`actor='contractor'`). Isolation-tested, deployed, live in prod
(commit `355e21b`). `WORKDIR /app` (outside the bind mount). Reached as
`http://contractor:4100`.
- Note: `apps/api/src/routes/opencode.ts` (proxy to the real third-party systemd OpenCode
  server) was **deliberately left unrenamed** — "opencode" there is the actual tool
  (`@opencode-ai/sdk`, `opencode.json`), not our container. When the container reaches parity,
  repoint the proxy's `baseUrl` to `http://contractor:4100` in the *same* deploy that retires
  the systemd unit.

**Marionette service** (`~/bentley-os/marionette/`): the orchestrator, DeepSeek reasoning.
- `POST /think {"request":"..."}` → DeepSeek (`deepseek-v4-pro`, JSON mode) → structured
  `Decision {decision, message, reasoning}` → audited (`actor='marionette'`,
  `action='marionette.think'`) → returned. `GET /health` still bare `{status:"ok"}`.
- **`delegate` branch is now live**: `schema.ts` allowlists `target_service='contractor'`
  only (`DELEGATABLE_SERVICES = ['contractor']` — model can't invent a target); `index.ts`
  POSTs to `http://contractor:4100/execute` and audits `marionette.delegate`. Verified
  end-to-end in prod — both `reply` and `delegate` paths confirmed working (audit rows
  present, real file created via contractor in isolation test).
- Failed delegation still returns 200 with the decision + error, never 502s a reasoning
  success.
- `MARIONETTE_MODEL` env var (default `deepseek-v4-pro`; set `deepseek-v4-flash` for cheap
  iteration).
- System prompt scoped to present capability — hard-ruled to admit what it can't see rather
  than hallucinate. Verified in prod.
- **Still cannot:** no memory (Qdrant unused, `/think` stateless), no delegation targets
  beyond contractor, no production-zone write actions (approval-gate layer is Milestone 4,
  not built) — contractor's writes are sandbox-only today, nothing auto-commits or
  auto-deploys.

**Ingestion — now scheduled, not just test-script-only:**
- `apps/api/src/ingestion/scheduler.ts` (new, commit `369e256`): `node-cron` job, every 5
  minutes, runs `runGcalSync()` then `runGmailSync()` sequentially, guarded against overlap
  with a `running` flag. Started from `index.ts` inside the `serve()` callback.
- **OAuth secrets now mounted into the live `api` container**: `docker-compose.yml`'s `api`
  service gained a `volumes:` block —
  `/home/spaghettios/bentley-os/client_secret.json:/secrets/client_secret.json:ro` and
  `.../token.json:/secrets/token.json:ro` (exact absolute host path, per the bind-mount
  lesson in §7). Previously only the *test* container had these mapped via
  `GOOGLE_CLIENT_SECRET_PATH`/`GOOGLE_TOKEN_PATH` env override; prod `api` had no path to
  them at all until this change.
- Isolation-tested pre-deploy: build succeeded, `/health` OK, both `runGcalSync()` and
  `runGmailSync()` manually invoked inside the isolation container resolved `/secrets/*`
  correctly (gcal: 732 fetched/731 upserted; gmail: 38 fetched/38 upserted).
- Deployed via `POST /deploy {"service":"api"}` (job succeeded, health confirmed at attempt
  2/12). First live cron tick confirmed clean in prod logs: both syncs ran incremental
  (`fetched: 0, upserted: 0` — correct, since isolation test had just consumed the delta).
- `docker compose config --hash='*'` confirmed only `api`'s hash changed; no other service
  perturbed.

---

## 5. Data model
people ──< email_recipients >── emails
people ──< event_attendees  >── calendar_events
│
audit_log   (every deploy action, eventually every AI action)
sync_state   (source PK, sync_token, updated_at — incremental ingestion cursors)
---

## 6. Roadmap (ordered by what unblocks what)

**Milestone 0 — Clean the base: ✅ Done.** Embedder removed, ontology schema loaded,
Cloudflare Access email-locked + MFA on.

**Orchestrator build-order (precedes Milestone 1's remaining work): ✅ Done.**
- Deploy service — ✅ built, rollback-tested + fixed (scope bug still open, see §4/§8).
- Contractor (OpenCode container) — ✅ built, `/execute` wired to real OpenCode, live in prod.
- Marionette — ✅ built, `/think` reasoning + `delegate` branch to contractor, both verified
  live in prod. **This closes the build-machine keystone** — marionette can now direct
  contractor to write code, not just reason about it.
- Wolverine (fixer) — not built.
- Local Whisper + embeddings — not built.

**Milestone 1 — Data in (Gmail + Calendar): 🔶 nearly done, one gap left**
| Step | Status | File |
|---|---|---|
| `sync_state` migration | ✅ applied to DB | `supabase/migrations/0002_sync_state.sql` |
| `gcal.ts` DB writes + token wiring | ✅ isolation-tested | `apps/api/src/ingestion/gcal.ts` |
| `gmail.ts` (same pattern) | ✅ isolation-tested (693 backfill + 0 incremental) | `apps/api/src/ingestion/gmail.ts` |
| Rebuild api image with `googleapis` | ✅ done | `apps/api/package.json` |
| node-cron schedule in api | ✅ done, live in prod (5 min interval) | `apps/api/src/ingestion/scheduler.ts` |
| Wire `gcal.ts` + `gmail.ts` into running api | ✅ done, live in prod, first tick confirmed | `apps/api/src/index.ts` |
| `event_attendees` / `organizer_id` population | ⬜ not started — **last Milestone 1 gap** | `apps/api/src/ingestion/gcal.ts` |

- gcal verified: first run full 30-day backfill (`fetched: 1536, upserted: 1536`, token
  persisted); second run incremental (`fetched: 0, upserted: 0`, same `nextSyncToken`).
- OAuth: installed-app flow, `client_secret.json` + `token.json` at repo root, gitignored,
  now also bind-mounted read-only into the live `api` container at `/secrets/`.
- Google APIs enabled: Gmail, Calendar, People, Drive, Tasks, Docs, Sheets, Slides, Keep.
  Scopes: `gmail.readonly`, `calendar.readonly`, `contacts.readonly`.
- **Done when:** new events + emails land in Postgres automatically, with provenance
  (source / source_id), **and** `event_attendees`/`organizer_id` are populated so "who's
  coming to X" is answerable. First two conditions now met; third is the remaining gap.

**Milestone 2 — Insight out.** Replace `apps/api/src/routes/dashboard.ts` (static status card)
with server-rendered views reading `calendar_events` / `emails` directly. "Today" +
"what changed" first. Only reach for a separate frontend app if server-rendered can't keep up.

**Milestone 3 — AI layer, read-only.** In **marionette**, not api. Classify email → the
existing `category`/`importance` columns. Morning brief. Grounded Q&A. This is where the
qdrant/embeddings decision can no longer be deferred.

**Milestone 4 — Action layer, approval-gated.** New action types (create event, draft reply,
commit + deploy via contractor) behind one-click approval, all writes through `audit_log`.
This is the milestone that actually reduces manual terminal work — contractor can already
write sandbox code via delegation, but nothing auto-commits, isolation-tests, or deploys yet;
that pipeline is this milestone's job.

**Milestone 5 — Earned autonomy.** Auto-execute low-risk tier only. **Blocked on the
rollback-scope fix (§4)** — the blast radius of a bad auto-rollback is the same mechanism that
must contain a bad AI action. Should be scheduled before Milestone 4 ships anything that
writes for real.

**Milestone 6 — Self-extension.** Tool registry + isolated test + approval + git automation +
rollback, **reusing `deploy`'s** job/audit machinery — not a parallel build-and-rollback system.

---

## 7. Hard-won lessons (don't relearn these)

- **Bind-mount path must be exact.** Use `/home/spaghettios/bentley-os`, never an alias or
  `/repo`. A mismatched path made `docker compose config --hash` compute different hashes for
  *every* service (config hashing includes resolved relative paths), so deploying `api` alone
  recreated `postgres` mid-deploy. Data survived only via the named volume. Same rule applied
  when adding the OAuth secrets volume mount to `api` — exact absolute host path, verified
  with `docker compose config --hash='*'` afterward to confirm no other service perturbed.
- **`COMPOSE_PROJECT_NAME=bentley-os` must be pinned** — default basename spawned a duplicate
  stack.
- **Run `docker compose config --hash='*'`** after any service addition/change to confirm no
  other service was perturbed.
- **`WORKDIR` must be `/app`** (not the bind-mounted repo path) or the bind mount overwrites
  `node_modules` at runtime.
- **`.js` vs `.ts` imports:** strip-types services (`node --experimental-strip-types`, no
  compile step) MUST import internal modules with `.ts` extensions — `.js` throws
  `ERR_MODULE_NOT_FOUND` at startup. The `.js` convention is for *compiled* TS (`api`) only.
  Applies to `deploy`, `contractor`, `marionette`.
- **api uses `pg` + real `tsc` build + `.js` imports** — different pattern from the strip-types
  services; easy to get wrong.
- **Node/npm live only inside Docker** — host has neither. Dependency changes = hand-edit
  `package.json`, let the build install.
- **Isolation-test before any commit** — throwaway `docker run`, run `/health` + the real path,
  confirm audit row (or, for ingestion, confirm the sync result object directly since gcal/gmail
  don't write audit rows yet), before deploying. Caught the `.js`/`.ts` bug with zero risk; also
  how the `/secrets` mount was verified to actually resolve inside the container before
  trusting it in prod.
- **`audit_log` is authoritative** for deployment state, not raw git history alone. Not yet
  authoritative for ingestion state — gcal/gmail sync results are stdout-only.
- **Incognito required** for accurate Cloudflare Access verification.
- **`-h 127.0.0.1`** required for `psql` TCP auth inside the postgres container.
- **Contractor reaches OpenCode via LAN IP, never `127.0.0.1`** — same container-network
  gotcha class as Cloudflare's; a bound-to-loopback service is unreachable from any other
  container regardless of shared network.
- **Long file pastes break the browser terminal** — for anything beyond a short heredoc,
  generate the file locally, or manually edit and commit via the GitHub web UI, rather than
  fighting scp or paste limits.

---

## 8. Open questions (decided-when-we-get-there, not blocking)

- **Docs cleanup:** the old `.md` files (`00_NORTH_STAR`, `01_CURRENT_STATE`, `02_DECISIONS`,
  `03_ROADMAP`, etc.) are being retired in favor of this Bible. Remove them from the project
  once this doc is trusted.
- **Rollback scope** (`git checkout -- .` is repo-wide, not per-service) — narrow before any
  real rollback test on `contractor`/`marionette`, and before any commit mixes shared files
  with service code. **Blocks Milestone 5.** Stakes rise with each service sharing the repo.
- **OpenCode duplication:** the systemd OpenCode server (`127.0.0.1:4096` internally, now
  reachable at `172.16.30.4:4096` from containers) and the `contractor` container are **not
  the same thing yet** — contractor calls the systemd server via SDK, it doesn't replace it.
  When the container reaches parity, repoint `apps/api/src/routes/opencode.ts`'s `baseUrl` to
  `http://contractor:4100` in the *same* deploy that retires the systemd unit. Don't run both
  long-term.
- **Postgres password rotation** — flagged (pasted plaintext into a chat 2026-07-10), still
  not done.
- **DeepSeek API key fragment** — a 6-char masked fragment printed into a chat; not usable
  alone, noted alongside the Postgres rotation. Both still pending as of 2026-07-11.
- **Shared audit module** — deploy + marionette + contractor each duplicate `audit_log` write
  logic; unify eventually. Ingestion (gcal/gmail) doesn't write to `audit_log` at all yet —
  decide whether it should before Milestone 2 dashboards need to show "last synced."
- **Embeddings provider** — resolved to "local model" but not built. If memory is the next
  marionette sense, decide deliberately and log it — never slip in OpenAI as an offhand change.
- **Whisper model size** (tiny/base/small) — not decided.
- **Log aggregation** specifics (which logs, retention) — not decided.
- **`event_attendees` / `organizer_id` gap** — `gcal.ts` doesn't populate people yet. **Now
  the last item blocking Milestone 1 completion** — close before Milestone 3 Q&A needs
  "who's coming to X."
- **`marionette/src/schema.ts`** has one leftover comment mentioning "opencode" conceptually —
  cosmetic, not fixed.

---

## 9. Guardrails to prevent contradiction/duplication

1. **One AI brain.** All classification/reasoning/generation goes in `marionette`. Catch
   yourself writing a prompt-calling function in `apps/api` → stop, it belongs in marionette,
   with api calling marionette's HTTP endpoint.
2. **One build/deploy system.** `deploy` already has queueing, health polling, audit-backed
   rollback. Milestone 6's git automation is an *extension* of `deploy`, not a parallel service.
3. **Schema before code.** Check `0001_secretary_ontology.sql` before adding a column —
   `emails.category`/`importance` already exist; don't re-add under a new name.
4. **`audit_log` is the one ledger.** Deploy actions and AI actions both write here. No second
   "AI decisions" table — extend `audit_log`'s `action`/`payload` conventions.
5. **Local vs. pushed state.** `git status` at the start of every session — this doc reflects
   the repo at time of writing, not necessarily right now.
6. **Two-zone autonomy.** Sandbox zone (marionette/contractor have full freedom, contained
   blast radius) vs. production zone (default-deny for side-effecting actions — send email,
   delete files, real-world writes — governed by explicit allow/deny list, Milestone 4).
   Contractor writing a file via `/execute` today is sandbox; nothing auto-promotes that to
   production without the Milestone 4 approval gate.
