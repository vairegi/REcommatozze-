// Command handlers for /recur, /recurring, /delrecur (bot admins, DM only).
import { telegramCall } from "./telegram.server";
import { parseRecurrenceSpec, nextRunAfter } from "./recurring.server";
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

/** Same ordering as /listpost (shared across all admins) so numbers line up. */
async function fetchUserBroadcasts(supabaseAdmin: any, _fromId: number) {
  const { data } = await supabaseAdmin
    .from("broadcasts")
    .select("id, source_chat_id, source_message_id, preview_text, mode, reply_markup, auto_delete_seconds, created_by, sent_at, scheduled_at, created_at, status")
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []) as any[];
}

async function fetchUserRecurrences(supabaseAdmin: any, fromId: number) {
  const { data } = await supabaseAdmin
    .from("broadcast_recurrences")
    .select("id, spec_text, active, next_run_at, last_run_at, run_count, preview_text, target_chat_ids, last_error, created_at, auto_delete_seconds")
    .eq("created_by", fromId)
    .order("created_at", { ascending: false })
    .limit(30);
  return (data ?? []) as any[];
}

const DUR_UNITS: Record<string, number> = {
  s: 1, sec: 1, secs: 1,
  m: 60, min: 60, mins: 60,
  h: 3600, hr: 3600, hrs: 3600,
  d: 86400,
};

/**
 * Extract an optional trailing auto-delete override like "in5m", "in 2h", "in5min".
 * Returns { rest, deleteSeconds }. deleteSeconds is null when not present.
 */
function extractDeleteToken(spec: string): { rest: string; deleteSeconds: number | null } {
  const m = spec.match(/\s+in\s*(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d)\s*$/i);
  if (!m) return { rest: spec, deleteSeconds: null };
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const secs = n * (DUR_UNITS[unit] ?? 0);
  if (!Number.isFinite(secs) || secs <= 0) return { rest: spec, deleteSeconds: null };
  // Hard cap 48h to match broadcast wizard.
  const capped = Math.min(secs, 48 * 3600);
  return { rest: spec.slice(0, m.index!).trimEnd(), deleteSeconds: capped };
}

