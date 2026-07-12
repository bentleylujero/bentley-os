Welcome to Ubuntu 26.04 LTS (GNU/Linux 7.0.0-27-generic x86_64)

 * Documentation:  https://docs.ubuntu.com
 * Management:     https://landscape.canonical.com
 * Support:        https://ubuntu.com/pro

 System information as of Sun Jul 12 07:25:47 PM UTC 2026

  System load:  0.11               Temperature:             216.0 C
  Usage of /:   9.3% of 217.97GB   Processes:               329
  Memory usage: 18%                Users logged in:         0
  Swap usage:   0%                 IPv4 address for enp4s0: 172.16.30.4

 * Strictly confined Kubernetes makes edge and IoT secure. Learn how MicroK8s
   just raised the bar for easy, resilient and secure K8s cluster deployment.

   https://ubuntu.com/engage/secure-kubernetes-at-the-edge

Expanded Security Maintenance for Applications is not enabled.

21 updates can be applied immediately.
To see these additional updates run: apt list --upgradable

1 additional security update can be applied with ESM Apps.
Learn more about enabling ESM Apps service at https://ubuntu.com/esm


Last login: Sun Jul 12 18:41:02 2026 from 172.19.0.6
spaghettios@spaghettios:~$ cd ~/bentley-os && git status && git log --oneline -3
On branch slice1-image-rollback
Your branch is up to date with 'origin/slice1-image-rollback'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
        modified:   apps/api/src/routes/dashboard.ts

no changes added to commit (use "git add" and/or "git commit -a")
0cf613e (HEAD -> slice1-image-rollback, origin/slice1-image-rollback) Refactor rollback process to use image preservation
7cb895d (origin/main, origin/HEAD, main) chore: gitignore whisper/Dockerfile.bak
403c84b Update THE_BIBLE.md with commit details and notes
spaghettios@spaghettios:~/bentley-os$ git diff apps/api/src/routes/dashboard.ts
diff --git a/apps/api/src/routes/dashboard.ts b/apps/api/src/routes/dashboard.ts
index fe56e5d..285ad0d 100644
--- a/apps/api/src/routes/dashboard.ts
+++ b/apps/api/src/routes/dashboard.ts
@@ -23,85 +23,188 @@ function fmtTime(d: Date | null): string {
   });
 }
 
