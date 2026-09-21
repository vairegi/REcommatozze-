// /permissions and /checkperms commands for bot admins (DM only).
import { telegramCall } from "./telegram.server";
import { formatPermissionSummary, runPermissionCheck } from "./permission-monitor.server";
import { fmtIST } from "./broadcast.server";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function isBotAdmin(supabaseAdmin: any, fromId: number): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("user_id")
    .eq("user_id", fromId)
    .maybeSingle();
  return !!data;
}

/** Returns true if handled. */
export async function handlePermissionsCommand(args: {
  cmd: string;
  fromId: number;
  argText: string;
  chatId: number;
  chatType: string;
}): Promise<boolean> {
  const { cmd, fromId, argText, chatId, chatType } = args;
  if (cmd !== "/permissions" && cmd !== "/checkperms") return false;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if (!(await isBotAdmin(supabaseAdmin, fromId))) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Bot admins only." });
    return true;
  }
  if (chatType !== "private") {
    await telegramCall("sendMessage", { chat_id: chatId, text: "🔒 Use this in a private chat with me." });
    return true;
  }

  if (cmd === "/checkperms") {
    await telegramCall("sendMessage", { chat_id: chatId, text: "🔍 Checking permissions across all tracked chats…" });
    try {
      const res = await runPermissionCheck();
      await telegramCall("sendMessage", {
        chat_id: chatId,
        parse_mode: "HTML",
        text: `✅ Done. Checked <b>${res.checked}</b>, alerted on <b>${res.alerted}</b>, errors <b>${res.errors}</b>.`,
      });
    } catch (e: any) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ ${e?.message ?? "check failed"}` });
    }
    return true;
  }

  // /permissions [chat_id] — one chat, or a summary of all
  const rest = argText.replace(/^\/permissions(@\S+)?\s*/i, "").trim();
  if (rest) {
    const id = Number(rest);
    if (!Number.isFinite(id)) {
      await telegramCall("sendMessage", { chat_id: chatId, text: "Usage: <code>/permissions [chat_id]</code>", parse_mode: "HTML" });
      return true;
    }
    const { data: chat } = await supabaseAdmin
      .from("telegram_chats")
      .select("chat_id, title, username, bot_permissions, bot_permissions_checked_at")
      .eq("chat_id", id)
      .maybeSingle();
    if (!chat) {
      await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Chat not tracked." });
      return true;
    }
    const c = chat as any;
    const title = c.title ?? c.username ?? String(c.chat_id);
    const when = c.bot_permissions_checked_at ? fmtIST(c.bot_permissions_checked_at) : "never";
    await telegramCall("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        `🔐 <b>${escapeHtml(title)}</b>\n` +
        `Last checked: ${when}\n\n` +
        `<pre>${escapeHtml(formatPermissionSummary(c.bot_permissions))}</pre>`,
    });
    return true;
  }

  // Full summary: healthy vs degraded vs unknown
  const { data: chats } = await supabaseAdmin
    .from("telegram_chats")
    .select("chat_id, title, username, bot_permissions, bot_permissions_checked_at")
    .in("type", ["channel", "supergroup", "group"])
    .order("first_seen_at", { ascending: true });
  const rows = (chats as any[]) ?? [];
  if (!rows.length) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "No chats tracked yet." });
    return true;
  }

  const degraded: string[] = [];
  const unknown: string[] = [];
  let healthy = 0;
  for (const c of rows) {
    const title = escapeHtml(c.title ?? c.username ?? String(c.chat_id));
    const p = c.bot_permissions;
    if (!p) { unknown.push(`• ${title} (<code>${c.chat_id}</code>)`); continue; }
    if (p.error) { unknown.push(`• ${title} — ${escapeHtml(String(p.error).slice(0, 60))}`); continue; }
    const status = String(p.status ?? "unknown");
    const isAdmin = status === "administrator" || status === "creator";
    if (!isAdmin) {
      degraded.push(`• ${title} — status: ${escapeHtml(status)}`);
      continue;
    }
    const perms = p.perms ?? {};
    const missing: string[] = [];
    for (const k of ["can_post_messages", "can_edit_messages", "can_delete_messages", "can_invite_users"]) {
      if (!perms[k]) missing.push(k.replace(/^can_/, "").replace(/_/g, " "));
    }
    if (missing.length) degraded.push(`• ${title} — missing: ${missing.join(", ")}`);
    else healthy++;
  }

  const lines = [
    "🔐 <b>Permission overview</b>",
    `Total: ${rows.length}  •  ✅ healthy: ${healthy}  •  ⚠ degraded: ${degraded.length}  •  ❔ unknown: ${unknown.length}`,
  ];
  if (degraded.length) { lines.push("", "<b>⚠ Degraded</b>", ...degraded.slice(0, 40)); }
  if (unknown.length) { lines.push("", "<b>❔ Unknown / not checked</b>", ...unknown.slice(0, 20)); }
  lines.push("", "Run <code>/checkperms</code> to refresh now, or <code>/permissions &lt;chat_id&gt;</code> for detail.");

  await telegramCall("sendMessage", { chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" });
  return true;
}