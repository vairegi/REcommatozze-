// Interactive /post wizard for bot admins (DM only).
import { telegramCall, getChatMemberStatus, getBotIdentity } from "./telegram.server";
import {
  parseScheduleIST,
  parseAutoDeleteSeconds,
  fmtIST,
  fmtDuration,
  executeBroadcast,
  formatDeliveryReport,
  runEditBroadcast,
  formatEditReport,
  parseButtonSpec,
  keyboardPreview,
} from "./broadcast.server";

type Admin = { user_id: number; role: string };

async function getBotAdmin(fromId: number): Promise<Admin | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("user_id, role")
    .eq("user_id", fromId)
    .maybeSingle();
  return (data as any) ?? null;
}

async function getDraft(userId: number) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("broadcast_drafts")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data as any;
}

async function saveDraft(userId: number, patch: Record<string, any>) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("broadcast_drafts").upsert(
    { user_id: userId, ...patch, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
}

async function clearDraft(userId: number) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("broadcast_drafts").delete().eq("user_id", userId);
}

function previewOf(message: any): string {
  if (message.text) return message.text.slice(0, 120);
  if (message.caption) return `[media] ${message.caption.slice(0, 100)}`;
  if (message.photo) return "[photo]";
  if (message.video) return "[video]";
  if (message.document) return `[document] ${message.document.file_name ?? ""}`;
  if (message.animation) return "[gif]";
  if (message.audio) return "[audio]";
  if (message.voice) return "[voice]";
  if (message.sticker) return `[sticker] ${message.sticker.emoji ?? ""}`;
  if (message.poll) return `[poll] ${message.poll.question ?? ""}`;
  return "[message]";
}

/** Entry: handle /post, /broadcasts, /cancel. Returns true if command was handled. */
export async function handleBroadcastCommand(args: {
  cmd: string;
  fromId: number;
  fromName: string;
  chatId: number;
  chatType: string;
  argText?: string;
  replyTo?: any;
}): Promise<boolean> {
  const { cmd, fromId, fromName, chatId, chatType, argText, replyTo } = args;
  if (
    cmd !== "/post" &&
    cmd !== "/crosspost" &&
    cmd !== "/splitpost" &&
    cmd !== "/broadcasts" &&
    cmd !== "/cancel" &&
    cmd !== "/editpost" &&
    cmd !== "/savebtn" &&
    cmd !== "/buttons" &&
    cmd !== "/delbtn"
  ) return false;

  const admin = await getBotAdmin(fromId);
  if (!admin) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: "❌ Only bot admins can use this. Ask an existing admin to /addadmin you.",
    });
    return true;
  }
  if (chatType !== "private") {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: `🔒 Use ${cmd} in a private chat with me.`,
    });
    return true;
  }

  if (cmd === "/cancel") {
    const d = await getDraft(fromId);
    if (!d) {
      await telegramCall("sendMessage", { chat_id: chatId, text: "Nothing to cancel." });
    } else {
      await clearDraft(fromId);
      await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Broadcast draft discarded." });
    }
    return true;
  }

  if (cmd === "/post" || cmd === "/crosspost") {
    const mode = cmd === "/crosspost" ? "forward" : "copy";
    await saveDraft(fromId, {
      step: "awaiting_content",
      source_chat_id: null,
      source_message_id: null,
      preview_text: null,
      selected_chat_ids: [],
      scheduled_at: null,
      auto_delete_seconds: null,
      editing_broadcast_id: null,
      awaiting_custom: null,
      source_message_json: null,
      reply_markup: null,
      mode,
      source_message_ids: null,
      media_group_id: null,
      split_enabled: false,
      split_source_chat_id: null,
      split_source_message_id: null,
      split_source_message_ids: null,
      split_preview_text: null,
      split_media_group_id: null,
    });
    // If /post was sent as a reply to a message, use that message as the content immediately.
    if (replyTo && replyTo.message_id && replyTo.chat?.id) {
      await saveDraft(fromId, {
        source_chat_id: replyTo.chat.id,
        source_message_id: replyTo.message_id,
        preview_text: previewOf(replyTo),
        source_message_json: replyTo,
        step: "awaiting_channels",
        selected_chat_ids: [],
      });
      await promptChannels(fromId, chatId);
      return true;
    }
    const label = mode === "forward"
      ? "🔁 <b>New crosspost</b> (forwards with 'forwarded from' header)"
      : "📝 <b>New broadcast</b> (clean copy, no forward header)";
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text:
        `${label}\n\nSend or forward the message you want to broadcast (text, photo, video, document, etc.).\n\nUse /cancel to abort.`,
      parse_mode: "HTML",
    });
    return true;
  }

  if (cmd === "/splitpost") {
    await startSplitPost(fromId, chatId, argText ?? "", replyTo);
    return true;
  }

  if (cmd === "/broadcasts") {
    await listBroadcasts(fromId, chatId, fromName);
    return true;
  }

  if (cmd === "/editpost") {
    // /editpost <broadcast_id>
    const rest = (argText ?? "").trim().split(/\s+/).slice(1).join(" ").trim();
    if (!rest) {
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: "Usage: <code>/editpost &lt;broadcast_id&gt;</code>\n\nOr use /broadcasts and tap ✏️ Edit on a sent post.",
        parse_mode: "HTML",
      });
      return true;
    }
    await startEditFlow(fromId, chatId, rest);
    return true;
  }

  if (cmd === "/buttons") {
    await listButtonPresets(fromId, chatId);
    return true;
  }
  if (cmd === "/savebtn") {
    await saveButtonPresetCommand(fromId, chatId, argText ?? "");
    return true;
  }
  if (cmd === "/delbtn") {
    const name = (argText ?? "").trim().split(/\s+/).slice(1).join(" ").trim();
    await deleteButtonPreset(fromId, chatId, name);
    return true;
  }
  return false;
}

async function listBroadcasts(fromId: number, chatId: number, _fromName: string) {
  return _listBroadcasts(fromId, chatId, _fromName);
}

// ================== Split post (two variants, alternating A/B/A/B) ==================

async function fetchRecentPosts(fromId: number) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("broadcasts")
    .select("id, preview_text, mode, source_chat_id, source_message_id, source_message_ids, reply_markup, created_at")
    .eq("created_by", fromId)
    .order("created_at", { ascending: false })
    .limit(20);
  return ((data ?? []) as any[]);
}

async function promptSplitContent(chatId: number, slot: "A" | "B") {
  await telegramCall("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      slot === "A"
        ? "🅰️ <b>Split post — send post A</b>\n\nSend or forward the first message (text, media, or album).\n\nUse /cancel to abort."
        : "🅱️ <b>Now send post B</b>\n\nSend or forward the second message. Channels will alternate: A, B, A, B…\n\nUse /cancel to abort.",
  });
}

