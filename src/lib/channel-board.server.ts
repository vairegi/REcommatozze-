// Channel board: renders the /channels list as a single spreadsheet-style PNG
// board (one sendPhoto instead of 3+ chunked text messages), with clickable
// inline buttons under it (per-channel "open" links + category filters +
// Refresh). Falls back to the legacy chunked text if rendering fails.
//
// Pure rendering (renderChannelBoard) does NO I/O — safe to unit-test.
// The gather step preserves the exact legacy /channels behavior (live
// getChatMember verification, [LIST] tags, ✅IAds partner tag, invite links).
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PARTNER_BOT = "@InsideAds_bot";
const PRIORITY = ["MINE", "ADULT", "MANGA"];
const MAX_OPEN_BUTTONS = 40; // inline keyboards are capped at 100 buttons total

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ChannelType = "channel" | "supergroup" | "group";

export interface ChannelEntry {
  num: number; // assigned after ordering
  type: ChannelType;
  title: string; // raw title/username (may contain any unicode)
  chatId: number;
  cats: string[]; // UPPERCASE list names, [] = none
  iads: boolean; // partner bot is also admin
  locked: boolean; // no invite link available
  url?: string;
}

export interface GatherDeps {
  supabaseAdmin: any;
  telegramCall: (m: string, b?: Record<string, unknown>) => Promise<any>;
  getBotIdentity: () => Promise<{ id: number; username?: string }>;
  getChatMemberStatus: (chatId: number, userId: number) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Data gathering (logic moved verbatim from the old handleChannelsCommand)
// ---------------------------------------------------------------------------
export async function gatherChannelEntries(d: GatherDeps): Promise<ChannelEntry[]> {
  const { data: chats } = await d.supabaseAdmin
    .from("telegram_chats")
    .select("chat_id, title, type, username, first_seen_at")
    .in("type", ["group", "supergroup", "channel"])
    .order("first_seen_at", { ascending: true })
    .limit(200);

  if (!chats?.length) return [];

  const bot = await d.getBotIdentity();
  let partnerId: number | null = null;
  try {
    const info = await d.telegramCall("getChat", { chat_id: PARTNER_BOT });
    partnerId = Number(info?.id) || null;
  } catch (e) {
    console.warn("getChat partner bot failed", e);
  }

  const { data: listRows } = await d.supabaseAdmin.from("chat_lists").select("category, chat_id");
  const listsByChat = new Map<number, string[]>();
  for (const r of (listRows as any[]) ?? []) {
    const id = Number(r.chat_id);
    const arr = listsByChat.get(id) ?? [];
    if (!arr.includes(r.category)) arr.push(r.category);
    listsByChat.set(id, arr);
  }

  const raw = await Promise.all(
    chats.map(async (c: any) => {
      const botStatus = await d.getChatMemberStatus(c.chat_id, bot.id);
      const botAdmin = botStatus === "administrator" || botStatus === "creator";
      if (!botAdmin) return null;

      let iads = false;
      if (partnerId) {
        const ps = await d.getChatMemberStatus(c.chat_id, partnerId);
        if (ps === "administrator" || ps === "creator") iads = true;
      }

      const title = String(c.title || c.username || `Chat ${c.chat_id}`);
      let url: string | undefined;
      let locked = false;
      if (c.username) {
        url = `https://t.me/${c.username}`;
      } else {
        try {
          const info = await d.telegramCall("getChat", { chat_id: c.chat_id });
          url = info?.invite_link;
          if (!url) {
            try {
              const created = await d.telegramCall("exportChatInviteLink", { chat_id: c.chat_id });
              if (typeof created === "string") url = created;
            } catch (e) {
              console.warn("exportChatInviteLink failed", c.chat_id, e);
            }
          }
          if (!url) locked = true;
        } catch (e) {
          console.warn("getChat failed", c.chat_id, e);
        }
      }
      // Remember the link so we can still reach the chat after losing admin rights.
      if (url) {
        try {
          await d.supabaseAdmin.from("telegram_chats").update({ invite_link: url }).eq("chat_id", c.chat_id);
        } catch {
          /* ignore */
        }
      }

      const cats = (listsByChat.get(Number(c.chat_id)) ?? []).map((x) => String(x).toUpperCase());
      const type: ChannelType =
        c.type === "channel" ? "channel" : c.type === "supergroup" ? "supergroup" : "group";
      return { type, title, chatId: Number(c.chat_id), cats, iads, locked, url };
    }),
  );

  // Order by category: MINE → ADULT → MANGA → any other list → [NONE] last.
  const rank = (cats: string[]) => {
    if (!cats.length) return 10_000;
    let best = 9_999;
    for (const c of cats) {
      const i = PRIORITY.indexOf(c);
      best = Math.min(best, i >= 0 ? i : 100);
    }
    return best;
  };
  const ordered = (raw.filter(Boolean) as Omit<ChannelEntry, "num">[])
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => rank(a.cats) - rank(b.cats) || a.i - b.i);
  return ordered.map(({ i, ...e }, idx) => ({ ...e, num: idx + 1 }));
}

