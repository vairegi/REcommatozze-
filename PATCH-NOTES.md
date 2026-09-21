# Patch v2 — fixes posting, /restore loop, and silent logs

Overwrite these files into your repo (paths preserved):
  src/db.ts
  src/index.ts
  src/webhook.ts
  src/lib/broadcast-wizard.server.ts
  src/lib/broadcast.server.ts

Then: git add -A && git commit -m "fix: posting + restore loop + logging" && git push
Render auto-deploys on push.

## What each fix does
1. src/db.ts — endpoint() now accepts libsql://, turso://, https:// (fixes "fetch failed").
2. src/webhook.ts — update_id idempotency guard. Telegram re-delivers slow updates;
   this stops /restore and broadcasts running 5-6 times in a row.
3. src/lib/broadcast-wizard.server.ts — target rows now get status:"pending".
   THE posting bug: targets were inserted with no status, so executeBroadcast's
   .eq("status","pending") query matched 0 rows -> "0 delivered".
4. src/lib/broadcast.server.ts — logs every per-target failure; never reports
   "delivered" when 0 targets were sent.
5. src/index.ts — process-level unhandledRejection/uncaughtException handlers so
   nothing fails silently in the Render logs.

## After deploy, re-verify
- /healthz  -> {"ok":true}
- Send a test broadcast -> should say "1 delivered"
- /restore  -> runs ONCE, not in a loop