/** /splitpost [numA] [numB] — set up an A/B alternating broadcast. */
async function startSplitPost(fromId: number, chatId: number, argText: string, replyTo?: any) {
  const nums = argText
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 1)
    .slice(0, 2);

  await saveDraft(fromId, {
    step: "awaiting_content",
    source_chat_id: null,
    source_message_id: null,
    source_message_ids: null,
    media_group_id: null,
    preview_text: null,
    source_message_json: null,
    selected_chat_ids: [],
    scheduled_at: null,
    auto_delete_seconds: null,
    editing_broadcast_id: null,
    awaiting_custom: null,
    reply_markup: null,
    mode: "copy",
    split_enabled: true,
    split_source_chat_id: null,
    split_source_message_id: null,
    split_source_message_ids: null,
    split_preview_text: null,
    split_media_group_id: null,
  });

  if (nums.length) {
    const rows = await fetchRecentPosts(fromId);
    const missing = nums.filter((n) => !rows[n - 1]);
    if (missing.length) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ No post #${missing.join(", #")} in your list. Run /listpost.` });
      await clearDraft(fromId);
      return;
    }
    const a = rows[nums[0] - 1];
    await saveDraft(fromId, {
      source_chat_id: Number(a.source_chat_id),
      source_message_id: Number(a.source_message_id),
      source_message_ids: a.source_message_ids?.length ? a.source_message_ids : null,
      preview_text: a.preview_text ?? null,
      mode: a.mode ?? "copy",
      reply_markup: a.reply_markup ?? null,
    });
    if (nums.length === 2) {
      const b = rows[nums[1] - 1];
      await saveDraft(fromId, {
        split_source_chat_id: Number(b.source_chat_id),
        split_source_message_id: Number(b.source_message_id),
        split_source_message_ids: b.source_message_ids?.length ? b.source_message_ids : null,
        split_preview_text: b.preview_text ?? null,
        step: "awaiting_channels",
      });
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: `♻️ Split post using #${nums[0]} (A) and #${nums[1]} (B). Channels will alternate A, B, A, B…`,
      });
      await promptChannels(fromId, chatId);
      return;
    }
    await saveDraft(fromId, { step: "awaiting_split_content" });
    await promptSplitContent(chatId, "B");
    return;
  }

  if (replyTo?.message_id && replyTo.chat?.id) {
    await saveDraft(fromId, {
      source_chat_id: replyTo.chat.id,
      source_message_id: replyTo.message_id,
      preview_text: previewOf(replyTo),
      source_message_json: replyTo,
      step: "awaiting_split_content",
    });
    await promptSplitContent(chatId, "B");
    return;
  }

  await promptSplitContent(chatId, "A");
}