export function filterEntries(entries: ChannelEntry[], filter?: string | null): ChannelEntry[] {
  const f = (filter ?? "").trim().toUpperCase();
  if (!f) return entries;
  if (f === "NONE") return entries.filter((e) => e.cats.length === 0);
  return entries.filter((e) => e.cats.includes(f));
}

export function collectCategories(entries: ChannelEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) for (const c of e.cats) set.add(c);
  return PRIORITY.filter((p) => set.has(p)).concat([...set].filter((c) => !PRIORITY.includes(c)).sort());
}

// ---------------------------------------------------------------------------
// Board rendering (pure, no I/O)
// ---------------------------------------------------------------------------
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// Bundled DejaVu has no emoji/color glyphs — strip non-latin-1 so nothing
// renders as tofu boxes. Channel titles with CJK/etc. degrade gracefully.
function asciiSafe(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}
function clip(s: string, max: number): string {
  const t = asciiSafe(s);
  return t.length > max ? t.slice(0, max - 1) + "…".replace(/[^\x20-\x7E\xA0-\xFF]/g, ".") : t;
}
function escClip(s: string, max: number): string {
  return escapeXml(clip(s, max));
}
function istStamp(): string {
  try {
    return new Date().toLocaleString("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date().toISOString().slice(0, 16).replace("T", " ");
  }
}

const W = 1560;
const M = 26; // side margin
const ROW_H = 34;
const GH_H = 40;
const HEAD_H = 138; // title bar + filter chips + column header
const FOOT_H = 46;

interface GroupDef {
  key: ChannelType;
  label: string;
  emoji: string;
  bar: string;
  text: string;
  stripe: string;
}
const GROUPS: GroupDef[] = [
  { key: "channel", label: "Channels", emoji: "📢", bar: "#DBEAFE", text: "#1D4ED8", stripe: "#EFF6FF" },
  { key: "supergroup", label: "Supergroups", emoji: "👥", bar: "#D1FAE5", text: "#047857", stripe: "#ECFDF5" },
  { key: "group", label: "Groups", emoji: "👥", bar: "#EDE9FE", text: "#6D28D9", stripe: "#F5F3FF" },
];

export function renderChannelBoard(entries: ChannelEntry[], filter?: string | null): Buffer {
  const visible = filterEntries(entries, filter);
  const byType = new Map<ChannelType, ChannelEntry[]>();
  for (const g of GROUPS) byType.set(g.key, []);
  for (const e of visible) byType.get(e.type)!.push(e);
  const groups = GROUPS.map((g) => ({ def: g, rows: byType.get(g.key)! })).filter((g) => g.rows.length > 0);

  const height = HEAD_H + groups.reduce((a, g) => a + GH_H + g.rows.length * ROW_H, 0) + FOOT_H;

  const P: string[] = [];
  P.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="DejaVu Sans">`,
  );
  P.push(`<rect width="${W}" height="${height}" fill="#F8FAFC"/>`);

  // Header
  const title = filter
    ? `CHANNELS BOARD · ${escapeXml(asciiSafe(String(filter).toUpperCase()))}`
    : "CHANNELS BOARD";
  P.push(`<text x="${M}" y="46" font-size="30" font-weight="bold" fill="#0F172A">${title}</text>`);
  P.push(
    `<text x="${M}" y="76" font-size="17" fill="#64748B">${visible.length} shown · ${entries.length} total · ${escapeXml(istStamp())} IST · tap a button below to open</text>`,
  );

  // Filter chips (visual only — clickable versions are the inline buttons)
  const cats = collectCategories(entries);
  const chips = ["ALL", ...cats, "NONE"];
  let cx = M;
  const cy = 96;
  for (const c of chips) {
    const active = (filter ? String(filter).toUpperCase() : "ALL") === c;
    const label = c === "ALL" ? `ALL (${entries.length})` : `${c} (${filterEntries(entries, c === "ALL" ? null : c).length})`;
    const wpx = 16 + label.length * 8.6;
    P.push(`<rect x="${cx}" y="${cy}" width="${wpx}" height="30" rx="15" fill="${active ? "#2563EB" : "#E2E8F0"}"/>`);
    P.push(
      `<text x="${cx + wpx / 2}" y="${cy + 20}" font-size="14" font-weight="bold" fill="${active ? "#FFFFFF" : "#334155"}" text-anchor="middle">${escapeXml(label)}</text>`,
    );
    cx += wpx + 10;
  }

  // Column header
  const chy = HEAD_H - 12;
  P.push(`<rect x="${M}" y="${chy - 24}" width="${W - 2 * M}" height="30" fill="#F1F5F9"/>`);
  const cols = { num: M + 12, name: M + 66, id: M + 640, lists: M + 900, iads: M + 1220, link: M + 1330 };
  const colLabel = (x: number, t: string) =>
    P.push(`<text x="${x}" y="${chy - 4}" font-size="14" font-weight="bold" fill="#64748B">${t}</text>`);
  colLabel(cols.num, "#");
  colLabel(cols.name, "CHANNEL");
  colLabel(cols.id, "ID");
  colLabel(cols.lists, "LISTS");
  colLabel(cols.iads, "IADS");
  colLabel(cols.link, "LINK");

  // Rows
  let y = HEAD_H + 8;
  for (const { def, rows } of groups) {
    P.push(`<rect x="${M}" y="${y}" width="${W - 2 * M}" height="${GH_H}" rx="8" fill="${def.bar}"/>`);
    P.push(
      `<text x="${M + 14}" y="${y + 26}" font-size="19" font-weight="bold" fill="${def.text}">${def.emoji} ${def.label} (${rows.length})</text>`,
    );
    y += GH_H;
    rows.forEach((e, i) => {
      if (i % 2 === 1) P.push(`<rect x="${M}" y="${y}" width="${W - 2 * M}" height="${ROW_H}" fill="${def.stripe}"/>`);
      const ty = y + 23;
      const nameFill = e.locked ? "#94A3B8" : "#0F172A";
      P.push(`<text x="${cols.num}" y="${ty}" font-size="15" font-weight="bold" fill="#475569">${e.num}.</text>`);
      P.push(`<text x="${cols.name}" y="${ty}" font-size="15" fill="${nameFill}">${escClip(e.title, 42)}</text>`);
      P.push(`<text x="${cols.id}" y="${ty}" font-size="14" fill="#64748B">${e.chatId}</text>`);
      if (e.cats.length) {
        const tag = e.cats.join("|");
        const tw = 12 + tag.length * 7.8;
        P.push(`<rect x="${cols.lists - 6}" y="${y + 7}" width="${tw}" height="20" rx="10" fill="#E2E8F0"/>`);
        P.push(`<text x="${cols.lists}" y="${ty}" font-size="12" font-weight="bold" fill="#334155">${escapeXml(clip(tag, 18))}</text>`);
      } else {
        P.push(`<text x="${cols.lists}" y="${ty}" font-size="13" fill="#CBD5E1">—</text>`);
      }
      P.push(
        `<text x="${cols.iads}" y="${ty}" font-size="14">${e.iads ? `<tspan fill="#059669" font-weight="bold">✓ IAds</tspan>` : `<tspan fill="#CBD5E1">—</tspan>`}</text>`,
      );
      P.push(
        `<text x="${cols.link}" y="${ty}" font-size="14">${e.locked ? `<tspan fill="#F59E0B">🔒</tspan>` : e.url ? `<tspan fill="#2563EB">open ↓</tspan>` : `<tspan fill="#CBD5E1">—</tspan>`}</text>`,
      );
      y += ROW_H;
    });
  }
  P.push(
    `<text x="${M}" y="${height - 16}" font-size="13" fill="#94A3B8">🔒 = no invite link (private, bot can still post) · ✅IAds = @InsideAds_bot also admin · numbering matches /channels text order</text>`,
  );
  P.push(`</svg>`);

  const fontDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "fonts");
  const resvg = new Resvg(P.join(""), {
    fitTo: { mode: "original" },
    background: "#F8FAFC",
    font: {
      loadSystemFonts: false,
      fontDirs: [fontDir],
      defaultFontFamily: "DejaVu Sans",
    },
  });
  return Buffer.from(resvg.render().asPng());
}

