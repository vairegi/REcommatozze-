import "dotenv/config";
import express from "express";
import { handleWebhookRequest } from "@/webhook";
import { deriveWebhookSecret, telegramCall, getBotIdentity } from "@/lib/telegram.server";
import { ensureSchema } from "@/db";

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = Number(process.env.PORT ?? 3000);
const WEBHOOK_PATH = "/telegram/webhook";

app.get("/", (_req, res) => res.json({ ok: true, service: "telegram-bot" }));
app.get("/healthz", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    const request = new Request(`http://localhost${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token":
          (req.header("X-Telegram-Bot-Api-Secret-Token") as string) ?? "",
      },
      body: JSON.stringify(req.body ?? {}),
    });
    const out = await handleWebhookRequest(request);
    const text = await out.text();
    res.status(out.status).type(out.headers.get("content-type") ?? "text/plain").send(text);
  } catch (e: any) {
    console.error("webhook error", e);
    res.status(200).json({ ok: false, error: e?.message ?? "error" });
  }
});

/** Register the webhook with Telegram on boot. */
async function registerWebhook() {
  const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  if (!base) {
    console.warn("PUBLIC_URL not set — skipping setWebhook. Set it to https://<service>.onrender.com");
    return;
  }
  const url = `${base}${WEBHOOK_PATH}`;
  await telegramCall("setWebhook", {
    url,
    secret_token: deriveWebhookSecret(),
    allowed_updates: [
      "message",
      "edited_message",
      "channel_post",
      "callback_query",
      "my_chat_member",
      "chat_member",
    ],
    drop_pending_updates: false,
  });
  const me = await getBotIdentity();
  console.log(`webhook registered: ${url} (bot @${me.username})`);
}

/** Interval scheduler with overlap protection. */
function every(ms: number, name: string, fn: () => Promise<unknown>) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e: any) {
      console.error(`${name} failed:`, e?.message ?? e);
    } finally {
      running = false;
    }
  }, ms);
}

const backupState: { last?: string } = {};
async function weeklyBackupIfDue() {
  // Sunday ~03:00 IST
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  if (nowIst.getUTCDay() !== 0 || nowIst.getUTCHours() !== 3) return;
  const stamp = nowIst.toISOString().slice(0, 13);
  if (backupState.last === stamp) return;
  backupState.last = stamp;

  const { supabaseAdmin } = await import("@/db");
  const { buildBackup, sendJsonDocument } = await import("@/lib/backup.server");
  const { data: admins } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("user_id, role")
    .eq("role", "super_admin");
  const payload = await buildBackup();
  const filename = `telemanage-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  for (const a of (admins as any[]) ?? []) {
    try {
      await sendJsonDocument(Number(a.user_id), filename, payload, "🗄 <b>Weekly automatic backup</b>");
    } catch (e) {
      console.error("weekly backup DM failed", e);
    }
  }
}

async function main() {
  try {
    await ensureSchema();
  } catch (e: any) {
    console.error("Turso schema init failed:", e?.message ?? e, e?.cause ? `(cause: ${e.cause})` : "");
  }

  app.listen(PORT, () => console.log(`listening on :${PORT}`));

  try {
    await registerWebhook();
  } catch (e: any) {
    console.error("setWebhook failed:", e?.message ?? e);
  }

  // Scheduled broadcasts + auto-deletes: every 60s
  every(60_000, "broadcast tick", async () => {
    const { tickBroadcasts } = await import("@/lib/broadcast.server");
    await tickBroadcasts();
  });
  // Recurring posts: every 60s
  every(60_000, "recurring tick", async () => {
    const mod: any = await import("@/lib/recurring.server");
    const fn = mod.tickRecurrences ?? mod.tickRecurring ?? mod.runDueRecurrences;
    if (typeof fn === "function") await fn();
  });
  // Bot permission monitor: every 6h
  every(6 * 3600_000, "permission check", async () => {
    const { runPermissionCheck } = await import("@/lib/permission-monitor.server");
    await runPermissionCheck();
  });
  // Weekly backup: checked hourly
  every(3600_000, "weekly backup", weeklyBackupIfDue);
}

main();