async function _listBroadcasts(fromId: number, chatId: number, _fromName: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: rows } = await supabaseAdmin
    .from("broadcasts")
    .select("id, preview_text, status, scheduled_at, sent_at, auto_delete_seconds, created_by, created_by_name, created_at")
    .eq("created_by", fromId)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!rows?.length) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "You haven't created any broadcasts yet. Use /post to make one." });
    return;
  }

  const lines: string[] = ["📣 <b>Recent broadcasts</b>\n"];
  const keyboard: any[][] = [];
  for (const r of rows as any[]) {
    const when = r.scheduled_at
      ? `⏰ ${fmtIST(r.scheduled_at)}`
      : r.sent_at
        ? `✅ ${fmtIST(r.sent_at)}`
        : `🕒 ${fmtIST(r.created_at)}`;
    const preview = (r.preview_text ?? "").slice(0, 60);
    lines.push(`• <b>${r.status}</b> — ${when}\n   ${escapeHtml(preview)}`);
    const row: any[] = [{ text: `👁 ${r.status}`, callback_data: `bc:v:${r.id}` }];
    if (r.status === "pending") row.push({ text: "🗑 Cancel", callback_data: `bc:cx:${r.id}` });
    if (r.status === "sent" || r.status === "partial") {
      row.push({ text: "✏️ Edit", callback_data: `bc:ed:${r.id}` });
      row.push({ text: "🚫 Cancel auto-delete", callback_data: `bc:cd:${r.id}` });
    }
    keyboard.push(row);
  }
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Called for any incoming DM message. Returns true if the message was consumed by the wizard. */
export async function handleBroadcastMessage(args: {
  fromId: number;
  fromName: string;
  chatId: number;
  chatType: string;
  message: any;
}): Promise<boolean> {
  const { fromId, chatId, chatType, message } = args;
  if (chatType !== "private") return false;
  const admin = await getBotAdmin(fromId);
  if (!admin) return false;
  const draft = await getDraft(fromId);
  if (!draft) return false;

  // Escape hatch: never swallow slash-commands. If the user types any command
  // while the wizard is waiting for free text, drop the pending text-input flag
  // and let normal command routing handle it (prevents getting stuck).
  const rawText: string = typeof message.text === "string" ? message.text : "";
  if (rawText.startsWith("/")) {
    if (draft.awaiting_custom) await saveDraft(fromId, { awaiting_custom: null });
    return false;
  }

  // Awaiting custom text input (schedule or auto-delete)
  if (draft.awaiting_custom === "schedule" && message.text) {
    const when = parseScheduleIST(message.text);
    if (!when) {
      await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Couldn't parse that time. Try: `in 5m`, `in 2h 30m`, `tomorrow 9am`, `25 jul 18:30`.", parse_mode: "Markdown" });
      return true;
    }
    if (when.getTime() <= Date.now() + 5000) {
      await telegramCall("sendMessage", { chat_id: chatId, text: "❌ That time is in the past. Pick a future time." });
      return true;
    }
    await saveDraft(fromId, { scheduled_at: when.toISOString(), awaiting_custom: null, step: "awaiting_delete" });
    await promptAutoDelete(chatId, when);
    return true;
  }
  if (draft.awaiting_custom === "autodelete" && message.text) {
    const secs = parseAutoDeleteSeconds(message.text);
    if (secs === null) {
      await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Couldn't parse that duration. Try: `30m`, `2h`, `2h 30m`, up to 48h." });
      return true;
    }
    await saveDraft(fromId, { auto_delete_seconds: secs, awaiting_custom: null, step: "confirm" });
    await promptConfirm(fromId, chatId);
    return true;
  }

  if (draft.awaiting_custom === "buttons" && message.text) {
    try {
      const kb = parseButtonSpec(message.text);
      await saveDraft(fromId, { reply_markup: { inline_keyboard: kb }, awaiting_custom: null });
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: `✅ Buttons attached (${kb.length} row${kb.length === 1 ? "" : "s"}):\n<pre>${escapeHtml(keyboardPreview(kb))}</pre>`,
        parse_mode: "HTML",
      });
      await promptConfirm(fromId, chatId);
    } catch (e: any) {
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: `❌ ${escapeHtml(e?.message ?? "invalid button spec")}\n\nSend again or tap 🔘 Buttons → Skip.`,
        parse_mode: "HTML",
      });
    }
    return true;
  }

  if (draft.awaiting_custom === "savebtn" && message.text) {
    const raw = message.text;
    const nl = raw.indexOf("\n");
    let name = (nl === -1 ? raw : raw.slice(0, nl)).trim();
    let spec = nl === -1 ? "" : raw.slice(nl + 1);
    // Single line like "Label - https://url" → treat the whole thing as the
    // button spec and auto-name the preset, instead of dead-ending.
    if (!spec.trim()) {
      if (/https?:\/\/|t\.me\//i.test(name)) {
        spec = name;
        name = `preset_${Date.now().toString().slice(-6)}`;
      } else {
        await telegramCall("sendMessage", {
          chat_id: chatId,
          text: "❌ Send: first line = preset name, then button lines.\n\nExample:\nmy_preset\nChannel - https://t.me/x | Bot - https://t.me/y\n\nOr just send the button line alone and I'll name it for you. /cancel to abort.",
        });
        return true;
      }
    }
    try {
      const kb = parseButtonSpec(spec);
      await upsertSharedPreset(fromId, name, kb);
      await saveDraft(fromId, { awaiting_custom: null });
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: `✅ Saved preset <b>${escapeHtml(name)}</b>:\n<pre>${escapeHtml(keyboardPreview(kb))}</pre>`,
        parse_mode: "HTML",
      });
    } catch (e: any) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ ${escapeHtml(e?.message ?? "invalid")}` });
    }
    return true;
  }

  // Awaiting chat IDs typed manually — only while still on the channel-picking step,
  // otherwise a leftover "chatid" flag would swallow custom schedule/auto-delete text.
  if (draft.awaiting_custom === "chatid" && draft.step === "awaiting_channels" && message.text) {
    const ids = Array.from(
      new Set(
        message.text
          .split(/[\s,]+/)
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map((s: string) => Number(s))
          .filter((n: number) => Number.isFinite(n) && n !== 0),
      ),
    ) as number[];
    if (!ids.length) {
      await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Send one or more chat IDs (space/comma separated). Example: `-1001234567890`", parse_mode: "Markdown" });
      return true;
    }
    const bot = await getBotIdentity();
    const ok: number[] = [];
    const bad: Array<{ id: number; reason: string }> = [];
    await Promise.all(ids.map(async (id) => {
      try {
        const bs = await getChatMemberStatus(id, bot.id);
        if (bs === "administrator" || bs === "creator") ok.push(id);
        else bad.push({ id, reason: `bot status: ${bs ?? "unknown"}` });
      } catch (e: any) {
        bad.push({ id, reason: e?.message ?? "lookup failed" });
      }
    }));
    if (!ok.length) {
      const lines = bad.map((b) => `  • <code>${b.id}</code> — ${escapeHtml(b.reason)}`).join("\n");
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ None of those work:\n${lines}\n\nSend valid IDs or /cancel.`, parse_mode: "HTML" });
      return true;
    }
    // Merge with any already-selected. Keep awaiting_custom = "chatid" so the
    // user can keep pasting more IDs without re-tapping a button.
    const merged = Array.from(new Set([...(draft.selected_chat_ids ?? []), ...ok]));
    await saveDraft(fromId, { selected_chat_ids: merged, awaiting_custom: "chatid" });
    const skipped = bad.length ? `\n\n⚠️ Skipped:\n${bad.map((b) => `  • <code>${b.id}</code> — ${escapeHtml(b.reason)}`).join("\n")}` : "";
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: `✅ Added ${ok.length} chat${ok.length === 1 ? "" : "s"} (total selected: <b>${merged.length}</b>).${skipped}\n\nPaste more IDs to add them, or tap ➡️ Next to continue.`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: `➡️ Next (${merged.length})`, callback_data: "bc:next" },
          { text: "❌ Cancel", callback_data: "bc:x" },
        ]],
      },
    });
    return true;
  }

  // Awaiting content
  if (draft.step === "awaiting_content") {
    // Any message with an id is fine
    if (!message.message_id || !message.chat?.id) return true;
    // Album (media group): Telegram delivers each item as its own update.
    if (message.media_group_id) {
      await saveDraft(fromId, {
        source_chat_id: message.chat.id,
        source_message_id: message.message_id,
        source_message_ids: [message.message_id],
        media_group_id: String(message.media_group_id),
        preview_text: previewOf(message),
        step: "collecting_album",
        selected_chat_ids: [],
      });
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: "🖼 Album detected — collecting items…",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Done, pick channels", callback_data: "bc:album_done" },
            { text: "❌ Cancel", callback_data: "bc:x" },
          ]],
        },
      });
      return true;
    }
    await saveDraft(fromId, {
      source_chat_id: message.chat.id,
      source_message_id: message.message_id,
      source_message_ids: null,
      media_group_id: null,
      preview_text: previewOf(message),
      step: "awaiting_channels",
      selected_chat_ids: [],
    });
    if (draft.split_enabled) {
      await saveDraft(fromId, { step: "awaiting_split_content", source_message_json: message });
      await promptSplitContent(chatId, "B");
      return true;
    }
    await promptChannels(fromId, chatId);
    return true;
  }

  // Awaiting the second (B) post of a split broadcast
  if (draft.step === "awaiting_split_content") {
    if (!message.message_id || !message.chat?.id) return true;
    if (message.media_group_id) {
      await saveDraft(fromId, {
        split_source_chat_id: message.chat.id,
        split_source_message_id: message.message_id,
        split_source_message_ids: [message.message_id],
        split_media_group_id: String(message.media_group_id),
        split_preview_text: previewOf(message),
        step: "collecting_split_album",
      });
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: "🖼 Album detected for post B — collecting items…",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Done, pick channels", callback_data: "bc:album_done" },
            { text: "❌ Cancel", callback_data: "bc:x" },
          ]],
        },
      });
      return true;
    }
    await saveDraft(fromId, {
      split_source_chat_id: message.chat.id,
      split_source_message_id: message.message_id,
      split_source_message_ids: null,
      split_media_group_id: null,
      split_preview_text: previewOf(message),
      step: "awaiting_channels",
      selected_chat_ids: [],
    });
    await promptChannels(fromId, chatId);
    return true;
  }

  // Collecting remaining items of post B's album
  if (draft.step === "collecting_split_album") {
    if (!message.message_id || !message.chat?.id) return true;
    if (message.media_group_id && String(message.media_group_id) === String((draft as any).split_media_group_id)) {
      const ids: number[] = ((draft as any).split_source_message_ids ?? []).map(Number);
      if (!ids.includes(message.message_id)) ids.push(message.message_id);
      ids.sort((a, b) => a - b);
      await saveDraft(fromId, { split_source_message_ids: ids, split_source_message_id: ids[0] });
    }
    return true;
  }

  // Collecting remaining items of an album
  if (draft.step === "collecting_album") {
    if (!message.message_id || !message.chat?.id) return true;
    if (message.media_group_id && String(message.media_group_id) === String((draft as any).media_group_id)) {
      const ids: number[] = ((draft as any).source_message_ids ?? []).map(Number);
      if (!ids.includes(message.message_id)) ids.push(message.message_id);
      ids.sort((a, b) => a - b);
      await saveDraft(fromId, { source_message_ids: ids, source_message_id: ids[0] });
    }
    return true;
  }

  // Awaiting new content for an edit
  if (draft.step === "awaiting_edit_content" && draft.editing_broadcast_id) {
    if (!message.message_id || !message.chat?.id) return true;
    await saveDraft(fromId, {
      source_chat_id: message.chat.id,
      source_message_id: message.message_id,
      preview_text: previewOf(message),
      source_message_json: message,
      step: "confirm_edit",
    });
    await promptConfirmEdit(fromId, chatId);
    return true;
  }

  // Any other text while draft exists but no prompt — ignore (let normal commands run)
  return false;
}

/** Begin an edit-after-send flow for an existing broadcast owned by fromId (or any, for super admins). */
async function startEditFlow(fromId: number, chatId: number, broadcastId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: bc } = await supabaseAdmin
    .from("broadcasts")
    .select("id, created_by, status, preview_text")
    .eq("id", broadcastId)
    .maybeSingle();
  if (!bc) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Broadcast not found." });
    return;
  }
  const b = bc as any;
  if (b.created_by !== fromId) {
    const { data: admin } = await supabaseAdmin
      .from("telegram_bot_admins")
      .select("role")
      .eq("user_id", fromId)
      .maybeSingle();
    if (!admin || (admin as any).role !== "super_admin") {
      await telegramCall("sendMessage", { chat_id: chatId, text: "❌ You can only edit your own broadcasts." });
      return;
    }
  }
  if (b.status !== "sent" && b.status !== "partial") {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: `❌ Only sent broadcasts can be edited (this one is <b>${b.status}</b>). Use /broadcasts to cancel it instead.`,
      parse_mode: "HTML",
    });
    return;
  }
  const { count } = await supabaseAdmin
    .from("broadcast_targets")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId)
    .not("sent_message_id", "is", null)
    .in("status", ["sent", "delete_failed"]);
  if (!count) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Nothing to edit — no delivered targets left (they may have been auto-deleted)." });
    return;
  }
  await saveDraft(fromId, {
    step: "awaiting_edit_content",
    editing_broadcast_id: broadcastId,
    source_chat_id: null,
    source_message_id: null,
    preview_text: null,
    selected_chat_ids: [],
    scheduled_at: null,
    auto_delete_seconds: null,
    awaiting_custom: null,
    mode: "copy",
  });
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text:
      `✏️ <b>Edit broadcast</b>\n\nSend or forward the <b>new</b> message. I'll replace it in all ${count} delivered target${count === 1 ? "" : "s"}.\n\n` +
      `Supported: text, photo, video, animation, document, audio. The new content type must match the original (Telegram won't turn a text post into media, or swap photo↔video, etc.).\n\n` +
      `Use /cancel to abort.`,
    parse_mode: "HTML",
  });
}