// ---------------------------------------------------------------------------
// Inline keyboard + caption + legacy text fallback
// ---------------------------------------------------------------------------
export function sendBoardKeyboard(
  visible: ChannelEntry[],
  cats: string[],
  filter: string | null,
  total: number,
): Record<string, unknown> {
  const chip = (label: string, data: string, active: boolean) => ({
    text: active ? `• ${label} •` : label,
    callback_data: data,
  });
  const rows: any[] = [];
  const chipRow: any[] = [chip(`All ${total}`, "chb:all", !filter)];
  for (const c of cats) chipRow.push(chip(c, `chb:cat:${c}`, !!filter && filter.toUpperCase() === c));
  chipRow.push(chip("No-list", "chb:cat:NONE", !!filter && filter.toUpperCase() === "NONE"));
  // Telegram allows 8 buttons per row; chips rarely exceed that, but be safe.
  for (let i = 0; i < chipRow.length; i += 6) rows.push(chipRow.slice(i, i + 6));
  rows.push([{ text: "🔄 Refresh", callback_data: `chb:refresh:${filter ?? ""}` }]);

  const openable = visible.filter((e) => !!e.url).slice(0, MAX_OPEN_BUTTONS);
  for (let i = 0; i < openable.length; i += 2) {
    rows.push(
      openable.slice(i, i + 2).map((e) => ({
        text: `📂 ${e.num}. ${clip(e.title, 20)}`,
        url: e.url,
      })),
    );
  }
  return { inline_keyboard: rows };
}

