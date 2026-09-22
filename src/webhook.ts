import { timingSafeEqual } from "crypto";

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

// Idempotency guard: Telegram re-delivers an update when the webhook is slow to
// ACK. Without this, /restore and broadcasts executed several times in a row.
const seenUpdates = new Map<number, number>();

async function isBotAdmin(supabaseAdmin: any, fromId: number): Promise<{ role: string | null; is: boolean }> {
  const { data } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("role")
    .eq("user_id", fromId)
    .maybeSingle();
  return { role: data?.role ?? null, is: !!data };
}

async function handleWhoAmI(args: {
  fromId: number;
  fromName: string;
  replyChatId: number;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, fromName, replyChatId, telegramCall, supabaseAdmin } = args;
  const { role, is } = await isBotAdmin(supabaseAdmin, fromId);
  let badge: string;
  if (!is) badge = "👤 regular user (no bot access)";
  else if (role === "super_admin") badge = "👑 super admin (owner)";
  else badge = "🛡 admin";
  await telegramCall("sendMessage", {
    chat_id: replyChatId,
    text: `<b>${escapeHtml(fromName)}</b>\nID: <code>${fromId}</code>\nRole: ${badge}`,
    parse_mode: "HTML",
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function chunkText(s: string, size: number): string[] {
  if (s.length <= size) return [s];
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + size, s.length);
    if (end < s.length) {
      const nl = s.lastIndexOf("\n\n", end);
      if (nl > i + 500) end = nl;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

// Compact category listing shown for /help and /start (screenshot style).
const HELP_COMPACT =
  "🤖 <b>Bot commands</b>\n" +
  "Type /description for full details.\n\n" +
  "🧭 <b>General</b>\n" +
  "/start • /help • /description • /whoami • /ping • /restart • /id • /rules\n\n" +
  "📡 <b>Channels</b>\n" +
  "/channels • /checkmember &lt;user_id|@username&gt; • /leave [chat_id] • /invite &lt;chat_id&gt;\n\n" +
  "📚 <b>Channel lists</b>\n" +
  "/lists • /showlist &lt;name&gt; • /createlist &lt;name&gt; [chat_id…] • /addtolist &lt;name&gt; &lt;chat_id…&gt; • /removefromlist &lt;name&gt; &lt;chat_id…&gt; • /dellist &lt;name&gt; • /adultchannels • /mangachannels\n\n" +
  "📣 <b>Broadcast</b>\n" +
  "/post • /post &lt;n&gt; • /splitpost [a] [b] • /crosspost • /broadcasts • /listpost • /dltpost &lt;n&gt; • /editpost &lt;id&gt; • /cancel\n\n" +
  "🔘 <b>Buttons</b>\n" +
  "/buttons • /savebtn &lt;name&gt; • /delbtn &lt;name&gt;\n\n" +
  "📝 <b>Templates</b>\n" +
  "/templates • /savetpl &lt;name&gt; • /deltpl &lt;name&gt; • /posttpl &lt;name&gt;\n\n" +
  "💬 <b>Engagement</b>\n" +
  "/react on|off • /comment &lt;channel_id&gt; &lt;message_id&gt; &lt;text&gt;\n\n" +
  "🔁 <b>Recurring</b>\n" +
  "/recur &lt;n|id&gt; &lt;spec&gt; [in&lt;time&gt;] • /listrecur • /pauserecur &lt;n&gt; • /resumerecur &lt;n&gt; • /dltrecur &lt;n|id&gt;\n\n" +
  "🔐 <b>Permissions</b>\n" +
  "/permissions [chat_id] • /checkperms\n\n" +
  "☢️ <b>Nuke</b>\n" +
  "/nuke • /nuke &lt;id&gt; • /dltmsg &lt;link&gt;\n\n" +
  "🗄 <b>Backup</b>\n" +
  "/backup • /restore\n\n" +
  "📊 <b>Stats</b>\n" +
  "/stats\n\n" +
  "🛡 <b>Admin management</b>\n" +
  "/addadmin &lt;user_id&gt; [super] • /addadmin &lt;chat_id&gt; &lt;user_id&gt; • /radmin &lt;user_id&gt; • /listadmins";

// Full descriptions shown for /description.
const HELP_DETAILED =
  "📖 <b>Full command reference</b>\n\n" +
  "🧭 <b>General</b>\n" +
  "/start, /help — compact command list\n" +
  "/description — this detailed reference\n" +
  "/whoami — show your bot role (owner / admin / user)\n" +
  "/ping — check the bot is alive\n" +
  "/restart — clear any stuck wizard/step state and start fresh (alias /reset).\n" +
  "/id — show your Telegram ID and current chat ID\n" +
  "/rules — show the group rules (in a group)\n\n" +
  "📡 <b>Channels</b> (bot admins)\n" +
  "/channels — DM only. List every group/channel where I'm admin, in the order I was added, with invite links.\n" +
  "/checkmember &lt;user_id|@username&gt; — DM only. Check every chat where I'm admin and mark 👤 if that user is in it, ❌👤 if not.\n" +
  "/leave [chat_id] — make me leave the current chat, or (in DM) a chat by ID.\n" +
  "/invite &lt;chat_id&gt; — get or generate an invite link for a private chat.\n\n" +
  "📚 <b>Channel lists</b> (bot admins, DM)\n" +
  "/lists — show every list with member counts.\n" +
  "/showlist &lt;name&gt; — show channels in a list, live-verified.\n" +
  "/createlist &lt;name&gt; [chat_id…] — create a new list, optionally seeded with channels.\n" +
  "/addtolist &lt;name&gt; &lt;chat_id…&gt; — add channels (auto-creates the list if new).\n" +
  "/removefromlist &lt;name&gt; &lt;chat_id…&gt; — remove channels from a list.\n" +
  "/dellist &lt;name&gt; — delete a list entirely.\n" +
  "/adultchannels, /mangachannels — shortcuts for the built-in lists.\n" +
  "Name rules: 1–30 chars, letters/digits/underscore.\n\n" +
  "📣 <b>Broadcast</b> (bot admins, DM)\n" +
  "/post — start the broadcast wizard: content → channels → mode → buttons → auto-delete → schedule → confirm.\n" +
  "/post &lt;number&gt; — reuse a previous post from /listpost (jumps into the channel picker).\n" +
  "/splitpost [a] [b] — send two different posts in one run: channels alternate 🅰️,🅱️,🅰️,🅱️… Give two /listpost numbers (<code>/splitpost 1 3</code>), one number (bot asks for post B), reply to a message with /splitpost, or send both in the wizard.\n" +
  "/listpost — numbered list of your last 20 broadcasts.\n" +
  "/dltpost &lt;number&gt; — remove a post from your history (does not delete already-sent channel messages; use /nuke for that).\n" +
  "/crosspost — same wizard but forwards with the “forwarded from” header.\n" +
  "/broadcasts — recent broadcasts with ✏️ Edit / 💣 Nuke buttons.\n" +
  "/editpost &lt;broadcast_id&gt; — replace a sent broadcast's content across every target channel.\n" +
  "/cancel — abort the current wizard.\n\n" +
  "🔘 <b>Buttons</b> (bot admins)\n" +
  "/buttons — list your saved inline-button presets.\n" +
  "/savebtn &lt;name&gt; — save an inline URL-button preset. Format: <code>Label - https://url</code>, <code>|</code> = same row, newline = new row.\n" +
  "/delbtn &lt;name&gt; — delete a preset.\n\n" +
  "📝 <b>Templates</b> (bot admins, DM)\n" +
  "/templates — list saved post templates.\n" +
  "/savetpl &lt;name&gt; — reply to a message with this to save it as a template.\n" +
  "/deltpl &lt;name&gt; — delete a template.\n" +
  "/posttpl &lt;name&gt; — start a broadcast from a saved template.\n\n" +
  "💬 <b>Engagement</b>\n" +
  "/react on|off — DM only. Auto-react to every message you send me with a random emoji.\n" +
  "/comment &lt;channel_id&gt; &lt;message_id&gt; &lt;text&gt; — post a comment under a channel post via its linked discussion group.\n\n" +
  "☢️ <b>Nuke</b> (super admins, DM)\n" +
  "/nuke — delete your latest broadcast from every channel it went to.\n" +
  "/nuke &lt;broadcast_id&gt; — target a specific broadcast.\n\n" +
  "/dltmsg &lt;t.me link&gt; — delete a single message from a channel, e.g. /dltmsg https://t.me/c/2797430230/63 (also accepts &lt;chat_id&gt; &lt;message_id&gt;).\n\n" +
  "🔁 <b>Recurring</b> (bot admins, DM)\n" +
  "/recur &lt;number|broadcast_id&gt; &lt;spec&gt; [in&lt;time&gt;] — turn any existing broadcast into a repeating schedule. The number comes from /listpost. Specs: <code>daily HH:MM</code>, <code>weekly &lt;day&gt; HH:MM</code>, <code>monthly &lt;day&gt; HH:MM</code> (all IST), or <code>cron &lt;expr&gt;</code> (UTC). Optional trailing <code>in5m</code> / <code>in2h</code> / <code>in1d</code> sets auto-delete (max 48h), overriding the template.\n" +
  "Example: <code>/recur 1 daily 09:00 in5m</code>\n" +
  "/listrecur — numbered list of your recurring posts.\n" +
  "/pauserecur &lt;number|id&gt; — pause a recurring schedule (keeps it in the list).\n" +
  "/resumerecur &lt;number|id&gt; — resume a paused schedule; next run is recomputed.\n" +
  "/dltrecur &lt;number|id&gt; — remove a recurring schedule.\n\n" +
  "🔐 <b>Permissions monitor</b> (bot admins, DM)\n" +
  "/permissions — overview of the bot's admin rights across every tracked chat.\n" +
  "/permissions &lt;chat_id&gt; — detailed permissions for one chat.\n" +
  "/checkperms — force a full permission check now. (Runs automatically every 6h and DMs alerts when the bot loses rights.)\n\n" +
  "🗄 <b>Backup</b> (super admins, DM)\n" +
  "/backup — DM you a JSON backup of all app data right now. A weekly backup is also sent automatically.\n" +
  "/restore — upload a backup JSON as a document with caption <code>/restore</code> to restore.\n\n" +
  "📊 <b>Stats</b>\n" +
  "/stats — global bot stats (bot admins).\n\n" +
  "🛡 <b>Admin management</b>\n" +
  "/addadmin &lt;user_id&gt; [super] — grant bot access. <code>super</code> makes them a super admin (super admins only).\n" +
  "/addadmin &lt;chat_id&gt; &lt;user_id&gt; — promote that user as admin in the chat with <b>all</b> permissions.\n" +
  "/radmin &lt;user_id&gt; — revoke bot access (super admins only for other super admins).\n" +
  "/listadmins — list bot admins.\n" +
  "(The first caller becomes the owner 👑 automatically.)";

async function handleStats(args: {
  fromId: number;
  replyChatId: number;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, replyChatId, telegramCall, supabaseAdmin } = args;
  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Only bot admins can use /stats." });
    return;
  }
  const since24 = new Date(Date.now() - 86400_000).toISOString();
  const [chats, members, msgs24, msgsAll, bcTotal, bcPending] = await Promise.all([
    supabaseAdmin.from("telegram_chats").select("type", { count: "exact" }),
    supabaseAdmin.from("telegram_members").select("user_id", { count: "exact", head: true }),
    supabaseAdmin.from("telegram_messages").select("update_id", { count: "exact", head: true }).gte("created_at", since24),
    supabaseAdmin.from("telegram_messages").select("update_id", { count: "exact", head: true }),
    supabaseAdmin.from("broadcasts").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("broadcasts").select("id", { count: "exact", head: true }).eq("status", "pending"),
  ]);
  const buckets = { channel: 0, supergroup: 0, group: 0, private: 0 } as Record<string, number>;
  for (const c of (chats.data as any[]) ?? []) buckets[c.type ?? "other"] = (buckets[c.type ?? "other"] ?? 0) + 1;
  const lines = [
    "📊 <b>Bot stats</b>",
    "",
    `📢 Channels: <b>${buckets.channel ?? 0}</b>`,
    `👥 Supergroups: <b>${buckets.supergroup ?? 0}</b>`,
    `👥 Groups: <b>${buckets.group ?? 0}</b>`,
    `👤 Members tracked: <b>${members.count ?? 0}</b>`,
    "",
    `💬 Messages seen (24h): <b>${msgs24.count ?? 0}</b>`,
    `💬 Messages seen (all): <b>${msgsAll.count ?? 0}</b>`,
    "",
    `📣 Broadcasts total: <b>${bcTotal.count ?? 0}</b>`,
    `⏰ Broadcasts pending: <b>${bcPending.count ?? 0}</b>`,
  ];
  await telegramCall("sendMessage", { chat_id: replyChatId, text: lines.join("\n"), parse_mode: "HTML" });
}

async function handleInvite(args: {
  fromId: number;
  argText: string;
  replyChatId: number;
  currentChat: { id: number; type: string; username?: string };
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, argText, replyChatId, currentChat, telegramCall, supabaseAdmin } = args;
  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Only bot admins can use /invite." });
    return;
  }
  const parts = argText.trim().split(/\s+/);
  const rawArg = parts[1];
  let targetId: number | null = null;
  if (rawArg) {
    const n = Number(rawArg);
    if (!Number.isFinite(n)) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "Usage: /invite <chat_id>" });
      return;
    }
    targetId = n;
  } else if (currentChat.type !== "private") {
    targetId = currentChat.id;
  } else {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "Usage: /invite <chat_id>\nRun /channels to see chat IDs." });
    return;
  }
  try {
    const info = await telegramCall("getChat", { chat_id: targetId });
    let link: string | undefined = info?.invite_link;
    let username: string | undefined = info?.username;
    if (!link && username) link = `https://t.me/${username}`;
    if (!link) {
      try {
        const created = await telegramCall("exportChatInviteLink", { chat_id: targetId });
        if (typeof created === "string") link = created;
      } catch (e) {
        console.warn("exportChatInviteLink failed", targetId, e);
      }
    }
    if (!link) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "🔒 No invite permission for that chat. Give me 'Invite users' admin right." });
      return;
    }
    const title = info?.title ?? info?.username ?? String(targetId);
    await telegramCall("sendMessage", {
      chat_id: replyChatId,
      text: `🔗 <b>${escapeHtml(title)}</b>\n${link}`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e: any) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: `❌ Failed: ${e?.message ?? "unknown"}` });
  }
}

