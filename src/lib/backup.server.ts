// Server-only: full app-data backup + restore via Telegram.
// Reads every app table (skipping `auth.*` and heavy raw update logs),
// sends the JSON as a document to the requesting super admin,
// and restores from an uploaded JSON via upsert.

const TABLES_FULL = [
  "profiles",
  "user_roles",
  "telegram_bot_admins",
  "telegram_chats",
  "telegram_members",
  "moderation_actions",
  "broadcasts",
  "broadcast_targets",
  "broadcast_drafts",
  "broadcast_templates",
  "chat_lists",
] as const;

// Messages table can grow large — cap to most recent N rows.
const MESSAGES_LIMIT = 10_000;

// Primary key(s) used when restoring via upsert.
const RESTORE_CONFLICT: Record<string, string> = {
  profiles: "id",
  user_roles: "id",
  telegram_bot_admins: "user_id",
  telegram_chats: "chat_id",
  telegram_members: "chat_id,user_id",
  moderation_actions: "id",
  broadcasts: "id",
  broadcast_targets: "id",
  broadcast_drafts: "user_id",
  broadcast_templates: "user_id,name",
  chat_lists: "list_name,chat_id",
  telegram_messages: "update_id",
};

export type BackupPayload = {
  version: 1;
  generated_at: string;
  project: string;
  tables: Record<string, unknown[]>;
  meta: { row_counts: Record<string, number>; notes: string[] };
};

export async function buildBackup(): Promise<BackupPayload> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const tables: Record<string, unknown[]> = {};
  const row_counts: Record<string, number> = {};
  const notes: string[] = [];

  for (const t of TABLES_FULL) {
    const { data, error } = await supabaseAdmin.from(t).select("*");
    if (error) {
      notes.push(`${t}: ${error.message}`);
      tables[t] = [];
      row_counts[t] = 0;
      continue;
    }
    tables[t] = data ?? [];
    row_counts[t] = data?.length ?? 0;
  }

  // Recent messages only.
  const { data: msgs, error: msgErr } = await supabaseAdmin
    .from("telegram_messages")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(MESSAGES_LIMIT);
  if (msgErr) {
    notes.push(`telegram_messages: ${msgErr.message}`);
    tables.telegram_messages = [];
    row_counts.telegram_messages = 0;
  } else {
    tables.telegram_messages = msgs ?? [];
    row_counts.telegram_messages = msgs?.length ?? 0;
    if ((msgs?.length ?? 0) === MESSAGES_LIMIT) {
      notes.push(`telegram_messages truncated to most recent ${MESSAGES_LIMIT}`);
    }
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    project: process.env.SUPABASE_PROJECT_ID ?? "unknown",
    tables,
    meta: { row_counts, notes },
  };
}

/** Send a JSON payload as a Telegram document via the connector gateway. */
export async function sendJsonDocument(chatId: number, filename: string, payload: unknown, caption?: string) {

  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: "application/json" });

  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("document", blob, filename);
  if (caption) {
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
  }

  const { apiBase } = await import("@/lib/telegram.server");
  const res = await fetch(`${apiBase()}/sendDocument`, { method: "POST", body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`sendDocument failed [${res.status}]: ${text}`);
  const parsed = JSON.parse(text);
  if (parsed.ok === false) throw new Error(`sendDocument error: ${parsed.description ?? text}`);
  return parsed.result;
}

/** Download a Telegram file by file_id via the connector gateway. */
export async function downloadTelegramFile(fileId: string): Promise<ArrayBuffer> {
  const { telegramCall, fileBase } = await import("@/lib/telegram.server");
  const info = await telegramCall("getFile", { file_id: fileId });
  const filePath = info?.file_path;
  if (!filePath) throw new Error("getFile returned no file_path");
  const res = await fetch(`${fileBase()}/${filePath}`);
  if (!res.ok) throw new Error(`file download failed [${res.status}]`);
  return await res.arrayBuffer();
}

export async function restoreFromPayload(payload: BackupPayload): Promise<{
  restored: Record<string, number>;
  errors: Record<string, string>;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const restored: Record<string, number> = {};
  const errors: Record<string, string> = {};

  // Restore in an order that respects FK-ish dependencies.
  const order = [
    "profiles",
    "user_roles",
    "telegram_bot_admins",
    "telegram_chats",
    "chat_lists",
    "telegram_members",
    "moderation_actions",
    "broadcast_templates",
    "broadcast_drafts",
    "broadcasts",
    "broadcast_targets",
    "telegram_messages",
  ];

  for (const t of order) {
    const rows = (payload.tables?.[t] as any[]) ?? [];
    if (!rows.length) {
      restored[t] = 0;
      continue;
    }
    const conflict = RESTORE_CONFLICT[t];
    const chunkSize = 500;
    let count = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await (supabaseAdmin.from(t as any) as any).upsert(
        chunk,
        conflict ? { onConflict: conflict } : undefined,
      );
      if (error) {
        errors[t] = error.message;
        break;
      }
      count += chunk.length;
    }
    restored[t] = count;
  }
  return { restored, errors };
}