function fmtDuration(secs: number): string {
  if (secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

/** Returns true if the command was handled. */
export async function handleRecurringCommand(args: {
  cmd: string;
  fromId: number;
  fromName: string;
  argText: string;
  chatId: number;
  chatType: string;
}): Promise<boolean> {
  const { cmd, fromId, fromName, argText, chatId, chatType } = args;
  const RECUR_CMDS = ["/recur", "/recurring", "/listrecur", "/delrecur", "/dltrecur", "/pauserecur", "/resumerecur"];
  if (!RECUR_CMDS.includes(cmd)) return false;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if (!(await isBotAdmin(supabaseAdmin, fromId))) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Only bot admins can use recurring commands." });
    return true;
  }
  if (chatType !== "private") {
    await telegramCall("sendMessage", { chat_id: chatId, text: "🔒 Use recurring commands in a private chat with me." });
    return true;
  }

  if (cmd === "/listrecur" || cmd === "/recurring") {
    await listRecurrences(fromId, chatId);
    return true;
  }
  if (cmd === "/dltrecur" || cmd === "/delrecur") {
    const rest = argText.replace(/^\/(dltrecur|delrecur)(@\S+)?\s*/i, "").trim();
    await deleteRecurrence(fromId, chatId, rest);
    return true;
  }
  if (cmd === "/pauserecur" || cmd === "/resumerecur") {
    const rest = argText.replace(/^\/(pauserecur|resumerecur)(@\S+)?\s*/i, "").trim();
    await setRecurrenceActive(fromId, chatId, rest, cmd === "/resumerecur");
    return true;
  }
  if (cmd === "/recur") {
    await createRecurrence(fromId, fromName, chatId, argText);
    return true;
  }
  return false;
}

const USAGE =
  "🔁 <b>Create a recurring post</b>\n\n" +
  "<code>/recur &lt;number|broadcast_id&gt; &lt;spec&gt; [in&lt;time&gt;]</code>\n\n" +
  "The number comes from /listpost. The referenced broadcast is used as the <b>template</b> (source message, target channels, buttons, mode).\n\n" +
  "<b>Spec examples</b>\n" +
  "• <code>daily 09:00</code> — every day at 09:00 IST\n" +
  "• <code>weekly mon 21:30</code> — every Monday 21:30 IST\n" +
  "• <code>monthly 1 09:00</code> — 1st of each month, 09:00 IST\n" +
  "• <code>cron 0 9 * * *</code> — advanced 5-field cron (UTC)\n\n" +
  "<b>Optional auto-delete</b> (overrides the template)\n" +
  "• <code>/recur 1 daily 09:00 in5m</code> — delete each post 5 minutes after it fires\n" +
  "• Units: <code>s</code>, <code>m</code>, <code>h</code>, <code>d</code>. Max 48h.\n\n" +
  "See existing schedules with /listrecur, remove with /dltrecur &lt;number|id&gt;.";

async function createRecurrence(fromId: number, fromName: string, chatId: number, argText: string) {
  const rest = argText.replace(/^\/recur(@\S+)?\s*/i, "").trim();
  if (!rest) {
    await telegramCall("sendMessage", { chat_id: chatId, text: USAGE, parse_mode: "HTML" });
    return;
  }
  const firstSpace = rest.indexOf(" ");
  if (firstSpace < 0) {
    await telegramCall("sendMessage", { chat_id: chatId, text: USAGE, parse_mode: "HTML" });
    return;
  }
  const idToken = rest.slice(0, firstSpace).trim();
  const specRaw = rest.slice(firstSpace + 1).trim();
  const { rest: specText, deleteSeconds: deleteOverride } = extractDeleteToken(specRaw);

  let parsed;
  try {
    parsed = parseRecurrenceSpec(specText);
  } catch (e: any) {
    await telegramCall("sendMessage", { chat_id: chatId, text: `❌ ${e?.message ?? "invalid spec"}\n\n${USAGE}`, parse_mode: "HTML" });
    return;
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Resolve idToken: positive integer → index into /listpost; otherwise treat as UUID.
  let bc: any = null;
  const asNum = Number(idToken);
  if (/^\d+$/.test(idToken) && Number.isInteger(asNum) && asNum >= 1) {
    const rows = await fetchUserBroadcasts(supabaseAdmin, fromId);
    bc = rows[asNum - 1] ?? null;
    if (!bc) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ No post #${asNum} in your /listpost.` });
      return;
    }
  } else {
    const { data } = await supabaseAdmin
      .from("broadcasts")
      .select("id, source_chat_id, source_message_id, preview_text, mode, reply_markup, auto_delete_seconds, created_by")
      .eq("id", idToken)
      .maybeSingle();
    bc = data;
  }
  if (!bc) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Broadcast not found. Use a number from /listpost or a broadcast id." });
    return;
  }
  const { data: targets } = await supabaseAdmin
    .from("broadcast_targets")
    .select("chat_id")
    .eq("broadcast_id", (bc as any).id);
  const chatIds = ((targets as any[]) ?? []).map((t) => Number(t.chat_id));
  if (!chatIds.length) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ That broadcast has no target channels." });
    return;
  }

  const finalDelete = deleteOverride ?? ((bc as any).auto_delete_seconds ?? null);

  const next = nextRunAfter(parsed.cron);
  const { data: rec, error } = await supabaseAdmin
    .from("broadcast_recurrences")
    .insert({
      created_by: fromId,
      created_by_name: fromName,
      source_chat_id: (bc as any).source_chat_id,
      source_message_id: (bc as any).source_message_id,
      preview_text: (bc as any).preview_text,
      mode: (bc as any).mode ?? "copy",
      reply_markup: (bc as any).reply_markup ?? null,
      auto_delete_seconds: finalDelete,
      target_chat_ids: chatIds,
      spec_kind: parsed.kind,
      spec_text: parsed.humanText,
      cron_expr: parsed.cron,
      next_run_at: next.toISOString(),
    })
    .select("id")
    .single();
  if (error || !rec) {
    await telegramCall("sendMessage", { chat_id: chatId, text: `❌ Failed: ${error?.message ?? "unknown"}` });
    return;
  }
  await telegramCall("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      `✅ <b>Recurring post scheduled</b>\n` +
      `ID: <code>${(rec as any).id}</code>\n` +
      `Schedule: ${escapeHtml(parsed.humanText)}\n` +
      `Targets: ${chatIds.length} channel${chatIds.length === 1 ? "" : "s"}\n` +
      (finalDelete ? `Auto-delete: ${fmtDuration(finalDelete)} after each send\n` : "") +
      `Next run: ${fmtIST(next)}`,
  });
}