function previewOfMessage(m: any): string {
  if (m.text) return m.text.slice(0, 120);
  if (m.caption) return `[media] ${m.caption.slice(0, 100)}`;
  if (m.photo) return "[photo]";
  if (m.video) return "[video]";
  if (m.document) return `[document] ${m.document.file_name ?? ""}`;
  if (m.animation) return "[gif]";
  if (m.audio) return "[audio]";
  if (m.voice) return "[voice]";
  if (m.sticker) return `[sticker] ${m.sticker.emoji ?? ""}`;
  return "[message]";
}

async function handleTemplateCommands(args: {
  cmd: string;
  fromId: number;
  fromName: string;
  argText: string;
  replyChatId: number;
  chatType: string;
  message: any;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { cmd, fromId, fromName, argText, replyChatId, chatType, message, telegramCall, supabaseAdmin } = args;
  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Only bot admins can use templates." });
    return;
  }
  if (chatType !== "private") {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: `🔒 Use ${cmd} in a private chat with me.` });
    return;
  }
  const parts = argText.trim().split(/\s+/);
  const name = parts[1];

  if (cmd === "/templates") {
    const { data: rows } = await supabaseAdmin
      .from("broadcast_templates")
      .select("name, preview_text, mode, created_at")
      .eq("user_id", fromId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!rows?.length) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "No templates yet. Reply to a message with /savetpl <name>." });
      return;
    }
    const lines = ["📚 <b>Your templates</b>", ""];
    for (const r of rows as any[]) {
      const badge = r.mode === "forward" ? "🔁" : "📝";
      lines.push(`${badge} <b>${escapeHtml(r.name)}</b> — <i>${escapeHtml((r.preview_text ?? "").slice(0, 60))}</i>`);
    }
    lines.push("", "Use /posttpl <name> to send.");
    await telegramCall("sendMessage", { chat_id: replyChatId, text: lines.join("\n"), parse_mode: "HTML" });
    return;
  }

  if (cmd === "/savetpl") {
    if (!name) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "Usage: reply to a message with /savetpl <name>" });
      return;
    }
    const src = message.reply_to_message;
    if (!src?.message_id) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Reply to the message you want to save as this template." });
      return;
    }
    const { error } = await supabaseAdmin.from("broadcast_templates").upsert(
      {
        user_id: fromId,
        name,
        source_chat_id: src.chat?.id ?? replyChatId,
        source_message_id: src.message_id,
        preview_text: previewOfMessage(src),
        mode: "copy",
      },
      { onConflict: "user_id,name" },
    );
    if (error) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: `❌ Save failed: ${error.message}` });
      return;
    }
    await telegramCall("sendMessage", { chat_id: replyChatId, text: `✅ Saved template <b>${escapeHtml(name)}</b>. Send with /posttpl ${escapeHtml(name)}.`, parse_mode: "HTML" });
    return;
  }

  if (cmd === "/deltpl") {
    if (!name) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "Usage: /deltpl <name>" });
      return;
    }
    const { error, count } = await supabaseAdmin
      .from("broadcast_templates")
      .delete({ count: "exact" })
      .eq("user_id", fromId)
      .eq("name", name);
    if (error) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: `❌ Delete failed: ${error.message}` });
      return;
    }
    await telegramCall("sendMessage", { chat_id: replyChatId, text: count ? `🗑 Deleted template ${name}.` : `ℹ️ No template named ${name}.` });
    return;
  }

  if (cmd === "/posttpl") {
    if (!name) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "Usage: /posttpl <name>" });
      return;
    }
    const { data: tpl } = await supabaseAdmin
      .from("broadcast_templates")
      .select("*")
      .eq("user_id", fromId)
      .eq("name", name)
      .maybeSingle();
    if (!tpl) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: `❌ No template named ${name}.` });
      return;
    }
    const t = tpl as any;
    const { startBroadcastFromTemplate } = await import("@/lib/broadcast-wizard.server");
    await telegramCall("sendMessage", {
      chat_id: replyChatId,
      text: `📚 Loading template <b>${escapeHtml(name)}</b>…`,
      parse_mode: "HTML",
    });
    await startBroadcastFromTemplate({
      fromId,
      chatId: replyChatId,
      template: {
        source_chat_id: t.source_chat_id,
        source_message_id: t.source_message_id,
        preview_text: t.preview_text,
        mode: t.mode,
      },
    });
    return;
  }
}

async function handleReactToggle(args: {
  fromId: number;
  argText: string;
  chat: { id: number; type: string };
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, argText, chat, telegramCall, supabaseAdmin } = args;
  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) {
    await telegramCall("sendMessage", { chat_id: chat.id, text: "❌ Only bot admins can use /react." });
    return;
  }
  if (chat.type !== "private") {
    await telegramCall("sendMessage", { chat_id: chat.id, text: "❌ /react only works in a private chat with me (DM)." });
    return;
  }
  const arg = (argText.trim().split(/\s+/)[1] ?? "").toLowerCase();
  if (arg !== "on" && arg !== "off") {
    const { data: cur } = await supabaseAdmin.from("telegram_chats").select("reactions_enabled").eq("chat_id", chat.id).maybeSingle();
    await telegramCall("sendMessage", { chat_id: chat.id, text: `😀 Auto-react in this DM is currently <b>${cur?.reactions_enabled ? "ON" : "OFF"}</b>.\nUse /react on or /react off.`, parse_mode: "HTML" });
    return;
  }
  const enabled = arg === "on";
  await supabaseAdmin
    .from("telegram_chats")
    .upsert(
      { chat_id: chat.id, type: chat.type, reactions_enabled: enabled },
      { onConflict: "chat_id" },
    );
  await telegramCall("sendMessage", { chat_id: chat.id, text: enabled ? "😀 Auto-reactions enabled — I'll react to every message you send me here." : "🚫 Auto-reactions disabled." });
}

async function handleComment(args: {
  fromId: number;
  argText: string;
  replyChatId: number;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, argText, replyChatId, telegramCall, supabaseAdmin } = args;
  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Only bot admins can use /comment." });
    return;
  }
  const parts = argText.trim().split(/\s+/);
  const channelId = Number(parts[1]);
  const messageId = Number(parts[2]);
  const text = parts.slice(3).join(" ");
  if (!Number.isFinite(channelId) || !Number.isFinite(messageId) || !text) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "Usage: /comment <channel_id> <message_id> <text>" });
    return;
  }
  try {
    const info = await telegramCall("getChat", { chat_id: channelId });
    const linked = info?.linked_chat_id;
    if (!linked) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ That channel has no linked discussion group — comments aren't possible." });
      return;
    }
    const res = await telegramCall("sendMessage", {
      chat_id: linked,
      text,
      reply_parameters: { chat_id: channelId, message_id: messageId },
    });
    const mid = res?.message_id;
    await telegramCall("sendMessage", {
      chat_id: replyChatId,
      text: `💬 Comment posted${mid ? ` (msg ${mid} in linked group ${linked})` : ""}.`,
    });
  } catch (e: any) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: `❌ Comment failed: ${e?.message ?? "unknown"}` });
  }
}

/** Parse "/dltmsg <t.me link>" or "/dltmsg <chat_id> <message_id>". */
function parseMessageRef(argText: string): { chatRef: string | number; messageId: number } | null {
  const parts = argText.trim().split(/\s+/).slice(1);
  if (parts.length === 0) return null;
  const first = parts[0];
  const linkMatch = first.match(/^(?:https?:\/\/)?t\.me\/(c\/)?([^/]+)\/(?:\d+\/)?(\d+)/i);
  if (linkMatch) {
    const isPrivate = Boolean(linkMatch[1]);
    const messageId = Number(linkMatch[3]);
    if (!Number.isFinite(messageId)) return null;
    return {
      chatRef: isPrivate ? Number(`-100${linkMatch[2]}`) : `@${linkMatch[2]}`,
      messageId,
    };
  }
  if (parts.length >= 2) {
    const cid = Number(parts[0]);
    const mid = Number(parts[1]);
    if (Number.isFinite(cid) && Number.isFinite(mid)) return { chatRef: cid, messageId: mid };
  }
  return null;
}

