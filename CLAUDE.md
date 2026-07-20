# Bentley OS — rules for Claude Code

You run commands on the box directly. THE_BIBLE.md is ground truth — read it before acting.
Believe real output over any prior assumption. Never say something worked without checking.

## Hard rules (from Bible §2, §7, §9)
- Isolation-test before every commit: `docker build -t <tag> apps/<svc>` (context is
  apps/<svc>/, NOT repo root), throwaway `docker run` on bentley-os_backend, probe /health +
  the real path via `node -e fetch(...)` (no curl in alpine/slim images).
- Deploy known services (api/contractor/marionette) via `POST http://127.0.0.1:4000/deploy
  {"service":"..."}` — confirm success by the `deploy.succeeded` audit row, NEVER the 202.
  whisper is NOT in the deploy map — rebuild it with raw `docker compose up -d --build whisper`.
- `git add` by explicit path, NEVER `-A` (untracked .bak files in tree).
- Import extensions: api uses `.js` (compiled tsc); deploy/contractor/marionette use `.ts`
  (strip-types). Wrong one throws ERR_MODULE_NOT_FOUND at startup.
- Schema changes = versioned migration in supabase/migrations/ (sequential prefix, plain SQL).
  Never ad-hoc production edits.
- psql in container: `docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley
  -d bentley -P pager=off -c "..."` (peer auth fails on socket; no less installed).
- Escape all DB-derived strings before HTML interpolation (esc() helper).
- Single-FILE bind mounts (token.json, client_secret.json) are pinned to an inode. Replace
  in place with `cat new > old` — NEVER `mv`/`rm`+`cp`, which silently leaves the container
  serving stale content. Verify the value from INSIDE the container, not the host.
- One-off helper scripts must live inside the app tree (/usr/src/app/), not /tmp — ESM
  resolves node_modules from the script's own directory, so /tmp throws ERR_MODULE_NOT_FOUND
  regardless of `-w`. Delete after use.
- Ingestion health = `sync_state.updated_at` age. token.json's expiry_date is frozen at mint
  and is NOT a health signal. /health green does not mean data is flowing.
- Never ship a change that could take down /health without saying so + giving rollback.
- `git fetch origin` + diff origin/main BEFORE every push (Copilot cloud agent reverts docs).

## Architecture (Bible §3, §9)
- One brain: all AI reasoning lives in marionette, never in apps/api.
- Ingestion + read APIs → api. docker/git → deploy. AI reasoning → marionette.
- audit_log is the one ledger. No parallel tables. Ontology-first, store each fact once.
- Absolute path is /home/spaghettios/bentley-os — never an alias.

## When done
Update THE_BIBLE.md current-state (§4); roadmap/open-questions when a milestone or decision
moves. Regenerate from repo state, don't hand-edit into staleness.
