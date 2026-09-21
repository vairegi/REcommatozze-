# Telegram Manager Bot — standalone (Render + Turso)

Full port of your Lovable bot: every command works exactly the same
(`/post`, `/splitpost`, `/listpost`, `/nuke`, `/recur`, `/listrecur`,
`/channels`, `/checkmember`, `/permissions`, `/addadmin`, `/backup`,
`/restore`, `/dltmsg`, lists, buttons, wizard, schedulers…).

Differences from the Lovable version:
- Telegram is called directly at `api.telegram.org` with your own bot token.
- Data lives in **Turso** (libSQL) instead of Postgres. It reads/writes the
  *same table shape* your Turso mirror already uses
  (`pk`, `data` JSON, `op`, `synced_at`), so your existing rows work as-is.
- Scheduled work runs inside the process (no external cron):
  broadcast tick every 60s, recurring posts every 60s,
  permission check every 6h, weekly backup DM (Sun ~03:00 IST).

---

## 1. Create the GitHub repo

1. Unzip this folder.
2. In the folder run:
   ```bash
   git init
   git add .
   git commit -m "telegram bot"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

## 2. Get your bot token

Open [@BotFather](https://t.me/BotFather) → `/mybots` → your bot → *API Token*.
(If you rotate the token, Telegram invalidates the old one.)

## 3. Get your Turso credentials

```bash
turso db show <your-db> --url      # -> libsql://...turso.io
turso db tokens create <your-db>   # -> auth token
```
Or copy them from the Turso dashboard (Database → Connect).

## 4. Deploy on Render (no blueprint)

1. [dashboard.render.com](https://dashboard.render.com) → **New +** → **Web Service**.
2. Connect your GitHub repo.
3. Settings:
   - **Runtime / Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Starter or higher (Free instances sleep and will miss
     scheduled posts).
4. Add the environment variables below, then **Create Web Service**.

### Environment variables

| Key | Value | Required |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | token from BotFather | ✅ |
| `TURSO_DATABASE_URL` | `libsql://<db>-<org>.turso.io` | ✅ |
| `TURSO_AUTH_TOKEN` | Turso auth token | ✅ |
| `PUBLIC_URL` | `https://<your-service>.onrender.com` | ✅ (after first deploy) |
| `PORT` | set automatically by Render | — |

## 5. Finish the webhook

The first deploy happens before you know the service URL. After the service
is live:

1. Copy the URL Render shows (e.g. `https://mybot.onrender.com`).
2. Set `PUBLIC_URL` to that value in **Environment**.
3. Click **Manual Deploy → Deploy latest commit** (or Save, which redeploys).

On boot the bot registers its own webhook at
`PUBLIC_URL/telegram/webhook` with a secret token derived from your bot
token, so no other setup is needed.

**Verify:** open `https://<service>.onrender.com/healthz` → `{"ok":true,...}`,
then DM the bot `/whoami`.

## 6. First-run notes

- If your Turso DB has no `telegram_bot_admins` row, the first person to DM
  the bot `/start` is claimed as **super admin** (same rule as before).
- Missing tables are created automatically on boot.
- Non-admins get no reply — that gate is unchanged.

## Run locally

```bash
cp .env.example .env      # fill in the values
npm install
npm run dev
```
Leave `PUBLIC_URL` empty locally (no webhook is registered), or point it at an
ngrok HTTPS URL.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot silent | Check Render logs for `webhook registered:`; if missing, set `PUBLIC_URL` and redeploy |
| `TURSO_AUTH_TOKEN is not set` | Add the env var, redeploy |
| Posts fire late | Free instance sleeping — upgrade to a paid instance |
| `401 Unauthorized` in logs | Another service still owns the webhook; redeploy this one to re-register |

## Layout

```
src/index.ts                       Express server + schedulers + setWebhook
src/webhook.ts                     all command handling (Telegram updates)
src/db.ts                          Turso storage layer (Supabase-style API)
src/lib/telegram.server.ts         Bot API client with retry/backoff
src/lib/broadcast.server.ts        broadcast delivery, edit, nuke, auto-delete
src/lib/broadcast-wizard.server.ts /post wizard, buttons, split posts
src/lib/recurring*.server.ts       recurring posts
src/lib/permission*.server.ts      bot permission monitor
src/lib/backup.server.ts           /backup and /restore
```