async function promptConfirmEdit(fromId: number, chatId: number) {
  const d = await getDraft(fromId);
  if (!d) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { count } = await supabaseAdmin
    .from("broadcast_targets")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", d.editing_broadcast_id)
    .not("sent_message_id", "is", null)
    .in("status", ["sent", "delete_failed"]);
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text:
      `📋 <b>Confirm edit</b>\n\n` +
      `New content: <i>${escapeHtml((d.preview_text ?? "").slice(0, 200))}</i>\n\n` +
      `Will replace the message in <b>${count ?? 0}</b> target${count === 1 ? "" : "s"}.`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "👁 Preview to me", callback_data: "bc:pv" }],
        [
          { text: "✅ Apply edit", callback_data: "bc:egox" },
          { text: "❌ Cancel", callback_data: "bc:x" },
        ],
      ],
    },
  });
}

async function promptChannels(fromId: number, chatId: number) {
  await renderChannelList(fromId, chatId);
}

/** Start a broadcast wizard directly from a saved template (skips awaiting_content). */
export async function startBroadcastFromTemplate(args: {
  fromId: number;
  chatId: number;
  template: { source_chat_id: number; source_message_id: number; preview_text?: string | null; mode?: string | null };
}): Promise<boolean> {
  const { fromId, chatId, template } = args;
  const admin = await getBotAdmin(fromId);
  if (!admin) return false;
  await saveDraft(fromId, {
    step: "awaiting_channels",
    source_chat_id: template.source_chat_id,
    source_message_id: template.source_message_id,
    preview_text: template.preview_text ?? null,
    selected_chat_ids: [],
    scheduled_at: null,
    auto_delete_seconds: null,
    editing_broadcast_id: null,
    awaiting_custom: null,
    reply_markup: null,
    mode: template.mode ?? "copy",
  });
  await promptChannels(fromId, chatId);
  return true;
}

async function renderChannelList(
  fromId: number,
  chatId: number,
  opts?: { editMessageId?: number },
) {
  const d = await getDraft(fromId);
  const selected: number[] = ((d?.selected_chat_ids ?? []) as any[]).map(Number);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: listRows } = await supabaseAdmin
    .from("chat_lists")
    .select("category, chat_id");

  const byCat = new Map<string, number[]>();
  for (const r of ((listRows ?? []) as any[])) {
    const cat = String(r.category);
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(Number(r.chat_id));
  }
  const cats = Array.from(byCat.keys()).sort();

  const rows: any[][] = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row: any[] = [];
    for (const cat of cats.slice(i, i + 2)) {
      const ids = byCat.get(cat)!;
      const allSel = ids.length > 0 && ids.every((id) => selected.includes(id));
      const mark = allSel ? "✅" : "◻️";
      row.push({ text: `${mark} ${cat} (${ids.length})`, callback_data: `bc:lst:${cat}` });
    }
    rows.push(row);
  }
  rows.push([{ text: "🎯 Enter ID", callback_data: "bc:byid" }]);
  if (selected.length) {
    rows.push([{ text: "🧹 Clear selection", callback_data: "bc:clr" }]);
  }
  rows.push([
    { text: `➡️ Next (${selected.length})`, callback_data: "bc:next" },
    { text: "❌ Cancel", callback_data: "bc:x" },
  ]);

  const catsLine = cats.length
    ? `Tap a list to add all its channels. Tap again to remove them.`
    : `No lists yet. Use /createlist &lt;name&gt; to make one, then /addtolist &lt;name&gt; &lt;chat_id&gt;.`;
  const text =
    `📡 <b>Pick target channels</b>\n\n` +
    `${catsLine}\n\n` +
    `Or tap 🎯 <b>Enter ID</b> to add specific chat IDs.\n\n` +
    `Selected: <b>${selected.length}</b>`;

  if (opts?.editMessageId) {
    try {
      await telegramCall("editMessageText", {
        chat_id: chatId,
        message_id: opts.editMessageId,
        text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      });
      return;
    } catch { /* fall through to send */ }
  }
  // Clear any leftover input mode; user will explicitly tap Enter ID to arm it.
  await saveDraft(fromId, { awaiting_custom: null });
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

async function promptTiming(_fromId: number, chatId: number) {
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text: "⏰ <b>When to send?</b> (all times IST)",
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🚀 Post now", callback_data: "bc:sch:now" },
          { text: "in 5m", callback_data: "bc:sch:300" },
        ],
        [
          { text: "in 2h", callback_data: "bc:sch:7200" },
          { text: "in 6h", callback_data: "bc:sch:21600" },
        ],
        [
          { text: "🌅 tomorrow 9am", callback_data: "bc:sch:tmr9" },
          { text: "✏️ Custom…", callback_data: "bc:sch:custom" },
        ],
        [{ text: "❌ Cancel", callback_data: "bc:x" }],
      ],
    },
  });
}

async function promptAutoDelete(chatId: number, scheduledAt: Date | null) {
  const line = scheduledAt ? `Scheduled: <b>${fmtIST(scheduledAt)}</b>\n\n` : "Post now.\n\n";
  await telegramCall("sendMessage", {
    chat_id: chatId,
    text: `${line}🗑 <b>Auto-delete after…?</b> (max 48h)`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🚫 No delete", callback_data: "bc:ad:0" },
          { text: "30m", callback_data: "bc:ad:1800" },
        ],
        [
          { text: "1h", callback_data: "bc:ad:3600" },
          { text: "6h", callback_data: "bc:ad:21600" },
        ],
        [
          { text: "24h", callback_data: "bc:ad:86400" },
          { text: "48h", callback_data: "bc:ad:172800" },
        ],
        [
          { text: "✏️ Custom…", callback_data: "bc:ad:custom" },
          { text: "❌ Cancel", callback_data: "bc:x" },
        ],
      ],
    },
  });
}

async function promptConfirm(fromId: number, chatId: number) {
  const d = await getDraft(fromId);
  if (!d) return;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: chats } = await supabaseAdmin
    .from("telegram_chats")
    .select("chat_id, title, username")
    .in("chat_id", d.selected_chat_ids ?? []);
  const selected: number[] = ((d.selected_chat_ids ?? []) as any[]).map(Number);
  const titleOf = (cid: number) => {
    const c = (chats as any[] | null | undefined)?.find((x) => Number(x.chat_id) === Number(cid));
    return escapeHtml(String(c?.title ?? c?.username ?? cid));
  };
  const isSplit = !!d.split_enabled && !!d.split_source_message_id;
  const chatLines = isSplit
    ? selected.map((cid, i) => `  ${i % 2 === 0 ? "🅰️" : "🅱️"} ${titleOf(cid)}`).join("\n")
    : selected.map((cid) => `  • ${titleOf(cid)}`).join("\n");

  const when = d.scheduled_at ? `⏰ ${fmtIST(d.scheduled_at)}` : "🚀 Now";
  const del = d.auto_delete_seconds ? `🗑 after ${fmtDuration(d.auto_delete_seconds)}` : "🚫 no auto-delete";
  const kb = (d.reply_markup as any)?.inline_keyboard as any[][] | undefined;
  const btnLine = kb?.length
    ? `\n🔘 Buttons:\n<pre>${escapeHtml(kb.map((r) => r.map((b: any) => `[${b.text}]`).join(" ")).join("\n"))}</pre>`
    : "";

  await telegramCall("sendMessage", {
    chat_id: chatId,
    text:
      (isSplit ? `📋 <b>Confirm split broadcast (A/B alternating)</b>\n\n` : `📋 <b>Confirm broadcast</b>\n\n`) +
      (isSplit
        ? `🅰️ <i>${escapeHtml((d.preview_text ?? "").slice(0, 150))}</i>\n🅱️ <i>${escapeHtml((d.split_preview_text ?? "").slice(0, 150))}</i>\n\n`
        : `Preview: <i>${escapeHtml((d.preview_text ?? "").slice(0, 200))}</i>\n\n`) +
      `Channels (${selected.length}):\n${chatLines}\n\n` +
      `When: ${when}\n` +
      `Delete: ${del}` + btnLine,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "👁 Preview to me", callback_data: "bc:pv" }],
        [{ text: kb?.length ? "🔘 Edit buttons" : "🔘 Add buttons", callback_data: "bc:bt" }],
        [
          { text: "✅ Confirm", callback_data: "bc:go" },
          { text: "❌ Cancel", callback_data: "bc:x" },
        ],
      ],
    },
  });
}