+function fmtDate(d: Date | null): string {
+  if (!d) return '';
+  const now = new Date();
+  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
+  const val = new Date(d.getFullYear(), d.getMonth(), d.getDate());
+  const diffDays = Math.floor((today.getTime() - val.getTime()) / 86400000);
+  if (diffDays === 0) {
+    return d.toLocaleTimeString('en-US', {
+      hour: 'numeric',
+      minute: '2-digit',
+      timeZone: TZ,
+    });
+  } else if (diffDays === 1) {
+    return 'Yesterday';
+  } else {
+    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ });
+  }
+}
+
+function isNew(receivedAt: Date | null, lastSeen: string | null): boolean {
+  if (!receivedAt) return false;
+  if (lastSeen) {
+    const seen = new Date(lastSeen);
+    return new Date(receivedAt).getTime() > seen.getTime();
+  }
+  return Date.now() - new Date(receivedAt).getTime() < 3600000;
+}
+
 dashboardRoute.get('/', async (c) => {
   let events: any[] = [];
   let emails: any[] = [];
+  let recentEmails: any[] = [];
+  let recentEvents: any[] = [];
   let dbError = '';
 
   try {
     const eventsQ = pool.query(
-      `SELECT title, starts_at, ends_at, location, status
+      SELECT title, starts_at, ends_at, location, status
          FROM calendar_events
         WHERE starts_at AT TIME ZONE $1 >= (now() AT TIME ZONE $1)::date
           AND starts_at AT TIME ZONE $1 <  ((now() AT TIME ZONE $1)::date + interval '1 day')
-        ORDER BY starts_at ASC`,
+        ORDER BY starts_at ASC,
       [TZ]
     );
+
     const emailsQ = pool.query(
-      `SELECT subject, snippet, received_at, is_unread
+      SELECT subject, snippet, received_at, is_unread
          FROM emails
         ORDER BY received_at DESC NULLS LAST
-        LIMIT 15`
+        LIMIT 15
+    );
+
+    const recentEmailsQ = pool.query(
+      SELECT subject, snippet, received_at, is_unread
+         FROM emails
+        WHERE created_at > now() - interval '24 hours'
+        ORDER BY created_at DESC
+        LIMIT 10
+    );
+
+    const recentEventsQ = pool.query(
+      SELECT title, starts_at, location
+         FROM calendar_events
+        WHERE created_at > now() - interval '24 hours'
+        ORDER BY created_at DESC
+        LIMIT 10
     );
-    const [eventsR, emailsR] = await Promise.all([eventsQ, emailsQ]);
+
+    const [eventsR, emailsR, recentEmailsR, recentEventsR] = await Promise.all([
+      eventsQ, emailsQ, recentEmailsQ, recentEventsQ,
+    ]);
     events = eventsR.rows;
     emails = emailsR.rows;
+    recentEmails = recentEmailsR.rows;
+    recentEvents = recentEventsR.rows;
   } catch (err: any) {
     dbError = err?.message ?? 'query failed';
spaghettios@spaghettios:~/bentley-os$ git checkout -- apps/api/src/routes/dashboard.ts
spaghettios@spaghettios:~/bentley-os$ git status
On branch slice1-image-rollback
Your branch is up to date with 'origin/slice1-image-rollback'.

nothing to commit, working tree clean
spaghettios@spaghettios:~/bentley-os$ git log --oneline --graph --all -15
* 0cf613e (HEAD -> slice1-image-rollback, origin/slice1-image-rollback) Refactor rollback process to use image preservation
* 7cb895d (origin/main, origin/HEAD, main) chore: gitignore whisper/Dockerfile.bak
* 403c84b Update THE_BIBLE.md with commit details and notes
* ef41370 Update THE_BIBLE.md to remove obsolete information
* 8ac171c Enhance deploy action completion and Telegram notifications
* 80298a4 feat(m4): async deploy-completion — poll audit_log to true finish, push ✅/❌ to Telegram
* 14c063a Revise THE_BIBLE.md for project updates and milestones
* 7d79632 feat(m2): server-rendered Today dashboard — today's events + recent email from Postgres
* fa39f5c Integrate audit-sight into marionette for real-time updates
* 27f18b3 feat(marionette): /think consumes audit-sight — narrates real system state
* 125de94 Revise documentation for Milestone 4 and Telegram integration
* 9f3f054 feat(marionette): audit-sight read endpoint (GET /audit/summary)
* b13c5ce feat(m4): Telegram approve/deny buttons + surface endpoint
* 3a66aef feat(m4): approval-gated action layer — propose/approve/deny/execute lifecycle
* 5862496 docs(bible): rollback-scope resolved (52c3f72); correct password 'drift' -> stale shell-var override; note b08a re-exposure
spaghettios@spaghettios:~/bentley-os$ git show --stat 0cf613e
commit 0cf613e9aaa32405e87e4794ac0300fd27d0cdc7 (HEAD -> slice1-image-rollback, origin/slice1-image-rollback)
Author: Bentley Lujero <bentley.lujero@gmail.com>
Date:   Sun Jul 12 10:47:42 2026 -0500

    Refactor rollback process to use image preservation
    
    Refactor rollback mechanism to use preserved images instead of git checkout. Update logging and audit payloads to include rollback image details.

 deploy/src/runner.ts | 118 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++------------------------------
 1 file changed, 88 insertions(+), 30 deletions(-)
spaghettios@spaghettios:~/bentley-os$ git checkout main
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
spaghettios@spaghettios:~/bentley-os$ git fetch origin && git status && git log --oneline -3
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
7cb895d (HEAD -> main, origin/main, origin/HEAD) chore: gitignore whisper/Dockerfile.bak
403c84b Update THE_BIBLE.md with commit details and notes
ef41370 Update THE_BIBLE.md to remove obsolete information
spaghettios@spaghettios:~/bentley-os$ ls supabase/migrations/ && echo "---" && cat supabase/migrations/0003_actions.sql
0001_secretary_ontology.sql  0002_sync_state.sql  0003_actions.sql
---
-- 0003_actions.sql
-- First-class action objects: proposed side-effecting operations awaiting human approval.
-- Mutable current-state store. audit_log remains the append-only ledger (target = actions.id).

create table if not exists actions (
  id            bigint generated always as identity primary key,
  kind          text not null,                    -- 'commit_deploy' (first + only slice for now)
  status        text not null default 'proposed', -- proposed|approved|executing|succeeded|failed|denied
  proposed_by   text not null,                    -- 'marionette'
  intent        jsonb not null default '{}',      -- machine-executable: {service, commit_message, ...}
  briefing      text,                             -- marionette's human-facing synthesis (dormant until steering lands)
  result        jsonb not null default '{}',      -- filled on execution outcome
  supersedes_id bigint,                           -- lineage pointer (dormant until steering lands)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_actions_status on actions (status);
create index if not exists idx_actions_created on actions (created_at desc);
spaghettios@spaghettios:~/bentley-os$ cat > supabase/migrations/0004_dashboard_state.sql << 'EOF'
-- 0004_dashboard_state.sql
-- Singleton state for the dashboard's "what changed" view.
-- Holds one fact: the last time the owner viewed the dashboard.
-- Enforced single-row (id pinned to 1) — not a shadow table, one fact stored once.
create table if not exists dashboard_state (
  id           smallint primary key default 1 check (id = 1),
  last_seen_at timestamptz not null default now()
);

-- Seed the singleton row. on conflict keeps re-running the migration safe.
insert into dashboard_state (id, last_seen_at)
values (1, now())
on conflict (id) do nothing;
EOF
spaghettios@spaghettios:~/bentley-os$ cat supabase/migrations/0004_dashboard_state.sql
-- 0004_dashboard_state.sql
-- Singleton state for the dashboard's "what changed" view.
-- Holds one fact: the last time the owner viewed the dashboard.
-- Enforced single-row (id pinned to 1) — not a shadow table, one fact stored once.
create table if not exists dashboard_state (
  id           smallint primary key default 1 check (id = 1),
  last_seen_at timestamptz not null default now()
);

-- Seed the singleton row. on conflict keeps re-running the migration safe.
insert into dashboard_state (id, last_seen_at)
values (1, now())
on conflict (id) do nothing;
spaghettios@spaghettios:~/bentley-os$ docker exec -i bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off < supabase/migrations/0004_dashboard_state.sql
CREATE TABLE
INSERT 0 1
spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c "SELECT * FROM dashboard_state;"
 id |         last_seen_at          
----+-------------------------------
  1 | 2026-07-12 19:34:10.699341+00
(1 row)

spaghettios@spaghettios:~/bentley-os$ cat apps/api/src/routes/dashboard.ts
import { Hono } from 'hono';
import { pool } from '../db/pool.js';

export const dashboardRoute = new Hono();

const TZ = 'America/Chicago';

function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

dashboardRoute.get('/', async (c) => {
  let events: any[] = [];
  let emails: any[] = [];
  let dbError = '';

  try {
    const eventsQ = pool.query(
      `SELECT title, starts_at, ends_at, location, status
         FROM calendar_events
        WHERE starts_at AT TIME ZONE $1 >= (now() AT TIME ZONE $1)::date
          AND starts_at AT TIME ZONE $1 <  ((now() AT TIME ZONE $1)::date + interval '1 day')
        ORDER BY starts_at ASC`,
      [TZ]
    );
    const emailsQ = pool.query(
      `SELECT subject, snippet, received_at, is_unread
         FROM emails
        ORDER BY received_at DESC NULLS LAST
        LIMIT 15`
    );
    const [eventsR, emailsR] = await Promise.all([eventsQ, emailsQ]);
    events = eventsR.rows;
    emails = emailsR.rows;
  } catch (err: any) {
    dbError = err?.message ?? 'query failed';
  }

  const eventsHtml = dbError
    ? `<p class="muted">couldn't load events: ${esc(dbError)}</p>`
    : events.length === 0
    ? `<p class="muted">Nothing on the calendar today.</p>`
    : events
        .map(
          (e) => `<div class="row">
        <span class="time">${esc(fmtTime(e.starts_at))}</span>
        <span class="body"><b>${esc(e.title) || '(untitled)'}</b>${
            e.location ? `<span class="sub"> · ${esc(e.location)}</span>` : ''
          }</span>
      </div>`
        )
        .join('');

  const emailsHtml = dbError
    ? ''
    : emails.length === 0
    ? `<p class="muted">No emails yet.</p>`
    : emails
        .map(
          (m) => `<div class="row">
        <span class="time">${esc(fmtTime(m.received_at))}</span>
        <span class="body">${m.is_unread ? '<span class="unread">●</span> ' : ''}<b>${
            esc(m.subject) || '(no subject)'
          }</b>${m.snippet ? `<span class="sub"> — ${esc(m.snippet)}</span>` : ''}</span>
      </div>`
        )
        .join('');

  return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bentley OS</title>
<style>
  body{background:#0b0e14;color:#e6e6e6;font-family:ui-monospace,Menlo,monospace;margin:0;padding:2rem;}
  .wrap{max-width:680px;margin:0 auto;}
  h1{font-size:1.4rem;letter-spacing:.02em;}
  h2{font-size:.95rem;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin:1.5rem 0 .5rem;}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#3fb950;margin-right:8px;}
  .card{background:#151a23;border:1px solid #222b38;border-radius:10px;padding:1rem 1.25rem;margin:.5rem 0;}
  .row{display:flex;gap:.9rem;padding:.45rem 0;border-bottom:1px solid #1c2431;}
  .row:last-child{border-bottom:none;}
  .time{color:#8b949e;font-size:.85rem;min-width:64px;white-space:nowrap;}
  .body{flex:1;overflow:hidden;}
  .sub{color:#8b949e;font-weight:normal;}
  .unread{color:#58a6ff;}
  a{color:#58a6ff;text-decoration:none;} a:hover{text-decoration:underline;}
  .muted{color:#8b949e;font-size:.85rem;}
</style></head>
<body><div class="wrap">
  <h1><span class="dot"></span>Bentley OS</h1>

  <h2>Today</h2>
  <div class="card">${eventsHtml}</div>

  <h2>Recent email</h2>
  <div class="card">${emailsHtml}</div>

  <p class="muted"><a href="/health">/health</a> · <span id="time"></span></p>
</div>
<script>document.getElementById('time').textContent = new Date().toLocaleString();</script>
</body></html>`);
});
spaghettios@spaghettios:~/bentley-os$ git pull origin main
remote: Enumerating objects: 13, done.
remote: Counting objects: 100% (13/13), done.
remote: Compressing objects: 100% (6/6), done.
remote: Total 7 (delta 5), reused 0 (delta 0), pack-reused 0 (from 0)
Unpacking objects: 100% (7/7), 2.58 KiB | 1.29 MiB/s, done.
From github.com:bentleylujero/bentley-os
 * branch            main       -> FETCH_HEAD
   7cb895d..5955d8d  main       -> origin/main
Updating 7cb895d..5955d8d
Fast-forward
 apps/api/src/routes/dashboard.ts | 109 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++-----
 1 file changed, 104 insertions(+), 5 deletions(-)
spaghettios@spaghettios:~/bentley-os$ grep -n "dashboard_state\|newEmailsQ\|What changed\|last_seen_at" apps/api/src/routes/dashboard.ts
50:      `SELECT last_seen_at FROM dashboard_state WHERE id = 1`
52:    lastSeen = seenR.rows[0]?.last_seen_at ?? null;
72:    // "What changed" = rows ingested (created_at) since the owner last looked.
74:    const newEmailsQ = lastSeen
98:      newEmailsQ,
113:    .query(`UPDATE dashboard_state SET last_seen_at = now() WHERE id = 1`)
178:      ? `What changed <span class="count">${changedCount}</span>`
179:      : `What changed`;
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git status && git rev-parse HEAD
On branch main
Your branch is up to date with 'origin/main'.

Untracked files:
  (use "git add <file>..." to include in what will be committed)
        supabase/migrations/0004_dashboard_state.sql

nothing added to commit but untracked files present (use "git add" to track)
5955d8d8f3c90d7b9ab8ffb35872c492e315879f
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && docker build -t api-isotest -f apps/api/Dockerfile .
[+] Building 2.6s (7/10)                                                                                                                                                  docker:default
 => [internal] load build definition from Dockerfile                                                                                                                                0.0s
 => => transferring dockerfile: 300B                                                                                                                                                0.0s
 => [internal] load metadata for docker.io/library/node:22-alpine                                                                                                                   0.0s
 => [internal] load .dockerignore                                                                                                                                                   0.0s
 => => transferring context: 2B                                                                                                                                                     0.0s
 => [1/6] FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => => resolve docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => [internal] load build context                                                                                                                                                   2.4s
 => => transferring context: 349.22MB                                                                                                                                               2.3s
 => CACHED [2/6] WORKDIR /usr/src/app                                                                                                                                               0.0s
 => ERROR [3/6] COPY package.json ./                                                                                                                                                0.0s
------
 > [3/6] COPY package.json ./:
------
Dockerfile:4
--------------------
   2 |     WORKDIR /usr/src/app
   3 |     
   4 | >>> COPY package.json ./
   5 |     RUN npm install
   6 |     
--------------------
ERROR: failed to build: failed to solve: failed to compute cache key: failed to calculate checksum of ref kfoe8a2ed40wx15i83lxonog4::excg7lqdacutza2k20slk9g8e: "/package.json": not found
spaghettios@spaghettios:~/bentley-os$ cat /home/spaghettios/bentley-os/apps/api/Dockerfile
FROM node:22-alpine AS base
WORKDIR /usr/src/app

COPY package.json ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["npm", "start"]
spaghettios@spaghettios:~/bentley-os$ ls /home/spaghettios/bentley-os/apps/api/package.json /home/spaghettios/bentley-os/package.json 2>&1
ls: cannot access '/home/spaghettios/bentley-os/package.json': No such file or directory
/home/spaghettios/bentley-os/apps/api/package.json
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && docker build -t api-isotest apps/api
[+] Building 8.3s (11/11) FINISHED                                                                                                                                        docker:default
 => [internal] load build definition from Dockerfile                                                                                                                                0.0s
 => => transferring dockerfile: 300B                                                                                                                                                0.0s
 => [internal] load metadata for docker.io/library/node:22-alpine                                                                                                                   0.0s
 => [internal] load .dockerignore                                                                                                                                                   0.0s
 => => transferring context: 69B                                                                                                                                                    0.0s
 => [1/6] FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => => resolve docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => [internal] load build context                                                                                                                                                   0.0s
 => => transferring context: 17.20kB                                                                                                                                                0.0s
 => CACHED [2/6] WORKDIR /usr/src/app                                                                                                                                               0.0s
 => CACHED [3/6] COPY package.json ./                                                                                                                                               0.0s
 => CACHED [4/6] RUN npm install                                                                                                                                                    0.0s
 => [5/6] COPY . .                                                                                                                                                                  0.1s
 => [6/6] RUN npm run build                                                                                                                                                         7.5s
 => exporting to image                                                                                                                                                              0.4s 
 => => exporting layers                                                                                                                                                             0.2s 
 => => exporting manifest sha256:29111bf3aebc5a6e2755fbf2eaff00bb87398113cd8c1464d1653fbd9a96c381                                                                                   0.0s
 => => exporting config sha256:588d7c9881f4bea4d48d6aaafeb3cd83b5abdaeb3fbb5f7d97732c7b8e5adf74                                                                                     0.0s
 => => exporting attestation manifest sha256:f1f3d1358100b22076b10bc6b357c8042fb49fb0f31f8a961fbc4c7a28376368                                                                       0.0s
 => => exporting manifest list sha256:7976482371b6d035e557b7e08fb5797578d6707b2baae5c5a947a0da44ab03d2                                                                              0.0s
 => => naming to docker.io/library/api-isotest:latest                                                                                                                               0.0s
 => => unpacking to docker.io/library/api-isotest:latest                                                                                                                            0.1s
spaghettios@spaghettios:~/bentley-os$ spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && docker build -t api-isotest apps/api
[+] Building 8.3s (11/11) FINISHED                                                                                                                                        docker:default
 => [internal] load build definition from Dockerfile                                                                                                                                0.0s
 => => transferring dockerfile: 300B                                                                                                                                                0.0s
 => [internal] load metadata for docker.io/library/node:22-alpine                                                                                                                   0.0s
 => [internal] load .dockerignore                                                                                                                                                   0.0s
 => => transferring context: 69B                                                                                                                                                    0.0s
 => [1/6] FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => => resolve docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => [internal] load build context                                                                                                                                                   0.0s
 => => transferring context: 17.20kB                                                                                                                                                0.0s
 => CACHED [2/6] WORKDIR /usr/src/app                                                                                                                                               0.0s
 => CACHED [3/6] COPY package.json ./                                                                                                                                               0.0s
 => CACHED [4/6] RUN npm install                                                                                                                                                    0.0s
 => [5/6] COPY . .                                                                                                                                                                  0.1s
 => [6/6] RUN npm run build                                                                                                                                                         7.5s
 => exporting to image                                                                                                                                                              0.4s  
 => => exporting layers                                                                                                                                                             0.2s  
 => => exporting manifest sha256:29111bf3aebc5a6e2755fbf2eaff00bb87398113cd8c1464d1653fbd9a96c381                                                                                   0.0s
 => => exporting config sha256:588d7c9881f4bea4d48d6aaafeb3cd83b5abdaeb3fbb5f7d97732c7b8e5adf74                                                                                     0.0s
 => => exporting attestation manifest sha256:f1f3d1358100b22076b10bc6b357c8042fb49fb0f31f8a961fbc4c7a28376368                                                                       0.0s
 => => exporting manifest list sha256:7976482371b6d035e557b7e08fb5797578d6707b2baae5c5a947a0da44ab03d2                                                                              0.0s
 => => naming to docker.io/library/api-isotest:latest                                                                                                                               0.0s
 => => unpacking to docker.io/library/api-isotest:latest                                                                                                                            0.1s
spaghettios@spaghettios:~/bentley-os$ 
-bash: spaghettios@spaghettios:~/bentley-os$: No such file or directory
-bash: syntax error near unexpected token `('
=: command not found
=: command not found
=: command not found
=: command not found
=: command not found
-bash: [1/6]: No such file or directory
=: command not found
=: command not found
=: command not found
=: command not found
=: command not found
=: command not found
-bash: [5/6]: No such file or directory
-bash: [6/6]: No such file or directory
=: command not found
=: command not found
=: command not found
=: command not found
=: command not found
=: command not found
=: command not found
=: command not found
-bash: spaghettios@spaghettios:~/bentley-os$: No such file or directory
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && docker run -d --rm --name api-isotest-run --network bentley-os_backend --env-file .env api-isotest
7ba0f3391b1530545e8d33bf75ad8c7492f7c2c7078f1f7fe07e3c16f1c89958
spaghettios@spaghettios:~/bentley-os$ sleep 3 && docker exec api-isotest-run node -e "fetch('http://localhost:3000/health').then(r=>r.text()).then(t=>console.log('HEALTH:',t)).catch(e=>console.log('ERR:',e.message))"
HEALTH: {"status":"ok","db":"connected","service":"bentley-os-api"}
spaghettios@spaghettios:~/bentley-os$ docker exec api-isotest-run node -e "fetch('http://localhost:3000/').then(r=>r.text()).then(t=>console.log(t.slice(0,2500))).catch(e=>console.log('ERR:',e.message))"
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bentley OS</title>
<style>
  body{background:#0b0e14;color:#e6e6e6;font-family:ui-monospace,Menlo,monospace;margin:0;padding:2rem;}
  .wrap{max-width:680px;margin:0 auto;}
  h1{font-size:1.4rem;letter-spacing:.02em;}
  h2{font-size:.95rem;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin:1.5rem 0 .5rem;}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#3fb950;margin-right:8px;}
  .card{background:#151a23;border:1px solid #222b38;border-radius:10px;padding:1rem 1.25rem;margin:.5rem 0;}
  .row{display:flex;gap:.9rem;padding:.45rem 0;border-bottom:1px solid #1c2431;}
  .row:last-child{border-bottom:none;}
  .time{color:#8b949e;font-size:.85rem;min-width:88px;white-space:nowrap;}
  .body{flex:1;overflow:hidden;}
  .sub{color:#8b949e;font-weight:normal;}
  .unread{color:#58a6ff;}
  .tag{display:inline-block;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;border:1px solid #2a3441;border-radius:4px;padding:0 5px;margin-right:4px;}
  .count{display:inline-block;background:#238636;color:#fff;font-size:.7rem;border-radius:9px;padding:0 7px;margin-left:6px;vertical-align:middle;}
  a{color:#58a6ff;text-decoration:none;} a:hover{text-decoration:underline;}
  .muted{color:#8b949e;font-size:.85rem;}
</style></head>
<body><div class="wrap">
  <h1><span class="dot"></span>Bentley OS</h1>
  <h2>What changed <span class="count">1</span></h2>
  <div class="card"><div class="row">
        <span class="time">Jul 12, 2:40 PM</span>
        <span class="body"><span class="tag">email</span> <span class="unread">●</span> <b>Phi Cu paid your $60.00 request</b><span class="sub"> — Bentley Lujero paid you $60.00 Phi Cu paid you $ 60 . 00 Coffee See transaction Money credited to your Venmo account. Transaction details Date Jul 12, 2026 Transaction ID 4639882118796926157 Sent to @</span></span>
      </div></div>
  <h2>Today</h2>
  <div class="card"><div class="row">
        <span class="time">9:30 AM</span>
        <span class="body"><b>Exercise</b></span>
      </div><div class="row">
        <span class="time">1:00 PM</span>
        <span class="body"><b>stroke practice - ignore this</b></span>
      </div></div>
  <h2>Recent email</h2>
  <div class="card"><div class="row">
        <span class="time">2:37 PM</span>
        <span class="body"><span class="unread">●</span> <
spaghettios@spaghettios:~/bentley-os$ docker rm -f api-isotest-run
api-isotest-run
spaghettios@spaghettios:~/bentley-os$ spaghettios@spaghettios:~/bentley-os$ docker rm -f api-isotest-run
api-isotest-run
spaghettios@spaghettios:~/bentley-os$ 
-bash: spaghettios@spaghettios:~/bentley-os$: No such file or directory
api-isotest-run: command not found
-bash: spaghettios@spaghettios:~/bentley-os$: No such file or directory
spaghettios@spaghettios:~/bentley-os$ curl -s -X POST http://127.0.0.1:4000/deploy -H 'Content-Type: application/json' -d '{"service":"api"}'
{"job_id":"63e689a8-2574-413c-bfa2-f830df92e9e9","status":"running","service":"api"}spaghettios@spaghettios:~/bentley-os$ spaghettios@spaghettios:~/bentley-os$ curl -s -X POST http://127.0.0.1:4000/deploy -H 'Content-Type: spaghettios@spaghettios:~/bentley-os$ curl -s -X POST http://127.0.0.1:4000/deploy -H 'Content-Type: application/json' -d '{"service":"api"}'
{"job_id":"63e689a8-2574-413c-bfa2-f830df92e9e9","status":"running","service":"api"}spaghettios@spaghettios:~/bentley-os$ 
-bash: spaghettios@spaghettios:~/bentley-os$: No such file or directory
-bash: job_id:63e689a8-2574-413c-bfa2-f830df92e9e9spaghettios@spaghettios:~/bentley-os$: No such file or directory
spaghettios@spaghettios:~/bentley-os$ sleep 25 && docker exec bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c "select at, action, outcome from audit_log where payload->>'job_id' = '63e689a8-2574-413c-bfa2-f830df92e9e9' order by at;"
              at               |      action      | outcome 
-------------------------------+------------------+---------
 2026-07-12 19:40:58.723613+00 | deploy.enqueued  | queued
 2026-07-12 19:40:58.739614+00 | deploy.started   | running
 2026-07-12 19:41:20.488798+00 | deploy.succeeded | success
(3 rows)

spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git add supabase/migrations/0004_dashboard_state.sql && git status
On branch main
Your branch is up to date with 'origin/main'.

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
        new file:   supabase/migrations/0004_dashboard_state.sql

Untracked files:
  (use "git add <file>..." to include in what will be committed)
        =
        CACHED
        [internal]
        exporting
        naming
        resolve
        transferring
        unpacking

spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git commit -m "migration: 0004_dashboard_state singleton for 'what changed' last-seen tracking"
[main b905e4b] migration: 0004_dashboard_state singleton for 'what changed' last-seen tracking
 1 file changed, 13 insertions(+)
 create mode 100644 supabase/migrations/0004_dashboard_state.sql
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git push origin main
Enumerating objects: 8, done.
Counting objects: 100% (8/8), done.
Delta compression using up to 16 threads
Compressing objects: 100% (4/4), done.
Writing objects: 100% (5/5), 775 bytes | 775.00 KiB/s, done.
Total 5 (delta 2), reused 0 (delta 0), pack-reused 0 (from 0)
remote: Resolving deltas: 100% (2/2), completed with 2 local objects.
To github.com:bentleylujero/bentley-os.git
   5955d8d..b905e4b  main -> main
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && rm -f -- '=' CACHED '[internal]' exporting naming resolve transferring unpacking && git status
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
spaghettios@spaghettios:~/bentley-os$ docker rmi api-isotest
Untagged: api-isotest:latest
Deleted: sha256:7976482371b6d035e557b7e08fb5797578d6707b2baae5c5a947a0da44ab03d2
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git log --oneline 7d79632..b905e4b
b905e4b (HEAD -> main, origin/main, origin/HEAD) migration: 0004_dashboard_state singleton for 'what changed' last-seen tracking
5955d8d feat(m2): "what changed" dashboard view — deltas since last look
7cb895d chore: gitignore whisper/Dockerfile.bak
403c84b Update THE_BIBLE.md with commit details and notes
ef41370 Update THE_BIBLE.md to remove obsolete information
8ac171c Enhance deploy action completion and Telegram notifications
80298a4 feat(m4): async deploy-completion — poll audit_log to true finish, push ✅/❌ to Telegram
14c063a Revise THE_BIBLE.md for project updates and milestones
spaghettios@spaghettios:~/bentley-os$ cat /home/spaghettios/bentley-os/supabase/migrations/0004_dashboard_state.sql
-- 0004_dashboard_state.sql
-- Singleton state for the dashboard's "what changed" view.
-- Holds one fact: the last time the owner viewed the dashboard.
-- Enforced single-row (id pinned to 1) — not a shadow table, one fact stored once.
create table if not exists dashboard_state (
  id           smallint primary key default 1 check (id = 1),
  last_seen_at timestamptz not null default now()
);

-- Seed the singleton row. on conflict keeps re-running the migration safe.
insert into dashboard_state (id, last_seen_at)
values (1, now())
on conflict (id) do nothing;
spaghettios@spaghettios:~/bentley-os$ sed -n '1,90p' /home/spaghettios/bentley-os/apps/api/src/routes/dashboard.ts
import { Hono } from 'hono';
import { pool } from '../db/pool.js';

export const dashboardRoute = new Hono();

const TZ = 'America/Chicago';

function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

// Compact "Jul 12, 3:04 PM" for cross-day deltas in the What-changed feed.
function fmtStamp(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

dashboardRoute.get('/', async (c) => {
  let events: any[] = [];
  let emails: any[] = [];
  let newEmails: any[] = [];
  let newEvents: any[] = [];
  let lastSeen: Date | null = null;
  let dbError = '';

  // Read the singleton last-seen marker first. Its own guard: if this fails,
  // the What-changed section simply shows nothing new — the rest still renders.
  try {
    const seenR = await pool.query(
      `SELECT last_seen_at FROM dashboard_state WHERE id = 1`
    );
    lastSeen = seenR.rows[0]?.last_seen_at ?? null;
  } catch {
    lastSeen = null;
  }

  try {
    const eventsQ = pool.query(
      `SELECT title, starts_at, ends_at, location, status
         FROM calendar_events
        WHERE starts_at AT TIME ZONE $1 >= (now() AT TIME ZONE $1)::date
          AND starts_at AT TIME ZONE $1 <  ((now() AT TIME ZONE $1)::date + interval '1 day')
        ORDER BY starts_at ASC`,
      [TZ]
    );
    const emailsQ = pool.query(
      `SELECT subject, snippet, received_at, is_unread
         FROM emails
        ORDER BY received_at DESC NULLS LAST
        LIMIT 15`
    );
    // "What changed" = rows ingested (created_at) since the owner last looked.
    // created_at, not received_at: an old email newly synced still counts as new to us.
    const newEmailsQ = lastSeen
      ? pool.query(
          `SELECT subject, snippet, received_at, created_at, is_unread
             FROM emails
            WHERE created_at > $1
            ORDER BY created_at DESC
            LIMIT 20`,
          [lastSeen]
        )
      : Promise.resolve({ rows: [] as any[] });
    const newEventsQ = lastSeen
      ? pool.query(
          `SELECT title, starts_at, location, created_at
             FROM calendar_events
            WHERE created_at > $1
            ORDER BY created_at DESC
            LIMIT 20`,
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git status && git log --oneline -3
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
b905e4b (HEAD -> main, origin/main, origin/HEAD) migration: 0004_dashboard_state singleton for 'what changed' last-seen tracking
5955d8d feat(m2): "what changed" dashboard view — deltas since last look
7cb895d chore: gitignore whisper/Dockerfile.bak
spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c "\d emails"
                               Table "public.emails"
   Column    |           Type           | Collation | Nullable |      Default      
-------------+--------------------------+-----------+----------+-------------------
 id          | uuid                     |           | not null | gen_random_uuid()
 source      | text                     |           | not null | 'gmail'::text
 source_id   | text                     |           | not null | 
 thread_id   | text                     |           |          | 
 sender_id   | uuid                     |           |          | 
 subject     | text                     |           |          | 
 snippet     | text                     |           |          | 
 received_at | timestamp with time zone |           |          | 
 is_unread   | boolean                  |           |          | 
 category    | text                     |           |          | 
 importance  | smallint                 |           |          | 
 created_at  | timestamp with time zone |           | not null | now()
Indexes:
    "emails_pkey" PRIMARY KEY, btree (id)
    "emails_source_source_id_key" UNIQUE CONSTRAINT, btree (source, source_id)
    "idx_emails_received_at" btree (received_at DESC)
    "idx_emails_sender" btree (sender_id)
Foreign-key constraints:
    "emails_sender_id_fkey" FOREIGN KEY (sender_id) REFERENCES people(id)
Referenced by:
    TABLE "email_recipients" CONSTRAINT "email_recipients_email_id_fkey" FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE

spaghettios@spaghettios:~/bentley-os$ grep -rn "importance\|category" apps/api/src/routes/dashboard.ts marionette/src/ 2>/dev/null
spaghettios@spaghettios:~/bentley-os$ cat apps/api/src/ingestion/gmail.ts
import { google } from 'googleapis';
import { readFileSync } from 'node:fs';
import { pool } from '../db/pool.js';

const SECRET_PATH = process.env.GOOGLE_CLIENT_SECRET_PATH || '/secrets/client_secret.json';
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || '/secrets/token.json';

function makeGmailClient() {
  const { installed } = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
  const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  const oauth2 = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris[0],
  );
  oauth2.setCredentials(token);
  return google.gmail({ version: 'v1', auth: oauth2 });
}

export interface GmailSyncResult {
  fetched: number;
  upserted: number;
  nextHistoryId: string | null;
  fullResync: boolean;
}

interface Addr {
  email: string;
  name: string | null;
}

// Parse a raw header value like: "Foo Bar <foo@x.com>, baz@y.com"
function parseAddresses(raw: string | undefined): Addr[] {
  if (!raw) return [];
  const out: Addr[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(.*?)<([^>]+)>$/);
    if (m) {
      const name = m[1].trim().replace(/^"|"$/g, '') || null;
      const email = m[2].trim().toLowerCase();
      if (email) out.push({ email, name });
    } else {
      const email = s.toLowerCase();
      if (email.includes('@')) out.push({ email, name: null });
    }
  }
  return out;
}

function header(headers: any[], name: string): string | undefined {
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? undefined;
}

async function upsertPerson(client: any, addr: Addr): Promise<string> {
  const res = await client.query(
    `INSERT INTO people (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET
       display_name = COALESCE(people.display_name, EXCLUDED.display_name),
       updated_at = now()
     RETURNING id`,
    [addr.email, addr.name],
  );
  return res.rows[0].id;
}

// Returns 1 if a new email row was inserted, 0 if it already existed.
async function upsertMessage(msg: Record<string, any>): Promise<number> {
  const payload = msg.payload ?? {};
  const headers = payload.headers ?? [];

  const fromAddrs = parseAddresses(header(headers, 'From'));
  const toAddrs = parseAddresses(header(headers, 'To'));
  const ccAddrs = parseAddresses(header(headers, 'Cc'));

  const subject = header(headers, 'Subject') ?? null;
  const snippet = msg.snippet ?? null;
  const threadId = msg.threadId ?? null;
  const internalMs = msg.internalDate ? Number(msg.internalDate) : null;
  const receivedAt = internalMs ? new Date(internalMs).toISOString() : null;
  const labels: string[] = msg.labelIds ?? [];
  const isUnread = labels.includes('UNREAD');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const senderId = fromAddrs[0] ? await upsertPerson(client, fromAddrs[0]) : null;

    const emailRes = await client.query(
      `INSERT INTO emails (source, source_id, thread_id, sender_id, subject, snippet, received_at, is_unread)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source, source_id) DO UPDATE SET
         thread_id = EXCLUDED.thread_id,
         sender_id = EXCLUDED.sender_id,
         subject = EXCLUDED.subject,
         snippet = EXCLUDED.snippet,
         received_at = EXCLUDED.received_at,
         is_unread = EXCLUDED.is_unread
       RETURNING id, (xmax = 0) AS inserted`,
      ['gmail', msg.id, threadId, senderId, subject, snippet, receivedAt, isUnread],
    );
    const emailId: string = emailRes.rows[0].id;
    const inserted: boolean = emailRes.rows[0].inserted;

    // Rebuild recipients for this email (idempotent on re-sync).
    await client.query(`DELETE FROM email_recipients WHERE email_id = $1`, [emailId]);

    const seen = new Set<string>();
    for (const [kind, addrs] of [['to', toAddrs], ['cc', ccAddrs]] as const) {
      for (const addr of addrs) {
        const dedupeKey = `${kind}:${addr.email}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const personId = await upsertPerson(client, addr);
        await client.query(
          `INSERT INTO email_recipients (email_id, person_id, kind)
           VALUES ($1, $2, $3)
           ON CONFLICT (email_id, person_id, kind) DO NOTHING`,
          [emailId, personId, kind],
        );
      }
    }

    await client.query('COMMIT');
    return inserted ? 1 : 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function fetchMessage(gmail: any, id: string): Promise<Record<string, any>> {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'metadata',
    metadataHeaders: ['From', 'To', 'Cc', 'Subject'],
  });
  return res.data;
}

// Full backfill: last 30 days of messages.
async function fullSync(gmail: any): Promise<GmailSyncResult> {
  let pageToken: string | undefined;
  let fetched = 0;
  let upserted = 0;
  let maxHistoryId = 0n;

  do {
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: 'newer_than:30d',
      maxResults: 100,
      pageToken,
    });
    const ids = (list.data.messages ?? []).map((m: any) => m.id);
    for (const id of ids) {
      const msg = await fetchMessage(gmail, id);
      fetched += 1;
      upserted += await upsertMessage(msg);
      if (msg.historyId) {
        const h = BigInt(msg.historyId);
        if (h > maxHistoryId) maxHistoryId = h;
      }
    }
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);

  return {
    fetched,
    upserted,
    nextHistoryId: maxHistoryId > 0n ? maxHistoryId.toString() : null,
    fullResync: true,
  };
}

// Incremental: history since startHistoryId. Throws {code:404} if too old.
async function incrementalSync(gmail: any, startHistoryId: string): Promise<GmailSyncResult> {
  let pageToken: string | undefined;
  let fetched = 0;
  let upserted = 0;
  let maxHistoryId = BigInt(startHistoryId);
  const changedIds = new Set<string>();

  do {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      maxResults: 500,
      pageToken,
    });
    for (const h of res.data.history ?? []) {
      if (h.id) {
        const hid = BigInt(h.id);
        if (hid > maxHistoryId) maxHistoryId = hid;
      }
      for (const added of h.messagesAdded ?? []) {
        if (added.message?.id) changedIds.add(added.message.id);
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  for (const id of changedIds) {
    try {
      const msg = await fetchMessage(gmail, id);
      fetched += 1;
      upserted += await upsertMessage(msg);
    } catch (e: any) {
      if (e?.code === 404) continue; // message deleted between history read and fetch
      throw e;
    }
  }

  return {
    fetched,
    upserted,
    nextHistoryId: maxHistoryId.toString(),
    fullResync: false,
  };
}

export async function runGmailSync(): Promise<GmailSyncResult> {
  const gmail = makeGmailClient();

  const stateRes = await pool.query(
    `SELECT sync_token FROM sync_state WHERE source = $1`,
    ['gmail'],
  );
  const startHistoryId: string | undefined = stateRes.rows[0]?.sync_token ?? undefined;

  let result: GmailSyncResult;
  if (startHistoryId) {
    try {
      result = await incrementalSync(gmail, startHistoryId);
    } catch (e: any) {
      if (e?.code === 404) {
        result = await fullSync(gmail); // cursor expired — self-heal
      } else {
        throw e;
      }
    }
  } else {
    result = await fullSync(gmail);
  }

  if (result.nextHistoryId) {
    await pool.query(
spaghettios@spaghettios:~/bentley-os$ cat > apps/api/src/ingestion/gmail.ts << 'EOF'
import { google } from 'googleapis';
import { readFileSync } from 'node:fs';
import { pool } from '../db/pool.js';

const SECRET_PATH = process.env.GOOGLE_CLIENT_SECRET_PATH || '/secrets/client_secret.json';
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || '/secrets/token.json';

function makeGmailClient() {
  const { installed } = JSON.parse(readFileSync(SECRET_PATH, 'utf8'));
  const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  const oauth2 = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris[0],
  );
  oauth2.setCredentials(token);
  return google.gmail({ version: 'v1', auth: oauth2 });
}

export interface GmailSyncResult {
  fetched: number;
  upserted: number;
  nextHistoryId: string | null;
  fullResync: boolean;
}

interface Addr {
  email: string;
  name: string | null;
}

// Parse a raw header value like: "Foo Bar <foo@x.com>, baz@y.com"
function parseAddresses(raw: string | undefined): Addr[] {
  if (!raw) return [];
  const out: Addr[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(.*?)<([^>]+)>$/);
    if (m) {
      const name = m[1].trim().replace(/^"|"$/g, '') || null;
      const email = m[2].trim().toLowerCase();
      if (email) out.push({ email, name });
    } else {
      const email = s.toLowerCase();
      if (email.includes('@')) out.push({ email, name: null });
    }
  }
  return out;
}

function header(headers: any[], name: string): string | undefined {
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? undefined;
}

// --- Body extraction ---------------------------------------------------------
// Gmail bodies are a nested MIME tree; parts are base64url-encoded.
// Prefer text/plain; fall back to stripped text/html. Never throws — a body
// extraction failure must not break ingestion (which is /health-adjacent).

function decodeB64Url(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBody(payload: any): string | null {
  if (!payload) return null;

  let plain: string | null = null;
  let html: string | null = null;

  function walk(part: any) {
    if (!part) return;
    const mime = part.mimeType ?? '';
    const data = part.body?.data;
    if (data) {
      if (mime === 'text/plain' && plain === null) plain = decodeB64Url(data);
      else if (mime === 'text/html' && html === null) html = decodeB64Url(data);
    }
    for (const child of part.parts ?? []) walk(child);
  }
  walk(payload);

  if (plain && plain.trim()) return plain.trim();
  if (html && html.trim()) return stripHtml(html);
  return null;
}

async function upsertPerson(client: any, addr: Addr): Promise<string> {
  const res = await client.query(
    `INSERT INTO people (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET
       display_name = COALESCE(people.display_name, EXCLUDED.display_name),
       updated_at = now()
     RETURNING id`,
    [addr.email, addr.name],
  );
  return res.rows[0].id;
}

// Returns 1 if a new email row was inserted, 0 if it already existed.
async function upsertMessage(msg: Record<string, any>): Promise<number> {
  const payload = msg.payload ?? {};
  const headers = payload.headers ?? [];

  const fromAddrs = parseAddresses(header(headers, 'From'));
  const toAddrs = parseAddresses(header(headers, 'To'));
  const ccAddrs = parseAddresses(header(headers, 'Cc'));

  const subject = header(headers, 'Subject') ?? null;
  const snippet = msg.snippet ?? null;
  const body = extractBody(payload);
  const threadId = msg.threadId ?? null;
  const internalMs = msg.internalDate ? Number(msg.internalDate) : null;
  const receivedAt = internalMs ? new Date(internalMs).toISOString() : null;
  const labels: string[] = msg.labelIds ?? [];
  const isUnread = labels.includes('UNREAD');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const senderId = fromAddrs[0] ? await upsertPerson(client, fromAddrs[0]) : null;

    const emailRes = await client.query(
      `INSERT INTO emails (source, source_id, thread_id, sender_id, subject, snippet, body, received_at, is_unread)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source, source_id) DO UPDATE SET
         thread_id = EXCLUDED.thread_id,
         sender_id = EXCLUDED.sender_id,
         subject = EXCLUDED.subject,
         snippet = EXCLUDED.snippet,
         body = EXCLUDED.body,
         received_at = EXCLUDED.received_at,
         is_unread = EXCLUDED.is_unread
       RETURNING id, (xmax = 0) AS inserted`,
      ['gmail', msg.id, threadId, senderId, subject, snippet, body, receivedAt, isUnread],
    );
    const emailId: string = emailRes.rows[0].id;
    const inserted: boolean = emailRes.rows[0].inserted;

    // Rebuild recipients for this email (idempotent on re-sync).
    await client.query(`DELETE FROM email_recipients WHERE email_id = $1`, [emailId]);

    const seen = new Set<string>();
    for (const [kind, addrs] of [['to', toAddrs], ['cc', ccAddrs]] as const) {
      for (const addr of addrs) {
        const dedupeKey = `${kind}:${addr.email}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const personId = await upsertPerson(client, addr);
        await client.query(
          `INSERT INTO email_recipients (email_id, person_id, kind)
           VALUES ($1, $2, $3)
           ON CONFLICT (email_id, person_id, kind) DO NOTHING`,
          [emailId, personId, kind],
        );
      }
    }

    await client.query('COMMIT');
    return inserted ? 1 : 0;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function fetchMessage(gmail: any, id: string): Promise<Record<string, any>> {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full',
  });
  return res.data;
}

// Full backfill: last 30 days of messages.
async function fullSync(gmail: any): Promise<GmailSyncResult> {
  let pageToken: string | undefined;
  let fetched = 0;
  let upserted = 0;
  let maxHistoryId = 0n;

  do {
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: 'newer_than:30d',
      maxResults: 100,
      pageToken,
    });
    const ids = (list.data.messages ?? []).map((m: any) => m.id);
    for (const id of ids) {
      const msg = await fetchMessage(gmail, id);
      fetched += 1;
      upserted += await upsertMessage(msg);
      if (msg.historyId) {
        const h = BigInt(msg.historyId);
        if (h > maxHistoryId) maxHistoryId = h;
      }
    }
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);

  return {
    fetched,
    upserted,
    nextHistoryId: maxHistoryId > 0n ? maxHistoryId.toString() : null,
    fullResync: true,
  };
}

// Incremental: history since startHistoryId. Throws {code:404} if too old.
async function incrementalSync(gmail: any, startHistoryId: string): Promise<GmailSyncResult> {
  let pageToken: string | undefined;
  let fetched = 0;
  let upserted = 0;
  let maxHistoryId = BigInt(startHistoryId);
  const changedIds = new Set<string>();

  do {
    const res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      maxResults: 500,
      pageToken,
    });
    for (const h of res.data.history ?? []) {
      if (h.id) {
        const hid = BigInt(h.id);
        if (hid > maxHistoryId) maxHistoryId = hid;
      }
      for (const added of h.messagesAdded ?? []) {
        if (added.message?.id) changedIds.add(added.message.id);
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  for (const id of changedIds) {
    try {
      const msg = await fetchMessage(gmail, id);
      fetched += 1;
      upserted += await upsertMessage(msg);
    } catch (e: any) {
      if (e?.code === 404) continue; // message deleted between history read and fetch
      throw e;
    }
  }

  return {
    fetched,
    upserted,
    nextHistoryId: maxHistoryId.toString(),
    fullResync: false,
  };
}

export async function runGmailSync(): Promise<GmailSyncResult> {
  const gmail = makeGmailClient();

  const stateRes = await pool.query(
    `SELECT sync_token FROM sync_state WHERE source = $1`,
    ['gmail'],
  );
  const startHistoryId: string | undefined = stateRes.rows[0]?.sync_token ?? undefined;

  let result: GmailSyncResult;
  if (startHistoryId) {
    try {
      result = await incrementalSync(gmail, startHistoryId);
    } catch (e: any) {
      if (e?.code === 404) {
        result = await fullSync(gmail); // cursor expired — self-heal
      } else {
        throw e;
      }
    }
  } else {
    result = await fullSync(gmail);
  }

  if (result.nextHistoryId) {
    await pool.query(
      `INSERT INTO sync_state (source, sync_token, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (source) DO UPDATE SET
         sync_token = EXCLUDED.sync_token,
         updated_at = now()`,
      ['gmail', result.nextHistoryId],
    );
  }

  return result;
}
EOF
spaghettios@spaghettios:~/bentley-os$ grep -n "format: 'full'\|extractBody\|body," apps/api/src/ingestion/gmail.ts && wc -l apps/api/src/ingestion/gmail.ts
86:function extractBody(payload: any): string | null {
133:  const body = extractBody(payload);
147:      `INSERT INTO emails (source, source_id, thread_id, sender_id, subject, snippet, body, received_at, is_unread)
154:         body = EXCLUDED.body,
158:      ['gmail', msg.id, threadId, senderId, subject, snippet, body, receivedAt, isUnread],
196:    format: 'full',
319 apps/api/src/ingestion/gmail.ts
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git status
On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
        modified:   apps/api/src/ingestion/gmail.ts

Untracked files:
  (use "git add <file>..." to include in what will be committed)
        supabase/migrations/0005_email_intelligence.sql

no changes added to commit (use "git add" and/or "git commit -a")
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && docker build -t bentley-api-test apps/api
[+] Building 8.1s (10/10) FINISHED                                                                                                                                        docker:default
 => [internal] load build definition from Dockerfile                                                                                                                                0.0s
 => => transferring dockerfile: 300B                                                                                                                                                0.0s
 => [internal] load metadata for docker.io/library/node:22-alpine                                                                                                                   0.0s
 => [internal] load .dockerignore                                                                                                                                                   0.0s
 => => transferring context: 69B                                                                                                                                                    0.0s
 => [1/6] FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => => resolve docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => [internal] load build context                                                                                                                                                   0.0s
 => => transferring context: 10.63kB                                                                                                                                                0.0s
 => CACHED [2/6] WORKDIR /usr/src/app                                                                                                                                               0.0s
 => CACHED [3/6] COPY package.json ./                                                                                                                                               0.0s
 => CACHED [4/6] RUN npm install                                                                                                                                                    0.0s
 => [5/6] COPY . .                                                                                                                                                                  0.0s
 => ERROR [6/6] RUN npm run build                                                                                                                                                   7.9s
------                                                                                                                                                                                   
 > [6/6] RUN npm run build:                                                                                                                                                              
0.382                                                                                                                                                                                    
0.382 > @bentley-os/api@0.1.0 build                                                                                                                                                      
0.382 > tsc -p tsconfig.json                                                                                                                                                             
0.382 
7.737 src/ingestion/gmail.ts(104,22): error TS2339: Property 'trim' does not exist on type 'never'.
7.737 src/ingestion/gmail.ts(104,43): error TS2339: Property 'trim' does not exist on type 'never'.
7.737 src/ingestion/gmail.ts(105,20): error TS2339: Property 'trim' does not exist on type 'never'.
------
Dockerfile:9
--------------------
   7 |     COPY . .
   8 |     
   9 | >>> RUN npm run build
  10 |     
  11 |     EXPOSE 3000
--------------------
ERROR: failed to build: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 2
spaghettios@spaghettios:~/bentley-os$ sed -n '80,130p' apps/api/src/ingestion/gmail.ts
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBody(payload: any): string | null {
  if (!payload) return null;

  let plain: string | null = null;
  let html: string | null = null;

  function walk(part: any) {
    if (!part) return;
    const mime = part.mimeType ?? '';
    const data = part.body?.data;
    if (data) {
      if (mime === 'text/plain' && plain === null) plain = decodeB64Url(data);
      else if (mime === 'text/html' && html === null) html = decodeB64Url(data);
    }
    for (const child of part.parts ?? []) walk(child);
  }
  walk(payload);

  if (plain && plain.trim()) return plain.trim();
  if (html && html.trim()) return stripHtml(html);
  return null;
}

async function upsertPerson(client: any, addr: Addr): Promise<string> {
  const res = await client.query(
    `INSERT INTO people (email, display_name)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET
       display_name = COALESCE(people.display_name, EXCLUDED.display_name),
       updated_at = now()
     RETURNING id`,
    [addr.email, addr.name],
  );
  return res.rows[0].id;
}

// Returns 1 if a new email row was inserted, 0 if it already existed.
async function upsertMessage(msg: Record<string, any>): Promise<number> {
  const payload = msg.payload ?? {};
  const headers = payload.headers ?? [];

  const fromAddrs = parseAddresses(header(headers, 'From'));
  const toAddrs = parseAddresses(header(headers, 'To'));
  const ccAddrs = parseAddresses(header(headers, 'Cc'));

spaghettios@spaghettios:~/bentley-os$ sed -i "s/  let plain: string | null = null;/  let plain: string | null = null as string | null;/" apps/api/src/ingestion/gmail.ts
spaghettios@spaghettios:~/bentley-os$ sed -i "s/  let html: string | null = null;/  let html: string | null = null as string | null;/" apps/api/src/ingestion/gmail.ts
spaghettios@spaghettios:~/bentley-os$ sed -n '87,88p' apps/api/src/ingestion/gmail.ts
  if (!payload) return null;

spaghettios@spaghettios:~/bentley-os$ grep -n "let plain\|let html" apps/api/src/ingestion/gmail.ts
89:  let plain: string | null = null as string | null;
90:  let html: string | null = null as string | null;
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && docker build -t bentley-api-test apps/api
[+] Building 8.0s (11/11) FINISHED                                                                                                                                        docker:default
 => [internal] load build definition from Dockerfile                                                                                                                                0.0s
 => => transferring dockerfile: 300B                                                                                                                                                0.0s
 => [internal] load metadata for docker.io/library/node:22-alpine                                                                                                                   0.0s
 => [internal] load .dockerignore                                                                                                                                                   0.0s
 => => transferring context: 69B                                                                                                                                                    0.0s
 => [1/6] FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => => resolve docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2                                                             0.0s
 => [internal] load build context                                                                                                                                                   0.0s
 => => transferring context: 10.66kB                                                                                                                                                0.0s
 => CACHED [2/6] WORKDIR /usr/src/app                                                                                                                                               0.0s
 => CACHED [3/6] COPY package.json ./                                                                                                                                               0.0s
 => CACHED [4/6] RUN npm install                                                                                                                                                    0.0s
 => [5/6] COPY . .                                                                                                                                                                  0.0s
 => [6/6] RUN npm run build                                                                                                                                                         7.3s
 => exporting to image                                                                                                                                                              0.4s 
 => => exporting layers                                                                                                                                                             0.2s 
 => => exporting manifest sha256:0848fd49aeb365c0ef8b8c572ebffc6fea59789c0502a9af286bec896fc207eb                                                                                   0.0s
 => => exporting config sha256:2500f3b0b5b15763d9141a59e186b398fcfb9a305a3cea7851647bd6262575e7                                                                                     0.0s
 => => exporting attestation manifest sha256:d0a4baad141954d4dd66d475fe7cf03b66dc7e046c2042da9ede75e466181719                                                                       0.0s
 => => exporting manifest list sha256:f254d67f21537214de5593560893d0b2e326e6cc9ff630eb0f1db3108e2219d5                                                                              0.0s
 => => naming to docker.io/library/bentley-api-test:latest                                                                                                                          0.0s
 => => unpacking to docker.io/library/bentley-api-test:latest                                                                                                                       0.1s
spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c "SELECT source, left(sync_token, 20) AS token_prefix, updated_at FROM sync_state WHERE source='gmail';"
 source | token_prefix |          updated_at           
--------+--------------+-------------------------------
 gmail  | 3925311      | 2026-07-12 20:20:00.701394+00
(1 row)

spaghettios@spaghettios:~/bentley-os$ grep -n "sync_token\|newer_than\|historyId\|history.list\|messages.list\|q:" apps/api/src/ingestion/gmail.ts
209:    const list = await gmail.users.messages.list({
211:      q: 'newer_than:30d',
220:      if (msg.historyId) {
221:        const h = BigInt(msg.historyId);
245:    const res = await gmail.users.history.list({
287:    `SELECT sync_token FROM sync_state WHERE source = $1`,
290:  const startHistoryId: string | undefined = stateRes.rows[0]?.sync_token ?? undefined;
309:      `INSERT INTO sync_state (source, sync_token, updated_at)
312:         sync_token = EXCLUDED.sync_token,
spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c "UPDATE sync_state SET sync_token = NULL WHERE source='gmail'; SELECT source, sync_token FROM sync_state WHERE source='gmail';"
UPDATE 1
 source | sync_token 
--------+------------
 gmail  | 
(1 row)

spaghettios@spaghettios:~/bentley-os$ grep -n "runGmailSync\|export" apps/api/src/ingestion/gmail.ts | head -20
20:export interface GmailSyncResult {
283:export async function runGmailSync(): Promise<GmailSyncResult> {
spaghettios@spaghettios:~/bentley-os$ docker run --rm bentley-api-test sh -c "ls dist && echo '---' && ls dist/ingestion"
db
index.js
ingestion
routes
---
gcal.js
gmail.js
scheduler.js
test-gcal-sync.js
test-gmail-sync.js
spaghettios@spaghettios:~/bentley-os$ spaghettios@spaghettios:~/bentley-os$ docker run --rm bentley-api-test sh -c "ls dist && echo '---' && ls dist/ingestion"
db
index.js
ingestion
routes
---
gcal.js
gmail.js
scheduler.js
test-gcal-sync.js
test-gmail-sync.js
spaghettios@spaghettios:~/bentley-os$ 
-bash: spaghettios@spaghettios:~/bentley-os$: No such file or directory
db: command not found
index.js: command not found
ingestion: command not found
Command 'routes' not found, did you mean:
  command 'route' from deb net-tools (2.10-2ubuntu1)
  command 'routel' from deb iproute2 (6.19.0-1ubuntu1.1)
Try: sudo apt install <deb name>
---: command not found
gcal.js: command not found
gmail.js: command not found
scheduler.js: command not found
test-gcal-sync.js: command not found
test-gmail-sync.js: command not found
-bash: spaghettios@spaghettios:~/bentley-os$: No such file or directory
spaghettios@spaghettios:~/bentley-os$ docker inspect bentley-os-api-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Mode}}){{println}}{{end}}'
/home/spaghettios/bentley-os/token.json -> /secrets/token.json (ro)
/home/spaghettios/bentley-os/client_secret.json -> /secrets/client_secret.json (ro)

spaghettios@spaghettios:~/bentley-os$ docker run --rm \
  --network bentley-os_backend \
  --env-file /home/spaghettios/bentley-os/.env \
  -v /home/spaghettios/bentley-os/token.json:/secrets/token.json:ro \
  -v /home/spaghettios/bentley-os/client_secret.json:/secrets/client_secret.json:ro \
  bentley-api-test \
  node -e "import('./dist/ingestion/gmail.js').then(m=>m.runGmailSync()).then(r=>{console.log('SYNC RESULT:',JSON.stringify(r));process.exit(0)}).catch(e=>{console.error('SYNC ERROR:',e);process.exit(1)})"
SYNC RESULT: {"fetched":718,"upserted":0,"nextHistoryId":"3925311","fullResync":true}
spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c "SELECT count(*) FILTER (WHERE body IS NOT NULL) AS with_body, count(*) AS total, max(length(body)) AS max_len, round(avg(length(body))) AS avg_len FROM emails;"
 with_body | total | max_len | avg_len 
-----------+-------+---------+---------
       718 |   765 |   27372 |    5082
(1 row)

spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c "SELECT subject, left(body, 300) AS body_preview FROM emails WHERE body IS NOT NULL ORDER BY received_at DESC LIMIT 1;"
                            subject                            |                                                                             body_preview                                                                              
---------------------------------------------------------------+-----------------------------------------------------------------------------------------------------------------------------------------------------------------------
 $18.6M Health Brand + 4.6-star Baking App + 300th The Exit Ep | Inside: 48% repeat customer rate health ecommerce brand, $4.3M annual revenue lego Shopify brand, and a 16-year-old logistics SaaS.\r                                +
                                                               | \r                                                                                                                                                                   +
                                                               | Need legal, finance or due diligence services for your next deal? Explore Flippa’s M&A network > (https://l.flippa.com/e3t/Ctc/RJ+113/d2q1V504/VXgH-w31KnqjW2BC0Tq9bK
(1 row)

spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git add supabase/migrations/0005_email_intelligence.sql apps/api/src/ingestion/gmail.ts && git status
On branch main
Your branch is up to date with 'origin/main'.

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
        modified:   apps/api/src/ingestion/gmail.ts
        new file:   supabase/migrations/0005_email_intelligence.sql

spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git commit -m "feat(m3): full-body gmail ingestion + email intelligence schema

- 0005_email_intelligence.sql: add body/reason/confidence/classified_at to emails + partial idx_emails_unclassified for the classifier queue
- gmail.ts: fetch format 'full' (metadata mode has no body), extractBody walks MIME tree (prefer text/plain, fallback stripped html), backfills bodies via EXCLUDED.body on re-sync" && git push origin main
[main 1dcf68a] feat(m3): full-body gmail ingestion + email intelligence schema
 2 files changed, 75 insertions(+), 5 deletions(-)
 create mode 100644 supabase/migrations/0005_email_intelligence.sql
To github.com:bentleylujero/bentley-os.git
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'github.com:bentleylujero/bentley-os.git'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally. This is usually caused by another repository pushing to
hint: the same ref. If you want to integrate the remote changes, use
hint: 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git fetch origin && git log --oneline origin/main -5 && echo '--- LOCAL ---' && git log --oneline main -5
remote: Enumerating objects: 5, done.
remote: Counting objects: 100% (5/5), done.
remote: Compressing objects: 100% (3/3), done.
remote: Total 3 (delta 2), reused 0 (delta 0), pack-reused 0 (from 0)
Unpacking objects: 100% (3/3), 5.79 KiB | 741.00 KiB/s, done.
From github.com:bentleylujero/bentley-os
   b905e4b..79bea75  main       -> origin/main
79bea75 (origin/main, origin/HEAD) Add 'What changed' section to dashboard and improve notifications
b905e4b migration: 0004_dashboard_state singleton for 'what changed' last-seen tracking
5955d8d feat(m2): "what changed" dashboard view — deltas since last look
7cb895d chore: gitignore whisper/Dockerfile.bak
403c84b Update THE_BIBLE.md with commit details and notes
--- LOCAL ---
1dcf68a (HEAD -> main) feat(m3): full-body gmail ingestion + email intelligence schema
b905e4b migration: 0004_dashboard_state singleton for 'what changed' last-seen tracking
5955d8d feat(m2): "what changed" dashboard view — deltas since last look
7cb895d chore: gitignore whisper/Dockerfile.bak
403c84b Update THE_BIBLE.md with commit details and notes
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git pull --rebase origin main
From github.com:bentleylujero/bentley-os
 * branch            main       -> FETCH_HEAD
Successfully rebased and updated refs/heads/main.
spaghettios@spaghettios:~/bentley-os$ cd /home/spaghettios/bentley-os && git push origin main && git log --oneline -3
Enumerating objects: 18, done.
Counting objects: 100% (18/18), done.
Delta compression using up to 16 threads
Compressing objects: 100% (8/8), done.
Writing objects: 100% (10/10), 2.21 KiB | 2.21 MiB/s, done.
Total 10 (delta 5), reused 0 (delta 0), pack-reused 0 (from 0)
remote: Resolving deltas: 100% (5/5), completed with 5 local objects.
To github.com:bentleylujero/bentley-os.git
   79bea75..4c39435  main -> main
4c39435 (HEAD -> main, origin/main, origin/HEAD) feat(m3): full-body gmail ingestion + email intelligence schema
79bea75 Add 'What changed' section to dashboard and improve notifications
b905e4b migration: 0004_dashboard_state singleton for 'what changed' last-seen tracking
spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && git fetch origin && git status && git rev-parse HEAD
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
4c394350e0466581c3ec8dadba5f0829f5d4b2d1
spaghettios@spaghettios:~/bentley-os$ curl -s -X POST http://127.0.0.1:4000/deploy \
  -H 'Content-Type: application/json' \
  -d '{"service":"api"}'
{"job_id":"1bbc12fd-9cb2-4ee1-8990-10723fa08b93","status":"running","service":"api"}spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c \      docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c \
"select at, action, outcome, payload->>'job_id' as job_id from audit_log where payload->>'job_id' = '1bbc12fd-9cb2-4ee1-8990-10723fa08b93' order by at;"
              at               |     action      | outcome |                job_id                
-------------------------------+-----------------+---------+--------------------------------------
 2026-07-12 20:34:21.616813+00 | deploy.enqueued | queued  | 1bbc12fd-9cb2-4ee1-8990-10723fa08b93
 2026-07-12 20:34:21.625104+00 | deploy.started  | running | 1bbc12fd-9cb2-4ee1-8990-10723fa08b93
(2 rows)

spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c \
"select at, action, outcome, payload->>'job_id' as job_id from audit_log where payload->>'job_id' = '1bbc12fd-9cb2-4ee1-8990-10723fa08b93' order by at;"
              at               |      action      | outcome |                job_id                
-------------------------------+------------------+---------+--------------------------------------
 2026-07-12 20:34:21.616813+00 | deploy.enqueued  | queued  | 1bbc12fd-9cb2-4ee1-8990-10723fa08b93
 2026-07-12 20:34:21.625104+00 | deploy.started   | running | 1bbc12fd-9cb2-4ee1-8990-10723fa08b93
 2026-07-12 20:34:43.343137+00 | deploy.succeeded | success | 1bbc12fd-9cb2-4ee1-8990-10723fa08b93
(3 rows)

spaghettios@spaghettios:~/bentley-os$ curl -s http://127.0.0.1:3000/health && echo && \
docker compose ps api && \
docker inspect -f '{{.Created}}' $(docker compose ps -q api)
{"status":"ok","db":"connected","service":"bentley-os-api"}
NAME               IMAGE            COMMAND                  SERVICE   CREATED          STATUS                    PORTS
bentley-os-api-1   bentley-os-api   "docker-entrypoint.s…"   api       24 seconds ago   Up 22 seconds (healthy)   127.0.0.1:3000->3000/tcp
2026-07-12T20:34:36.599887331Z
spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c "\d emails"
                                Table "public.emails"
    Column     |           Type           | Collation | Nullable |      Default      
---------------+--------------------------+-----------+----------+-------------------
 id            | uuid                     |           | not null | gen_random_uuid()
 source        | text                     |           | not null | 'gmail'::text
 source_id     | text                     |           | not null | 
 thread_id     | text                     |           |          | 
 sender_id     | uuid                     |           |          | 
 subject       | text                     |           |          | 
 snippet       | text                     |           |          | 
 received_at   | timestamp with time zone |           |          | 
 is_unread     | boolean                  |           |          | 
 category      | text                     |           |          | 
 importance    | smallint                 |           |          | 
 created_at    | timestamp with time zone |           | not null | now()
 body          | text                     |           |          | 
 reason        | text                     |           |          | 
 confidence    | smallint                 |           |          | 
 classified_at | timestamp with time zone |           |          | 
Indexes:
    "emails_pkey" PRIMARY KEY, btree (id)
    "emails_source_source_id_key" UNIQUE CONSTRAINT, btree (source, source_id)
    "idx_emails_received_at" btree (received_at DESC)
    "idx_emails_sender" btree (sender_id)
    "idx_emails_unclassified" btree (received_at DESC) WHERE classified_at IS NULL
Foreign-key constraints:
    "emails_sender_id_fkey" FOREIGN KEY (sender_id) REFERENCES people(id)
Referenced by:
    TABLE "email_recipients" CONSTRAINT "email_recipients_email_id_fkey" FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE

spaghettios@spaghettios:~/bentley-os$ cat ~/bentley-os/marionette/src/deepseek.ts
// deepseek.ts — thin client for the DeepSeek chat-completions API.
// Proven working against api.deepseek.com/chat/completions (JSON mode, deepseek-v4-pro).
// Model is configurable via MARIONETTE_MODEL so we can test cheaply against
// deepseek-v4-flash and reserve deepseek-v4-pro for real decisions.

const API_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const TIMEOUT_MS = 60_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekResult {
  content: string;
  model: string;
  usage: unknown;
  finishReason: string | undefined;
}

// Calls DeepSeek in JSON mode. Returns the raw string content (expected to be a
// JSON object) plus metadata. Throws on network failure, non-2xx, or missing content.
export async function callDeepSeek(messages: ChatMessage[]): Promise<DeepSeekResult> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not set in environment');

  const model = process.env.MARIONETTE_MODEL || DEFAULT_MODEL;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('DeepSeek returned no message content');
  }

  return {
    content,
    model,
    usage: data?.usage,
    finishReason: data?.choices?.[0]?.finish_reason,
  };
}
spaghettios@spaghettios:~/bentley-os$ cat ~/bentley-os/marionette/src/index.ts
echo "===== AUDIT ====="
cat ~/bentley-os/marionette/src/audit.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Agent, setGlobalDispatcher } from 'undici';
import { callDeepSeek } from './deepseek.ts';
import { normalizeDecision } from './schema.ts';
import { audit } from './audit.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { createAction, listActions, getAction, approveAction, denyAction } from './actions.ts';
import { auditSummary } from './audit-read.ts';
import { isSystemStatusQuestion, formatAuditForPrompt } from './system-sight.ts';

// contractor's /execute can run long (real OpenCode build tasks, multi-step
// tool use) — raise past undici's default 5-minute headers/body timeout so
// a legitimately slow build isn't mistaken for a dead connection.
setGlobalDispatcher(new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
}));

const app = new Hono();
app.get('/health', (c) => c.json({ status: 'ok' }));

// Mari's sight over her own ledger — read-only view of audit_log.
app.get('/audit/summary', async (c) => {
  const w = Number(c.req.query('window')) || 60;
  try {
    const summary = await auditSummary(w);
    return c.json(summary);
  } catch (err) {
    console.error('[audit/summary] failed:', err);
    return c.json({ error: 'audit read failed' }, 500);
  }
});
// POST /think  { "request": "<what you want marionette to reason about>" }
// Calls DeepSeek, returns a structured Decision, audits the call either way.
// If the decision is "delegate", hands the spec to contractor and folds the
// result back into the response before returning.
app.post('/think', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be valid JSON' }, 400);
  }
  const request = body?.request;
  if (typeof request !== 'string' || request.trim() === '') {
    return c.json({ error: 'missing "request" string in body' }, 400);
  }
  let decision;
  try {
    // Mari's sight: if this reads as a system-activity question, fetch her own
    // audit ledger and inject a compact summary as a second system turn. The
    // prompt (prompt.ts) tells her to narrate from a SYSTEM ACTIVITY block when
    // present. Keyword-gated so coding/other requests are not polluted with it.
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
    ];
    if (isSystemStatusQuestion(request)) {
      try {
        const summary = await auditSummary(60);
        messages.push({ role: 'system' as const, content: formatAuditForPrompt(summary) });
      } catch (sightErr) {
        console.error('[think] audit-sight fetch failed:', sightErr);
      }
    }
    messages.push({ role: 'user' as const, content: request });
    const result = await callDeepSeek(messages);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      parsed = { decision: 'reply', message: result.content, reasoning: '' };
    }
    decision = normalizeDecision(parsed);
    await audit({
      action: 'marionette.think',
      outcome: 'success',
      payload: {
        request,
        decision,
        model: result.model,
        usage: result.usage,
        finish_reason: result.finishReason,
      },
    });
  } catch (err: any) {
    const message = err?.message || String(err);
    // Failures are first-class audit events — an orchestrator whose failures are
    // invisible is worse than useless.
    await audit({
      action: 'marionette.think',
      outcome: 'error',
      payload: { request, error: message },
    });
    return c.json({ error: 'think failed', detail: message }, 502);
  }
  if (decision.decision !== 'delegate') {
    return c.json({ decision });
  }
  // Delegate branch: hand the spec to contractor, fold its result back in.
  // A failed delegation is still a successful /think — we return what we
  // know rather than 502ing a request that reasoned correctly.
  try {
    const res = await fetch('http://contractor:4100/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec: decision.spec }),
    });
    const contractorResult = await res.json();
    await audit({
      action: 'marionette.delegate',
      outcome: res.ok ? 'success' : 'error',
      target: decision.target_service,
      payload: { spec: decision.spec, status: res.status, result: contractorResult },
    });
    return c.json({ decision, delegation: { status: res.status, result: contractorResult } });
  } catch (err: any) {
    const message = err?.message || String(err);
    const cause = err?.cause?.message || err?.cause || null;
    await audit({
      action: 'marionette.delegate',
      outcome: 'error',
      target: decision.target_service,
      payload: { spec: decision.spec, error: message, cause },
    });
    return c.json({ decision, delegation: { error: message, cause } });
  }
});

// ── Action lifecycle (Milestone 4, gate slice) ──────────────────────────────
// marionette owns the actions table's state transitions. api/Telegram relay to
// these endpoints; they do no reasoning of their own. Every transition audits
// with target = the action id.
spaghettios@spaghettios:~/bentley-os$ cat > ~/bentley-os/marionette/src/classify.ts << 'EOF'
// classify.ts — the Clair triage engine. Reads unclassified emails, judges
// CONSEQUENCE (what happens if this is ignored?), writes importance/category/
// reason/confidence + classified_at. Two-pass: Pass 1 judges from subject+
// snippet; Pass 2 re-judges against the full body when Pass 1 is low-confidence
// or flags high stakes. Uncertainty triggers MORE scrutiny, never silent demotion.
//
// Reasoning lives HERE (marionette), never in api's dashboard route. The
// dashboard only reads the columns this writes.

import postgres from 'postgres';
import { callDeepSeek, type ChatMessage } from './deepseek.ts';
import { audit } from './audit.ts';

const sql = postgres(process.env.DATABASE_URL || '', {
  max: 2,
  idle_timeout: 20,
});

// Pass 2 triggers: Pass 1 confidence below this, OR importance at/above the
// high-stakes cutoff (a "you're being evicted" first-glance judgement deserves
// a full-body second look before we commit it).
const LOW_CONFIDENCE = 60;
const HIGH_STAKES = 70;

const CATEGORIES = ['action', 'financial', 'personal', 'work', 'newsletter', 'receipt', 'other'] as const;
type Category = typeof CATEGORIES[number];

interface Classification {
  importance: number;   // 0..100, sort key — pure consequence
  category: Category;
  reason: string;       // the one-line "why this matters" — the whole game
  confidence: number;   // 0..100, self-assessed certainty; low => Pass 2
}

interface EmailRow {
  id: string;
  subject: string | null;
  snippet: string | null;
  body: string | null;
}

const SYSTEM = `You are Clair, a priority-triage engine for one person's inbox.
Your ONLY job: judge CONSEQUENCE. Ask "what happens to this person if they never see this email?"
That question — not the sender, not the topic, not human-vs-automated — sets importance.

An automated "your account is overdrawn" or "your lease is being terminated" outranks a
friend's "hey what's up". A newsletter, however interesting, is low consequence.

Rules:
- importance is 0..100, a pure consequence score. 80-100: real harm/cost/deadline if missed.
  40-79: matters but not urgent. 0-39: safe to ignore (newsletters, receipts, noise).
- category is EXACTLY one of: action, financial, personal, work, newsletter, receipt, other.
- reason is ONE plain-language sentence naming the concrete consequence of ignoring it.
  Not a summary — the stakes. "Miss this and your flight rebooking window closes tonight."
- confidence is 0..100: how sure you are given ONLY what you were shown. If subject+snippet
  are too thin to judge stakes, say so with LOW confidence — do not guess high.

Respond ONLY with a JSON object: {"importance": <int>, "category": "<cat>", "reason": "<sentence>", "confidence": <int>}`;

function passUserMsg(email: EmailRow, includeBody: boolean): string {
  const parts = [
    `Subject: ${email.subject ?? '(none)'}`,
    `Snippet: ${email.snippet ?? '(none)'}`,
  ];
  if (includeBody) {
    // Cap body — full marketing emails can be huge; the stakes live near the top.
    const body = (email.body ?? '').slice(0, 4000);
    parts.push(`Full body:\n${body || '(empty)'}`);
  }
  return parts.join('\n');
}

function coerce(raw: unknown): Classification {
  const o = (raw ?? {}) as Record<string, unknown>;
  let importance = Math.round(Number(o.importance));
  if (!Number.isFinite(importance)) importance = 0;
  importance = Math.max(0, Math.min(100, importance));

  let confidence = Math.round(Number(o.confidence));
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(100, confidence));

  let category = String(o.category ?? 'other') as Category;
  if (!CATEGORIES.includes(category)) category = 'other';

  const reason = typeof o.reason === 'string' ? o.reason.slice(0, 500) : '';

  return { importance, category, reason, confidence };
}

async function classifyOne(email: EmailRow): Promise<{ result: Classification; passes: number }> {
  // Pass 1 — subject + snippet only.
  const p1msgs: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: passUserMsg(email, false) },
  ];
  const r1 = await callDeepSeek(p1msgs);
  const c1 = coerce(JSON.parse(r1.content));

  const needsPass2 =
    (c1.confidence < LOW_CONFIDENCE || c1.importance >= HIGH_STAKES) &&
    (email.body != null && email.body.trim() !== '');

  if (!needsPass2) {
    return { result: c1, passes: 1 };
  }

  // Pass 2 — re-judge against the full body. This is the authoritative answer.
  const p2msgs: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: passUserMsg(email, true) },
  ];
  const r2 = await callDeepSeek(p2msgs);
  const c2 = coerce(JSON.parse(r2.content));
  return { result: c2, passes: 2 };
}

// Classify up to `limit` unclassified emails (newest first, via the partial
// index). Returns a per-email report. Each email audits independently — one
// bad email must not sink the batch.
export async function classifyBatch(limit: number): Promise<{
  processed: number;
  results: Array<{ id: string; ok: boolean; importance?: number; category?: string; passes?: number; error?: string }>;
}> {
  const emails = await sql<EmailRow[]>`
    select id, subject, snippet, body
    from emails
    where classified_at is null
    order by received_at desc nulls last
    limit ${limit}
  `;

  const results = [];
  for (const email of emails) {
    try {
      const { result, passes } = await classifyOne(email);
      await sql`
        update emails set
          importance    = ${result.importance},
          category      = ${result.category},
          reason        = ${result.reason},
          confidence    = ${result.confidence},
          classified_at = now()
        where id = ${email.id}
      `;
      await audit({
        action: 'marionette.classify',
        target: email.id,
        outcome: 'success',
        payload: {
          importance: result.importance,
          category: result.category,
          confidence: result.confidence,
          passes,
        },
      });
      results.push({ id: email.id, ok: true, importance: result.importance, category: result.category, passes });
    } catch (err: any) {
      const message = err?.message || String(err);
      await audit({
        action: 'marionette.classify',
        target: email.id,
        outcome: 'error',
        payload: { error: message },
      });
      results.push({ id: email.id, ok: false, error: message });
    }
  }

  return { processed: emails.length, results };
}
EOF
echo "written"
written
spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && sed -i "s|import { auditSummary } from './audit-read.ts';|import { auditSummary } from './audit-read.ts';\nimport { classifyBatch } from './classify.ts';|" marionette/src/index.ts
spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && cat > /tmp/classify_route.txt << 'EOF'
// POST /classify  { "limit": 20 }   (default 20)
// Runs the Clair two-pass triage over unclassified emails. Reasoning lives here;
// the dashboard only reads the columns this writes. Batch-bounded and manually
// triggered for now — cron wiring is a later slice once the output is trusted.
app.post('/classify', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body is fine */ }
  let limit = Number(body?.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  try {
    const report = await classifyBatch(limit);
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: 'classify batch failed', detail: err?.message || String(err) }, 500);
  }
});

EOF
echo "marker written"
marker written
spaghettios@spaghettios:~/bentley-os$ grep -n "POST /think" marionette/src/index.ts
35:// POST /think  { "request": "<what you want marionette to reason about>" }
spaghettios@spaghettios:~/bentley-os$ grep -n "classifyBatch" marionette/src/index.ts
10:import { classifyBatch } from './classify.ts';
spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && awk 'NR==35{while((getline line < "/tmp/classify_route.txt")>0) print line; print ""} {print}' marionette/src/index.ts > /tmp/index.new && mv /tmp/index.new marionette/src/index.ts
spaghettios@spaghettios:~/bentley-os$ grep -n "classifyBatch\|POST /classify\|app.post('/classify'" marionette/src/index.ts
10:import { classifyBatch } from './classify.ts';
35:// POST /classify  { "limit": 20 }   (default 20)
39:app.post('/classify', async (c) => {
46:    const report = await classifyBatch(limit);
spaghettios@spaghettios:~/bentley-os$ sed -n '33,54p' marionette/src/index.ts
  }
});
// POST /classify  { "limit": 20 }   (default 20)
// Runs the Clair two-pass triage over unclassified emails. Reasoning lives here;
// the dashboard only reads the columns this writes. Batch-bounded and manually
// triggered for now — cron wiring is a later slice once the output is trusted.
app.post('/classify', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* empty body is fine */ }
  let limit = Number(body?.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  if (limit > 100) limit = 100;
  try {
    const report = await classifyBatch(limit);
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: 'classify batch failed', detail: err?.message || String(err) }, 500);
  }
});


// POST /think  { "request": "<what you want marionette to reason about>" }
spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && docker build -t marionette-test ./marionette
[+] Building 0.5s (10/10) FINISHED                                                                                                                                        docker:default
 => [internal] load build definition from Dockerfile                                                                                                                                0.0s
 => => transferring dockerfile: 393B                                                                                                                                                0.0s
 => [internal] load metadata for docker.io/library/node:22-slim                                                                                                                     0.0s
 => [internal] load .dockerignore                                                                                                                                                   0.0s
 => => transferring context: 2B                                                                                                                                                     0.0s
 => [1/5] FROM docker.io/library/node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf                                                               0.0s
 => => resolve docker.io/library/node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf                                                               0.0s
 => [internal] load build context                                                                                                                                                   0.0s
 => => transferring context: 30.42kB                                                                                                                                                0.0s
 => CACHED [2/5] WORKDIR /app                                                                                                                                                       0.0s
 => CACHED [3/5] COPY package.json ./                                                                                                                                               0.0s
 => CACHED [4/5] RUN npm install --omit=dev                                                                                                                                         0.0s
 => [5/5] COPY src ./src                                                                                                                                                            0.0s
 => exporting to image                                                                                                                                                              0.2s
 => => exporting layers                                                                                                                                                             0.1s
 => => exporting manifest sha256:bbe0527db4e4d3f6e7095259ff498d463bdbd1e96a080eb71deb1285074de44c                                                                                   0.0s
 => => exporting config sha256:96996b40ee72d504c177ae09c96bbc33eaf5cb11eb6348c36db7b52e91eec9f1                                                                                     0.0s
 => => exporting attestation manifest sha256:3039f547d0e360b125e4c00e1c149d595988f38f138f384e891de0db21d296c7                                                                       0.0s
 => => exporting manifest list sha256:e640f65cc3e27f25f7b47748e83fb3663bada7fa87431a3f1f5c3ae59478747a                                                                              0.0s
 => => naming to docker.io/library/marionette-test:latest                                                                                                                           0.0s
 => => unpacking to docker.io/library/marionette-test:latest                                                                                                                        0.0s
spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && docker run -d --rm --name marionette-test \
  --network bentley-os_backend \
  --env-file .env \
  marionette-test && sleep 2 && docker logs marionette-test
9be41536a8de2a03641131ca053622250f1cff2960b14a1326a4d8a66567765d
marionette listening on :4200
spaghettios@spaghettios:~/bentley-os$ docker exec marionette-test node -e "fetch('http://localhost:4200/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:1})}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('ERR',e.message))"
{
  "processed": 1,
  "results": [
    {
      "id": "91246b59-4701-4668-82a0-02792adf5149",
      "ok": true,
      "importance": 5,
      "category": "newsletter",
      "passes": 1
    }
  ]
}
spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c \
"select subject, importance, category, confidence, reason from emails where id = '91246b59-4701-4668-82a0-02792adf5149';"
                            subject                            | importance |  category  | confidence |                                   reason                                    
---------------------------------------------------------------+------------+------------+------------+-----------------------------------------------------------------------------
 $18.6M Health Brand + 4.6-star Baking App + 300th The Exit Ep |          5 | newsletter |         95 | No direct consequence; this is a business digest and can be safely ignored.
(1 row)

spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c \
"select at, action, target, outcome, payload from audit_log where action='marionette.classify' order by at desc limit 1;"
              at               |       action        |                target                | outcome |                                  payload                                   
-------------------------------+---------------------+--------------------------------------+---------+----------------------------------------------------------------------------
 2026-07-12 20:43:05.622437+00 | marionette.classify | 91246b59-4701-4668-82a0-02792adf5149 | success | {"passes": 1, "category": "newsletter", "confidence": 95, "importance": 5}
(1 row)

spaghettios@spaghettios:~/bentley-os$ docker rm -f marionette-test && docker rmi marionette-test 2>/dev/null; echo "cleaned"
marionette-test
Untagged: marionette-test:latest
Deleted: sha256:e640f65cc3e27f25f7b47748e83fb3663bada7fa87431a3f1f5c3ae59478747a
cleaned
spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && git add marionette/src/classify.ts marionette/src/index.ts && git status
On branch main
Your branch is up to date with 'origin/main'.

Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
        new file:   marionette/src/classify.ts
        modified:   marionette/src/index.ts

spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && git commit -m "feat(m3): Clair two-pass email triage classifier — POST /classify" && git push origin main
[main 5d45b8d] feat(m3): Clair two-pass email triage classifier — POST /classify
 2 files changed, 191 insertions(+)
 create mode 100644 marionette/src/classify.ts
Enumerating objects: 10, done.
Counting objects: 100% (10/10), done.
Delta compression using up to 16 threads
Compressing objects: 100% (6/6), done.
Writing objects: 100% (6/6), 3.58 KiB | 3.58 MiB/s, done.
Total 6 (delta 4), reused 0 (delta 0), pack-reused 0 (from 0)
remote: Resolving deltas: 100% (4/4), completed with 4 local objects.
To github.com:bentleylujero/bentley-os.git
   4c39435..5d45b8d  main -> main
spaghettios@spaghettios:~/bentley-os$ curl -s -X POST http://127.0.0.1:4000/deploy \
  -H 'Content-Type: application/json' \
  -d '{"service":"marionette"}'
{"job_id":"8acb31a7-4560-4d3b-98d8-71aa10dca17b","status":"running","service":"marionette"}spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c \
"select at, action, outcome from audit_log where payload->>'job_id' = '8acb31a7-4560-4d3b-98d8-71aa10dca17b' order by at;"
              at               |     action      | outcome 
-------------------------------+-----------------+---------
 2026-07-12 21:00:49.416439+00 | deploy.enqueued | queued
 2026-07-12 21:00:49.430279+00 | deploy.started  | running
(2 rows)

spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c \
"select at, action, outcome from audit_log where payload->>'job_id' = '8acb31a7-4560-4d3b-98d8-71aa10dca17b' order by at;"
              at               |      action      | outcome 
-------------------------------+------------------+---------
 2026-07-12 21:00:49.416439+00 | deploy.enqueued  | queued
 2026-07-12 21:00:49.430279+00 | deploy.started   | running
 2026-07-12 21:01:10.678303+00 | deploy.succeeded | success
(3 rows)

spaghettios@spaghettios:~/bentley-os$ curl -s -X POST http://127.0.0.1:3000/opencode/../marionette 2>/dev/null; \
docker exec bentley-os-marionette-1 node -e "fetch('http://localhost:4200/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:20})}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('ERR',e.message))"
404 Not Found^Cspaghettios@spaghettioscurl -s -X POST http://127.0.0.1:3000/opencode/../marionette 2>/dev/null; \ 2>/dev/null; \
docker exec bentley-os-marionette-1 node -e "fetch('http://localhost:4200/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:20})}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('ERR',e.message))"
404 Not Founddocker exec bentley-os-marionette-1 node -e "fetch('http://localhost:4200/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:20})}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('ERR',e.messagspaghettios@spaghettios:~/bentley-os$ docker exec bentley-os-marionette-1 node -e "fetch('http://localhost:4200/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:20})}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('ERR',e.message))"age))"
spaghettios@spaghettios:~/bentley-os$ docker exec bentley-os-marionette-1 node -e "fetch('http://localhost:4200/classify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:20})}).then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2))).catch(e=>console.log('ERR',e.message))")"
{
  "processed": 20,
  "results": [
    {
      "id": "4dc33bc0-b5b0-406c-bc9d-8680c6d319b7",
      "ok": true,
      "importance": 5,
      "category": "other",
      "passes": 1
    },
    {
      "id": "c0595064-41ea-45ae-b199-7127ea5036e5",
      "ok": true,
      "importance": 10,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "f77e190c-feab-4c6d-80fa-9a36520902d5",
      "ok": true,
      "importance": 85,
      "category": "action",
      "passes": 2
    },
    {
      "id": "9d854d68-feb3-45a7-8645-7236d40c299f",
      "ok": true,
      "importance": 85,
      "category": "action",
      "passes": 2
    },
    {
      "id": "de5e752e-d7ce-4163-8ca1-6a3039200472",
      "ok": true,
      "importance": 15,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "a554516d-4fc6-4edf-95b8-8bf2c13da803",
      "ok": true,
      "importance": 10,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "e41f2e08-e9cc-485f-af56-18af8a8dabdc",
      "ok": true,
      "importance": 10,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "10c216b0-ae78-4415-997c-9f389102d792",
      "ok": true,
      "importance": 10,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "fd6ec8ca-bf61-4d1e-8806-9894e1e84210",
      "ok": true,
      "importance": 50,
      "category": "action",
      "passes": 1
    },
    {
      "id": "8c1e03e5-7679-4a95-97cd-ddc1f6dfc29d",
      "ok": true,
      "importance": 30,
      "category": "work",
      "passes": 1
    },
    {
      "id": "b9fab254-83e2-4e7b-a35f-10332818f636",
      "ok": true,
      "importance": 25,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "c708cbdb-141f-497b-b861-2b17f4a92427",
      "ok": true,
      "importance": 10,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "e2986aa4-d233-44b8-8192-7fb65ea75b2c",
      "ok": true,
      "importance": 5,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "98663bba-2335-4c98-8f51-170988dbf2fa",
      "ok": true,
      "importance": 20,
      "category": "work",
      "passes": 1
    },
    {
      "id": "43e92fff-6351-4c7d-90b3-05263a6afd8e",
      "ok": true,
      "importance": 10,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "7c4bcdc7-1c01-48e4-a9c8-a1ea4103e2e2",
      "ok": true,
      "importance": 0,
      "category": "other",
      "passes": 1
    },
    {
      "id": "b14f67a5-c880-4101-8b78-43e998298131",
      "ok": true,
      "importance": 10,
      "category": "other",
      "passes": 1
    },
    {
      "id": "c5724301-0c84-4ebd-b039-2a029d6754a8",
      "ok": true,
      "importance": 10,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "9d19766e-4213-492c-bcfb-32076f8c7695",
      "ok": true,
      "importance": 10,
      "category": "newsletter",
      "passes": 1
    },
    {
      "id": "12c2d73b-ed54-42f3-abe2-34176436020f",
      "ok": true,
      "importance": 25,
      "category": "work",
      "passes": 1
    }
  ]
}
spaghettios@spaghettios:~/bentley-os$ docker exec -it bentley-os-postgres-1 psql -h 127.0.0.1 -U bentley -d bentley -P pager=off -c \
"select importance, category, left(subject,45) as subject, reason from emails where classified_at is not null order by importance desc limit 8;"
 importance | category |                    subject                    |                                                              reason                                                               
------------+----------+-----------------------------------------------+-----------------------------------------------------------------------------------------------------------------------------------
         90 | action   | [GitHub] Your personal access token (classic) | If ignored, the token expires and any service using it (e.g., CI/CD, scripts) will break, causing workflow interruptions.
         85 | action   | Security alert                                | Miss this and an unauthorized person could access your Google account, potentially leading to data theft or financial loss.
         65 | action   | Order Destination Change Needed!              | Ignoring this email means your order may ship to the wrong address, causing delays or loss.
         65 | action   | Order Destination Change Needed!              | You might not know if the address change fails, causing the order to ship to the wrong destination.
         65 | action   | Re: Order Destination Change Needed!          | If ignored, the order might ship to the wrong address, causing delivery failure or loss.
         60 | action   | Order Destination Change Needed!              | Miss this and the customer may lose access to the delivery address, risking a lost package and negative service experience.
         55 | action   | Remember to Register a Backup MFA Verificatio | Without a backup MFA method, losing access to your primary method could lock you out of your account, requiring lengthy recovery.
         50 | action   | [Action needed] Complete your billing setup f | Missing this could prevent you from using the Gemini API, potentially disrupting any projects relying on it.
(8 rows)

spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && ls *.md && git log --oneline -8
THE_BIBLE.md
5d45b8d (HEAD -> main, origin/main, origin/HEAD) feat(m3): Clair two-pass email triage classifier — POST /classify
4c39435 feat(m3): full-body gmail ingestion + email intelligence schema
79bea75 Add 'What changed' section to dashboard and improve notifications
b905e4b migration: 0004_dashboard_state singleton for 'what changed' last-seen tracking
5955d8d feat(m2): "what changed" dashboard view — deltas since last look
7cb895d chore: gitignore whisper/Dockerfile.bak
403c84b Update THE_BIBLE.md with commit details and notes
ef41370 Update THE_BIBLE.md to remove obsolete information
spaghettios@spaghettios:~/bentley-os$ cd ~/bentley-os && ls *.md && git log --oneline -8
THE_BIBLE.md
5d45b8d (HEAD -> main, origin/main, origin/HEAD) feat(m3): Clair two-pass email triage classifier — POST /classify
4c39435 feat(m3): full-body gmail ingestion + email intelligence schema
79bea75 Add 'What changed' section to dashboard and improve notifications
b905e4b migration: 0004_dashboard_state singleton for 'what changed' last-seen tracking
5955d8d feat(m2): "what changed" dashboard view — deltas since last look
7cb895d chore: gitignore whisper/Dockerfile.bak
403c84b Update THE_BIBLE.md with commit details and notes
ef41370 Update THE_BIBLE.md to remove obsolete information
spaghettios@spaghettios:~/bentley-os$ echo "===== DASHBOARD ROUTE ====="
cat apps/api/src/routes/dashboard.ts
echo "===== 0004 ====="
cat supabase/migrations/0004_dashboard_state.sql
echo "===== 0005 ====="
cat supabase/migrations/0005_email_intelligence.sql
===== DASHBOARD ROUTE =====
import { Hono } from 'hono';
import { pool } from '../db/pool.js';

export const dashboardRoute = new Hono();

const TZ = 'America/Chicago';

function esc(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

// Compact "Jul 12, 3:04 PM" for cross-day deltas in the What-changed feed.
function fmtStamp(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: TZ,
  });
}

dashboardRoute.get('/', async (c) => {
  let events: any[] = [];
  let emails: any[] = [];
  let newEmails: any[] = [];
  let newEvents: any[] = [];
  let lastSeen: Date | null = null;
  let dbError = '';

  // Read the singleton last-seen marker first. Its own guard: if this fails,
  // the What-changed section simply shows nothing new — the rest still renders.
  try {
    const seenR = await pool.query(
      `SELECT last_seen_at FROM dashboard_state WHERE id = 1`
    );
    lastSeen = seenR.rows[0]?.last_seen_at ?? null;
  } catch {
    lastSeen = null;
  }

  try {
    const eventsQ = pool.query(
      `SELECT title, starts_at, ends_at, location, status
         FROM calendar_events
        WHERE starts_at AT TIME ZONE $1 >= (now() AT TIME ZONE $1)::date
          AND starts_at AT TIME ZONE $1 <  ((now() AT TIME ZONE $1)::date + interval '1 day')
        ORDER BY starts_at ASC`,
      [TZ]
    );
    const emailsQ = pool.query(
      `SELECT subject, snippet, received_at, is_unread
         FROM emails
        ORDER BY received_at DESC NULLS LAST
        LIMIT 15`
    );
    // "What changed" = rows ingested (created_at) since the owner last looked.
    // created_at, not received_at: an old email newly synced still counts as new to us.
    const newEmailsQ = lastSeen
      ? pool.query(
          `SELECT subject, snippet, received_at, created_at, is_unread
             FROM emails
            WHERE created_at > $1
            ORDER BY created_at DESC
            LIMIT 20`,
          [lastSeen]
        )
      : Promise.resolve({ rows: [] as any[] });
    const newEventsQ = lastSeen
      ? pool.query(
          `SELECT title, starts_at, location, created_at
             FROM calendar_events
            WHERE created_at > $1
            ORDER BY created_at DESC
            LIMIT 20`,
          [lastSeen]
        )
      : Promise.resolve({ rows: [] as any[] });

    const [eventsR, emailsR, newEmailsR, newEventsR] = await Promise.all([
      eventsQ,
      emailsQ,
      newEmailsQ,
      newEventsQ,
    ]);
    events = eventsR.rows;
    emails = emailsR.rows;
    newEmails = newEmailsR.rows;
    newEvents = newEventsR.rows;
  } catch (err: any) {
    dbError = err?.message ?? 'query failed';
  }

  // Advance the marker to now — fire-and-forget, after the deltas above are
  // already captured, so THIS view still shows what was new and the NEXT resets.
  // Own guard: a failed update must never break the response.
  void pool
    .query(`UPDATE dashboard_state SET last_seen_at = now() WHERE id = 1`)
    .catch(() => {});

  const changedCount = newEmails.length + newEvents.length;
  const changedHtml = dbError
    ? ''
    : !lastSeen
    ? `<p class="muted">First look — nothing to compare against yet.</p>`
    : changedCount === 0
    ? `<p class="muted">Nothing new since you last looked.</p>`
    : [
        ...newEvents.map(
          (e) => `<div class="row">
        <span class="time">${esc(fmtStamp(e.created_at))}</span>
        <span class="body"><span class="tag">event</span> <b>${
            esc(e.title) || '(untitled)'
          }</b>${
            e.location ? `<span class="sub"> · ${esc(e.location)}</span>` : ''
          }</span>
      </div>`
        ),
        ...newEmails.map(
          (m) => `<div class="row">
        <span class="time">${esc(fmtStamp(m.created_at))}</span>
        <span class="body"><span class="tag">email</span> ${
            m.is_unread ? '<span class="unread">●</span> ' : ''
          }<b>${esc(m.subject) || '(no subject)'}</b>${
            m.snippet ? `<span class="sub"> — ${esc(m.snippet)}</span>` : ''
          }</span>
      </div>`
        ),
      ].join('');

  const eventsHtml = dbError
    ? `<p class="muted">couldn't load events: ${esc(dbError)}</p>`
    : events.length === 0
    ? `<p class="muted">Nothing on the calendar today.</p>`
    : events
        .map(
          (e) => `<div class="row">
        <span class="time">${esc(fmtTime(e.starts_at))}</span>
        <span class="body"><b>${esc(e.title) || '(untitled)'}</b>${
            e.location ? `<span class="sub"> · ${esc(e.location)}</span>` : ''
          }</span>
      </div>`
        )
        .join('');

  const emailsHtml = dbError
    ? ''
    : emails.length === 0
    ? `<p class="muted">No emails yet.</p>`
    : emails
        .map(
          (m) => `<div class="row">
        <span class="time">${esc(fmtTime(m.received_at))}</span>
        <span class="body">${m.is_unread ? '<span class="unread">●</span> ' : ''}<b>${
            esc(m.subject) || '(no subject)'
          }</b>${m.snippet ? `<span class="sub"> — ${esc(m.snippet)}</span>` : ''}</span>
      </div>`
        )
        .join('');

  const changedHeading =
    !dbError && lastSeen && changedCount > 0
      ? `What changed <span class="count">${changedCount}</span>`
      : `What changed`;

  return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bentley OS</title>
<style>
  body{background:#0b0e14;color:#e6e6e6;font-family:ui-monospace,Menlo,monospace;margin:0;padding:2rem;}
  .wrap{max-width:680px;margin:0 auto;}
  h1{font-size:1.4rem;letter-spacing:.02em;}
  h2{font-size:.95rem;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin:1.5rem 0 .5rem;}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#3fb950;margin-right:8px;}
  .card{background:#151a23;border:1px solid #222b38;border-radius:10px;padding:1rem 1.25rem;margin:.5rem 0;}
  .row{display:flex;gap:.9rem;padding:.45rem 0;border-bottom:1px solid #1c2431;}
  .row:last-child{border-bottom:none;}
  .time{color:#8b949e;font-size:.85rem;min-width:88px;white-space:nowrap;}
  .body{flex:1;overflow:hidden;}
  .sub{color:#8b949e;font-weight:normal;}
  .unread{color:#58a6ff;}
  .tag{display:inline-block;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;border:1px solid #2a3441;border-radius:4px;padding:0 5px;margin-right:4px;}
  .count{display:inline-block;background:#238636;color:#fff;font-size:.7rem;border-radius:9px;padding:0 7px;margin-left:6px;vertical-align:middle;}
  a{color:#58a6ff;text-decoration:none;} a:hover{text-decoration:underline;}
  .muted{color:#8b949e;font-size:.85rem;}
</style></head>
<body><div class="wrap">
  <h1><span class="dot"></span>Bentley OS</h1>
  <h2>${changedHeading}</h2>
  <div class="card">${changedHtml}</div>
  <h2>Today</h2>
  <div class="card">${eventsHtml}</div>
  <h2>Recent email</h2>
  <div class="card">${emailsHtml}</div>
  <p class="muted"><a href="/health">/health</a> · <span id="time"></span></p>
</div>
<script>document.getElementById('time').textContent = new Date().toLocaleString();</script>
</body></html>`);
});
===== 0004 =====
-- 0004_dashboard_state.sql
-- Singleton state for the dashboard's "what changed" view.
-- Holds one fact: the last time the owner viewed the dashboard.
-- Enforced single-row (id pinned to 1) — not a shadow table, one fact stored once.
create table if not exists dashboard_state (
  id           smallint primary key default 1 check (id = 1),
  last_seen_at timestamptz not null default now()
);

-- Seed the singleton row. on conflict keeps re-running the migration safe.
insert into dashboard_state (id, last_seen_at)
values (1, now())
on conflict (id) do nothing;
===== 0005 =====
-- 0005_email_intelligence.sql
-- M3: email body storage + triage classification fields.
-- body: full decoded text/plain (or stripped html) — feeds Pass-2 classification,
--   embeddings, and future pattern detection (unsubscribe suggestions, Q&A).
-- reason: marionette's one-line "why this matters" consequence assessment.
-- confidence: marionette's Pass-1 self-reported certainty (0-100); low values
--   trigger Pass-2 full-body re-classification.
-- classified_at: null = never judged; classifier only touches WHERE classified_at IS NULL.

ALTER TABLE emails ADD COLUMN IF NOT EXISTS body          text;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS reason        text;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS confidence    smallint;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS classified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_emails_unclassified
  ON emails (received_at DESC)
  WHERE classified_at IS NULL;
spaghettios@spaghettios:~/bentley-os$ 