export function boardCaption(
  visible: ChannelEntry[],
  total: number,
  filter: string | null,
  escapeHtml: (s: string) => string,
): string {
  const openable = visible.filter((e) => !!e.url).length;
  const counts = GROUPS.map(
    (g) => `${g.emoji} ${visible.filter((e) => e.type === g.key).length} ${g.label.toLowerCase()}`,
  ).join(" · ");
  const lines = [
    `📋 <b>Channels board${filter ? ` · ${escapeHtml(filter.toUpperCase())}` : ""}</b> — ${visible.length} of ${total} chats where I'm admin`,
    counts,
    `🕒 ${escapeHtml(istStamp())} IST`,
  ];
  if (openable > MAX_OPEN_BUTTONS) {
    lines.push(`ℹ️ Open buttons show the first ${MAX_OPEN_BUTTONS} of ${openable} linkable chats.`);
  }
  lines.push(`\nNeed the old text? <code>/channels text</code>`);
  return lines.join("\n");
}

export function buildBoardText(entries: ChannelEntry[], escapeHtml: (s: string) => string): string {
  const buckets: Record<ChannelType, string[]> = { channel: [], supergroup: [], group: [] };
  for (const e of entries) {
    const partnerTag = e.iads ? "✅IAds " : "";
    const tag = e.cats.length
      ? `<b>[${escapeHtml(e.cats.join("|").toUpperCase())}]</b> `
      : `<b>[NONE]</b> `;
    const name = e.url ? `<a href="${escapeHtml(e.url)}">${escapeHtml(e.title)}</a>` : escapeHtml(e.title);
    const suffix = e.locked ? " 🔒" : "";
    buckets[e.type].push(`${partnerTag}${tag}${name}${suffix} — <code>${e.chatId}</code>`);
  }
  const numbered = (items: string[]) => items.map((it, i) => `<b>${i + 1}.</b> ${it}`).join("\n\n");
  const sections: string[] = [];
  if (buckets.channel.length) sections.push(`📢 <b>Channels (${buckets.channel.length})</b>\n${numbered(buckets.channel)}`);
  if (buckets.supergroup.length)
    sections.push(`👥 <b>Supergroups (${buckets.supergroup.length})</b>\n${numbered(buckets.supergroup)}`);
  if (buckets.group.length) sections.push(`👥 <b>Groups (${buckets.group.length})</b>\n${numbered(buckets.group)}`);
  return sections.length ? sections.join("\n\n") : "No chats found where I am admin.";
}

