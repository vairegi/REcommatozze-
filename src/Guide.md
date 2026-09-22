# Project Guide & Change Log

Single Telegram channel-manager bot ("Trash Manga Bot" / @lifesimplerbot, Render service `recommatozze`). Admins run it from a private DM. Stack: **Node 20+ / TypeScript (tsx), Express webhook, Turso (libsql) via `supabaseAdmin`-style client, direct Telegram Bot API** (no framework). Start: `npm start` → `tsx src/index.ts`. Entry: `src/index.ts` → `src/webhook.ts`. DB access in `src/db.ts`; Telegram client in `src/lib/telegram.server.ts`.

> Repo quirk: loose duplicates (`index.ts`, `db.ts`) sit next to the real tree under `src/`. **The files that run are under `src/`** — edit those.

---

## v2 — `/channels` native TEXT spreadsheet (2026-09-22)

**Replaces v1 (image board), which was rolled back** after the owner clarified they wanted a text table, not an image. v2 is plain-text only — no image generation, no new dependencies.

### What `/channels` does now
- Sends a monospace **`<pre>` spreadsheet** (HTML `parse_mode`), chunked to stay under Telegram's 4096-char limit (~3,400 budget per chunk, split on row boundaries).
- Each row is two narrow lines so nothing wraps awkwardly on mobile:
  `NN. <channel name>` / `chat_id · LIST ✅IAds 🔒`.
- **Embedded links:** the channel *name itself* is `<a href="invite_link">Name</a>` — no "open" buttons.
- **Exactly one inline button:** a single 🔄 **Refresh** on the *last* chunk only. All v1 per-channel / filter buttons removed.
- **Dynamic:** every call re-queries `telegram_chats` + `chat_lists` in Turso *and* live-verifies admin via `getChatMember`, so a channel the bot was just made admin of appears on the very next `/channels`; lost-access channels drop off.
- **Ordering preserved:** MINE → ADULT → MANGA → other lists → `[NONE]` last; stable within a tier.
- **Refresh** deletes the previous board's messages and posts fresh ones (no stale duplicates).

### Where it lives (all in `src/webhook.ts`)
- `gatherChannelEntries` — Turso pull + live verify + invite-link resolution (the v1 data-gather logic, moved inline).
- `chbRow` / `buildChannelBoardChunks` — spreadsheet formatting + smart chunking.
- `sendChannelBoard` — delete-old-then-send, one Refresh button on the last chunk.
- `handleChannelsCommand` — `/channels` entry (DM-only; signature back to no `argText`/board deps).
- `handleChannelListRefresh` — `chl:refresh` callback (admin-only, DM-only) routed **before** `handleBroadcastCallback`.
- `channelBoardMessages` — in-memory `Map<chatId, messageId[]>` for refresh cleanup. Memory-only → after a Render redeploy the first Refresh just posts a new board without deleting the old one (once). Persist to Turso if that ever matters.
- `handleChannelsCommandLegacy` — original text list, kept for reference (unused).

### Verification done before shipping v2
`tsc --noEmit` clean; behavior tests (gather/numbering/links/flags, chunking ≤ limit, one-button keyboard, refresh delete+resend, empty state); boot smoke (`/healthz` 200). **No new npm dependency.** No separate lib module.

### Rolled back from v1 (do not re-add unless asked)
`src/lib/channel-board.server.ts`, `src/lib/assets/fonts/*`, `@resvg/resvg-js` dep, and the `sendPhotoBuffer` / `editPhotoBuffer` / `editMessageCaption` helpers in `telegram.server.ts` — all removed.