async function handleDeleteMessageCommand(args: {
  fromId: number;
  argText: string;
  replyChatId: number;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, argText, replyChatId, telegramCall, supabaseAdmin } = args;
  const { data: admin } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("role")
    .eq("user_id", fromId)
    .maybeSingle();
  if (!admin) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Only bot admins can use /dltmsg." });
    return;
  }

  const ref = parseMessageRef(argText);
  if (!ref) {
    await telegramCall("sendMessage", {
      chat_id: replyChatId,
      text: "Usage: <code>/dltmsg https://t.me/c/2797430230/63</code>\nor <code>/dltmsg -1002797430230 63</code>",
      parse_mode: "HTML",
    });
    return;
  }

  // Resolve a friendly title + link for the reply.
  let title = String(ref.chatRef);
  let link: string | null = null;
  if (typeof ref.chatRef === "number") {
    const { data: chatRow } = await supabaseAdmin
      .from("telegram_chats")
      .select("title, username")
      .eq("chat_id", ref.chatRef)
      .maybeSingle();
    if (chatRow?.title) title = chatRow.title;
    link = chatRow?.username
      ? `https://t.me/${chatRow.username}/${ref.messageId}`
      : `https://t.me/c/${String(ref.chatRef).replace(/^-100/, "")}/${ref.messageId}`;
  } else {
    title = ref.chatRef;
    link = `https://t.me/${String(ref.chatRef).slice(1)}/${ref.messageId}`;
  }
  const titleHtml = link
    ? `<a href="${link}">${escapeHtml(title)}</a>`
    : `<b>${escapeHtml(title)}</b>`;

  try {
    await telegramCall("deleteMessage", { chat_id: ref.chatRef, message_id: ref.messageId });
    // Keep tracking rows in sync when this message was part of a broadcast.
    if (typeof ref.chatRef === "number") {
      await supabaseAdmin
        .from("broadcast_targets")
        .update({ status: "deleted", deleted_at: new Date().toISOString() })
        .eq("chat_id", ref.chatRef)
        .eq("sent_message_id", ref.messageId);
    }
    await telegramCall("sendMessage", {
      chat_id: replyChatId,
      text: `🗑 Deleted message <b>${ref.messageId}</b> from ${titleHtml}.`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (e: any) {
    await telegramCall("sendMessage", {
      chat_id: replyChatId,
      text: `❌ Could not delete message <b>${ref.messageId}</b> from ${titleHtml}.\n<i>${escapeHtml(e?.message ?? "unknown error")}</i>`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

async function handleNukeCommand(args: {
  fromId: number;
  argText: string;
  replyChatId: number;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, argText, replyChatId, telegramCall, supabaseAdmin } = args;
  const { data: admin } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("role")
    .eq("user_id", fromId)
    .maybeSingle();
  if (!admin || admin.role !== "super_admin") {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Only super admins can use /nuke." });
    return;
  }

  const arg = argText.trim().split(/\s+/)[1];
  let bcId: string | null = null;
  let bc: any = null;
  if (arg) {
    const { data } = await supabaseAdmin
      .from("broadcasts")
      .select("id, preview_text, sent_at, status, created_by_name")
      .eq("id", arg)
      .maybeSingle();
    if (!data) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Broadcast not found." });
      return;
    }
    bc = data;
    bcId = data.id;
  } else {
    const { data } = await supabaseAdmin
      .from("broadcasts")
      .select("id, preview_text, sent_at, status, created_by_name")
      .eq("created_by", fromId)
      .in("status", ["sent", "partial", "sending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) {
      await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ No recent broadcast of yours to nuke." });
      return;
    }
    bc = data;
    bcId = data.id;
  }

  const { count } = await supabaseAdmin
    .from("broadcast_targets")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", bcId)
    .not("sent_message_id", "is", null)
    .neq("status", "deleted");

  await telegramCall("sendMessage", {
    chat_id: replyChatId,
    text:
      `☢️ <b>Nuking broadcast…</b>\n\n` +
      `Preview: <i>${escapeHtml((bc.preview_text ?? "").slice(0, 200))}</i>\n` +
      `Deleting from <b>${count ?? 0}</b> channel(s)…`,
    parse_mode: "HTML",
  });
  try {
    const { runNuke } = await import("@/lib/broadcast.server");
    const res = await runNuke({ broadcastId: bcId!, fromId });
    await telegramCall("sendMessage", {
      chat_id: replyChatId,
      text: `☢️ <b>Nuke complete</b>\n✅ Deleted: <b>${res.deleted}</b>\n❌ Failed: <b>${res.failed}</b>`,
      parse_mode: "HTML",
    });
  } catch (e: any) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: `❌ Nuke failed: ${e?.message ?? e}` });
  }
}

function formatName(u: { first_name?: string; last_name?: string; username?: string } | null | undefined): string {
  if (!u) return "there";
  return u.first_name || u.username || "there";
}

// Fetch this admin's recent broadcasts (newest first). Numbers are 1-based against this list.
// Post history is shared across all bot admins so any admin can reuse a post.
async function fetchListPost(supabaseAdmin: any, _fromId?: number) {
  const { data } = await supabaseAdmin
    .from("broadcasts")
    .select("id, preview_text, status, mode, scheduled_at, sent_at, created_at, source_chat_id, source_message_id, reply_markup, created_by, created_by_name")
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []) as any[];
}

async function handleListPost(args: {
  fromId: number;
  replyChatId: number;
  chatType: string;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, replyChatId, chatType, telegramCall, supabaseAdmin } = args;
  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Only bot admins can use /listpost." });
    return;
  }
  void chatType;
  const rows = await fetchListPost(supabaseAdmin, fromId);
  if (!rows.length) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "No broadcasts yet. Use /post to make one." });
    return;
  }
  const lines: string[] = ["🗂 <b>Recent posts (all admins)</b>", ""];
  rows.forEach((r, i) => {
    const n = i + 1;
    const badge = r.mode === "forward" ? "🔁" : "📝";
    const when = r.sent_at ?? r.scheduled_at ?? r.created_at;
    const preview = escapeHtml((r.preview_text ?? "").slice(0, 70));
    const who = r.created_by_name ? ` · 👤 ${escapeHtml(String(r.created_by_name))}` : "";
    lines.push(`<b>${n}.</b> ${badge} <b>${r.status}</b> — ${escapeHtml(String(when).slice(0, 16).replace("T", " "))}${who}\n   ${preview}`);
  });
  lines.push("", "Reuse: <code>/post &lt;number&gt;</code>", "Delete from history: <code>/dltpost &lt;number&gt;</code>");
  await telegramCall("sendMessage", { chat_id: replyChatId, text: lines.join("\n"), parse_mode: "HTML" });
}

async function handleDltPost(args: {
  fromId: number;
  argText: string;
  replyChatId: number;
  chatType: string;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, argText, replyChatId, chatType, telegramCall, supabaseAdmin } = args;
  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Only bot admins can use /dltpost." });
    return;
  }
  void chatType;
  const raw = (argText.trim().split(/\s+/)[1] ?? "").trim();
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "Usage: <code>/dltpost &lt;number&gt;</code>\nSee numbers via /listpost.", parse_mode: "HTML" });
    return;
  }
  const rows = await fetchListPost(supabaseAdmin, fromId);
  const bc = rows[n - 1];
  if (!bc) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: `❌ No post #${n} in your list. Run /listpost.` });
    return;
  }
  await supabaseAdmin.from("broadcast_targets").delete().eq("broadcast_id", bc.id);
  const { error } = await supabaseAdmin.from("broadcasts").delete().eq("id", bc.id);
  if (error) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: `❌ Delete failed: ${error.message}` });
    return;
  }
  await telegramCall("sendMessage", {
    chat_id: replyChatId,
    text: `🗑 Removed post #${n} from your history.\n<i>Note: this only clears the record — it does not delete already-sent channel messages. Use /nuke for that.</i>`,
    parse_mode: "HTML",
  });
}

async function handlePostByNumber(args: {
  fromId: number;
  n: number;
  replyChatId: number;
  chatType: string;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, n, replyChatId, chatType, telegramCall, supabaseAdmin } = args;
  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ Only bot admins can use /post." });
    return;
  }
  if (chatType !== "private") {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "🔒 Use /post in a private chat with me." });
    return;
  }
  const rows = await fetchListPost(supabaseAdmin, fromId);
  const bc = rows[n - 1];
  if (!bc) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: `❌ No post #${n} in your list. Run /listpost.` });
    return;
  }
  if (!bc.source_chat_id || !bc.source_message_id) {
    await telegramCall("sendMessage", { chat_id: replyChatId, text: "❌ That post has no source message stored." });
    return;
  }
  const { startBroadcastFromTemplate } = await import("@/lib/broadcast-wizard.server");
  await telegramCall("sendMessage", {
    chat_id: replyChatId,
    text: `♻️ Reusing post #${n}…`,
  });
  await startBroadcastFromTemplate({
    fromId,
    chatId: replyChatId,
    template: {
      source_chat_id: Number(bc.source_chat_id),
      source_message_id: Number(bc.source_message_id),
      preview_text: bc.preview_text ?? null,
      mode: bc.mode ?? "copy",
    },
  });
}

