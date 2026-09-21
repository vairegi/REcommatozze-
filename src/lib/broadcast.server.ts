// Server-only broadcast helpers: timing parser (IST), sender, deleter.
import { telegramCall, buildMessageLink } from "./telegram.server";

const IST_OFFSET_MIN = 330; // +05:30

// ================== Inline button parsing ==================

export type InlineButton = { text: string; url: string };
export type InlineKeyboard = InlineButton[][];

/**
 * Parse a user-authored button spec into a Telegram inline_keyboard.
 * - Newlines separate rows
 * - `|` splits buttons within a row
 * - Each button is `Label - https://url` (first ` - ` separates)
 * Blank lines and lines starting with `#` are ignored.
 * Returns null with an error message string via thrown Error on invalid input.
 */
export function parseButtonSpec(input: string): InlineKeyboard {
  const rows: InlineKeyboard = [];
  const lines = input.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    const row: InlineButton[] = [];
    for (const cell of cells) {
      const idx = cell.search(/\s-\s|\s—\s/);
      if (idx < 0) throw new Error(`Bad button "${cell}" — use "Label - https://url"`);
      const label = cell.slice(0, idx).trim();
      const url = cell.slice(idx + 3).trim();
      if (!label) throw new Error(`Empty label in "${cell}"`);
      if (!/^https?:\/\/|^tg:\/\//i.test(url)) throw new Error(`Invalid URL "${url}" — must start with http(s):// or tg://`);
      if (label.length > 64) throw new Error(`Label too long (max 64): "${label}"`);
      row.push({ text: label, url });
    }
    if (row.length) rows.push(row);
  }
  if (!rows.length) throw new Error("No buttons found.");
  if (rows.length > 10) throw new Error("Too many rows (max 10).");
  for (const r of rows) if (r.length > 8) throw new Error("Too many buttons in a row (max 8).");
  return rows;
}

export function keyboardPreview(kb: InlineKeyboard): string {
  return kb.map((row) => row.map((b) => `[${b.text}]`).join(" ")).join("\n");
}

/** Return current time as a Date represented in IST wall-clock via component math. */
function nowIST(): Date {
  const now = new Date();
  return new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
}

/** Convert an IST wall-clock Date (year/mo/day/hh/mm interpreted as IST) back to a UTC Date. */
function istWallClockToUtc(y: number, mo: number, d: number, h: number, mi: number): Date {
  // Build as if UTC, then subtract IST offset to get real UTC.
  const asUtc = Date.UTC(y, mo, d, h, mi, 0);
  return new Date(asUtc - IST_OFFSET_MIN * 60_000);
}

/**
 * Parse a relative or absolute schedule string in IST.
 * Supported:
 *   "in 5m", "in 2h", "in 2h 5m", "in 1d 3h"
 *   "tomorrow 9am", "tomorrow 15:30", "tomorrow 9:00 pm"
 *   "today 8pm"
 *   "25 jul 18:30", "25 jul 6:30 pm"
 *   "18:30" (today or tomorrow if already past)
 */