async function listRecurrences(fromId: number, chatId: number) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const rows = await fetchUserRecurrences(supabaseAdmin, fromId);
  if (!rows.length) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "No recurring posts. Create one with <code>/recur &lt;number&gt; daily 09:00</code> (number from /listpost).",
    });
    return;
  }
  const lines = ["🔁 <b>Your recurring posts</b>\n"];
  rows.forEach((r, i) => {
    const targets = (r.target_chat_ids ?? []).length;
    const state = r.active ? "✅" : "⏸";
    const preview = escapeHtml((r.preview_text ?? "").slice(0, 60));
    const del = r.auto_delete_seconds ? ` • del ${fmtDuration(r.auto_delete_seconds)}` : "";
    lines.push(
      `<b>${i + 1}.</b> ${state} <code>${r.id}</code>\n` +
      `   ${escapeHtml(r.spec_text)} • ${targets} chat${targets === 1 ? "" : "s"} • ran ${r.run_count}×${del}\n` +
      `   next: ${fmtIST(r.next_run_at)}${r.last_run_at ? ` • last: ${fmtIST(r.last_run_at)}` : ""}\n` +
      (preview ? `   <i>${preview}</i>\n` : "") +
      (r.last_error ? `   ⚠ ${escapeHtml(String(r.last_error).slice(0, 100))}\n` : ""),
    );
  });
  lines.push("\nRemove with <code>/dltrecur &lt;number&gt;</code>.");
  await telegramCall("sendMessage", { chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" });
}

async function deleteRecurrence(fromId: number, chatId: number, token: string) {
  if (!token) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "Usage: <code>/dltrecur &lt;number|id&gt;</code> (number from /listrecur)", parse_mode: "HTML" });
    return;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let id = token;
  if (/^\d+$/.test(token)) {
    const rows = await fetchUserRecurrences(supabaseAdmin, fromId);
    const rec = rows[Number(token) - 1];
    if (!rec) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ No recurring #${token} in your list. Run /listrecur.` });
      return;
    }
    id = rec.id;
  }
  const { error, count } = await supabaseAdmin
    .from("broadcast_recurrences")
    .delete({ count: "exact" })
    .eq("id", id)
    .eq("created_by", fromId);
  if (error) {
    await telegramCall("sendMessage", { chat_id: chatId, text: `❌ ${error.message}` });
    return;
  }
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text: count ? "✅ Recurring post removed." : "❌ Not found (or not yours).",
  });
}

async function setRecurrenceActive(fromId: number, chatId: number, token: string, active: boolean) {
  const verb = active ? "resume" : "pause";
  if (!token) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `Usage: <code>/${verb}recur &lt;number|id&gt;</code> (number from /listrecur)`,
    });
    return;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let id = token;
  if (/^\d+$/.test(token)) {
    const rows = await fetchUserRecurrences(supabaseAdmin, fromId);
    const rec = rows[Number(token) - 1];
    if (!rec) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ No recurring #${token} in your list. Run /listrecur.` });
      return;
    }
    id = rec.id;
  }

  const update: { active: boolean; next_run_at?: string } = { active };
  // On resume, recompute next_run_at so it doesn't fire immediately for every missed slot.
  if (active) {
    const { data: cur } = await supabaseAdmin
      .from("broadcast_recurrences")
      .select("cron_expr")
      .eq("id", id)
      .eq("created_by", fromId)
      .maybeSingle();
    if ((cur as any)?.cron_expr) {
      try { update.next_run_at = nextRunAfter((cur as any).cron_expr).toISOString(); } catch { /* keep existing */ }
    }
  }

  const { data, error } = await supabaseAdmin
    .from("broadcast_recurrences")
    .update(update)
    .eq("id", id)
    .eq("created_by", fromId)
    .select("id, spec_text, next_run_at")
    .maybeSingle();
  if (error) {
    await telegramCall("sendMessage", { chat_id: chatId, text: `❌ ${error.message}` });
    return;
  }
  if (!data) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Not found (or not yours)." });
    return;
  }
  const r = data as any;
  await telegramCall("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text: active
      ? `▶️ <b>Resumed</b> — ${escapeHtml(r.spec_text)}\nNext run: ${fmtIST(r.next_run_at)}`
      : `⏸ <b>Paused</b> — ${escapeHtml(r.spec_text)}\nUse <code>/resumerecur ${token}</code> to re-enable.`,
  });
}