export async function handleWebhookRequest(request: Request): Promise<Response> {
        const { deriveWebhookSecret, telegramCall, getBotIdentity, getChatMemberStatus, setMessageReaction, REACTION_EMOJIS } =
          await import("@/lib/telegram.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { handleBroadcastCommand, handleBroadcastMessage, handleBroadcastCallback } =
          await import("@/lib/broadcast-wizard.server");

        const expected = deriveWebhookSecret();
        const actual = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (!safeEqual(actual, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const update = await request.json();
        if (typeof update.update_id !== "number") {
          return Response.json({ ok: true, ignored: true });
        }

        // Skip any update we've already started (Telegram retries slow webhooks).
        {
          const nowMs = Date.now();
          for (const [id, ts] of seenUpdates) if (nowMs - ts > 10 * 60_000) seenUpdates.delete(id);
          if (seenUpdates.has(update.update_id)) {
            console.warn(`duplicate update ${update.update_id} ignored`);
            return Response.json({ ok: true, duplicate: true });
          }
          seenUpdates.set(update.update_id, nowMs);
        }

        // Callback queries (inline button taps) — route channel-list refresh, then broadcast wizard.
        if (update.callback_query) {
          try {
            const cq = update.callback_query;
            if (typeof cq?.data === "string" && cq.data === "chl:refresh") {
              await handleChannelListRefresh(cq);
            } else {
              await handleBroadcastCallback(cq);
            }
          } catch (e) {
            console.error("callback_query failed", e);
          }
          return Response.json({ ok: true });
        }

        // my_chat_member: bot's own membership changed in a chat
        const myMember = update.my_chat_member;
        if (myMember?.chat?.id) {
          const c = myMember.chat;
          const newStatus: string | undefined = myMember.new_chat_member?.status;
          const oldStatus: string | undefined = myMember.old_chat_member?.status;
          const isAdmin = newStatus === "administrator" || newStatus === "creator";
          const wasAdmin = oldStatus === "administrator" || oldStatus === "creator";
          await supabaseAdmin.from("telegram_chats").upsert(
            {
              chat_id: c.id,
              title: c.title ?? c.username ?? `Chat ${c.id}`,
              type: c.type,
              username: c.username ?? null,
              last_activity_at: new Date().toISOString(),
            },
            { onConflict: "chat_id" },
          );
          // Store bot status via a follow-up update (columns may be added later; ignore if missing)
          try {
            await supabaseAdmin
              .from("telegram_chats")
              .update({
                bot_status: newStatus ?? null,
                bot_is_admin: isAdmin,
                bot_status_checked_at: new Date().toISOString(),
              } as any)
              .eq("chat_id", c.id);
          } catch (e) {
            console.warn("bot_status columns not yet migrated", e);
          }

          // While we still have admin rights, capture an invite link so we can
          // point admins back to the chat even after the bot is kicked.
          if (isAdmin && !c.username) {
            try {
              const info = await telegramCall("getChat", { chat_id: c.id });
              let link: string | undefined = info?.invite_link;
              if (!link) {
                const created = await telegramCall("exportChatInviteLink", { chat_id: c.id });
                if (typeof created === "string") link = created;
              }
              if (link) {
                await supabaseAdmin.from("telegram_chats").update({ invite_link: link }).eq("chat_id", c.id);
              }
            } catch (e) {
              console.warn("invite link capture failed", c.id, e);
            }
          }

          // Alert bot admins when bot loses admin rights or is removed/kicked from a chat
          if (wasAdmin && !isAdmin) {
            try {
              const actor = myMember.from;
              const actorName = actor
                ? [actor.first_name, actor.last_name].filter(Boolean).join(" ") ||
                  actor.username || `ID ${actor.id}`
                : "unknown";
              const chatTitle = c.title ?? c.username ?? `Chat ${c.id}`;
              const chatLabel = c.username ? `@${c.username}` : `<code>${c.id}</code>`;
              // Build a deep link to the chat so the admin can jump in and re-grant rights.
              let deepLink: string | null = null;
              if (c.username) {
                deepLink = `https://t.me/${c.username}`;
              } else {
                const { data: stored } = await supabaseAdmin
                  .from("telegram_chats")
                  .select("invite_link")
                  .eq("chat_id", c.id)
                  .maybeSingle();
                deepLink = (stored as any)?.invite_link ?? null;
                if (!deepLink) {
                  const idStr = String(c.id);
                  if (idStr.startsWith("-100")) deepLink = `https://t.me/c/${idStr.slice(4)}`;
                }
              }
              let reason = "demoted from admin";
              if (newStatus === "left") reason = "removed / left the chat";
              else if (newStatus === "kicked") reason = "banned / kicked";
              else if (newStatus === "member") reason = "demoted to regular member";
              else if (newStatus === "restricted") reason = "restricted";
              const text =
                `⚠️ <b>Admin rights lost</b>\n\n` +
                `Chat: <b>${escapeHtml(chatTitle)}</b> (${chatLabel})\n` +
                `Type: ${c.type}\n` +
                `Was: <code>${oldStatus}</code> → Now: <code>${newStatus ?? "unknown"}</code>\n` +
                `Reason: ${reason}\n` +
                `By: ${escapeHtml(actorName)}` +
                (deepLink ? `\n\n🔗 <a href="${deepLink}">Open chat</a> to restore admin rights` : "");
              // Persist event for the admin log page
              try {
                await supabaseAdmin.from("bot_admin_events").insert({
                  chat_id: c.id,
                  chat_title: chatTitle,
                  chat_username: c.username ?? null,
                  chat_type: c.type ?? null,
                  old_status: oldStatus ?? null,
                  new_status: newStatus ?? null,
                  reason,
                  actor_id: actor?.id ?? null,
                  actor_name: actorName,
                  actor_username: actor?.username ?? null,
                  deep_link: deepLink,
                });
              } catch (err) {
                console.warn("bot_admin_events insert failed", err);
              }
              const { data: admins } = await supabaseAdmin
                .from("telegram_bot_admins")
                .select("user_id");
              for (const a of admins ?? []) {
                try {
                  await telegramCall("sendMessage", {
                    chat_id: a.user_id,
                    text,
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                  });
                } catch (err) {
                  console.warn("alert DM failed", a.user_id, err);
                }
              }
            } catch (e) {
              console.error("admin-loss alert failed", e);
            }
          }
          return Response.json({ ok: true });
        }

        const message = update.message ?? update.edited_message;
        const newMembers = message?.new_chat_members as Array<any> | undefined;
        const leftMember = message?.left_chat_member;
        const chat = message?.chat;

        // Log the raw update (idempotent by update_id)
        if (message && chat?.id) {
          await supabaseAdmin.from("telegram_messages").upsert(
            {
              update_id: update.update_id,
              chat_id: chat.id,
              user_id: message.from?.id ?? null,
              message_id: message.message_id ?? null,
              text: message.text ?? null,
              raw_update: update,
            },
            { onConflict: "update_id" },
          );

          // Upsert chat metadata
          await supabaseAdmin.from("telegram_chats").upsert(
            {
              chat_id: chat.id,
              title: chat.title ?? chat.username ?? `Chat ${chat.id}`,
              type: chat.type,
              username: chat.username ?? null,
              last_activity_at: new Date().toISOString(),
            },
            { onConflict: "chat_id" },
          );
        }

        // Handle new members: welcome them
        if (newMembers?.length && chat?.id) {
          const { data: chatRow } = await supabaseAdmin
            .from("telegram_chats")
            .select("welcome_enabled, welcome_message")
            .eq("chat_id", chat.id)
            .maybeSingle();

          for (const m of newMembers) {
            await supabaseAdmin.from("telegram_members").upsert(
              {
                chat_id: chat.id,
                user_id: m.id,
                username: m.username ?? null,
                first_name: m.first_name ?? null,
                last_name: m.last_name ?? null,
                is_bot: !!m.is_bot,
                status: "member",
                joined_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
              },
              { onConflict: "chat_id,user_id" },
            );

            if (!m.is_bot && chatRow?.welcome_enabled !== false) {
              const template = chatRow?.welcome_message || "Welcome, {name}! 👋";
              const text = template.replace(/\{name\}/g, formatName(m));
              try {
                await telegramCall("sendMessage", { chat_id: chat.id, text });
              } catch (e) {
                console.error("welcome send failed", e);
              }
            }
          }
        }

        // Left member
        if (leftMember && chat?.id) {
          await supabaseAdmin
            .from("telegram_members")
            .update({ status: "left", last_seen_at: new Date().toISOString() })
            .eq("chat_id", chat.id)
            .eq("user_id", leftMember.id);
        }

        // Regular messages: track sender + handle commands
        if (message && !newMembers && !leftMember && message.from && chat?.id) {
          const from = message.from;
          await supabaseAdmin.from("telegram_members").upsert(
            {
              chat_id: chat.id,
              user_id: from.id,
              username: from.username ?? null,
              first_name: from.first_name ?? null,
              last_name: from.last_name ?? null,
              is_bot: !!from.is_bot,
              last_seen_at: new Date().toISOString(),
            },
            { onConflict: "chat_id,user_id" },
          );
          // Keep bot admin names fresh whenever they interact.
          try {
            await supabaseAdmin
              .from("telegram_bot_admins")
              .update({
                first_name: from.first_name ?? null,
                username: from.username ?? null,
              })
              .eq("user_id", from.id);
          } catch (e) {
            console.warn("bot_admins name refresh failed", e);
          }
          const text: string = message.text ?? "";
          const cmd = text.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();

          // Silently ignore commands from non-bot-admins so the bot doesn't
          // respond to random users. Bootstrap exception: when there are no
          // bot admins yet, allow /addadmin and /listadmins so the first
          // caller can claim ownership.
          const isCommand = !!cmd && cmd.startsWith("/");
          if (isCommand) {
            const { data: gateRow } = await supabaseAdmin
              .from("telegram_bot_admins")
              .select("user_id")
              .eq("user_id", from.id)
              .maybeSingle();
            if (!gateRow) {
              const { count: gateCount } = await supabaseAdmin
                .from("telegram_bot_admins")
                .select("user_id", { count: "exact", head: true });
              const bootstrap =
                (gateCount ?? 0) === 0 && (cmd === "/addadmin" || cmd === "/listadmins");
              if (!bootstrap) {
                return Response.json({ ok: true });
              }
            }
          }

          // /restore via uploaded JSON document (caption starts with /restore)
          const captionCmd = (message.caption ?? "").trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
          if (message.document && captionCmd === "/restore") {
            await handleRestoreDocument({
              fromId: from.id,
              chatId: chat.id,
              chatType: chat.type,
              document: message.document,
              telegramCall,
              supabaseAdmin,
            });
            return Response.json({ ok: true });
          }

          try {
            // Broadcast wizard: consume forwarded/media messages or custom-input replies first.
            const consumed = await handleBroadcastMessage({
              fromId: from.id,
              fromName: from.first_name || from.username || `user ${from.id}`,
              chatId: chat.id,
              chatType: chat.type,
              message,
            });
            if (consumed) return Response.json({ ok: true });

            // Broadcast commands
            // /post <number> reuses a previous post from /listpost
            if (cmd === "/post") {
              const arg = (text ?? "").trim().split(/\s+/)[1];
              const asNum = arg ? Number(arg) : NaN;
              if (arg && Number.isInteger(asNum) && asNum >= 1) {
                await handlePostByNumber({
                  fromId: from.id,
                  n: asNum,
                  replyChatId: chat.id,
                  chatType: chat.type,
                  telegramCall,
                  supabaseAdmin,
                });
                return Response.json({ ok: true });
              }
            }
            if (cmd === "/listpost") {
              await handleListPost({ fromId: from.id, replyChatId: chat.id, chatType: chat.type, telegramCall, supabaseAdmin });
              return Response.json({ ok: true });
            }
            if (cmd === "/dltpost") {
              await handleDltPost({ fromId: from.id, argText: text ?? "", replyChatId: chat.id, chatType: chat.type, telegramCall, supabaseAdmin });
              return Response.json({ ok: true });
            }
            if (cmd === "/post" || cmd === "/crosspost" || cmd === "/splitpost" || cmd === "/broadcasts" || cmd === "/cancel" || cmd === "/editpost" || cmd === "/savebtn" || cmd === "/buttons" || cmd === "/delbtn") {
              const handled = await handleBroadcastCommand({
                cmd,
                fromId: from.id,
                fromName: from.first_name || from.username || `user ${from.id}`,
                chatId: chat.id,
                chatType: chat.type,
                argText: text,
                replyTo: message.reply_to_message,
              });
              if (handled) return Response.json({ ok: true });
            }

            if (cmd === "/start" || cmd === "/help") {
              await telegramCall("sendMessage", {
                chat_id: chat.id,
                text: HELP_COMPACT,
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
              });
            } else if (cmd === "/description" || cmd === "/desc" || cmd === "/commands") {
              for (const chunk of chunkText(HELP_DETAILED, 3800)) {
                await telegramCall("sendMessage", {
                  chat_id: chat.id,
                  text: chunk,
                  parse_mode: "HTML",
                  link_preview_options: { is_disabled: true },
                });
              }
            } else if (cmd === "/ping") {
              await telegramCall("sendMessage", { chat_id: chat.id, text: "pong 🏓" });
            } else if (cmd === "/restart" || cmd === "/reset") {
              await supabaseAdmin.from("broadcast_drafts").delete().eq("user_id", from.id);
              await telegramCall("sendMessage", {
                chat_id: chat.id,
                text: "🔄 <b>Reset done.</b>\nAll pending wizard state was cleared. Start fresh with /post, /splitpost or /help.",
                parse_mode: "HTML",
              });
            } else if (cmd === "/id") {
              await telegramCall("sendMessage", {
                chat_id: chat.id,
                text: `Your Telegram user ID: <code>${from.id}</code>\nChat ID: <code>${chat.id}</code>`,
                parse_mode: "HTML",
              });
            } else if (cmd === "/whoami") {
              await handleWhoAmI({ fromId: from.id, fromName: from.first_name || from.username || `user ${from.id}`, replyChatId: chat.id, telegramCall, supabaseAdmin });
            } else if (cmd === "/stats") {
              await handleStats({ fromId: from.id, replyChatId: chat.id, telegramCall, supabaseAdmin });
            } else if (cmd === "/invite") {
              await handleInvite({ fromId: from.id, argText: text, replyChatId: chat.id, currentChat: chat, telegramCall, supabaseAdmin });
            } else if (cmd === "/savetpl" || cmd === "/templates" || cmd === "/deltpl" || cmd === "/posttpl") {
              await handleTemplateCommands({ cmd, fromId: from.id, fromName: from.first_name || from.username || `user ${from.id}`, argText: text, replyChatId: chat.id, chatType: chat.type, message, telegramCall, supabaseAdmin });
            } else if (cmd === "/react") {
              await handleReactToggle({ fromId: from.id, argText: text, chat, telegramCall, supabaseAdmin });
            } else if (cmd === "/comment") {
              await handleComment({ fromId: from.id, argText: text, replyChatId: chat.id, telegramCall, supabaseAdmin });
            } else if (cmd === "/nuke") {
              await handleNukeCommand({ fromId: from.id, argText: text, replyChatId: chat.id, telegramCall, supabaseAdmin });
            } else if (cmd === "/dltmsg" || cmd === "/delmsg") {
              await handleDeleteMessageCommand({ fromId: from.id, argText: text, replyChatId: chat.id, telegramCall, supabaseAdmin });
            } else if (cmd === "/backup") {
              await handleBackupCommand({ fromId: from.id, chatId: chat.id, chatType: chat.type, telegramCall, supabaseAdmin });
            } else if (cmd === "/restore") {
              await telegramCall("sendMessage", {
                chat_id: chat.id,
                text: "📥 To restore, upload the backup JSON file with caption <code>/restore</code>. Super admins only, DM only.",
                parse_mode: "HTML",
              });
            } else if (cmd === "/rules") {
              const { data: c } = await supabaseAdmin
                .from("telegram_chats")
                .select("rules")
                .eq("chat_id", chat.id)
                .maybeSingle();
              await telegramCall("sendMessage", {
                chat_id: chat.id,
                text: c?.rules?.trim() ? `📜 Group Rules:\n\n${c.rules}` : "No rules have been set for this group yet.",
              });
            } else if (cmd === "/channels") {
              if (chat.type !== "private") {
                await telegramCall("sendMessage", {
                  chat_id: chat.id,
                  text: "🔒 Use /channels in a private chat with me for privacy.",
                });
              } else {
                await handleChannelsCommand({
                  dmChatId: chat.id,
                  supabaseAdmin,
                  telegramCall,
                  getBotIdentity,
                  getChatMemberStatus,
                });
              }
            } else if (cmd === "/leave") {
              await handleLeaveCommand({
                fromId: from.id,
                replyChatId: chat.id,
                currentChat: chat,
                argText: text,
                telegramCall,
                getChatMemberStatus,
                supabaseAdmin,
              });
            } else if (cmd === "/checkmember") {
              if (chat.type !== "private") {
                await telegramCall("sendMessage", {
                  chat_id: chat.id,
                  text: "🔒 Use /checkmember in a private chat with me.",
                });
              } else {
                await handleCheckMemberCommand({
                  dmChatId: chat.id,
                  argText: text,
                  supabaseAdmin,
                  telegramCall,
                  getBotIdentity,
                  getChatMemberStatus,
                });
              }
            } else if (cmd === "/addadmin" || cmd === "/radmin" || cmd === "/listadmins") {
              await handleBotAdminCommands({
                cmd,
                fromId: from.id,
                fromName: from.first_name || from.username || `user ${from.id}`,
                argText: text,
                replyChatId: chat.id,
                telegramCall,
                supabaseAdmin,
              });
            } else if (
              cmd === "/recur" ||
              cmd === "/recurring" ||
              cmd === "/listrecur" ||
              cmd === "/delrecur" ||
              cmd === "/dltrecur" ||
              cmd === "/pauserecur" ||
              cmd === "/resumerecur"
            ) {
              const { handleRecurringCommand } = await import("@/lib/recurring-commands.server");
              await handleRecurringCommand({
                cmd,
                fromId: from.id,
                fromName: from.first_name || from.username || `user ${from.id}`,
                argText: text,
                chatId: chat.id,
                chatType: chat.type,
              });
            } else if (cmd === "/permissions" || cmd === "/checkperms") {
              const { handlePermissionsCommand } = await import("@/lib/permissions-commands.server");
              await handlePermissionsCommand({
                cmd,
                fromId: from.id,
                argText: text,
                chatId: chat.id,
                chatType: chat.type,
              });
            } else if (
              cmd === "/adultchannels" ||
              cmd === "/adultchannel" ||
              cmd === "/mangachannels" ||
              cmd === "/mangachannel" ||
              cmd === "/lists" ||
              cmd === "/showlist" ||
              cmd === "/dellist" ||
              cmd === "/addtolist" ||
              cmd === "/createlist" ||
              cmd === "/newlist" ||
              cmd === "/removefromlist" ||
              cmd === "/rmfromlist"
            ) {
              await handleChatListCommands({
                cmd,
                fromId: from.id,
                fromName: from.first_name || from.username || `user ${from.id}`,
                argText: text,
                replyChatId: chat.id,
                chatType: chat.type,
                telegramCall,
                supabaseAdmin,
                getBotIdentity,
                getChatMemberStatus,
              });
            }

            // Auto-react to every message (including commands) in private DMs when enabled.
            if (
              chat.type === "private" &&
              message.message_id &&
              !from.is_bot
            ) {
              try {
                const { data: chatRow } = await supabaseAdmin
                  .from("telegram_chats")
                  .select("reactions_enabled")
                  .eq("chat_id", chat.id)
                  .maybeSingle();
                if (chatRow?.reactions_enabled) {
                  const emoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
                  await setMessageReaction(chat.id, message.message_id, emoji);
                }
              } catch (e) {
                console.warn("auto-react failed", e);
              }
            }
          } catch (e) {
            console.error("command failed", e);
          }
        }

        return Response.json({ ok: true });
}

// ---------------------------------------------------------------------------
// /channels — v3 SCRAPJAV-style compact text grid.
// Single monospace <pre> table, one line per channel, faint ─ separators,
// small caption, one 🔄 Refresh button on the LAST chunk. No image, no
// per-channel buttons. Data pulled from Turso + live-verified every call.
// ---------------------------------------------------------------------------

// Per-admin memory of the previous board's message ids, so Refresh can
// delete+resend and leave no stale duplicates. Memory-only — after a Render
// restart the first Refresh just posts a fresh board.
const channelBoardMessages = new Map<number, number[]>();

const CHB_PARTNER_BOT = "@InsideAds_bot";
const CHB_PRIORITY = ["MINE", "ADULT", "MANGA"];
const CHB_MAXLEN = 3400; // safely under Telegram's 4096-char cap incl. <pre>

interface ChbEntry {
  type: "channel" | "supergroup" | "group";
  title: string;
  chatId: number;
  cats: string[];
  iads: boolean;
  locked: boolean;
  url?: string;
}

async function gatherChannelEntries(deps: {
  supabaseAdmin: any;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  getBotIdentity: () => Promise<{ id: number; username?: string }>;
  getChatMemberStatus: (chatId: number, userId: number) => Promise<string | null>;
}): Promise<ChbEntry[]> {
  const { supabaseAdmin, telegramCall, getBotIdentity, getChatMemberStatus } = deps;

  const { data: chats } = await supabaseAdmin
    .from("telegram_chats")
    .select("chat_id, title, type, username, first_seen_at")
    .in("type", ["group", "supergroup", "channel"])
    .order("first_seen_at", { ascending: true })
    .limit(200);
  if (!chats?.length) return [];

  const bot = await getBotIdentity();
  let partnerId: number | null = null;
  try {
    const info = await telegramCall("getChat", { chat_id: CHB_PARTNER_BOT });
    partnerId = Number(info?.id) || null;
  } catch (e) {
    console.warn("getChat partner bot failed", e);
  }

  const { data: listRows } = await supabaseAdmin.from("chat_lists").select("category, chat_id");
  const listsByChat = new Map<number, string[]>();
  for (const r of (listRows as any[]) ?? []) {
    const id = Number(r.chat_id);
    const arr = listsByChat.get(id) ?? [];
    if (!arr.includes(r.category)) arr.push(r.category);
    listsByChat.set(id, arr);
  }

  const raw = await Promise.all(
    chats.map(async (c: any): Promise<ChbEntry | null> => {
      const botStatus = await getChatMemberStatus(c.chat_id, bot.id);
      if (!(botStatus === "administrator" || botStatus === "creator")) return null;

      let iads = false;
      if (partnerId) {
        const ps = await getChatMemberStatus(c.chat_id, partnerId);
        iads = ps === "administrator" || ps === "creator";
      }

      const title = String(c.title || c.username || `Chat ${c.chat_id}`);
      let url: string | undefined;
      let locked = false;
      if (c.username) {
        url = `https://t.me/${c.username}`;
      } else {
        try {
          const info = await telegramCall("getChat", { chat_id: c.chat_id });
          url = info?.invite_link;
          if (!url) {
            try {
              const created = await telegramCall("exportChatInviteLink", { chat_id: c.chat_id });
              if (typeof created === "string") url = created;
            } catch { /* private, no link */ }
          }
          if (!url) locked = true;
        } catch (e) {
          console.warn("getChat failed", c.chat_id, e);
        }
      }
      if (url) {
        try {
          await supabaseAdmin.from("telegram_chats").update({ invite_link: url }).eq("chat_id", c.chat_id);
        } catch { /* ignore */ }
      }

      const cats = (listsByChat.get(Number(c.chat_id)) ?? []).map((x: any) => String(x).toUpperCase());
      const type = c.type === "channel" ? "channel" : c.type === "supergroup" ? "supergroup" : "group";
      return { type, title, chatId: Number(c.chat_id), cats, iads, locked, url };
    }),
  );

  const rank = (cats: string[]) => {
    if (!cats.length) return 10_000;
    let best = 9_999;
    for (const c of cats) {
      const i = CHB_PRIORITY.indexOf(c);
      best = Math.min(best, i >= 0 ? i : 100);
    }
    return best;
  };
  return (raw.filter(Boolean) as ChbEntry[])
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => rank(a.cats) - rank(b.cats) || (a as any).i - (b as any).i);
}

// Compact single-line row: "NN. Name        TAG   ✅🔒"  (≤ ~52 mono chars).
function chbRow(num: number, e: ChbEntry): string {
  const n = String(num).padStart(2, " ");
  const display = e.title.length > 24 ? e.title.slice(0, 23) + "…" : e.title;
  const name = escapeHtml(display.padEnd(24, " "));
  const linked = e.url ? `<a href="${escapeHtml(e.url)}">${name}</a>` : name;
  const tags = escapeHtml((e.cats.length ? e.cats.join("|") : "NONE").padEnd(10, " "));
  const flags = `${e.iads ? " ✅" : "  "}${e.locked ? " 🔒" : ""}`;
  return `${n}. ${linked}  ${tags}${flags}`;
}

function buildChannelBoardChunks(entries: ChbEntry[]): string[] {
  const buckets: Record<ChbEntry["type"], ChbEntry[]> = { channel: [], supergroup: [], group: [] };
  for (const e of entries) buckets[e.type].push(e);

  const SEP = "─".repeat(52);
  const HEAD = ` N  Name                      List        Flags`;
  const lines: string[] = [];
  let num = 0;
  const section = (label: string, rows: ChbEntry[]) => {
    if (!rows.length) return;
    lines.push("", label, SEP, HEAD, SEP);
    for (const e of rows) lines.push(chbRow(++num, e));
  };
  section(`📢 CHANNELS (${buckets.channel.length})`, buckets.channel);
  section(`👥 SUPERGROUPS (${buckets.supergroup.length})`, buckets.supergroup);
  section(`👥 GROUPS (${buckets.group.length})`, buckets.group);

  const stamp = (() => {
    try {
      return new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    } catch { return new Date().toISOString().slice(0, 16).replace("T", " "); }
  })();
  const header = `🎯 <b>CHANNELS — live board</b> · ${entries.length} chats · ${escapeHtml(stamp)} IST`;
  const footer = `<i>Tap a name to open · List = MINE|ADULT|MANGA|... · ✅ = @InsideAds_bot admin · 🔒 = no invite link</i>`;

  const chunks: string[] = [];
  let cur = "";
  for (const ln of lines) {
    const candidate = cur ? cur + "\n" + ln : ln;
    if (cur && (header + "\n<pre>" + candidate + "</pre>\n" + footer).length > CHB_MAXLEN) {
      chunks.push(cur); cur = ln;
    } else cur = candidate;
  }
  if (cur) chunks.push(cur);
  return chunks.map((body, i) => {
    const page = chunks.length > 1 ? ` <i>(${i + 1}/${chunks.length})</i>` : "";
    const head = i === 0 ? header + "\n" : "";
    const foot = i === chunks.length - 1 ? "\n" + footer : "";
    return head + `<pre>${body.replace(/^\n+/, "")}</pre>` + page + foot;
  });
}

async function sendChannelBoard(dmChatId: number, entries: ChbEntry[], telegramCall: any): Promise<void> {
  // Wipe the previous board so Refresh never leaves stale duplicates.
  const old = channelBoardMessages.get(dmChatId) ?? [];
  for (const mid of old) {
    try { await telegramCall("deleteMessage", { chat_id: dmChatId, message_id: mid }); } catch { /* already gone */ }
  }

  const chunks = buildChannelBoardChunks(entries);
  const sentIds: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const res = await telegramCall("sendMessage", {
      chat_id: dmChatId,
      text: chunks[i],
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(isLast ? { reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "chl:refresh" }]] } } : {}),
    });
    if (res?.message_id) sentIds.push(res.message_id);
  }
  channelBoardMessages.set(dmChatId, sentIds);
}