/** Handle any callback_query with data starting with "bc:". */
export async function handleBroadcastCallback(cq: any): Promise<boolean> {
  const data: string = cq?.data ?? "";
  if (!data.startsWith("bc:")) return false;
  const fromId: number = cq.from.id;
  const fromName: string = cq.from.first_name || cq.from.username || `user ${fromId}`;
  const chatId: number = cq.message?.chat?.id ?? fromId;

  const admin = await getBotAdmin(fromId);
  if (!admin) {
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Not a bot admin.", show_alert: true });
    return true;
  }

  const [, op, arg] = data.split(":");
  const draft = await getDraft(fromId);

  // Global cancel
  if (op === "x") {
    await clearDraft(fromId);
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Cancelled" });
    if (cq.message?.message_id) {
      try {
        await telegramCall("editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: "❌ Broadcast cancelled." });
      } catch { /* ignore */ }
    }
    return true;
  }

  // Legacy per-channel toggle (no longer rendered). Ignore politely.
  if (op === "t") {
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
    return true;
  }

  // Album collected — move on to channel picking.
  if (op === "album_done") {
    if (!draft || (draft.step !== "collecting_album" && draft.step !== "collecting_split_album")) {
      await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
      return true;
    }
    const isSplitSlot = draft.step === "collecting_split_album";
    const ids: number[] = ((isSplitSlot ? (draft as any).split_source_message_ids : (draft as any).source_message_ids) ?? []).map(Number);
    const needsB = !isSplitSlot && draft.split_enabled;
    await saveDraft(fromId, {
      step: needsB ? "awaiting_split_content" : "awaiting_channels",
      ...(needsB ? {} : { selected_chat_ids: [] }),
    });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: `${ids.length} item(s) captured` });
    if (cq.message?.message_id) {
      try {
        await telegramCall("editMessageText", {
          chat_id: chatId,
          message_id: cq.message.message_id,
          text: `🖼 Album captured — ${ids.length} item(s).`,
        });
      } catch { /* ignore */ }
    }
    if (needsB) {
      await promptSplitContent(chatId, "B");
      return true;
    }
    await promptChannels(fromId, chatId);
    return true;
  }

  if (op === "pre" && draft) {
    const categories: Array<"adult" | "manga"> =
      arg === "adult" ? ["adult"] : arg === "manga" ? ["manga"] : arg === "both" ? ["adult", "manga"] : [];
    if (!categories.length) {
      await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
      return true;
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: listRows } = await supabaseAdmin
      .from("chat_lists")
      .select("chat_id")
      .in("category", categories);
    const listIds = new Set<number>((listRows ?? []).map((r: any) => Number(r.chat_id)));
    if (!listIds.size) {
      await telegramCall("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `The ${categories.join(" & ")} list is empty. Use /addtolist <category> <chat_id>.`,
        show_alert: true,
      });
      return true;
    }
    // Filter to chats where the bot is admin.
    const bot = await getBotIdentity();
    const { data: chats } = await supabaseAdmin
      .from("telegram_chats")
      .select("chat_id")
      .in("chat_id", Array.from(listIds));
    const eligible: number[] = [];
    await Promise.all(
      ((chats as any[]) ?? []).map(async (c) => {
        const bs = await getChatMemberStatus(Number(c.chat_id), bot.id);
        if (bs === "administrator" || bs === "creator") eligible.push(Number(c.chat_id));
      }),
    );
    if (!eligible.length) {
      await telegramCall("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: `No chats in the ${categories.join(" & ")} list where I'm currently admin.`,
        show_alert: true,
      });
      return true;
    }
    await saveDraft(fromId, { selected_chat_ids: eligible });
    await telegramCall("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `Selected ${eligible.length} chat${eligible.length === 1 ? "" : "s"} (${categories.join(" & ")}).`,
    });
    return true;
  }

  if (op === "byid" && draft) {
    await saveDraft(fromId, { awaiting_custom: "chatid" });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text:
        "🎯 <b>Send chat ID(s)</b>\n\nPaste one or more Telegram chat IDs (space or comma separated). I'll verify I'm admin in each.\n\nExample: <code>-1001234567890 -1009876543210</code>",
      parse_mode: "HTML",
    });
    return true;
  }

  // Toggle a whole list (add if not fully selected, remove otherwise).
  if (op === "lst" && draft) {
    const cat = arg;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: listRows } = await supabaseAdmin
      .from("chat_lists")
      .select("chat_id")
      .eq("category", cat);
    const ids = ((listRows ?? []) as any[]).map((r) => Number(r.chat_id));
    if (!ids.length) {
      await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: `"${cat}" is empty.`, show_alert: true });
      return true;
    }
    const current: number[] = ((draft.selected_chat_ids ?? []) as any[]).map(Number);
    const allSel = ids.every((id) => current.includes(id));
    let next: number[];
    let msg: string;
    if (allSel) {
      const removeSet = new Set(ids);
      next = current.filter((id) => !removeSet.has(id));
      msg = `Removed ${cat} (${ids.length})`;
    } else {
      next = Array.from(new Set([...current, ...ids]));
      msg = `Added ${cat} (${ids.length})`;
    }
    await saveDraft(fromId, { selected_chat_ids: next });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: msg });
    await renderChannelList(fromId, chatId, { editMessageId: cq.message?.message_id });
    return true;
  }

  if (op === "clr" && draft) {
    await saveDraft(fromId, { selected_chat_ids: [] });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Cleared" });
    await renderChannelList(fromId, chatId, { editMessageId: cq.message?.message_id });
    return true;
  }

  if (op === "all" && draft) {
    const bot = await getBotIdentity();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: chats } = await supabaseAdmin
      .from("telegram_chats")
      .select("chat_id, type, title, username")
      .in("type", ["group", "supergroup", "channel"])
      .limit(50);
    const eligible: number[] = [];
    await Promise.all((chats as any[]).map(async (c) => {
      const bs = await getChatMemberStatus(c.chat_id, bot.id);
      if (bs === "administrator" || bs === "creator") eligible.push(c.chat_id);
    }));
    await saveDraft(fromId, { selected_chat_ids: eligible });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: `Selected ${eligible.length}` });
    return true;
  }

  if (op === "next" && draft) {
    if (!(draft.selected_chat_ids ?? []).length) {
      await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Pick at least one channel.", show_alert: true });
      return true;
    }
    await saveDraft(fromId, { step: "awaiting_timing", awaiting_custom: null });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
    await promptTiming(fromId, chatId);
    return true;
  }

  if (op === "sch" && draft) {
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
    if (arg === "custom") {
      await saveDraft(fromId, { awaiting_custom: "schedule" });
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: "Send the time (IST). Examples: `in 5m`, `in 2h 30m`, `tomorrow 9am`, `25 jul 18:30`.",
        parse_mode: "Markdown",
      });
      return true;
    }
    let scheduledAt: Date | null = null;
    if (arg === "now") scheduledAt = null;
    else if (arg === "tmr9") scheduledAt = parseScheduleIST("tomorrow 9am");
    else {
      const secs = Number(arg);
      if (Number.isFinite(secs)) scheduledAt = new Date(Date.now() + secs * 1000);
    }
    await saveDraft(fromId, { scheduled_at: scheduledAt ? scheduledAt.toISOString() : null, step: "awaiting_delete" });
    await promptAutoDelete(chatId, scheduledAt);
    return true;
  }

  if (op === "ad" && draft) {
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
    if (arg === "custom") {
      await saveDraft(fromId, { awaiting_custom: "autodelete" });
      await telegramCall("sendMessage", { chat_id: chatId, text: "Send auto-delete duration. Examples: `30m`, `2h`, `2h 30m`. Max 48h.", parse_mode: "Markdown" });
      return true;
    }
    const secs = Number(arg);
    await saveDraft(fromId, { auto_delete_seconds: secs > 0 ? secs : null, step: "confirm" });
    await promptConfirm(fromId, chatId);
    return true;
  }

  if (op === "go" && draft) {
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Submitting…" });
    await commitDraft(fromId, fromName, chatId);
    return true;
  }

  // Preview: copy source message to the admin's DM so they see exactly what channels will get.
  if (op === "pv" && draft) {
    if (!draft.source_chat_id || !draft.source_message_id) {
      await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "No content yet.", show_alert: true });
      return true;
    }
    try {
      await telegramCall("sendMessage", { chat_id: fromId, text: "👁 <b>Preview</b> — this is exactly what channels will receive:", parse_mode: "HTML" });
      const albumIds: number[] = ((draft as any).source_message_ids ?? []).map(Number).filter(Boolean);
      if (albumIds.length > 1) {
        const res = await telegramCall("copyMessages", {
          chat_id: fromId,
          from_chat_id: draft.source_chat_id,
          message_ids: albumIds,
        });
        if (draft.reply_markup) {
          const { sendAlbumButtons } = await import("@/lib/broadcast.server");
          const first = Array.isArray(res) ? Number(res[0]?.message_id) : undefined;
          await sendAlbumButtons(fromId, draft.reply_markup, first);
        }
      } else {
        await telegramCall("copyMessage", {
          chat_id: fromId,
          from_chat_id: draft.source_chat_id,
          message_id: draft.source_message_id,
          ...(draft.reply_markup ? { reply_markup: draft.reply_markup } : {}),
        });
      }
      if (draft.split_enabled && draft.split_source_message_id && draft.split_source_chat_id) {
        await telegramCall("sendMessage", { chat_id: fromId, text: "🅱️ <b>Post B</b> (every second channel):", parse_mode: "HTML" });
        const bIds: number[] = ((draft as any).split_source_message_ids ?? []).map(Number).filter(Boolean);
        if (bIds.length > 1) {
          const resB = await telegramCall("copyMessages", {
            chat_id: fromId,
            from_chat_id: draft.split_source_chat_id,
            message_ids: bIds,
          });
          if (draft.reply_markup) {
            const { sendAlbumButtons } = await import("@/lib/broadcast.server");
            const firstB = Array.isArray(resB) ? Number(resB[0]?.message_id) : undefined;
            await sendAlbumButtons(fromId, draft.reply_markup, firstB);
          }
        } else {
          await telegramCall("copyMessage", {
            chat_id: fromId,
            from_chat_id: draft.split_source_chat_id,
            message_id: draft.split_source_message_id,
            ...(draft.reply_markup ? { reply_markup: draft.reply_markup } : {}),
          });
        }
      }
      await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Preview sent" });
    } catch (e: any) {
      await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: `Preview failed: ${e?.message ?? "unknown"}`, show_alert: true });
    }
    return true;
  }

  // Buttons sub-flow
  if (op === "bt" && draft) {
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
    await promptButtonsMenu(fromId, chatId);
    return true;
  }
  if (op === "btn" && draft) {
    await saveDraft(fromId, { awaiting_custom: "buttons" });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
    await telegramCall("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        "🔘 <b>Send button spec — you can add as many as you like</b>\n\n" +
        "• Each button: <code>Label - https://url</code>\n" +
        "• <code>|</code> puts buttons on the <b>same row</b>\n" +
        "• A <b>new line</b> starts a new row\n" +
        "• Up to 10 rows, 8 buttons per row\n\n" +
        "<b>Example — 3 rows, 5 buttons total:</b>\n" +
        "<pre>Channel - https://t.me/mychannel | Bot - https://t.me/mybot\n" +
        "Manga - https://t.me/manga | Anime - https://t.me/anime\n" +
        "Support - https://t.me/support</pre>",
    });
    return true;
  }
  if (op === "btc" && draft) {
    await saveDraft(fromId, { reply_markup: null, awaiting_custom: null });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Buttons cleared" });
    await promptConfirm(fromId, chatId);
    return true;
  }
  if (op === "bk" && draft) {
    await saveDraft(fromId, { awaiting_custom: null });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
    await promptConfirm(fromId, chatId);
    return true;
  }
  if (op === "btp" && draft) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: preset } = await supabaseAdmin
      .from("broadcast_button_presets")
      .select("name, buttons")
      .eq("id", arg)
      .maybeSingle();
    if (!preset) {
      await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Preset not found", show_alert: true });
      return true;
    }
    await saveDraft(fromId, { reply_markup: (preset as any).buttons });
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: `Applied "${(preset as any).name}"` });
    await promptConfirm(fromId, chatId);
    return true;
  }

  // /nuke confirmation
  if (op === "nuke") {
    const { runNuke } = await import("@/lib/broadcast.server");
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Nuking…" });
    try {
      const res = await runNuke({ broadcastId: arg, fromId });
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: `☢️ <b>Nuke complete</b>\n✅ Deleted: <b>${res.deleted}</b>\n❌ Failed: <b>${res.failed}</b>`,
        parse_mode: "HTML",
      });
    } catch (e: any) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ Nuke failed: ${e?.message ?? e}` });
    }
    if (cq.message?.message_id) {
      try { await telegramCall("editMessageReplyMarkup", { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch { /* ignore */ }
    }
    return true;
  }
  if (op === "nukex") {
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Cancelled" });
    if (cq.message?.message_id) {
      try { await telegramCall("editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: "☢️ Nuke cancelled." }); } catch { /* ignore */ }
    }
    return true;
  }

  // /broadcasts row actions
  if (op === "v") {
    await showBroadcastDetail(fromId, chatId, arg, cq.id);
    return true;
  }
  if (op === "cx") {
    await cancelPendingBroadcast(fromId, chatId, arg, cq.id);
    return true;
  }
  if (op === "cd") {
    await cancelAutoDeletes(fromId, chatId, arg, cq.id);
    return true;
  }

  // Edit-after-send: start
  if (op === "ed") {
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
    await startEditFlow(fromId, chatId, arg);
    return true;
  }

  // Edit-after-send: apply
  if (op === "egox" && draft?.editing_broadcast_id) {
    if (!draft.source_chat_id || !draft.source_message_id) {
      await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "No new content yet.", show_alert: true });
      return true;
    }
    await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "Applying edit…" });
    // Fetch the new source message details from Telegram by copying it into DM — no; we have it stored.
    // We need the full Message object to build InputMedia. Re-fetch by looking at the last stored preview isn't enough,
    // so we instead read the message via a self-copy trick: forwardMessage into DM would re-send.
    // Simpler: the wizard captured the message directly; reconstruct file_ids by reading the raw update — but the draft
    // only stored ids. We hydrate by using getChat / but Bot API has no getMessage. So we asked the admin to send in DM;
    // that message already lives at source_chat_id/source_message_id. Re-fetch via a forwardMessage→ourselves? That
    // creates a new message. Instead, we store the raw message in the draft row.
    const newSource = draft.source_message_json ?? null;
    if (!newSource) {
      await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Lost the new content — please /editpost again." });
      await clearDraft(fromId);
      return true;
    }
    try {
      const res = await runEditBroadcast({
        broadcastId: draft.editing_broadcast_id,
        fromId,
        newSource,
      });
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: formatEditReport(res),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (e: any) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ Edit failed: ${e?.message ?? e}` });
    }
    await clearDraft(fromId);
    return true;
  }

  await telegramCall("answerCallbackQuery", { callback_query_id: cq.id });
  return true;
}

