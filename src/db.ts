// Turso (libSQL) storage layer with a Supabase-compatible query API.
//
// Row shape (matches the existing Turso mirror created by the Lovable app):
//   CREATE TABLE "<table>" (pk TEXT PRIMARY KEY, data TEXT /* json */, op TEXT, synced_at TEXT)
// so all data already mirrored into Turso keeps working as-is.
import { randomUUID } from "node:crypto";

export const TABLES = [
  "profiles",
  "user_roles",
  "telegram_bot_admins",
  "telegram_chats",
  "telegram_members",
  "telegram_messages",
  "moderation_actions",
  "bot_admin_events",
  "broadcasts",
  "broadcast_targets",
  "broadcast_drafts",
  "broadcast_templates",
  "broadcast_recurrences",
  "broadcast_button_presets",
  "chat_lists",
] as const;

export const PK_COLUMNS: Record<string, string[]> = {
  profiles: ["id"],
  user_roles: ["id"],
  telegram_bot_admins: ["user_id"],
  telegram_chats: ["chat_id"],
  telegram_members: ["chat_id", "user_id"],
  telegram_messages: ["update_id"],
  moderation_actions: ["id"],
  bot_admin_events: ["id"],
  broadcasts: ["id"],
  broadcast_targets: ["id"],
  broadcast_drafts: ["user_id"],
  broadcast_templates: ["user_id", "name"],
  broadcast_recurrences: ["id"],
  broadcast_button_presets: ["id"],
  chat_lists: ["category", "chat_id"],
};

type Arg = { type: "text" | "null"; value?: string };
type Stmt = { sql: string; args?: Arg[] };

function arg(v: string | null): Arg {
  return v === null ? { type: "null" } : { type: "text", value: String(v) };
}

function endpoint(): string {
  // TURSO_ENDPOINT is a dev/test override (used by the sandbox harness);
  // production leaves it unset and uses TURSO_DATABASE_URL.
  const override = process.env.TURSO_ENDPOINT;
  if (override) return override;
  // Accept libsql://, turso://, https:// (and a bare host): the Turso dashboard
  // and CLI print different schemes, and Node fetch only speaks http(s).
  const raw = (process.env.TURSO_DATABASE_URL ?? "").trim();
  if (!raw) throw new Error("TURSO_DATABASE_URL is not set");
  const https = raw.replace(/^(libsql|turso|https?):\/\//, "https://").replace(/\/$/, "");
  return `${https}/v2/pipeline`;
}

/** Run statements in one Turso HTTP round-trip; returns rows per statement. */
export async function tursoExec(stmts: Stmt[]): Promise<Array<Array<Record<string, any>>>> {
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!token) throw new Error("TURSO_AUTH_TOKEN is not set");
  const body = {
    requests: [...stmts.map((stmt) => ({ type: "execute", stmt })), { type: "close" }],
  };
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${text.slice(0, 400)}`);
  const parsed = JSON.parse(text);
  const results: any[] = parsed?.results ?? [];
  const out: Array<Array<Record<string, any>>> = [];
  for (const r of results) {
    if (r?.type === "error") throw new Error(`Turso error: ${r?.error?.message ?? "unknown"}`);
    const rs = r?.response?.result;
    if (!rs) continue;
    const cols: string[] = (rs.cols ?? []).map((c: any) => c.name);
    const rows = (rs.rows ?? []).map((row: any[]) => {
      const o: Record<string, any> = {};
      row.forEach((cell: any, i: number) => {
        o[cols[i]] = cell?.type === "null" ? null : cell?.value;
      });
      return o;
    });
    out.push(rows);
  }
  return out;
}

function createSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS "${table}" (pk TEXT PRIMARY KEY, data TEXT, op TEXT, synced_at TEXT)`;
}

export async function ensureSchema(): Promise<void> {
  await tursoExec(TABLES.map((t) => ({ sql: createSql(t) })));
}

function rowKey(table: string, row: Record<string, any>): string {
  const cols = PK_COLUMNS[table] ?? ["id"];
  return cols.map((c) => String(row?.[c] ?? "")).join("::");
}

/** Fill server-side defaults the Postgres schema used to provide. */
function withDefaults(table: string, row: Record<string, any>): Record<string, any> {
  const out = { ...row };
  const pks = PK_COLUMNS[table] ?? ["id"];
  if (pks.length === 1 && pks[0] === "id" && (out.id === undefined || out.id === null)) {
    out.id = randomUUID();
  }
  const now = new Date().toISOString();
  if (out.created_at === undefined) out.created_at = now;
  if (table === "telegram_chats" && out.first_seen_at === undefined) out.first_seen_at = now;
  return out;
}

