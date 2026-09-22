// Telegram Bot API client (direct, no gateway).
import { createHash } from "node:crypto";

export function botToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return t;
}

export function apiBase(): string {
  return `https://api.telegram.org/bot${botToken()}`;
}

export function fileBase(): string {
  return `https://api.telegram.org/file/bot${botToken()}`;
}

export async function telegramCall(method: string, body: Record<string, unknown> = {}) {
  const maxAttempts = 4;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${apiBase()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      const json = JSON.parse(text);
      if (json.ok === false) {
        throw new Error(`Telegram ${method} error: ${json.description ?? text}`);
      }
      return json.result;
    }
    const retriable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    lastErr = new Error(`Telegram ${method} failed [${res.status}]: ${text}`);
    if (!retriable || attempt === maxAttempts) throw lastErr;
    let delayMs = 500 * Math.pow(2, attempt - 1);
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs > 0) delayMs = Math.min(secs * 1000, 10_000);
    } else {
      try {
        const j = JSON.parse(text);
        const p = j?.parameters?.retry_after;
        if (typeof p === "number" && p > 0) delayMs = Math.min(p * 1000, 10_000);
      } catch {}
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastErr ?? new Error(`Telegram ${method} failed`);
}

export function deriveWebhookSecret(): string {
  return createHash("sha256").update(`telegram-webhook:${botToken()}`).digest("base64url");
}

let _botIdCache: { id: number; username?: string } | null = null;
export async function getBotIdentity(): Promise<{ id: number; username?: string }> {
  if (_botIdCache) return _botIdCache;
  const me = await telegramCall("getMe");
  _botIdCache = { id: me.id, username: me.username };
  return _botIdCache;
}

export async function getChatMemberStatus(chatId: number, userId: number): Promise<string | null> {
  try {
    const m = await telegramCall("getChatMember", { chat_id: chatId, user_id: userId });
    return m?.status ?? null;
  } catch {
    return null;
  }
}

/** Build a t.me link to a message. */
export function buildMessageLink(opts: {
  chatId: number;
  messageId: number;
  username?: string | null;
}): string | null {
  if (!opts.messageId) return null;
  if (opts.username) return `https://t.me/${opts.username}/${opts.messageId}`;
  const s = String(opts.chatId);
  if (s.startsWith("-100")) return `https://t.me/c/${s.slice(4)}/${opts.messageId}`;
  return null;
}

export async function setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<void> {
  await telegramCall("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
    is_big: false,
  });
}

export const REACTION_EMOJIS = [
  "👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱",
  "🎉","🤩","😢","🙏","👌","🕊","🤣","⚡","🍌","🏆",
  "💯","🤗","🫡","😍","🐳","❤‍🔥","🌚","🌭","💅","🤪",
];

/** Send a PNG (or any image) held in memory via multipart/form-data. */
export async function sendPhotoBuffer(args: {
  chatId: number;
  png: Buffer | Uint8Array;
  caption?: string;
  parseMode?: string;
  replyMarkup?: Record<string, unknown>;
}): Promise<any> {
  const form = new FormData();
  form.append("chat_id", String(args.chatId));
  const bytes = args.png instanceof Uint8Array ? args.png : new Uint8Array(args.png as ArrayLike<number>);
  // Copy into a fresh ArrayBuffer so the Blob gets a clean ArrayBuffer (not SharedArrayBuffer).
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  form.append("photo", new Blob([ab], { type: "image/png" }), "board.png");
  if (args.caption) {
    form.append("caption", args.caption);
    form.append("parse_mode", args.parseMode ?? "HTML");
  }
  if (args.replyMarkup) form.append("reply_markup", JSON.stringify(args.replyMarkup));
  const res = await fetch(`${apiBase()}/sendPhoto`, { method: "POST", body: form });
  const json: any = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(`Telegram sendPhoto failed: ${json?.description ?? res.status}`);
  }
  return json.result;
}

/** Replace the image + caption + keyboard of an existing photo message (true board refresh). */
export async function editPhotoBuffer(args: {
  chatId: number;
  messageId: number;
  png: Buffer | Uint8Array;
  caption?: string;
  parseMode?: string;
  replyMarkup?: Record<string, unknown>;
}): Promise<any> {
  const form = new FormData();
  form.append("chat_id", String(args.chatId));
  form.append("message_id", String(args.messageId));
  const bytes = args.png instanceof Uint8Array ? args.png : new Uint8Array(args.png as ArrayLike<number>);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  form.append(
    "media",
    JSON.stringify({
      type: "photo",
      media: "attach://board.png",
      caption: args.caption ?? "",
      parse_mode: args.parseMode ?? "HTML",
    }),
  );
  form.append("board.png", new Blob([ab], { type: "image/png" }), "board.png");
  if (args.replyMarkup) form.append("reply_markup", JSON.stringify(args.replyMarkup));
  const res = await fetch(`${apiBase()}/editMessageMedia`, { method: "POST", body: form });
  const json: any = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(`Telegram editMessageMedia failed: ${json?.description ?? res.status}`);
  }
  return json.result;
}

/** Edit the caption + inline keyboard of an existing photo message (used for board Refresh/filter). */
export async function editMessageCaption(args: {
  chatId: number;
  messageId: number;
  caption?: string;
  parseMode?: string;
  replyMarkup?: Record<string, unknown>;
}): Promise<any> {
  return telegramCall("editMessageCaption", {
    chat_id: args.chatId,
    message_id: args.messageId,
    caption: args.caption ?? "",
    parse_mode: args.parseMode ?? "HTML",
    reply_markup: args.replyMarkup,
  });
}
