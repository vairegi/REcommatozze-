# Project Guide & Change Log

Single Telegram channel-manager bot ("Trash Manga Bot" / @lifesimplerbot, Render service `recommatozze`). Admins run it from a private DM. Stack: **Node 20+ / TypeScript (tsx), Express webhook, Turso (libsql), direct Telegram Bot API** (no framework). Start: `npm start` → `tsx src/index.ts`. Entry: `src/index.ts` → `src/webhook.ts`. DB access in `src/db.ts`; Telegram client in `src/lib/telegram.server.ts`.

> Repo quirk: loose duplicates (`index.ts`, `db.ts`) sit next to the real tree under `src/`. **The files that run are under `src/`** — edit those.

---

## v4 — `/channels` native Rich Message TABLE (2026-09-22)

Replaces the v3 monospace `<pre>` grid with a **real table** using the Bot API 10.x Rich Messages feature (`sendRichMessage` + `InputRichBlockTable`). Verified against the official docs (https://core.telegram.org/bots/api).

### How it works
- Sends **one `sendRichMessage`** whose `rich_message.blocks` are: board header paragraph → per-section heading (`📢 Channels` / `👥 Supergroups` / `👥 Groups`) → **bordered, striped, compact table** per section → divider → footer legend.
- Table columns: `# | Channel | List | IAds`. Channel name cell is a **RichTextUrl** — the name itself is clickable. `✅` marks channels where @InsideAds_bot is also admin, `🔒` marks channels with no invite link.
- **Exactly one inline button:** 🔄 Refresh, attached via `reply_markup` on the last rich message (callback `chl:refresh`, admin-only, DM-only — routed before the broadcast wizard).
- Chunking: tables split at 120 rows/message (rich-message limit is 500 blocks) — with ~85 channels this is a single message.
- **Automatic fallback:** if the Bot API rejects `sendRichMessage` (older server), the bot logs a warning and sends the v3 `<pre>` grid instead, so `/channels` never breaks.
- Data still pulled from Turso + live-verified via `getChatMember` on every call; ordering MINE → ADULT → MANGA → others → NONE unchanged. Refresh deletes the old board and reposts.

### Where it lives (`src/webhook.ts`)
- `buildChannelBoardRich` — builds the rich-message blocks/tables.
- `chbTableRow`, `rtLinked`, `rtBold` — row/cell helpers.
- `sendChannelBoard` — tries rich table, falls back to `sendChannelBoardText` (v3 grid).
- `gatherChannelEntries`, `handleChannelsCommand`, `handleChannelListRefresh` — unchanged from v3.

### Dev/test support added
- `src/lib/telegram.server.ts`: `TELEGRAM_API_BASE` env override (test harness only).
- `src/db.ts`: `TURSO_ENDPOINT` env override (test harness only).
Both are no-ops in production.

### Verification
`tsc --noEmit` clean; boot smoke OK; full end-to-end harness (mock Telegram API + mock Turso, real bot process, real webhook POST): `/channels` → 1 sendRichMessage, 3 tables, 88 rows, bordered+striped+compact, 85 clickable name cells, single Refresh button. ✅

## v3 — compact SCRAPJAV-style text grid (superseded by v4; kept as the automatic fallback)

Replaces v1 (image board) and v2 (2-line-per-row text list). v3 matches the SCRAPJAV "TARGETS — live board" screenshot: a single compact monospace grid, one line per channel.

### What `/channels` does now
- **Single-line rows** inside one `<pre>` block: ` N. Name                      List        Flags`.
- **Section headers** (`📢 CHANNELS (n)`, `👥 SUPERGROUPS (n)`, `👥 GROUPS (n)`) each with a `─` separator and column header inside their own section.
- **Embedded links:** the channel name itself is `<a href="invite_link">Name</a>` — no "open" buttons per channel.
- **One inline button only:** a single 🔄 **Refresh** on the *last* chunk. Every other v1 button (per-channel opens, category filters, refresh-with-payload) is gone.
- **Small caption footer:** `Tap a name to open · List = MINE|ADULT|MANGA|... · ✅ = @InsideAds_bot admin · 🔒 = no invite link`.
- **Dynamic:** every call (and every Refresh) re-queries Turso *and* live-verifies admin via `getChatMember`, so a channel the bot was just made admin of appears the very next `/channels`; lost-access channels drop off.
- **Ordering preserved from v1/v2:** MINE → ADULT → MANGA → other lists → NONE last; stable within a tier.
- **Refresh** deletes the previous board's messages then posts fresh — never leaves stale duplicates. In-memory tracking, so after a Render redeploy the first Refresh just posts new (once).
- **Chunking:** splits at ~3,400 chars on row boundaries, re-opens `<pre>` per chunk with a small `(1/2)` marker.

### Where it lives (all in `src/webhook.ts`)
- `channelBoardMessages` — `Map<chatId, messageId[]>` for refresh cleanup.
- `gatherChannelEntries` — Turso pull + live verify + invite-link resolution.
- `chbRow` — one compact row.
- `buildChannelBoardChunks` — grid + section headers + smart chunking.
- `sendChannelBoard` — delete-old-then-send, Refresh button on last chunk only.
- `handleChannelsCommand` — `/channels` entry (DM-only via the dispatcher's existing guard).
- `handleChannelListRefresh` — `chl:refresh` callback (admin-only, DM-only) routed **before** `handleBroadcastCallback`.

### Rolled back in v3 (removed from repo)
- Deleted: `src/lib/channel-board.server.ts`, `src/lib/assets/` (bundled fonts).
- Removed dep: `@resvg/resvg-js` (no new npm dependencies in v3).
- Removed from `src/lib/telegram.server.ts`: `sendPhotoBuffer`, `editPhotoBuffer`, `editMessageCaption` (image helpers, unused).
- Removed from `src/webhook.ts`: `handleChannelBoardCallback`, all `chb:*` callback data, all board-import/dispatch plumbing.

### Verification done before shipping v3
`tsc --noEmit` clean; boot smoke test (`src/index.ts` starts, `/healthz` returns 200). No new npm dependency; no separate lib module.

---

## v2 — 2-line-per-row text list (superseded by v3)
Interim rollback of v1. Two lines per row, embedded links, single Refresh. Superseded because the visual density did not match the SCRAPJAV screenshot the owner referenced.

## v1 — image board with buttons (rolled back)
Rendered a PNG spreadsheet via `@resvg/resvg-js` + bundled DejaVu fonts, with a wall of per-channel/filter/refresh buttons. Rolled back per owner: they wanted native text, clickable names, and a single Refresh button.