async function commitDraft(fromId: number, fromName: string, chatId: number) {
  const d = await getDraft(fromId);
  if (!d) return;
  if (!d.source_chat_id || !d.source_message_id || !(d.selected_chat_ids ?? []).length) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Draft incomplete." });
    await clearDraft(fromId);
    return;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Split mode: two posts alternating A/B/A/B across the selected channels.
  if (d.split_enabled && d.split_source_chat_id && d.split_source_message_id) {
    await commitSplitDraft(fromId, fromName, chatId, d);
    return;
  }
  const { data: bc, error } = await supabaseAdmin
    .from("broadcasts")
    .insert({
      created_by: fromId,
      created_by_name: fromName,
      source_chat_id: d.source_chat_id,
      source_message_id: d.source_message_id,
      source_message_ids: (d as any).source_message_ids?.length ? (d as any).source_message_ids : null,
      preview_text: d.preview_text,
      scheduled_at: d.scheduled_at,
      auto_delete_seconds: d.auto_delete_seconds,
      mode: d.mode ?? "copy",
      reply_markup: d.reply_markup ?? null,
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !bc) {
    await telegramCall("sendMessage", { chat_id: chatId, text: `❌ Failed to create broadcast: ${error?.message ?? "unknown"}` });
    return;
  }
  // Targets
  const { data: chats } = await supabaseAdmin
    .from("telegram_chats")
    .select("chat_id, title, username")
    .in("chat_id", d.selected_chat_ids);
  const targetRows = (d.selected_chat_ids as number[]).map((cid) => {
    const c = (chats as any[] | null | undefined)?.find((x) => Number(x.chat_id) === Number(cid));
    return {
      broadcast_id: bc.id,
      chat_id: cid,
      chat_title: c?.title ?? c?.username ?? String(cid),
    };
  });
  await supabaseAdmin.from("broadcast_targets").insert(targetRows);
  await clearDraft(fromId);

  if (!d.scheduled_at) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "🚀 Sending now…" });
    try {
      const res = await executeBroadcast(bc.id);
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: formatDeliveryReport(res.targets, res.status),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (e: any) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ Send failed: ${e?.message ?? e}` });
    }
  } else {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text: `⏰ Scheduled for ${fmtIST(d.scheduled_at)}. Use /broadcasts to view or cancel.`,
    });
  }
}

async function showBroadcastDetail(fromId: number, chatId: number, id: string, cqId: string) {
  return _showBroadcastDetail(fromId, chatId, id, cqId);
}

/** Create two broadcasts (A and B) and alternate the selected channels between them. */
async function commitSplitDraft(fromId: number, fromName: string, chatId: number, d: any) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const selected: number[] = ((d.selected_chat_ids ?? []) as any[]).map(Number);
  const groupId = crypto.randomUUID();

  const { data: chats } = await supabaseAdmin
    .from("telegram_chats")
    .select("chat_id, title, username")
    .in("chat_id", selected);
  const titleOf = (cid: number) => {
    const c = (chats as any[] | null | undefined)?.find((x) => Number(x.chat_id) === Number(cid));
    return String(c?.title ?? c?.username ?? cid);
  };

  const variants = [
    {
      label: "A" as const,
      source_chat_id: Number(d.source_chat_id),
      source_message_id: Number(d.source_message_id),
      source_message_ids: d.source_message_ids?.length ? d.source_message_ids : null,
      preview_text: d.preview_text ?? null,
      chatIds: selected.filter((_, i) => i % 2 === 0),
    },
    {
      label: "B" as const,
      source_chat_id: Number(d.split_source_chat_id),
      source_message_id: Number(d.split_source_message_id),
      source_message_ids: d.split_source_message_ids?.length ? d.split_source_message_ids : null,
      preview_text: d.split_preview_text ?? null,
      chatIds: selected.filter((_, i) => i % 2 === 1),
    },
  ];

  const created: Array<{ label: "A" | "B"; id: string; count: number }> = [];
  for (const v of variants) {
    if (!v.chatIds.length) continue;
    const { data: bc, error } = await supabaseAdmin
      .from("broadcasts")
      .insert({
        created_by: fromId,
        created_by_name: fromName,
        source_chat_id: v.source_chat_id,
        source_message_id: v.source_message_id,
        source_message_ids: v.source_message_ids,
        preview_text: v.preview_text,
        scheduled_at: d.scheduled_at,
        auto_delete_seconds: d.auto_delete_seconds,
        mode: d.mode ?? "copy",
        reply_markup: d.reply_markup ?? null,
        status: "pending",
        split_group_id: groupId,
        split_variant: v.label,
      })
      .select("id")
      .single();
    if (error || !bc) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ Failed to create post ${v.label}: ${error?.message ?? "unknown"}` });
      continue;
    }
    await supabaseAdmin.from("broadcast_targets").insert(
      v.chatIds.map((cid) => ({ broadcast_id: (bc as any).id, chat_id: cid, chat_title: titleOf(cid) })),
    );
    created.push({ label: v.label, id: (bc as any).id, count: v.chatIds.length });
  }
  await clearDraft(fromId);

  if (!created.length) return;

  if (d.scheduled_at) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      text:
        `⏰ Split broadcast scheduled for ${fmtIST(d.scheduled_at)}.\n` +
        created.map((c) => `${c.label === "A" ? "🅰️" : "🅱️"} ${c.count} channel${c.count === 1 ? "" : "s"}`).join("\n"),
    });
    return;
  }

  await telegramCall("sendMessage", {
    chat_id: chatId,
    text: `🚀 Sending split broadcast…\n${created.map((c) => `${c.label === "A" ? "🅰️" : "🅱️"} ${c.count} channel${c.count === 1 ? "" : "s"}`).join("\n")}`,
  });
  for (const c of created) {
    try {
      const res = await executeBroadcast(c.id);
      await telegramCall("sendMessage", {
        chat_id: chatId,
        text: `${c.label === "A" ? "🅰️" : "🅱️"} <b>Post ${c.label}</b>\n` + formatDeliveryReport(res.targets, res.status),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (e: any) {
      await telegramCall("sendMessage", { chat_id: chatId, text: `❌ Post ${c.label} failed: ${e?.message ?? e}` });
    }
  }
}

async function _showBroadcastDetail(fromId: number, chatId: number, id: string, cqId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: bc } = await supabaseAdmin.from("broadcasts").select("*").eq("id", id).eq("created_by", fromId).maybeSingle();
  if (!bc) {
    await telegramCall("answerCallbackQuery", { callback_query_id: cqId, text: "Not found", show_alert: true });
    return;
  }
  const { data: targets } = await supabaseAdmin.from("broadcast_targets").select("chat_id, chat_title, status, error, delete_at").eq("broadcast_id", id);
  const b = bc as any;
  const lines = [
    `📣 <b>Broadcast ${b.status}</b>`,
    `Preview: <i>${escapeHtml((b.preview_text ?? "").slice(0, 200))}</i>`,
    b.scheduled_at ? `Scheduled: ${fmtIST(b.scheduled_at)}` : "Immediate",
    b.sent_at ? `Sent: ${fmtIST(b.sent_at)}` : "",
    b.auto_delete_seconds ? `Auto-delete: ${fmtDuration(b.auto_delete_seconds)}` : "No auto-delete",
    "",
    "Targets:",
    ...((targets as any[] | null | undefined) ?? []).map((t) => {
      const del = t.delete_at ? ` (del ${fmtIST(t.delete_at)})` : "";
      const err = t.error ? ` — ${escapeHtml(t.error.slice(0, 60))}` : "";
      return `  • ${t.status} ${escapeHtml(t.chat_title ?? String(t.chat_id))}${del}${err}`;
    }),
  ].filter(Boolean);
  await telegramCall("answerCallbackQuery", { callback_query_id: cqId });
  await telegramCall("sendMessage", { chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" });
}

async function cancelPendingBroadcast(fromId: number, chatId: number, id: string, cqId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: bc } = await supabaseAdmin.from("broadcasts").select("id, status").eq("id", id).eq("created_by", fromId).maybeSingle();
  if (!bc) { await telegramCall("answerCallbackQuery", { callback_query_id: cqId, text: "Not found", show_alert: true }); return; }
  if ((bc as any).status !== "pending") {
    await telegramCall("answerCallbackQuery", { callback_query_id: cqId, text: "Already sent.", show_alert: true }); return;
  }
  await supabaseAdmin.from("broadcasts").update({ status: "cancelled" }).eq("id", id);
  await telegramCall("answerCallbackQuery", { callback_query_id: cqId, text: "Cancelled" });
  await telegramCall("sendMessage", { chat_id: chatId, text: "🗑 Broadcast cancelled." });
}

async function cancelAutoDeletes(fromId: number, chatId: number, id: string, cqId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: bc } = await supabaseAdmin.from("broadcasts").select("id").eq("id", id).eq("created_by", fromId).maybeSingle();
  if (!bc) { await telegramCall("answerCallbackQuery", { callback_query_id: cqId, text: "Not found", show_alert: true }); return; }
  const { error } = await supabaseAdmin
    .from("broadcast_targets")
    .update({ delete_at: null })
    .eq("broadcast_id", id)
    .eq("status", "sent")
    .not("delete_at", "is", null);
  if (error) {
    await telegramCall("answerCallbackQuery", { callback_query_id: cqId, text: "Failed", show_alert: true }); return;
  }
  await telegramCall("answerCallbackQuery", { callback_query_id: cqId, text: "Auto-delete cancelled" });
  await telegramCall("sendMessage", { chat_id: chatId, text: "🚫 Auto-delete cleared for remaining targets." });
}

// ================== Button presets ==================

/** Presets are shared across all bot admins: one row per name, any admin can save/overwrite/use it. */
async function upsertSharedPreset(fromId: number, name: string, kb: any[][]) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("broadcast_button_presets").delete().eq("name", name);
  await supabaseAdmin.from("broadcast_button_presets").insert({
    user_id: fromId,
    name,
    buttons: { inline_keyboard: kb },
    updated_at: new Date().toISOString(),
  });
}

