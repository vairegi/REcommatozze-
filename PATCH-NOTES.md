# Patch: fix "fetch failed" Turso connection on Render

## Root cause
TURSO_DATABASE_URL was set with a `turso://` scheme (what Turso CLI prints).
src/db.ts only converted `libsql://` to `https://`, so it tried to fetch
`turso://.../v2/pipeline` — Node fetch cannot speak that scheme -> "fetch failed".
With the DB unreachable, every admin insert silently failed, which is why the bot
re-claimed you as owner on every message and /addadmin always failed.

## Changed files (overwrite into repo, keeping folder structure)
- src/db.ts    — endpoint() now accepts libsql://, turso://, https:// or bare host; trims whitespace.
- src/index.ts — schema-init error logging now prints the underlying cause.

## Deploy steps
1. Copy these two files over the ones in your repo, commit, push.
2. Render redeploys automatically on push. Logs should no longer show "Turso schema init failed".
3. DM the bot /whoami — should say super admin and stop re-claiming ownership.
