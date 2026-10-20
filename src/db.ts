// ─── db (split from bin/cc-launch.mjs) ─────────────────────────────

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { DB_PATH, SETTINGS_PATH, VIRTUAL_STACK_APPS, VIRTUAL_STACK_PROVIDER_ID } from "./paths.js";
import { appendVirtualStackRowCore, virtualStackProviderForCore } from "./stack/virtual-row.js";
import type { ProviderRow } from "./types.js";

// ─── DB queries ───────────────────────────────────────────────────────

// sqlite's busy wait must be allowed to complete before the process timeout
// kills it — with .timeout 3000 and a 2000ms process cap the lock wait could
// never finish.
const DB_BUSY_TIMEOUT_MS = 3000;
const DB_PROC_TIMEOUT_MS = 5000;

function queryDB(sql: string): any[] {
  try {
    const json = execFileSync("sqlite3", ["-json", DB_PATH, sql], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: DB_PROC_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(json || "[]");
  } catch (e: any) {
    if (e.status === 1 && (!e.stdout || !e.stderr)) return [];
    throw e;
  }
}

// Write helper for SQLite (mirrors queryDB without -json / JSON.parse).
// Used by runtime-preference recycling to atomically patch common_config_claude.
// ".timeout 3000" is a sqlite3 dot-command setting the busy timeout — the
// 2s `timeout` option below only bounds the PROCESS, and can't make sqlite
// wait out a lock held by the cc-switch desktop app mid-write.
function execDB(sql: string): void {
  execFileSync("sqlite3", [DB_PATH, `.timeout ${DB_BUSY_TIMEOUT_MS}`, sql], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: DB_PROC_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sqlQuote(str: string): string {
  return "'" + String(str).replace(/'/g, "''") + "'";
}

// Provider names already in the DB for this app — injected into the virtual
// row derivation so this module does not have to import stack/state.
function takenProviderNames(appType: string): string[] {
  try {
    return queryDB(`SELECT name FROM providers WHERE app_type = ${sqlQuote(appType)}`).map(
      (r) => r.name,
    );
  } catch {
    return [];
  }
}

function virtualProvider(appType: string) {
  return virtualStackProviderForCore(appType, takenProviderNames(appType));
}

function appendVirtualStackRow(rows: any[], appType: string) {
  return appendVirtualStackRowCore(rows, appType, takenProviderNames(appType));
}

// All DB providers matching a name, ordered by id. Names are NOT unique in
// the cc-switch DB, so launch/customize must use this instead of taking the
// first row blindly. The virtual aggregation entry answers only when the DB
// has no match, preserving the DB-first rule of queryProvider.
function queryProviderMatches(name: string, appType: string): ProviderRow[] {
  const rows = queryDB(
    `SELECT id, name, settings_config, category, meta FROM providers WHERE name = ${sqlQuote(name)} AND app_type = ${sqlQuote(appType)} ORDER BY id`,
  );
  if (rows.length) return rows;
  // Virtual aggregation entry: DB-first by name, the derived row answers only
  // under its own (collision-dodged) display name. Fail-open on derive trouble.
  try {
    if (VIRTUAL_STACK_APPS.has(appType)) {
      const v = virtualProvider(appType);
      if (v && v.name === name) return [v];
    }
  } catch {
    /* fall through to [] */
  }
  return [];
}

// Legacy first-wins lookup has been removed: callers must either use
// queryProviderMatches (and surface ambiguity) or queryProviderById.

function queryProviderById(id: string, appType: string): ProviderRow | null {
  const rows = queryDB(
    `SELECT id, name, settings_config, category, meta FROM providers WHERE id = ${sqlQuote(id)} AND app_type = ${sqlQuote(appType)} LIMIT 1`,
  );
  if (rows[0]) return rows[0];
  try {
    if (id === VIRTUAL_STACK_PROVIDER_ID && VIRTUAL_STACK_APPS.has(appType)) {
      return virtualProvider(appType);
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

function queryProvidersByApp(appType: string): ProviderRow[] {
  const rows = queryDB(
    `SELECT id, name FROM providers WHERE app_type = ${sqlQuote(appType)} ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC`,
  );
  return appendVirtualStackRow(rows, appType);
}

// Same query, but errors PROPAGATE (queryDB's silent-catch collapses any
// sqlite3 failure — missing binary, missing table, locked DB — to [], which
// would corrupt callers that must fail open: the v1→v2 history migration
// (every live entry would be marked dead) and the TUI's alive snapshot
// (every Recent row would be flagged ✗ missing).
function queryProvidersStrict(appType: string): ProviderRow[] {
  const json = execFileSync(
    "sqlite3",
    [
      "-json",
      DB_PATH,
      `SELECT id, name FROM providers WHERE app_type = ${sqlQuote(appType)} ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC`,
    ],
    { encoding: "utf8", timeout: DB_PROC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Virtual row merges ONLY onto a successful read — a DB failure must
  // propagate untouched so history migration / alive snapshots stay honest.
  return appendVirtualStackRow(JSON.parse(json || "[]"), appType);
}

// Full-row listing for `switch list`: same ordering and virtual-row merge as
// queryProvidersByApp, but keeps every column the inspector needs. `strict`
// propagates sqlite3 failures (the read-only command must not report an empty
// provider set on a broken DB) and never lets sqlite3 create a missing DB.
function queryProviderRowsByApp(appType: string, strict = false): ProviderRow[] {
  const sql = `SELECT id, name, settings_config, category, meta, is_current, sort_index FROM providers WHERE app_type = ${sqlQuote(appType)} ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC`;
  if (!strict) return appendVirtualStackRow(queryDB(sql), appType);
  if (!existsSync(DB_PATH)) throw new Error(`cc-switch DB not found: ${DB_PATH}`);
  const json = execFileSync("sqlite3", ["-json", DB_PATH, sql], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: DB_PROC_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return appendVirtualStackRow(JSON.parse(json || "[]"), appType);
}

// cc-switch schema generation, read from SQLite's user_version. 4.0.2+ is 20;
// 3.20.4 and 4.0.0/4.0.1 are 19. Missing DB / sqlite3 failure → null (callers
// fall back to the legacy common-config source). Guarding on existsSync
// matters: sqlite3 would CREATE an empty DB file for a missing path.
function readSchemaUserVersion(): number | null {
  try {
    if (!existsSync(DB_PATH)) return null;
    const rows = queryDB("PRAGMA user_version");
    const version = Number(rows?.[0]?.user_version);
    return Number.isInteger(version) ? version : null;
  } catch {
    return null;
  }
}

function queryCommonConfig(appType: any) {
  const key = `common_config_${appType}`;
  const rows = queryDB(`SELECT value FROM settings WHERE key = ${sqlQuote(key)}`);
  return rows[0]?.value || null;
}

// Atomically merge a patch into common_config_claude via sqlite json_patch
// (RFC 7396 merge patch: keys present in the patch override/add; absent keys
// are left untouched). A single UPDATE is atomic, so concurrent launches can't
// lose updates on disjoint keys. Only updates an existing row — never creates
// the common config if absent.
function patchCommonConfigClaude(patchObj: any) {
  const key = "common_config_claude";
  const patchLit = sqlQuote(JSON.stringify(patchObj));
  execDB(
    `UPDATE settings SET value = json_patch(value, json(${patchLit})) WHERE key = ${sqlQuote(key)}`,
  );
}

// Atomically merge a patch into one provider's settings_config via sqlite
// json_patch (RFC 7396 — same contract as patchCommonConfigClaude, but the
// target is providers.settings_config, a TEXT column holding JSON). A single
// UPDATE is atomic, so concurrent launches can't lose updates on disjoint
// keys. Only updates an existing row — never INSERTs a provider.
function patchProviderSettingsConfig(providerId: any, appType: any, patchObj: any) {
  const patchLit = sqlQuote(JSON.stringify(patchObj));
  execDB(
    `UPDATE providers SET settings_config = json_patch(settings_config, json(${patchLit})) ` +
      `WHERE id = ${sqlQuote(providerId)} AND app_type = ${sqlQuote(appType)}`,
  );
}

// ─── Settings reader ──────────────────────────────────────────────────

function loadSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

export {
  DB_BUSY_TIMEOUT_MS,
  DB_PROC_TIMEOUT_MS,
  execDB,
  loadSettings,
  patchCommonConfigClaude,
  patchProviderSettingsConfig,
  queryCommonConfig,
  queryDB,
  queryProviderById,
  queryProviderMatches,
  queryProviderRowsByApp,
  queryProvidersByApp,
  queryProvidersStrict,
  readSchemaUserVersion,
  sqlQuote,
};