async function handleChannelsCommand(args: {
  dmChatId: number;
  supabaseAdmin: any;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  getBotIdentity: () => Promise<{ id: number; username?: string }>;
  getChatMemberStatus: (chatId: number, userId: number) => Promise<string | null>;
}) {
  const { dmChatId, telegramCall } = args;
  await telegramCall("sendMessage", { chat_id: dmChatId, text: "🔍 Checking chats…" });
  const entries = await gatherChannelEntries(args);
  if (!entries.length) {
    await telegramCall("sendMessage", { chat_id: dmChatId, text: "I'm not in any groups or channels yet." });
    return;
  }
  await sendChannelBoard(dmChatId, entries, telegramCall);
}

async function handleChannelListRefresh(cq: any) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { telegramCall, getBotIdentity, getChatMemberStatus } = await import("@/lib/telegram.server");
  const fromId = Number(cq?.from?.id);
  const chatId = Number(cq?.message?.chat?.id);
  const chatType = String(cq?.message?.chat?.type ?? "private");

  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) { await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "⛔ Admins only.", show_alert: true }); return; }
  if (chatType !== "private") { await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "🔒 Use /channels in DM.", show_alert: true }); return; }

  await telegramCall("answerCallbackQuery", { callback_query_id: cq.id, text: "🔄 Refreshing…" });
  const entries = await gatherChannelEntries({ supabaseAdmin, telegramCall, getBotIdentity, getChatMemberStatus });
  if (!entries.length) {
    await telegramCall("sendMessage", { chat_id: chatId, text: "I'm not in any groups or channels yet." });
    return;
  }
  await sendChannelBoard(chatId, entries, telegramCall);
}

