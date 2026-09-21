// Server-only: periodic bot-permission check across every tracked chat.
// Alerts bot admins when the bot's admin permissions drop or when it lost
// admin status entirely.
import { telegramCall, getBotIdentity } from "./telegram.server";

// Permissions we care about, in a stable display order.
const KEY_PERMS = [
  "can_post_messages",
  "can_edit_messages",
  "can_delete_messages",
  "can_invite_users",
  "can_restrict_members",
  "can_promote_members",
  "can_manage_chat",
  "can_change_info",
  "can_pin_messages",
] as const;
type Perm = typeof KEY_PERMS[number];

interface Snapshot {
  status: string;               // "administrator" | "member" | "left" | "kicked" | "creator" | ...
  perms: Partial<Record<Perm, boolean>>;
}

function extractSnapshot(m: any): Snapshot {
  const status = String(m?.status ?? "unknown");
  const perms: Partial<Record<Perm, boolean>> = {};
  for (const k of KEY_PERMS) perms[k] = Boolean(m?.[k]);
  return { status, perms };
}

function diffPerms(prev: Snapshot | null, curr: Snapshot): { lost: Perm[]; gained: Perm[]; statusChanged: boolean } {
  if (!prev) return { lost: [], gained: [], statusChanged: false };
  const lost: Perm[] = [];
  const gained: Perm[] = [];
  for (const k of KEY_PERMS) {
    const p = Boolean(prev.perms?.[k]);
    const c = Boolean(curr.perms?.[k]);
    if (p && !c) lost.push(k);
    if (!p && c) gained.push(k);
  }
  return { lost, gained, statusChanged: prev.status !== curr.status };
}

function permLabel(p: Perm): string {
  return p.replace(/^can_/, "").replace(/_/g, " ");
}

/** Check every tracked chat, persist a snapshot, and DM admins on regressions. */
export async function runPermissionCheck(): Promise<{ checked: number; alerted: number; errors: number }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const bot = await getBotIdentity();

  const { data: chats } = await supabaseAdmin
    .from("telegram_chats")
    .select("chat_id, title, username, bot_permissions")
    .in("type", ["channel", "supergroup", "group"]);

  const { data: admins } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("user_id");
  const adminIds = ((admins as any[]) ?? []).map((a) => Number(a.user_id));

  const nowIso = new Date().toISOString();
  let checked = 0;
  let alerted = 0;
  let errors = 0;

  for (const c of (chats as any[]) ?? []) {
    let member: any;
    try {
      member = await telegramCall("getChatMember", { chat_id: c.chat_id, user_id: bot.id });
    } catch (e: any) {
      errors++;
      // Persist error state so the dashboard can show it, but don't spam admins.
      await supabaseAdmin
        .from("telegram_chats")
        .update({
          bot_permissions: { error: (e?.message ?? String(e)).slice(0, 200), status: "unknown" },
          bot_permissions_checked_at: nowIso,
        })
        .eq("chat_id", c.chat_id);
      continue;
    }

    const curr = extractSnapshot(member);
    const prev = (c.bot_permissions ?? null) as Snapshot | null;
    const diff = diffPerms(prev, curr);

    await supabaseAdmin
      .from("telegram_chats")
      .update({
        bot_permissions: curr as any,
        bot_permissions_checked_at: nowIso,
      })
      .eq("chat_id", c.chat_id);

    checked++;

    // Alert if we lost permissions OR status regressed away from admin/creator.
    const wasAdmin = prev && (prev.status === "administrator" || prev.status === "creator");
    const isAdmin = curr.status === "administrator" || curr.status === "creator";
    const regressed = wasAdmin && !isAdmin;
    if (prev && (diff.lost.length > 0 || regressed)) {
      const title = (c.title ?? c.username ?? String(c.chat_id)) as string;
      const lines = [
        `⚠️ <b>Bot permission changed</b>`,
        `Chat: <b>${escapeHtml(title)}</b> (<code>${c.chat_id}</code>)`,
        `Status: <b>${escapeHtml(prev.status)}</b> → <b>${escapeHtml(curr.status)}</b>`,
      ];
      if (diff.lost.length) {
        lines.push(`Lost: ${diff.lost.map((p) => `<code>${permLabel(p)}</code>`).join(", ")}`);
      }
      const msg = lines.join("\n");
      for (const uid of adminIds) {
        try {
          await telegramCall("sendMessage", { chat_id: uid, text: msg, parse_mode: "HTML" });
        } catch { /* ignore per-admin failure */ }
      }
      alerted++;
    }
  }

  return { checked, alerted, errors };
}

/** Human-readable summary of a chat's current permission snapshot. */
export function formatPermissionSummary(snapshot: any): string {
  if (!snapshot) return "not checked yet";
  if (snapshot.error) return `error: ${snapshot.error}`;
  const status = String(snapshot.status ?? "unknown");
  const perms = (snapshot.perms ?? {}) as Record<string, boolean>;
  const on = KEY_PERMS.filter((p) => perms[p]);
  const off = KEY_PERMS.filter((p) => !perms[p]);
  const lines = [`status: ${status}`];
  if (on.length) lines.push(`✅ ${on.map(permLabel).join(", ")}`);
  if (off.length) lines.push(`❌ ${off.map(permLabel).join(", ")}`);
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}