export function parseScheduleIST(input: string): Date | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  // "in <n>d <n>h <n>m <n>s"
  const rel = s.match(/^in\s+(.+)$/);
  if (rel) {
    let total = 0;
    let matched = false;
    const re = /(\d+)\s*(d|h|m|min|mins|s|sec|secs|hr|hrs|day|days|hour|hours|minute|minutes)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rel[1])) !== null) {
      matched = true;
      const n = parseInt(m[1], 10);
      const u = m[2];
      if (u.startsWith("d")) total += n * 86400;
      else if (u.startsWith("h")) total += n * 3600;
      else if (u.startsWith("s")) total += n;
      else total += n * 60; // minutes default
    }
    if (!matched) return null;
    return new Date(Date.now() + total * 1000);
  }

  // day keyword
  let dayOffset: number | null = null;
  let rest = s;
  if (s.startsWith("today")) { dayOffset = 0; rest = s.slice(5).trim(); }
  else if (s.startsWith("tomorrow") || s.startsWith("tmrw")) {
    dayOffset = 1;
    rest = s.replace(/^(tomorrow|tmrw)/, "").trim();
  }

  const timeParsed = parseTimeToken(rest);
  if (dayOffset !== null) {
    if (!timeParsed) return null;
    const ist = nowIST();
    return istWallClockToUtc(
      ist.getUTCFullYear(),
      ist.getUTCMonth(),
      ist.getUTCDate() + dayOffset,
      timeParsed.h,
      timeParsed.mi,
    );
  }

  // "<day> <month> [year] <time>"
  const dateRe = /^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?\s+(.+)$/;
  const dm = s.match(dateRe);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const mo = MONTHS[dm[2].slice(0, 3)];
    if (mo === undefined) return null;
    const year = dm[3] ? parseInt(dm[3], 10) : nowIST().getUTCFullYear();
    const t = parseTimeToken(dm[4]);
    if (!t) return null;
    return istWallClockToUtc(year, mo, day, t.h, t.mi);
  }

  // Bare time: today; if past, tomorrow.
  const t = parseTimeToken(s);
  if (t) {
    const ist = nowIST();
    let candidate = istWallClockToUtc(
      ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), t.h, t.mi,
    );
    if (candidate.getTime() <= Date.now()) {
      candidate = istWallClockToUtc(
        ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, t.h, t.mi,
      );
    }
    return candidate;
  }

  return null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseTimeToken(str: string): { h: number; mi: number } | null {
  const s = str.trim();
  if (!s) return null;
  // 24h: HH:MM or H:MM
  let m = s.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    const ap = m[3];
    if (ap) {
      if (h < 1 || h > 12) return null;
      if (ap === "pm" && h !== 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
    }
    if (h > 23 || mi > 59) return null;
    return { h, mi };
  }
  // "9am", "9 pm", "12am"
  m = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = parseInt(m[1], 10);
    const ap = m[2];
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return { h, mi: 0 };
  }
  return null;
}

/** Parse an auto-delete duration: "30m", "1h", "6h", "24h", "48h", "2h 30m". Cap 48h. */
export function parseAutoDeleteSeconds(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === "no" || s === "none" || s === "off") return 0;
  let total = 0;
  const re = /(\d+)\s*(d|h|m|min|mins|hr|hrs|day|days|hour|hours|minute|minutes)/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseInt(m[1], 10);
    const u = m[2];
    if (u.startsWith("d")) total += n * 86400;
    else if (u.startsWith("h")) total += n * 3600;
    else total += n * 60;
  }
  if (!matched) return null;
  if (total > 172800) return null;
  if (total <= 0) return null;
  return total;
}

