// Server-only helpers for recurring broadcasts.
// Presets translate to a 5-field UTC cron; advanced users can supply cron directly.
import { CronExpressionParser } from "cron-parser";
import { executeBroadcast, formatDeliveryReport } from "./broadcast.server";
import { telegramCall } from "./telegram.server";

const IST_OFFSET_MIN = 330;

const DOW: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

function parseHHMM(s: string): { h: number; mi: number } | null {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/**
 * Convert an IST wall-clock HH:MM into UTC HH:MM. When the IST time
 * crosses midnight in UTC we also return a day shift (+/-1) that callers
 * apply to day-of-week / day-of-month fields.
 */
function istHHMMToUtc(h: number, mi: number): { h: number; mi: number; dayShift: -1 | 0 } {
  const total = h * 60 + mi - IST_OFFSET_MIN;
  let mins = total;
  let dayShift: -1 | 0 = 0;
  if (mins < 0) {
    mins += 24 * 60;
    dayShift = -1;
  }
  return { h: Math.floor(mins / 60) % 24, mi: mins % 60, dayShift };
}

export interface ParsedRecurrence {
  kind: "daily" | "weekly" | "monthly" | "cron";
  cron: string;
  humanText: string;
}

/**
 * Parse a recurrence spec string. Examples:
 *   "daily 09:00"
 *   "weekly mon 21:30"
 *   "monthly 1 09:00"     -> day-of-month = 1
 *   'cron 0 9 * * *'      -> raw 5-field UTC cron
 */
export function parseRecurrenceSpec(input: string): ParsedRecurrence {
  const s = input.trim().toLowerCase();
  if (!s) throw new Error("empty spec");

  if (s.startsWith("cron ")) {
    const expr = s.slice(5).trim();
    // validate
    CronExpressionParser.parse(expr, { tz: "UTC" });
    return { kind: "cron", cron: expr, humanText: `cron (UTC): ${expr}` };
  }

  const parts = s.split(/\s+/);
  const kind = parts[0];

  if (kind === "daily") {
    const t = parseHHMM(parts[1] ?? "");
    if (!t) throw new Error('daily needs HH:MM (IST), e.g. "daily 09:00"');
    const u = istHHMMToUtc(t.h, t.mi);
    return {
      kind: "daily",
      cron: `${u.mi} ${u.h} * * *`,
      humanText: `daily at ${pad(t.h)}:${pad(t.mi)} IST`,
    };
  }

  if (kind === "weekly") {
    const day = DOW[parts[1] ?? ""];
    if (day === undefined) throw new Error('weekly needs a day, e.g. "weekly mon 21:30"');
    const t = parseHHMM(parts[2] ?? "");
    if (!t) throw new Error('weekly needs HH:MM (IST) after the day');
    const u = istHHMMToUtc(t.h, t.mi);
    const utcDay = (day + (u.dayShift === -1 ? 6 : 0)) % 7;
    return {
      kind: "weekly",
      cron: `${u.mi} ${u.h} * * ${utcDay}`,
      humanText: `weekly ${parts[1]} at ${pad(t.h)}:${pad(t.mi)} IST`,
    };
  }

  if (kind === "monthly") {
    const dom = parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(dom) || dom < 1 || dom > 28) {
      throw new Error('monthly needs day 1-28, e.g. "monthly 1 09:00"');
    }
    const t = parseHHMM(parts[2] ?? "");
    if (!t) throw new Error('monthly needs HH:MM (IST) after the day');
    const u = istHHMMToUtc(t.h, t.mi);
    // If the IST->UTC shift is -1, subtract 1 from the day-of-month.
    // dom=1 shifted becomes "last day of previous month" which cron can't express;
    // in that edge case require the user to use an advanced cron expression.
    if (u.dayShift === -1 && dom === 1) {
      throw new Error("that time crosses UTC midnight into the previous month — use `cron` mode");
    }
    const utcDom = u.dayShift === -1 ? dom - 1 : dom;
    return {
      kind: "monthly",
      cron: `${u.mi} ${u.h} ${utcDom} * *`,
      humanText: `monthly on day ${dom} at ${pad(t.h)}:${pad(t.mi)} IST`,
    };
  }

  throw new Error('unknown spec. Use "daily HH:MM", "weekly <day> HH:MM", "monthly <day> HH:MM", or "cron <expr>"');
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Next fire time (UTC Date) strictly after `from`. */
export function nextRunAfter(cronExpr: string, from: Date = new Date()): Date {
  const it = CronExpressionParser.parse(cronExpr, { currentDate: from, tz: "UTC" });
  return it.next().toDate();
}

/** Run every due recurrence. Called from tickBroadcasts. */
export async function tickRecurrences(): Promise<{ fired: number; failed: number }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nowIso = new Date().toISOString();

  const { data: due } = await supabaseAdmin
    .from("broadcast_recurrences")
    .select("*")
    .eq("active", true)
    .lte("next_run_at", nowIso)
    .limit(20);

  let fired = 0;
  let failed = 0;
  for (const r of (due as any[]) ?? []) {
    try {
      // Create a broadcast row + targets, then execute immediately.
      const { data: bc, error: bcErr } = await supabaseAdmin
        .from("broadcasts")
        .insert({
          created_by: r.created_by,
          created_by_name: r.created_by_name,
          source_chat_id: r.source_chat_id,
          source_message_id: r.source_message_id,
          preview_text: r.preview_text,
          auto_delete_seconds: r.auto_delete_seconds,
          mode: r.mode ?? "copy",
          reply_markup: r.reply_markup ?? null,
          status: "pending",
          recurrence_id: r.id,
        })
        .select("id")
        .single();
      if (bcErr || !bc) throw new Error(bcErr?.message ?? "insert failed");

      const { data: chats } = await supabaseAdmin
        .from("telegram_chats")
        .select("chat_id, title, username")
        .in("chat_id", r.target_chat_ids ?? []);
      const targetRows = ((r.target_chat_ids as number[]) ?? []).map((cid) => {
        const c = (chats as any[] | null)?.find((x) => Number(x.chat_id) === Number(cid));
        return { broadcast_id: bc.id, chat_id: cid, chat_title: c?.title ?? String(cid) };
      });
      if (targetRows.length) {
        await supabaseAdmin.from("broadcast_targets").insert(targetRows);
      }

      const res = await executeBroadcast(bc.id);

      // Compute next fire strictly after now to avoid a tight loop if the
      // send took longer than one cron interval.
      const next = nextRunAfter(r.cron_expr, new Date());
      await supabaseAdmin
        .from("broadcast_recurrences")
        .update({
          last_run_at: new Date().toISOString(),
          next_run_at: next.toISOString(),
          run_count: (r.run_count ?? 0) + 1,
          last_error: null,
        })
        .eq("id", r.id);

      // DM the owner a short delivery report.
      try {
        await telegramCall("sendMessage", {
          chat_id: r.created_by,
          text: `🔁 <b>Recurring post fired</b> — ${escapeHtml(r.spec_text)}\n\n${formatDeliveryReport(res.targets, res.status)}`,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
      } catch { /* ignore */ }
      fired++;
    } catch (e: any) {
      failed++;
      // Move next_run forward so we don't retry every tick on a broken schedule.
      let next: Date | null = null;
      try { next = nextRunAfter(r.cron_expr, new Date()); } catch { /* keep current */ }
      await supabaseAdmin
        .from("broadcast_recurrences")
        .update({
          last_error: (e?.message ?? String(e)).slice(0, 500),
          next_run_at: next ? next.toISOString() : r.next_run_at,
        })
        .eq("id", r.id);
    }
  }
  return { fired, failed };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}