// ---- legacy implementation kept for reference (unused) ----
async function handleChannelsCommandLegacy(args: {
  dmChatId: number;
  supabaseAdmin: any;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  getBotIdentity: () => Promise<{ id: number; username?: string }>;
  getChatMemberStatus: (chatId: number, userId: number) => Promise<string | null>;
}) {
  const { dmChatId, supabaseAdmin, telegramCall, getBotIdentity, getChatMemberStatus } = args;

  await telegramCall("sendMessage", { chat_id: dmChatId, text: "🔍 Checking chats…" });

  const { data: chats } = await supabaseAdmin
    .from("telegram_chats")
    .select("chat_id, title, type, username, first_seen_at")
    .in("type", ["group", "supergroup", "channel"])
    .order("first_seen_at", { ascending: true })
    .limit(200);

  if (!chats?.length) {
    await telegramCall("sendMessage", {
      chat_id: dmChatId,
      text: "I'm not in any groups or channels yet.",
    });
    return;
  }

  const bot = await getBotIdentity();
  // Resolve the partner bot once; used to tag channels where it is also admin.
  const PARTNER_BOT = "@InsideAds_bot";
  let partnerId: number | null = null;
  try {
    const info = await telegramCall("getChat", { chat_id: PARTNER_BOT });
    partnerId = Number(info?.id) || null;
  } catch (e) {
    console.warn("getChat partner bot failed", e);
  }
  const buckets: Record<"channel" | "supergroup" | "group", string[]> = {
    channel: [],
    supergroup: [],
    group: [],
  };

  // Which list(s) each chat belongs to, for the [LIST] prefix.
  const { data: listRows } = await supabaseAdmin
    .from("chat_lists")
    .select("category, chat_id");
  const listsByChat = new Map<number, string[]>();
  for (const r of (listRows as any[]) ?? []) {
    const id = Number(r.chat_id);
    const arr = listsByChat.get(id) ?? [];
    if (!arr.includes(r.category)) arr.push(r.category);
    listsByChat.set(id, arr);
  }

  const entries = await Promise.all(
    chats.map(async (c: any) => {
      const botStatus = await getChatMemberStatus(c.chat_id, bot.id);
      const botAdmin = botStatus === "administrator" || botStatus === "creator";
      if (!botAdmin) return null;

      let partnerTag = "";
      if (partnerId) {
        const ps = await getChatMemberStatus(c.chat_id, partnerId);
        if (ps === "administrator" || ps === "creator") partnerTag = "✅IAds ";
      }

      const label = c.title || c.username || `Chat ${c.chat_id}`;
      let url: string | undefined;
      let suffix = "";
      if (c.username) {
        url = `https://t.me/${c.username}`;
      } else {
        try {
          const info = await telegramCall("getChat", { chat_id: c.chat_id });
          url = info?.invite_link;
          if (!url) {
            try {
              const created = await telegramCall("exportChatInviteLink", { chat_id: c.chat_id });
              if (typeof created === "string") url = created;
            } catch (e) {
              console.warn("exportChatInviteLink failed", c.chat_id, e);
            }
          }
          if (!url) suffix = " 🔒";
        } catch (e) {
          console.warn("getChat failed", c.chat_id, e);
        }
      }
      // Remember the link so we can still reach the chat after losing admin rights.
      if (url) {
        try {
          await supabaseAdmin.from("telegram_chats").update({ invite_link: url }).eq("chat_id", c.chat_id);
        } catch { /* ignore */ }
      }
      const name = url
        ? `<a href="${url}">${escapeHtml(label)}</a>`
        : escapeHtml(label);
      const cats = listsByChat.get(Number(c.chat_id)) ?? [];
      const tag = cats.length
        ? `<b>[${escapeHtml(cats.join("|").toUpperCase())}]</b> `
        : `<b>[NONE]</b> `;
      const bucket = (c.type as "channel" | "supergroup" | "group") ?? "group";
      return {
        bucket,
        cats: cats.map((x) => String(x).toUpperCase()),
        line: `${partnerTag}${tag}${name}${suffix} — <code>${c.chat_id}</code>`,
      };
    }),
  );

  // Order by category: MINE → ADULT → MANGA → any other list → [NONE] last.
  const PRIORITY = ["MINE", "ADULT", "MANGA"];
  const rank = (cats: string[]) => {
    if (!cats.length) return 10_000; // [NONE] goes last
    let best = 9_999;
    for (const c of cats) {
      const i = PRIORITY.indexOf(c);
      best = Math.min(best, i >= 0 ? i : 100);
    }
    return best;
  };
  const ordered = (entries.filter(Boolean) as any[])
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => rank(a.cats) - rank(b.cats) || a.i - b.i);
  for (const e of ordered) {
    buckets[e.bucket as "channel" | "supergroup" | "group"].push(e.line);
  }

  const numbered = (items: string[]) =>
    items.map((it, i) => `<b>${i + 1}.</b> ${it}`).join("\n\n");

  const sections: string[] = [];
  if (buckets.channel.length)
    sections.push(`📢 <b>Channels (${buckets.channel.length})</b>\n${numbered(buckets.channel)}`);
  if (buckets.supergroup.length)
    sections.push(`👥 <b>Supergroups (${buckets.supergroup.length})</b>\n${numbered(buckets.supergroup)}`);
  if (buckets.group.length)
    sections.push(`👥 <b>Groups (${buckets.group.length})</b>\n${numbered(buckets.group)}`);

  // Telegram caps messages at 4096 chars - split long lists into parts.
  const fullList = sections.length
    ? sections.join("\n\n")
    : "No chats found where I am admin.";
  const MAXLEN = 3800;
  const chunks: string[] = [];
  let cur = "";
  for (const line of fullList.split("\n")) {
    if (cur && (cur + "\n" + line).length > MAXLEN) { chunks.push(cur); cur = line; }
    else { cur = cur ? cur + "\n" + line : line; }
  }
  if (cur) chunks.push(cur);
  for (let ci = 0; ci < chunks.length; ci++) {
    const head = chunks.length > 1 ? `📋 <b>Chats (part ${ci + 1}/${chunks.length})</b>\n\n` : "";
    await telegramCall("sendMessage", { chat_id: dmChatId, text: head + chunks[ci], parse_mode: "HTML", disable_web_page_preview: true });
  }
}