/** Format a Date in IST for display. */
export function fmtIST(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  const ist = new Date(date.getTime() + IST_OFFSET_MIN * 60_000);
  const y = ist.getUTCFullYear();
  const mo = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const da = String(ist.getUTCDate()).padStart(2, "0");
  const h = String(ist.getUTCHours()).padStart(2, "0");
  const mi = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${h}:${mi} IST`;
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Delete every delivered message of a broadcast across all target channels.
 * Called by /nuke after super-admin confirmation.
 */
export async function runNuke(args: { broadcastId: string; fromId: number }): Promise<{ deleted: number; failed: number }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Verify caller is super admin.
  const { data: admin } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("role")
    .eq("user_id", args.fromId)
    .maybeSingle();
  if (!admin || (admin as any).role !== "super_admin") {
    throw new Error("only super admins can nuke");
  }

  const { data: bc } = await supabaseAdmin
    .from("broadcasts")
    .select("id")
    .eq("id", args.broadcastId)
    .maybeSingle();
  if (!bc) throw new Error("broadcast not found");

  const { data: targets } = await supabaseAdmin
    .from("broadcast_targets")
    .select("id, chat_id, sent_message_id, sent_message_ids, status")
    .eq("broadcast_id", args.broadcastId)
    .not("sent_message_id", "is", null)
    .neq("status", "deleted");

  let deleted = 0;
  let failed = 0;
  for (const t of (targets as any[]) ?? []) {
    try {
      const ids = (t.sent_message_ids?.length ? t.sent_message_ids : [t.sent_message_id]).map(Number);
      await deleteTargetMessages(t.chat_id, ids);
      await supabaseAdmin
        .from("broadcast_targets")
        .update({ status: "deleted", deleted_at: new Date().toISOString(), delete_at: null })
        .eq("id", t.id);
      deleted++;
    } catch (e: any) {
      await supabaseAdmin
        .from("broadcast_targets")
        .update({ status: "delete_failed", error: e?.message ?? String(e) })
        .eq("id", t.id);
      failed++;
    }
  }
  return { deleted, failed };
}

export interface SendResultTarget {
  chat_id: number;
  chat_title?: string | null;
  username?: string | null;
  ok: boolean;
  error?: string;
  message_id?: number;
  link?: string | null;
}

/** Sends are issued in small parallel waves so 50+ channel broadcasts finish fast
 *  while staying well under Telegram's ~30 msg/s ceiling. */
const WAVE_SIZE = 5;
const WAVE_GAP_MS = 900;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Telegram does not allow an inline keyboard on a media group (album).
 * To still get buttons under a multi-image post we send a tiny companion
 * message replying to the album that carries the keyboard. Its message id is
 * tracked with the album so auto-delete / nuke removes it too.
 */
export async function sendAlbumButtons(
  chatId: number,
  replyMarkup: any,
  replyToMessageId?: number,
): Promise<number | null> {
  const base: Record<string, any> = {
    chat_id: chatId,
    reply_markup: replyMarkup,
    disable_notification: true,
  };
  if (replyToMessageId) base.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };
  try {
    const res = await telegramCall("sendMessage", { ...base, text: "\u2063" });
    return res?.message_id ?? null;
  } catch {
    try {
      const res = await telegramCall("sendMessage", { ...base, text: "👇" });
      return res?.message_id ?? null;
    } catch {
      return null;
    }
  }
}

/** Delete one target's message(s), handling albums (multiple message ids). */
export async function deleteTargetMessages(chatId: number, ids: number[]): Promise<void> {
  const clean = ids.map(Number).filter(Boolean);
  if (!clean.length) throw new Error("no message_id");
  if (clean.length === 1) {
    await telegramCall("deleteMessage", { chat_id: chatId, message_id: clean[0] });
    return;
  }
  await telegramCall("deleteMessages", { chat_id: chatId, message_ids: clean });
}

/** Copy the source message to every target chat. */
export async function executeBroadcast(broadcastId: string): Promise<{
  targets: SendResultTarget[];
  status: "sent" | "partial" | "failed";
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: bc, error: bcErr } = await supabaseAdmin
    .from("broadcasts")
    .select("id, source_chat_id, source_message_id, source_message_ids, auto_delete_seconds, status, mode, reply_markup")
    .eq("id", broadcastId)
    .maybeSingle();
  if (bcErr || !bc) throw new Error(`broadcast not found: ${broadcastId}`);
  if (bc.status !== "pending") {
    throw new Error(`broadcast ${broadcastId} status is ${bc.status}, not pending`);
  }

  await supabaseAdmin.from("broadcasts").update({ status: "sending" }).eq("id", broadcastId);

  const { data: targets } = await supabaseAdmin
    .from("broadcast_targets")
    .select("id, chat_id, chat_title")
    .eq("broadcast_id", broadcastId)
    .eq("status", "pending");

  // Preload usernames so we can build t.me links for delivery reports.
  const chatIds = (targets ?? []).map((t: any) => t.chat_id);
  const { data: chatMeta } = chatIds.length
    ? await supabaseAdmin
        .from("telegram_chats")
        .select("chat_id, username, title")
        .in("chat_id", chatIds)
    : { data: [] as any[] };
  const metaMap = new Map<number, { username: string | null; title: string | null }>();
  for (const c of (chatMeta as any[]) ?? []) {
    metaMap.set(Number(c.chat_id), { username: c.username ?? null, title: c.title ?? null });
  }

  const method = (bc as any).mode === "forward" ? "forwardMessage" : "copyMessage";
  const replyMarkup = (bc as any).reply_markup ?? null;
  // forwardMessage doesn't accept reply_markup — force copy when buttons are attached
  const effectiveMethod = replyMarkup ? "copyMessage" : method;

  const results: SendResultTarget[] = [];
  const nowMs = Date.now();
  const albumIds: number[] = ((bc as any).source_message_ids ?? []).map(Number).filter(Boolean);
  const isAlbum = albumIds.length > 1;
  const list = targets ?? [];
  const sendOne = async (t: any) => {
    try {
      let mid: number | undefined;
      let mids: number[] | null = null;
      if (isAlbum) {
        // Albums must be copied as a group; Telegram rejects reply_markup here,
        // so buttons ride on a companion message replying to the album.
        const res = await telegramCall("copyMessages", {
          chat_id: t.chat_id,
          from_chat_id: bc.source_chat_id,
          message_ids: albumIds,
        });
        mids = Array.isArray(res) ? res.map((m: any) => Number(m.message_id)).filter(Boolean) : null;
        mid = mids?.[0];
        if (replyMarkup && mid) {
          const btnId = await sendAlbumButtons(t.chat_id, replyMarkup, mid);
          if (btnId) mids = [...(mids ?? []), btnId];
        }
      } else {
        const payload: Record<string, any> = {
          chat_id: t.chat_id,
          from_chat_id: bc.source_chat_id,
          message_id: bc.source_message_id,
        };
        if (replyMarkup) payload.reply_markup = replyMarkup;
        const res = await telegramCall(effectiveMethod, payload);
        mid = res?.message_id as number | undefined;
      }
      const deleteAt = bc.auto_delete_seconds
        ? new Date(nowMs + bc.auto_delete_seconds * 1000).toISOString()
        : null;
      await supabaseAdmin
        .from("broadcast_targets")
        .update({
          status: "sent",
          sent_message_id: mid ?? null,
          sent_message_ids: mids,
          delete_at: deleteAt,
          error: null,
        })
        .eq("id", t.id);
      const meta = metaMap.get(Number(t.chat_id));
      results.push({
        chat_id: t.chat_id,
        chat_title: t.chat_title ?? meta?.title ?? null,
        username: meta?.username ?? null,
        ok: true,
        message_id: mid,
        link: mid ? buildMessageLink({ chatId: t.chat_id, messageId: mid, username: meta?.username }) : null,
      });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      await supabaseAdmin
        .from("broadcast_targets")
        .update({ status: "failed", error: msg })
        .eq("id", t.id);
      const meta = metaMap.get(Number(t.chat_id));
      results.push({
        chat_id: t.chat_id,
        chat_title: t.chat_title ?? meta?.title ?? null,
        username: meta?.username ?? null,
        ok: false,
        error: msg,
      });
    }
  };

  // Send in small parallel waves: 50+ channels finish in seconds instead of
  // minutes, while the wave size + gap keeps us far below Telegram's limits.
  for (let i = 0; i < list.length; i += WAVE_SIZE) {
    if (i > 0) await sleep(WAVE_GAP_MS);
    await Promise.all(list.slice(i, i + WAVE_SIZE).map((t: any) => sendOne(t)));
  }

  const okCount = results.filter((r) => r.ok).length;
  const status: "sent" | "partial" | "failed" =
    okCount === results.length ? "sent" : okCount === 0 ? "failed" : "partial";

  await supabaseAdmin
    .from("broadcasts")
    .update({ status, sent_at: new Date().toISOString() })
    .eq("id", broadcastId);

  return { targets: results, status };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build a per-channel ✅/❌ delivery report with message links. */
export function formatDeliveryReport(
  results: SendResultTarget[],
  status: "sent" | "partial" | "failed",
): string {
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const headline =
    status === "sent"
      ? "📣 <b>Broadcast delivered</b>"
      : status === "partial"
        ? "📣 <b>Broadcast partially delivered</b>"
        : "📣 <b>Broadcast failed</b>";
  const lines = [headline, `✅ ${ok} delivered${fail ? `   ❌ ${fail} failed` : ""}`, ""];
  for (const r of results) {
    const title = escapeHtml(r.chat_title ?? String(r.chat_id));
    if (r.ok) {
      const link = r.link ? ` — <a href="${r.link}">open</a>` : "";
      lines.push(`✅ ${title}${link}`);
    } else {
      const err = r.error ? ` — ${escapeHtml(r.error.slice(0, 100))}` : "";
      lines.push(`❌ ${title}${err}`);
    }
  }
  return lines.join("\n");
}

export interface EditResultTarget {
  chat_id: number;
  chat_title?: string | null;
  username?: string | null;
  ok: boolean;
  error?: string;
  link?: string | null;
}

/**
 * Edit every already-delivered target of a broadcast, replacing its content
 * with the content of `newSource`. Supported new content shapes: text,
 * photo, video, animation, document, audio. Per-target failures are recorded
 * and reported but never abort the loop.
 */
export async function runEditBroadcast(args: {
  broadcastId: string;
  fromId: number;
  newSource: any; // Telegram Message object the admin sent in DM
}): Promise<{ targets: EditResultTarget[]; okCount: number; failCount: number }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: bc } = await supabaseAdmin
    .from("broadcasts")
    .select("id, created_by")
    .eq("id", args.broadcastId)
    .maybeSingle();
  if (!bc) throw new Error("broadcast not found");
  if ((bc as any).created_by !== args.fromId) {
    // Allow super admin to edit anyone's broadcast.
    const { data: admin } = await supabaseAdmin
      .from("telegram_bot_admins")
      .select("role")
      .eq("user_id", args.fromId)
      .maybeSingle();
    if (!admin || (admin as any).role !== "super_admin") {
      throw new Error("only the creator or a super admin can edit this broadcast");
    }
  }

  const { data: targets } = await supabaseAdmin
    .from("broadcast_targets")
    .select("id, chat_id, chat_title, sent_message_id, status")
    .eq("broadcast_id", args.broadcastId)
    .not("sent_message_id", "is", null)
    .in("status", ["sent", "delete_failed"]);

  const chatIds = (targets ?? []).map((t: any) => t.chat_id);
  const { data: chatMeta } = chatIds.length
    ? await supabaseAdmin
        .from("telegram_chats")
        .select("chat_id, username, title")
        .in("chat_id", chatIds)
    : { data: [] as any[] };
  const metaMap = new Map<number, { username: string | null; title: string | null }>();
  for (const c of (chatMeta as any[]) ?? []) {
    metaMap.set(Number(c.chat_id), { username: c.username ?? null, title: c.title ?? null });
  }

  const src = args.newSource ?? {};
  const results: EditResultTarget[] = [];

  for (const t of (targets as any[]) ?? []) {
    const meta = metaMap.get(Number(t.chat_id));
    const base = {
      chat_id: t.chat_id as number,
      chat_title: (t.chat_title ?? meta?.title ?? null) as string | null,
      username: meta?.username ?? null,
      link: buildMessageLink({ chatId: t.chat_id, messageId: t.sent_message_id, username: meta?.username }),
    };
    try {
      if (src.text) {
        await telegramCall("editMessageText", {
          chat_id: t.chat_id,
          message_id: t.sent_message_id,
          text: src.text,
          entities: src.entities,
          disable_web_page_preview: false,
        });
      } else {
        const media = buildInputMedia(src);
        if (!media) throw new Error("unsupported content type — send text, photo, video, animation, document, or audio");
        await telegramCall("editMessageMedia", {
          chat_id: t.chat_id,
          message_id: t.sent_message_id,
          media,
        });
      }
      results.push({ ...base, ok: true });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      // Persist the last edit error on the target for visibility.
      await supabaseAdmin
        .from("broadcast_targets")
        .update({ error: `edit failed: ${msg}` })
        .eq("id", t.id);
      results.push({ ...base, ok: false, error: msg });
    }
  }

  // Update the source pointer + preview so /broadcasts reflects the new content,
  // and future /nuke / re-edits target the right message ids (target ids don't change).
  const newPreview = previewOfSource(src);
  await supabaseAdmin
    .from("broadcasts")
    .update({
      source_chat_id: src.chat?.id ?? undefined,
      source_message_id: src.message_id ?? undefined,
      preview_text: newPreview,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.broadcastId);

  const okCount = results.filter((r) => r.ok).length;
  return { targets: results, okCount, failCount: results.length - okCount };
}

function firstFileId(arr: any): string | null {
  if (!Array.isArray(arr) || !arr.length) return null;
  // Photo array is smallest→largest; pick largest for best quality edit.
  const last = arr[arr.length - 1];
  return last?.file_id ?? null;
}

function buildInputMedia(src: any): any | null {
  const caption = src.caption;
  const caption_entities = src.caption_entities;
  if (src.photo) {
    const file_id = firstFileId(src.photo);
    if (!file_id) return null;
    return { type: "photo", media: file_id, caption, caption_entities };
  }
  if (src.video) {
    return { type: "video", media: src.video.file_id, caption, caption_entities };
  }
  if (src.animation) {
    return { type: "animation", media: src.animation.file_id, caption, caption_entities };
  }
  if (src.document) {
    return { type: "document", media: src.document.file_id, caption, caption_entities };
  }
  if (src.audio) {
    return { type: "audio", media: src.audio.file_id, caption, caption_entities };
  }
  return null;
}

function previewOfSource(m: any): string {
  if (!m) return "[message]";
  if (m.text) return String(m.text).slice(0, 120);
  if (m.caption) return `[media] ${String(m.caption).slice(0, 100)}`;
  if (m.photo) return "[photo]";
  if (m.video) return "[video]";
  if (m.document) return `[document] ${m.document.file_name ?? ""}`;
  if (m.animation) return "[gif]";
  if (m.audio) return "[audio]";
  return "[message]";
}

export function formatEditReport(res: { targets: EditResultTarget[]; okCount: number; failCount: number }): string {
  const headline = res.failCount === 0
    ? "✏️ <b>Edit applied to all targets</b>"
    : res.okCount === 0
      ? "✏️ <b>Edit failed on all targets</b>"
      : "✏️ <b>Edit partially applied</b>";
  const lines = [headline, `✅ ${res.okCount} updated${res.failCount ? `   ❌ ${res.failCount} failed` : ""}`, ""];
  for (const r of res.targets) {
    const title = (r.chat_title ?? String(r.chat_id))
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (r.ok) {
      const link = r.link ? ` — <a href="${r.link}">open</a>` : "";
      lines.push(`✅ ${title}${link}`);
    } else {
      const err = r.error ? ` — ${r.error.slice(0, 120).replace(/&/g, "&amp;").replace(/</g, "&lt;")}` : "";
      lines.push(`❌ ${title}${err}`);
    }
  }
  return lines.join("\n");
}

/** Run pending scheduled broadcasts and pending auto-deletes. */
export async function tickBroadcasts(): Promise<{
  sent: number;
  deleted: number;
  deleteFailed: number;
  recurringFired: number;
  recurringFailed: number;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nowIso = new Date().toISOString();

  // 1) send due broadcasts
  const { data: due } = await supabaseAdmin
    .from("broadcasts")
    .select("id, created_by")
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .not("scheduled_at", "is", null)
    .limit(20);

  let sent = 0;
  for (const b of due ?? []) {
    try {
      const res = await executeBroadcast(b.id);
      sent++;
      // notify creator DM
      try {
        await telegramCall("sendMessage", {
          chat_id: b.created_by,
          text: formatDeliveryReport(res.targets, res.status),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      } catch { /* ignore */ }
    } catch (e) {
      console.error("scheduled broadcast failed", b.id, e);
      await supabaseAdmin
        .from("broadcasts")
        .update({ status: "failed" })
        .eq("id", b.id);
    }
  }

  // 2) auto-delete
  const { data: toDelete } = await supabaseAdmin
    .from("broadcast_targets")
    .select("id, broadcast_id, chat_id, chat_title, sent_message_id, sent_message_ids")
    .eq("status", "sent")
    .not("delete_at", "is", null)
    .lte("delete_at", nowIso)
    .limit(100);

  let deleted = 0;
  let deleteFailed = 0;
  // Group per-broadcast results so we can DM the creator one summary per broadcast.
  const perBroadcast = new Map<string, Array<{ chat_id: number; chat_title: string | null; ok: boolean; error?: string }>>();
  const pushResult = (bid: string, r: { chat_id: number; chat_title: string | null; ok: boolean; error?: string }) => {
    if (!perBroadcast.has(bid)) perBroadcast.set(bid, []);
    perBroadcast.get(bid)!.push(r);
  };
  for (const t of toDelete ?? []) {
    if (!t.sent_message_id) {
      await supabaseAdmin
        .from("broadcast_targets")
        .update({ status: "delete_failed", error: "no message_id" })
        .eq("id", t.id);
      deleteFailed++;
      pushResult(String((t as any).broadcast_id), { chat_id: t.chat_id, chat_title: (t as any).chat_title ?? null, ok: false, error: "no message_id" });
      continue;
    }
    try {
      const ids = ((t as any).sent_message_ids?.length ? (t as any).sent_message_ids : [t.sent_message_id]).map(Number);
      await deleteTargetMessages(t.chat_id, ids);
      await supabaseAdmin
        .from("broadcast_targets")
        .update({ status: "deleted", deleted_at: new Date().toISOString() })
        .eq("id", t.id);
      deleted++;
      pushResult(String((t as any).broadcast_id), { chat_id: t.chat_id, chat_title: (t as any).chat_title ?? null, ok: true });
    } catch (e: any) {
      await supabaseAdmin
        .from("broadcast_targets")
        .update({ status: "delete_failed", error: e?.message ?? String(e) })
        .eq("id", t.id);
      deleteFailed++;
      pushResult(String((t as any).broadcast_id), { chat_id: t.chat_id, chat_title: (t as any).chat_title ?? null, ok: false, error: e?.message ?? String(e) });
    }
  }

  // DM each broadcast creator a deletion summary (always, success or failure).
  for (const [bid, rows] of perBroadcast) {
    try {
      const { data: bc } = await supabaseAdmin
        .from("broadcasts")
        .select("created_by")
        .eq("id", bid)
        .maybeSingle();
      const creator = (bc as any)?.created_by;
      if (!creator) continue;
      const ok = rows.filter((r) => r.ok).length;
      const fail = rows.length - ok;
      const lines = [
        `🧹 <b>Auto-delete complete</b>`,
        `✅ ${ok} deleted${fail ? `   ❌ ${fail} failed` : ""}`,
        "",
        ...rows.map((r) => {
          const title = (r.chat_title ?? String(r.chat_id)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          if (r.ok) return `✅ ${title}`;
          const err = r.error ? ` — ${r.error.slice(0, 100).replace(/</g, "&lt;")}` : "";
          return `❌ ${title}${err}`;
        }),
      ];
      await telegramCall("sendMessage", {
        chat_id: creator,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch { /* ignore DM failures */ }
  }

  // 3) recurring broadcasts
  const { tickRecurrences } = await import("./recurring.server");
  let recurringFired = 0;
  let recurringFailed = 0;
  try {
    const r = await tickRecurrences();
    recurringFired = r.fired;
    recurringFailed = r.failed;
  } catch (e) {
    console.error("tickRecurrences failed", e);
  }

  return { sent, deleted, deleteFailed, recurringFired, recurringFailed };
}