type Filter =
  | { kind: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike"; col: string; val: any }
  | { kind: "in"; col: string; vals: any[] }
  | { kind: "is"; col: string; val: any }
  | { kind: "notis"; col: string; val: any };

function matches(row: Record<string, any>, f: any): boolean {
  const v = row?.[f.col];
  switch (f.kind) {
    case "eq":
      return String(v ?? "") === String(f.val ?? "");
    case "neq":
      return String(v ?? "") !== String(f.val ?? "");
    case "gt":
      return v != null && String(v) > String(f.val);
    case "gte":
      return v != null && String(v) >= String(f.val);
    case "lt":
      return v != null && String(v) < String(f.val);
    case "lte":
      return v != null && String(v) <= String(f.val);
    case "like":
      return typeof v === "string" && v.includes(String(f.val).replace(/%/g, ""));
    case "ilike":
      return (
        typeof v === "string" &&
        v.toLowerCase().includes(String(f.val).replace(/%/g, "").toLowerCase())
      );
    case "in":
      return (f.vals ?? []).map((x: any) => String(x)).includes(String(v ?? ""));
    case "is":
      return f.val === null ? v === null || v === undefined : v === f.val;
    case "notis":
      return f.val === null ? v !== null && v !== undefined : v !== f.val;
    default:
      return true;
  }
}

type Result = { data: any; error: { message: string } | null; count: number | null };

class Query implements PromiseLike<Result> {
  private filters: Filter[] = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private _limit: number | null = null;
  private _offset = 0;
  private _single: "one" | "maybe" | null = null;
  private _count = false;
  private _head = false;
  private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: any = null;

  constructor(private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this._count = true;
    if (opts?.head) this._head = true;
    return this;
  }
  insert(rows: any) {
    this.mode = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: any, _opts?: { onConflict?: string }) {
    this.mode = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch: any) {
    this.mode = "update";
    this.payload = patch;
    return this;
  }
  delete(opts?: { count?: string }) {
    this.mode = "delete";
    if (opts?.count) this._count = true;
    return this;
  }
  eq(col: string, val: any) { this.filters.push({ kind: "eq", col, val }); return this; }
  neq(col: string, val: any) { this.filters.push({ kind: "neq", col, val }); return this; }
  gt(col: string, val: any) { this.filters.push({ kind: "gt", col, val }); return this; }
  gte(col: string, val: any) { this.filters.push({ kind: "gte", col, val }); return this; }
  lt(col: string, val: any) { this.filters.push({ kind: "lt", col, val }); return this; }
  lte(col: string, val: any) { this.filters.push({ kind: "lte", col, val }); return this; }
  like(col: string, val: any) { this.filters.push({ kind: "like", col, val }); return this; }
  ilike(col: string, val: any) { this.filters.push({ kind: "ilike", col, val }); return this; }
  in(col: string, vals: any[]) { this.filters.push({ kind: "in", col, vals: vals ?? [] }); return this; }
  is(col: string, val: any) { this.filters.push({ kind: "is", col, val }); return this; }
  not(col: string, op: string, val: any) {
    if (op === "is") this.filters.push({ kind: "notis", col, val });
    else this.filters.push({ kind: "neq", col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) { this._limit = n; return this; }
  range(from: number, to: number) { this._offset = from; this._limit = to - from + 1; return this; }
  single() { this._single = "one"; return this; }
  maybeSingle() { this._single = "maybe"; return this; }

  private async fetchRows(): Promise<Record<string, any>[]> {
    const res = await tursoExec([
      { sql: createSql(this.table) },
      { sql: `SELECT data FROM "${this.table}"` },
    ]);
    const rows = res[res.length - 1] ?? [];
    const parsed = rows.map((r) => {
      try {
        return JSON.parse(r.data ?? "{}");
      } catch {
        return {};
      }
    });
    const out = parsed.filter((row) => this.filters.every((f) => matches(row, f)));
    for (const o of [...this.orders].reverse()) {
      out.sort((a, b) => {
        const av = a?.[o.col];
        const bv = b?.[o.col];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : String(av) < String(bv)
              ? -1
              : 1;
        return o.asc ? cmp : -cmp;
      });
    }
    return out;
  }

  private async fetchAllRaw(): Promise<Map<string, Record<string, any>>> {
    const res = await tursoExec([
      { sql: createSql(this.table) },
      { sql: `SELECT pk, data FROM "${this.table}"` },
    ]);
    const rows = res[res.length - 1] ?? [];
    const m = new Map<string, Record<string, any>>();
    for (const r of rows) {
      try {
        m.set(String(r.pk), JSON.parse(r.data ?? "{}"));
      } catch {
        /* ignore malformed */
      }
    }
    return m;
  }

  private async run(): Promise<Result> {
    try {
      if (this.mode === "select") {
        const all = await this.fetchRows();
        const count = all.length;
        let rows = all.slice(this._offset);
        if (this._limit !== null) rows = rows.slice(0, this._limit);
        if (this._head) return { data: null, error: null, count };
        if (this._single) {
          if (!rows.length) {
            return this._single === "maybe"
              ? { data: null, error: null, count }
              : { data: null, error: { message: "no rows found" }, count };
          }
          return { data: rows[0], error: null, count };
        }
        return { data: rows, error: null, count: this._count ? count : null };
      }

      if (this.mode === "insert" || this.mode === "upsert") {
        const now = new Date().toISOString();
        const rows = (this.payload as any[]).map((r) => withDefaults(this.table, r));
        const stmts: Stmt[] = [{ sql: createSql(this.table) }];
        if (this.mode === "insert") {
          for (const row of rows) {
            stmts.push({
              sql: `INSERT INTO "${this.table}" (pk, data, op, synced_at) VALUES (?, ?, 'insert', ?) ON CONFLICT(pk) DO UPDATE SET data=excluded.data, synced_at=excluded.synced_at`,
              args: [arg(rowKey(this.table, row)), arg(JSON.stringify(row)), arg(now)],
            });
          }
        } else {
          const existing = await this.fetchAllRaw();
          for (const row of rows) {
            const key = rowKey(this.table, row);
            const prev = existing.get(key) ?? {};
            const merged = { ...prev, ...row };
            stmts.push({
              sql: `INSERT INTO "${this.table}" (pk, data, op, synced_at) VALUES (?, ?, 'upsert', ?) ON CONFLICT(pk) DO UPDATE SET data=excluded.data, op='upsert', synced_at=excluded.synced_at`,
              args: [arg(key), arg(JSON.stringify(merged)), arg(now)],
            });
          }
        }
        const CHUNK = 100;
        for (let i = 0; i < stmts.length; i += CHUNK) await tursoExec(stmts.slice(i, i + CHUNK));
        const data = this._single ? rows[0] ?? null : rows;
        return { data, error: null, count: rows.length };
      }

      if (this.mode === "update") {
        const targets = await this.fetchRows();
        const now = new Date().toISOString();
        const stmts: Stmt[] = [{ sql: createSql(this.table) }];
        const updated: any[] = [];
        for (const row of targets) {
          const merged = { ...row, ...this.payload };
          updated.push(merged);
          stmts.push({
            sql: `INSERT INTO "${this.table}" (pk, data, op, synced_at) VALUES (?, ?, 'update', ?) ON CONFLICT(pk) DO UPDATE SET data=excluded.data, op='update', synced_at=excluded.synced_at`,
            args: [arg(rowKey(this.table, merged)), arg(JSON.stringify(merged)), arg(now)],
          });
        }
        const CHUNK = 100;
        for (let i = 0; i < stmts.length; i += CHUNK) await tursoExec(stmts.slice(i, i + CHUNK));
        const data = this._single ? updated[0] ?? null : updated;
        return { data, error: null, count: updated.length };
      }

      const targets = await this.fetchRows();
      const stmts: Stmt[] = [{ sql: createSql(this.table) }];
      for (const row of targets) {
        stmts.push({
          sql: `DELETE FROM "${this.table}" WHERE pk = ?`,
          args: [arg(rowKey(this.table, row))],
        });
      }
      const CHUNK = 100;
      for (let i = 0; i < stmts.length; i += CHUNK) await tursoExec(stmts.slice(i, i + CHUNK));
      return { data: targets, error: null, count: targets.length };
    } catch (e: any) {
      return { data: this._single ? null : [], error: { message: e?.message ?? String(e) }, count: null };
    }
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

export const supabaseAdmin: any = {
  from(table: string) {
    return new Query(table);
  },
};