async function promptButtonsMenu(fromId: number, chatId: number) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: presets } = await supabaseAdmin
    .from("broadcast_button_presets")
    .select("id, name")
    .order("name", { ascending: true })
    .limit(20);
  const rows: any[][] = [];
  for (const p of (presets as any[] | null | undefined) ?? []) {
    rows.push([{ text: `📌 ${p.name}`, callback_data: `bc:btp:${p.id}` }]);
  }
  rows.push([{ text: "✏️ Type custom", callback_data: "bc:btn" }]);
  rows.push([{ text: "🗑 Remove buttons", callback_data: "bc:btc" }, { text: "↩️ Back", callback_data: "bc:bk" }]);
  await telegramCall("sendMessage", {
    chat_id: chatId,
    parse_mode: "HTML",
    text:
      "🔘 <b>Buttons</b>\n\nPick a saved preset, type a custom set, or remove buttons. Save presets with <code>/savebtn &lt;name&gt;</code> (first line = name, then button lines).",
    reply_markup: { inline_keyboard: rows },
  });
}

async function listButtonPresets(fromId: number, chatId: number) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: presets } = await supabaseAdmin
    .from("broadcast_button_presets")
    .select("name, buttons, updated_at")
    .order("name", { ascending: true });
  if (!presets?.length) {
    await telegramCall("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        "No saved button presets yet.\n\nSave one with <code>/savebtn</code> then reply with:\n<pre>preset name\nLabel - https://url | Label2 - https://url2\nRow2 - https://url</pre>",
    });
    return;
  }
  const lines: string[] = ["🔘 <b>Shared button presets</b>\n"];
  for (const p of presets as any[]) {
    const kb = (p.buttons?.inline_keyboard ?? []) as any[][];
    lines.push(`<b>${escapeHtml(p.name)}</b>\n<pre>${escapeHtml(kb.map((r) => r.map((b: any) => `[${b.text}]`).join(" ")).join("\n"))}</pre>`);
  }
  lines.push("\nDelete with <code>/delbtn &lt;name&gt;</code>.");
  await telegramCall("sendMessage", { chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" });
}

async function saveButtonPresetCommand(fromId: number, chatId: number, argText: string) {
  // argText is the full command text e.g. "/savebtn myname\nLabel - url\n..."
  const afterCmd = argText.replace(/^\/savebtn(@\S+)?\s*/i, "");
  const nl = afterCmd.indexOf("\n");
  if (nl === -1 || !afterCmd.slice(nl + 1).trim()) {
    // Prompt for follow-up
    await saveDraft(fromId, { awaiting_custom: "savebtn" });
    await telegramCall("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        "🔘 <b>Save button preset — you can add as many buttons as you like</b>\n\n" +
        "Reply with the preset name on line 1, then one or more button rows:\n" +
        "• Each button: <code>Label - https://url</code>\n" +
        "• <code>|</code> = same row, new line = new row\n\n" +
        "<pre>my_preset\n" +
        "Channel - https://t.me/mychannel | Bot - https://t.me/mybot\n" +
        "Manga - https://t.me/manga | Anime - https://t.me/anime\n" +
        "Support - https://t.me/support</pre>",
    });
    return;
  }
  const name = afterCmd.slice(0, nl).trim();
  const spec = afterCmd.slice(nl + 1);
  if (!name) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Missing preset name." });
    return;
  }
  try {
    const kb = parseButtonSpec(spec);
    await upsertSharedPreset(fromId, name, kb);
    await telegramCall("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `✅ Saved preset <b>${escapeHtml(name)}</b>:\n<pre>${escapeHtml(keyboardPreview(kb))}</pre>`,
    });
  } catch (e: any) {
    await telegramCall("sendMessage", { chat_id: chatId, text: `❌ ${e?.message ?? "invalid button spec"}` });
  }
}

async function deleteButtonPreset(fromId: number, chatId: number, name: string) {
  if (!name) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "Usage: <code>/delbtn &lt;name&gt;</code>", parse_mode: "HTML" });
    return;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error, count } = await supabaseAdmin
    .from("broadcast_button_presets")
    .delete({ count: "exact" })
    .eq("name", name);
  if (error) {
    await telegramCall("sendMessage", { chat_id: chatId, text: `❌ ${error.message}` });
    return;
  }
  await telegramCall("sendMessage", { chat_id: chatId, text: count ? `🗑 Deleted preset "${name}".` : `❌ No preset named "${name}".` });
}