// ---------------------------------------------------------------------------
// Delivery + refresh (used by webhook.ts)
// ---------------------------------------------------------------------------
export interface BoardDeps extends GatherDeps {
  dmChatId: number;
  filter?: string | null;
  messageId?: number; // set when refreshing in place (edit instead of new post)
  escapeHtml: (s: string) => string;
  sendPhotoBuffer: (args: {
    chatId: number;
    png: Buffer;
    caption?: string;
    replyMarkup?: Record<string, unknown>;
  }) => Promise<any>;
  editMessageCaption: (args: {
    chatId: number;
    messageId: number;
    caption?: string;
    replyMarkup?: Record<string, unknown>;
  }) => Promise<any>;
  editPhotoBuffer: (args: {
    chatId: number;
    messageId: number;
    png: Buffer;
    caption?: string;
    replyMarkup?: Record<string, unknown>;
  }) => Promise<any>;
  sendLegacyChunks: (entries: ChannelEntry[]) => Promise<void>; // old chunked-text path
}

export async function deliverChannelBoard(deps: BoardDeps): Promise<void> {
  const { dmChatId, telegramCall } = deps;
  const all = await gatherChannelEntries(deps);
  if (!all.length) {
    await telegramCall("sendMessage", { chat_id: dmChatId, text: "I'm not in any groups or channels yet." });
    return;
  }
  const filter = deps.filter?.trim() ? deps.filter.trim().toUpperCase() : null;
  const visible = filterEntries(all, filter);
  const cats = collectCategories(all);
  const keyboard = sendBoardKeyboard(visible, cats, filter, all.length);
  const caption = boardCaption(visible, all.length, filter, deps.escapeHtml);

  let png: Buffer | null = null;
  try {
    png = renderChannelBoard(all, filter);
  } catch (e) {
    console.error("channel board render failed, falling back to text:", e);
  }

  if (deps.messageId) {
    // Refresh path: swap the image itself (fresh data), then caption/buttons as fallback.
    if (png) {
      try {
        await deps.editPhotoBuffer({ chatId: dmChatId, messageId: deps.messageId, png, caption, replyMarkup: keyboard });
        return;
      } catch (e) {
        console.warn("editPhotoBuffer failed, trying caption-only edit:", e);
      }
    }
    try {
      await deps.editMessageCaption({
        chatId: dmChatId,
        messageId: deps.messageId,
        caption,
        replyMarkup: keyboard,
      });
      return;
    } catch (e) {
      console.warn("editMessageCaption failed, posting new board:", e);
    }
  }
  if (png) {
    try {
      await deps.sendPhotoBuffer({ chatId: dmChatId, png, caption, replyMarkup: keyboard });
      return;
    } catch (e) {
      console.error("sendPhoto failed, falling back to chunked text:", e);
    }
  }
  await deps.sendLegacyChunks(all);
}