async function handleCheckMemberCommand(args: {
  dmChatId: number;
  argText: string;
  supabaseAdmin: any;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  getBotIdentity: () => Promise<{ id: number; username?: string }>;
  getChatMemberStatus: (chatId: number, userId: number) => Promise<string | null>;
}) {
  const { dmChatId, argText, supabaseAdmin, telegramCall, getBotIdentity, getChatMemberStatus } = args;

  const raw = argText.trim().split(/\s+/).slice(1).join(" ").trim();
  if (!raw) {
    await telegramCall("sendMessage", {
      chat_id: dmChatId,
      text: "Usage: /checkmember <user_id|@username>",
    });
    return;
  }

  let targetId: number | null = Number.isFinite(Number(raw)) ? Number(raw) : null;
  let targetLabel = raw;
  if (targetId === null) {
    const uname = raw.startsWith("@") ? raw : `@${raw}`;
    try {
      const info = await telegramCall("getChat", { chat_id: uname });
      targetId = Number(info?.id) || null;
      targetLabel = info?.username ? `@${info.username}` : uname;
    } catch {
      targetId = null;
    }
    if (!targetId) {
      await telegramCall("sendMessage", {
        chat_id: dmChatId,
        text: `❌ Couldn't resolve ${escapeHtml(uname)}. Telegram only resolves usernames I've seen before — try the numeric user ID.`,
        parse_mode: "HTML",
      });
      return;
    }
  }

  await telegramCall("sendMessage", { chat_id: dmChatId, text: "🔍 Checking chats…" });

  const { data: chats } = await supabaseAdmin
    .from("telegram_chats")
    .select("chat_id, title, type, username, invite_link, first_seen_at")
    .in("type", ["group", "supergroup", "channel"])
    .order("first_seen_at", { ascending: true })
    .limit(200);

  if (!chats?.length) {
    await telegramCall("sendMessage", { chat_id: dmChatId, text: "I'm not in any groups or channels yet." });
    return;
  }

  const bot = await getBotIdentity();

  const { data: listRows } = await supabaseAdmin.from("chat_lists").select("category, chat_id");
  const listsByChat = new Map<number, string[]>();
  for (const r of (listRows as any[]) ?? []) {
    const id = Number(r.chat_id);
    const arr = listsByChat.get(id) ?? [];
    if (!arr.includes(r.category)) arr.push(r.category);
    listsByChat.set(id, arr);
  }

  const PRESENT = new Set(["creator", "administrator", "member", "restricted"]);

  const entries = await Promise.all(
    (chats as any[]).map(async (c) => {
      const botStatus = await getChatMemberStatus(c.chat_id, bot.id);
      if (botStatus !== "administrator" && botStatus !== "creator") return null;

      const st = await getChatMemberStatus(c.chat_id, targetId!);
      const mark = st && PRESENT.has(st) ? "👤" : "❌👤";

      const label = c.title || c.username || `Chat ${c.chat_id}`;
      let url: string | undefined = c.username ? `https://t.me/${c.username}` : c.invite_link || undefined;
      if (!url) {
        try {
          const info = await telegramCall("getChat", { chat_id: c.chat_id });
          url = info?.invite_link;
          if (!url) {
            try {
              const created = await telegramCall("exportChatInviteLink", { chat_id: c.chat_id });
              if (typeof created === "string") url = created;
            } catch { /* ignore */ }
          }
          if (url) {
            try {
              await supabaseAdmin.from("telegram_chats").update({ invite_link: url }).eq("chat_id", c.chat_id);
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
      const name = url ? `<a href="${url}">${escapeHtml(label)}</a>` : `${escapeHtml(label)} 🔒`;
      const cats = (listsByChat.get(Number(c.chat_id)) ?? []).map((x) => String(x).toUpperCase());
      const tag = cats.length ? `<b>[${escapeHtml(cats.join("|"))}]</b>` : `<b>[NONE]</b>`;
      return {
        cats,
        present: mark === "👤",
        line: `${tag} ${mark} ${name} — <code>${c.chat_id}</code>`,
      };
    }),
  );

  const PRIORITY = ["MINE", "ADULT", "MANGA"];
  const rank = (cats: string[]) => {
    if (!cats.length) return 10_000;
    let best = 9_999;
    for (const c of cats) {
      const i = PRIORITY.indexOf(c);
      best = Math.min(best, i >= 0 ? i : 100);
    }
    return best;
  };
  const ordered = (entries.filter(Boolean) as any[])
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => rank(a.cats) - rank(b.cats) || a.i - b.i);

  if (!ordered.length) {
    await telegramCall("sendMessage", { chat_id: dmChatId, text: "No chats found where I am admin." });
    return;
  }

  const inCount = ordered.filter((e) => e.present).length;
  const header =
    `👤 <b>Membership check</b> for <code>${escapeHtml(targetLabel)}</code> (<code>${targetId}</code>)\n` +
    `In ${inCount} of ${ordered.length} chats\n`;

  const lines = ordered.map((e, i) => `<b>${i + 1}.</b> ${e.line}`);
  // Chunk to stay under Telegram's 4096-char message limit.
  const chunks: string[] = [];
  let cur = header;
  for (const l of lines) {
    if (cur.length + l.length + 2 > 3800) {
      chunks.push(cur);
      cur = "";
    }
    cur += `\n${l}`;
  }
  if (cur.trim()) chunks.push(cur);

  for (const chunk of chunks) {
    await telegramCall("sendMessage", {
      chat_id: dmChatId,
      text: chunk,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
}

async function handleLeaveCommand(args: {
  fromId: number;
  replyChatId: number;
  currentChat: { id: number; type: string };
  argText: string;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  getChatMemberStatus: (chatId: number, userId: number) => Promise<string | null>;
  supabaseAdmin: any;
}) {
  const { fromId, replyChatId, currentChat, argText, telegramCall, getChatMemberStatus, supabaseAdmin } = args;

  const parts = argText.trim().split(/\s+/);
  const rawArg = parts[1];

  let targetChatId: number | null = null;
  if (rawArg) {
    const parsed = Number(rawArg);
    if (!Number.isFinite(parsed)) {
      await telegramCall("sendMessage", {
        chat_id: replyChatId,
        text: "Usage: /leave <chat_id>\nExample: /leave -1001234567890",
      });
      return;
    }
    targetChatId = parsed;
  } else if (currentChat.type !== "private") {
    targetChatId = currentChat.id;
  } else {
    await telegramCall("sendMessage", {
      chat_id: replyChatId,
      text: "Usage: /leave <chat_id>\nRun /channels to see chat IDs, or use /leave inside the group/channel itself.",
    });
    return;
  }

  // Allow if caller is a global bot admin OR an admin/creator of the target chat
  const { data: botAdminRow } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("user_id")
    .eq("user_id", fromId)
    .maybeSingle();
  const isBotAdmin = !!botAdminRow;
  if (!isBotAdmin) {
    const userStatus = await getChatMemberStatus(targetChatId, fromId);
    if (userStatus !== "administrator" && userStatus !== "creator") {
      await telegramCall("sendMessage", {
        chat_id: replyChatId,
        text: "❌ You must be a bot admin or an admin of that chat to make me leave.",
      });
      return;
    }
  }

  try {
    await telegramCall("leaveChat", { chat_id: targetChatId });
    try {
      await supabaseAdmin
        .from("telegram_chats")
        .update({
          bot_status: "left",
          bot_is_admin: false,
          bot_status_checked_at: new Date().toISOString(),
        } as any)
        .eq("chat_id", targetChatId);
    } catch (e) {
      console.warn("failed to update bot_status after leave", e);
    }
    if (replyChatId !== targetChatId) {
      await telegramCall("sendMessage", {
        chat_id: replyChatId,
        text: `👋 Left chat <code>${targetChatId}</code>.`,
        parse_mode: "HTML",
      });
    }
  } catch (e: any) {
    await telegramCall("sendMessage", {
      chat_id: replyChatId,
      text: `❌ Failed to leave chat <code>${targetChatId}</code>: ${e?.message ?? "unknown error"}`,
      parse_mode: "HTML",
    });
  }
}
async function handleBotAdminCommands(args: {
  cmd: string;
  fromId: number;
  fromName: string;
  argText: string;
  replyChatId: number;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { cmd, fromId, fromName, argText, replyChatId, telegramCall, supabaseAdmin } = args;

  const send = (text: string, extra: Record<string, unknown> = {}) =>
    telegramCall("sendMessage", { chat_id: replyChatId, text, ...extra });

  // Count existing global bot admins
  const { count } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("user_id", { count: "exact", head: true });
  const adminCount = count ?? 0;

  // Is the caller a global bot admin?
  const { data: callerRow } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("user_id")
    .eq("user_id", fromId)
    .maybeSingle();
  const callerIsBotAdmin = !!callerRow;

  // Bootstrap: if there are no bot admins yet, the first caller becomes the owner.
  if (adminCount === 0 && (cmd === "/addadmin" || cmd === "/listadmins")) {
    await supabaseAdmin.from("telegram_bot_admins").upsert(
      {
        user_id: fromId,
        username: null,
        first_name: fromName,
        added_by: fromId,
        added_by_name: fromName,
        role: "super_admin",
      },
      { onConflict: "user_id" },
    );
    await send(
      `👑 No bot admins existed yet, so you (<code>${fromId}</code>) are now the owner (super admin).`,
      { parse_mode: "HTML" },
    );
    // Fall through so /addadmin <id> in the same message still works
  } else if (!callerIsBotAdmin) {
    await send("❌ Only bot admins can use this command.");
    return;
  }

  // Fetch caller's role for permission checks below
  const { data: callerFull } = await supabaseAdmin
    .from("telegram_bot_admins")
    .select("role")
    .eq("user_id", fromId)
    .maybeSingle();
  const callerIsSuper = callerFull?.role === "super_admin";

  if (cmd === "/listadmins") {
    const { data: rows } = await supabaseAdmin
      .from("telegram_bot_admins")
      .select("user_id, username, first_name, added_by_name, created_at, role")
      .order("role", { ascending: true })
      .order("created_at", { ascending: true });

    if (!rows?.length) {
      await send("No bot admins configured yet. Use /addadmin <user_id> to add one.");
      return;
    }

    // Backfill missing names via getChat (best effort — requires the user to have DMed the bot).
    await Promise.all(
      rows.map(async (r: any) => {
        if (r.first_name || r.username) return;
        try {
          const info = await telegramCall("getChat", { chat_id: r.user_id });
          const first_name = info?.first_name ?? null;
          const username = info?.username ?? null;
          if (first_name || username) {
            r.first_name = first_name;
            r.username = username;
            await supabaseAdmin
              .from("telegram_bot_admins")
              .update({ first_name, username })
              .eq("user_id", r.user_id);
          }
        } catch (e) {
          console.warn("getChat backfill failed", r.user_id, e);
        }
      }),
    );

    const lines = rows.map((r: any) => {
      const label = r.first_name || r.username || `user ${r.user_id}`;
      const handle = r.username ? ` (@${r.username})` : "";
      const crown = r.role === "super_admin" ? "👑 " : "• ";
      return `${crown}${label}${handle} — <code>${r.user_id}</code>`;
    });
    await send(
      `👮 Bot admins (${rows.length}) — 👑 = super admin:\n\n${lines.join("\n")}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // /addadmin and /radmin require a user_id argument
  const parts = argText.trim().split(/\s+/).slice(1);

  // /addadmin <channel_id> <user_id> — promote a user inside a chat with all rights.
  if (
    cmd === "/addadmin" &&
    parts.length >= 2 &&
    Number.isFinite(Number(parts[0])) &&
    Number.isFinite(Number(parts[1]))
  ) {
    const chatId = Number(parts[0]);
    const userId = Number(parts[1]);
    try {
      await telegramCall("promoteChatMember", {
        chat_id: chatId,
        user_id: userId,
        is_anonymous: false,
        can_manage_chat: true,
        can_post_messages: true,
        can_edit_messages: true,
        can_delete_messages: true,
        can_manage_video_chats: true,
        can_restrict_members: true,
        can_promote_members: true,
        can_change_info: true,
        can_invite_users: true,
        can_pin_messages: true,
        can_post_stories: true,
        can_edit_stories: true,
        can_delete_stories: true,
        can_manage_topics: true,
      });
    } catch (e: any) {
      await send(`❌ Promote failed: ${e?.message ?? String(e)}`);
      return;
    }
    let chatLabel = String(chatId);
    try {
      const info = await telegramCall("getChat", { chat_id: chatId });
      chatLabel = info?.title ?? info?.username ?? chatLabel;
    } catch { /* ignore */ }
    let userLabel = String(userId);
    try {
      const m = await telegramCall("getChatMember", { chat_id: chatId, user_id: userId });
      userLabel = m?.user?.first_name ?? (m?.user?.username ? `@${m.user.username}` : userLabel);
    } catch { /* ignore */ }
    await send(
      `✅ Promoted ${escapeHtml(userLabel)} (<code>${userId}</code>) with all permissions in <b>${escapeHtml(chatLabel)}</b> (<code>${chatId}</code>).`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const rawArg = parts[0];
  const targetId = Number(rawArg);
  if (!rawArg || !Number.isFinite(targetId)) {
    const usage = cmd === "/addadmin"
      ? "Usage: /addadmin <user_id> [super]\nAdd 'super' to grant super admin (super admins only)."
      : `Usage: ${cmd} <user_id>`;
    await send(`${usage}\nTip: users can send /id to get their Telegram user ID.`);
    return;
  }

  if (cmd === "/addadmin") {
    const wantsSuper = (parts[1] ?? "").toLowerCase() === "super";
    if (wantsSuper && !callerIsSuper) {
      await send("❌ Only super admins 👑 can add other super admins.");
      return;
    }
    const role = wantsSuper ? "super_admin" : "admin";
    // Try to fetch the target's name/username via getChat (works if they've DMed the bot).
    let targetFirstName: string | null = null;
    let targetUsername: string | null = null;
    try {
      const info = await telegramCall("getChat", { chat_id: targetId });
      targetFirstName = info?.first_name ?? null;
      targetUsername = info?.username ?? null;
    } catch (e) {
      console.warn("getChat on addadmin target failed", targetId, e);
    }
    const { error } = await supabaseAdmin.from("telegram_bot_admins").upsert(
      {
        user_id: targetId,
        username: targetUsername,
        first_name: targetFirstName,
        added_by: fromId,
        added_by_name: fromName,
        role,
      },
      { onConflict: "user_id" },
    );

    if (error) {
      await send(`❌ Failed to add bot admin: ${error.message}`);
      return;
    }
    const label = targetFirstName || targetUsername || `user ${targetId}`;
    const badge = wantsSuper ? "super admin 👑" : "admin";
    await send(`✅ Added ${label} (<code>${targetId}</code>) as a ${badge}.`, { parse_mode: "HTML" });
    return;
  }

  if (cmd === "/radmin") {
    const { data: existing } = await supabaseAdmin
      .from("telegram_bot_admins")
      .select("first_name, username, role")
      .eq("user_id", targetId)
      .maybeSingle();

    if (!existing) {
      await send(`ℹ️ <code>${targetId}</code> is not a bot admin.`, { parse_mode: "HTML" });
      return;
    }

    if (existing.role === "super_admin" && !callerIsSuper) {
      await send("❌ Only super admins 👑 can remove other super admins.");
      return;
    }

    if (existing.role === "super_admin") {
      const { count: superCount } = await supabaseAdmin
        .from("telegram_bot_admins")
        .select("user_id", { count: "exact", head: true })
        .eq("role", "super_admin");
      if ((superCount ?? 0) <= 1) {
        await send("❌ Can't remove the last super admin 👑.");
        return;
      }
    }

    const { error } = await supabaseAdmin
      .from("telegram_bot_admins")
      .delete()
      .eq("user_id", targetId);

    if (error) {
      await send(`❌ Failed to remove bot admin: ${error.message}`);
      return;
    }
    const label = existing.first_name || existing.username || `user ${targetId}`;
    await send(`🗑️ Removed ${label} (<code>${targetId}</code>) from bot admins.`, { parse_mode: "HTML" });
  }
}

async function handleChatListCommands(args: {
  cmd: string;
  fromId: number;
  fromName: string;
  argText: string;
  replyChatId: number;
  chatType: string;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
  getBotIdentity: () => Promise<{ id: number; username?: string }>;
  getChatMemberStatus: (chatId: number, userId: number) => Promise<string | null>;
}) {
  const { cmd, fromId, fromName, argText, replyChatId, chatType, telegramCall, supabaseAdmin, getBotIdentity, getChatMemberStatus } = args;
  const send = (text: string, extra: Record<string, unknown> = {}) =>
    telegramCall("sendMessage", { chat_id: replyChatId, text, ...extra });

  const { is } = await isBotAdmin(supabaseAdmin, fromId);
  if (!is) {
    await send("❌ Only bot admins can manage channel lists.");
    return;
  }
  if (chatType !== "private") {
    await send(`🔒 Use ${cmd} in a private chat with me.`);
    return;
  }

  const listCmd =
    cmd === "/adultchannels" || cmd === "/adultchannel"
      ? "adult"
      : cmd === "/mangachannels" || cmd === "/mangachannel"
        ? "manga"
        : null;

  // /lists — show all lists with counts
  if (cmd === "/lists") {
    const { data: rows } = await supabaseAdmin
      .from("chat_lists")
      .select("category");
    if (!rows?.length) {
      await send(
        "📭 No channel lists yet.\nCreate one with /addtolist <name> <chat_id>\nExample: /addtolist anime -1001234567890",
      );
      return;
    }
    const counts = new Map<string, number>();
    for (const r of rows as Array<{ category: string }>) {
      counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const lines = sorted.map(
      ([name, n]) => `• <b>${escapeHtml(name)}</b> — ${n} channel${n === 1 ? "" : "s"}  <code>/showlist ${name}</code>`,
    );
    await send(
      `📚 <b>Channel lists (${sorted.length})</b>\n\n${lines.join("\n")}\n\n` +
        `Add: <code>/addtolist &lt;name&gt; &lt;chat_id&gt;</code>\n` +
        `Remove: <code>/removefromlist &lt;name&gt; &lt;chat_id&gt;</code>\n` +
        `Delete whole list: <code>/dellist &lt;name&gt;</code>`,
      { parse_mode: "HTML", disable_web_page_preview: true },
    );
    return;
  }

  // /showlist <name> — resolve name from args, then fall through to list renderer
  let showList: string | null = listCmd;
  if (cmd === "/showlist") {
    const name = argText.replace(/^\/\S+\s*/, "").trim().toLowerCase();
    if (!name) {
      await send("Usage: /showlist <name>\nSee /lists for all lists.");
      return;
    }
    if (!/^[a-z0-9_]{1,30}$/.test(name)) {
      await send("❌ List name must be 1-30 chars: letters, digits, underscore.");
      return;
    }
    showList = name;
  }

  // /dellist <name> — delete entire list
  if (cmd === "/dellist") {
    const name = argText.replace(/^\/\S+\s*/, "").trim().toLowerCase();
    if (!name) {
      await send("Usage: /dellist <name>");
      return;
    }
    const { data: existing } = await supabaseAdmin
      .from("chat_lists")
      .select("chat_id")
      .eq("category", name);
    if (!existing?.length) {
      await send(`📭 List <b>${escapeHtml(name)}</b> does not exist.`, { parse_mode: "HTML" });
      return;
    }
    const { error } = await supabaseAdmin.from("chat_lists").delete().eq("category", name);
    if (error) {
      await send(`❌ Failed: ${error.message}`);
      return;
    }
    await send(
      `🗑 Deleted list <b>${escapeHtml(name)}</b> (${existing.length} channel${existing.length === 1 ? "" : "s"} removed).`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (showList) {
    const { data: rows } = await supabaseAdmin
      .from("chat_lists")
      .select("chat_id, created_at")
      .eq("category", showList)
      .order("created_at", { ascending: true });
    if (!rows?.length) {
      await send(
        `📭 The ${showList} list is empty.\nAdd channels with /addtolist ${showList} <chat_id> [chat_id …]`,
      );
      return;
    }
    const bot = await getBotIdentity();
    const adminChecks = await Promise.all(
      rows.map(async (r: any) => {
        const status = await getChatMemberStatus(Number(r.chat_id), bot.id).catch(() => null);
        return status === "administrator" || status === "creator";
      }),
    );
    const activeRows = rows.filter((_: any, i: number) => adminChecks[i]);
    const skipped = rows.length - activeRows.length;
    if (!activeRows.length) {
      await send(
        `📭 I'm no longer admin in any channel on the ${showList} list (${skipped} skipped).\nRemove them with /removefromlist ${showList} <chat_id>`,
      );
      return;
    }
    const ids = activeRows.map((r: any) => Number(r.chat_id));
    const { data: chats } = await supabaseAdmin
      .from("telegram_chats")
      .select("chat_id, title, username, type")
      .in("chat_id", ids);
    const byId = new Map<number, any>((chats ?? []).map((c: any) => [Number(c.chat_id), c]));
    const emoji = showList === "adult" ? "🔞" : showList === "manga" ? "📚" : "📁";
    const labelTitle = showList.charAt(0).toUpperCase() + showList.slice(1);
    const header =
      `${emoji} <b>${escapeHtml(labelTitle)} channels (${activeRows.length})</b>` +
      (skipped ? `\n<i>${skipped} hidden — bot is no longer admin.</i>` : "");
    const lines = await Promise.all(
      activeRows.map(async (r: any, i: number) => {
        const c = byId.get(Number(r.chat_id));
        const title = c?.title || (c?.username ? `@${c.username}` : `Chat ${r.chat_id}`);
        let url: string | undefined;
        let suffix = "";
        if (c?.username) {
          url = `https://t.me/${c.username}`;
        } else {
          try {
            const info = await telegramCall("getChat", { chat_id: Number(r.chat_id) });
            url = info?.invite_link;
            if (!url) {
              try {
                const created = await telegramCall("exportChatInviteLink", {
                  chat_id: Number(r.chat_id),
                });
                if (typeof created === "string") url = created;
              } catch (e) {
                console.warn("exportChatInviteLink failed", r.chat_id, e);
              }
            }
            if (!url) suffix = " 🔒";
          } catch (e) {
            console.warn("getChat failed", r.chat_id, e);
          }
        }
        const name = url
          ? `<a href="${url}">${escapeHtml(title)}</a>`
          : escapeHtml(title);
        return `<b>${i + 1}.</b> ${name}${suffix} — <code>${r.chat_id}</code>`;
      }),
    );
    await send(`${header}\n\n${lines.join("\n\n")}`, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    return;
  }

  // /addtolist and /removefromlist
  const rest = argText.replace(/^\/\S+\s*/, "").trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  const category = (parts.shift() ?? "").toLowerCase();
  if (!/^[a-z0-9_]{1,30}$/.test(category)) {
    await send(
      `Usage:\n${cmd} <list_name> <chat_id> [chat_id …]\n\nList name: 1-30 chars, letters/digits/underscore.\nExample: ${cmd} anime -1001710860595 -1002298797194\n\nSee all lists: /lists`,
    );
    return;
  }
  const ids = parts
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n) && n !== 0);
  if (cmd === "/createlist" || cmd === "/newlist") {
    const { data: existing } = await supabaseAdmin
      .from("chat_lists")
      .select("chat_id")
      .eq("category", category);
    if (existing?.length) {
      await send(
        `⚠️ List <b>${escapeHtml(category)}</b> already exists with ${existing.length} channel${existing.length === 1 ? "" : "s"}.\nView: <code>/showlist ${escapeHtml(category)}</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }
    if (!ids.length) {
      await send(
        `✅ List name <b>${escapeHtml(category)}</b> is available.\n\nAdd channels to create it:\n<code>/addtolist ${escapeHtml(category)} &lt;chat_id&gt; [chat_id …]</code>\n\nRun /channels to see IDs.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    const rows = ids.map((chat_id) => ({
      category,
      chat_id,
      added_by: fromId,
      added_by_name: fromName,
    }));
    const { error } = await supabaseAdmin
      .from("chat_lists")
      .upsert(rows, { onConflict: "category,chat_id" });
    if (error) {
      await send(`❌ Failed: ${error.message}`);
      return;
    }
    await send(
      `🆕 Created list <b>${escapeHtml(category)}</b> with ${ids.length} channel${ids.length === 1 ? "" : "s"}.\nView: <code>/showlist ${escapeHtml(category)}</code>\nAdd more: <code>/addtolist ${escapeHtml(category)} &lt;chat_id&gt;</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (!ids.length) {
    await send(`Provide at least one chat_id. Run /channels to see IDs.`);
    return;
  }

  if (cmd === "/addtolist") {
    const rows = ids.map((chat_id) => ({
      category,
      chat_id,
      added_by: fromId,
      added_by_name: fromName,
    }));
    const { error } = await supabaseAdmin
      .from("chat_lists")
      .upsert(rows, { onConflict: "category,chat_id" });
    if (error) {
      await send(`❌ Failed: ${error.message}`);
      return;
    }
    await send(
      `✅ Added ${ids.length} chat${ids.length === 1 ? "" : "s"} to the <b>${escapeHtml(category)}</b> list.\nView it: <code>/showlist ${escapeHtml(category)}</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // remove
  const { error } = await supabaseAdmin
    .from("chat_lists")
    .delete()
    .eq("category", category)
    .in("chat_id", ids);
  if (error) {
    await send(`❌ Failed: ${error.message}`);
    return;
  }
  await send(
    `🗑 Removed ${ids.length} chat${ids.length === 1 ? "" : "s"} from the <b>${escapeHtml(category)}</b> list.`,
    { parse_mode: "HTML" },
  );
}

async function handleBackupCommand(args: {
  fromId: number;
  chatId: number;
  chatType: string;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, chatId, chatType, telegramCall, supabaseAdmin } = args;
  if (chatType !== "private") {
    await telegramCall("sendMessage", { chat_id: chatId, text: "🔒 Use /backup in a private chat with me." });
    return;
  }
  const { role } = await isBotAdmin(supabaseAdmin, fromId);
  if (role !== "super_admin") {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Only super admins can run /backup." });
    return;
  }
  await telegramCall("sendMessage", { chat_id: chatId, text: "📦 Building backup…" });
  try {
    const { buildBackup, sendJsonDocument } = await import("@/lib/backup.server");
    const payload = await buildBackup();
    const filename = `telemanage-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const totalRows = Object.values(payload.meta.row_counts).reduce((a, b) => a + b, 0);
    const caption =
      `🗄 <b>Backup</b>\n` +
      `Generated: <code>${payload.generated_at}</code>\n` +
      `Rows: <b>${totalRows}</b> across ${Object.keys(payload.meta.row_counts).length} tables\n` +
      (payload.meta.notes.length ? `Notes: ${escapeHtml(payload.meta.notes.join("; "))}` : "");
    await sendJsonDocument(chatId, filename, payload, caption);
  } catch (e: any) {
    await telegramCall("sendMessage", { chat_id: chatId, text: `❌ Backup failed: ${e?.message ?? "unknown"}` });
  }
}

async function handleRestoreDocument(args: {
  fromId: number;
  chatId: number;
  chatType: string;
  document: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  supabaseAdmin: any;
}) {
  const { fromId, chatId, chatType, document, telegramCall, supabaseAdmin } = args;
  if (chatType !== "private") {
    await telegramCall("sendMessage", { chat_id: chatId, text: "🔒 Restore only works in a private chat with me." });
    return;
  }
  const { role } = await isBotAdmin(supabaseAdmin, fromId);
  if (role !== "super_admin") {
    await telegramCall("sendMessage", { chat_id: chatId, text: "❌ Only super admins can /restore." });
    return;
  }
  await telegramCall("sendMessage", { chat_id: chatId, text: "📥 Downloading backup…" });
  try {
    const { downloadTelegramFile, restoreFromPayload } = await import("@/lib/backup.server");
    const buf = await downloadTelegramFile(document.file_id);
    const text = new TextDecoder().decode(buf);
    const payload = JSON.parse(text);
    if (payload?.version !== 1 || !payload?.tables) {
      await telegramCall("sendMessage", { chat_id: chatId, text: "❌ File doesn't look like a TeleManage backup (missing version/tables)." });
      return;
    }
    await telegramCall("sendMessage", { chat_id: chatId, text: "♻️ Restoring… this may take a moment." });
    const { restored, errors } = await restoreFromPayload(payload);
    const lines = ["✅ <b>Restore complete</b>", ""];
    for (const [t, n] of Object.entries(restored)) lines.push(`• ${t}: <b>${n}</b>`);
    if (Object.keys(errors).length) {
      lines.push("", "⚠️ <b>Errors</b>");
      for (const [t, e] of Object.entries(errors)) lines.push(`• ${t}: ${escapeHtml(e)}`);
    }
    await telegramCall("sendMessage", { chat_id: chatId, text: lines.join("\n"), parse_mode: "HTML" });
  } catch (e: any) {
    console.error("restore failed:", e?.message ?? e, "\n", e?.stack ?? "");
    await telegramCall("sendMessage", { chat_id: chatId, text: `❌ Restore failed: ${e?.message ?? "unknown"}` });
  }
}
