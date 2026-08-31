#!/usr/bin/env node
// switch: Claude Code / Codex multi-provider parallel launcher
//
// Usage:
//   switch                                 # TUI interactive mode: select CLI then provider
//   switch update                          # Self-update to the latest npm version
//   switch <provider> <cmd> [args...]     # Command mode: specify provider and CLI directly
//
// Reads provider config from ~/.cc-switch/cc-switch.db, generates isolated instance dirs,
// and launches via CLAUDE_CONFIG_DIR / CODEX_HOME env var isolation.
// Different terminals use their own provider configs without interference.

import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  readdirSync,
  unlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ─── Path constants ────────────────────────────────────────────────────

function getHomeDir() {
  const testHome = process.env.CC_SWITCH_TEST_HOME;
  if (testHome && testHome.trim()) return testHome.trim();
  return homedir();
}

const HOME = getHomeDir();
const CC_SWITCH_DIR = join(HOME, ".cc-switch");
const DB_PATH = join(CC_SWITCH_DIR, "cc-switch.db");
const SETTINGS_PATH = join(CC_SWITCH_DIR, "settings.json");
const INSTANCES_DIR = join(CC_SWITCH_DIR, "instances");
const HISTORY_PATH = join(CC_SWITCH_DIR, "launch_history.json");
const SYNC_STATE_PATH = join(CC_SWITCH_DIR, "sync-state.json");

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const RESOURCES_DIR = join(SCRIPT_DIR, "..", "resources");

const NPM_PACKAGE_NAME = "cc-switch-parallel";

// Injected at build time by build.mjs; "__VERSION__" placeholder for source runs.
const VERSION = "__VERSION__";

// ─── smol-toml loader ─────────────────────────────────────────────────

let _tomlModule = null;

function getToml() {
  if (_tomlModule) return _tomlModule;
  // Try resolving from this package's node_modules
  const candidates = [
    join(SCRIPT_DIR, "..", "node_modules", "smol-toml"),
    join(SCRIPT_DIR, "..", "..", "node_modules", "smol-toml"),
  ];
  for (const p of candidates) {
    try {
      const mod = require(p);
      if (mod.parse && mod.stringify) {
        _tomlModule = mod;
        return mod;
      }
    } catch {}
  }
  try {
    const mod = require("smol-toml");
    if (mod.parse && mod.stringify) {
      _tomlModule = mod;
      return mod;
    }
  } catch {}
  throw new Error(
    "Failed to load smol-toml module. Please run npm install smol-toml.",
  );
}

function parseToml(text) {
  return getToml().parse(text);
}

function stringifyToml(obj) {
  return getToml().stringify(obj);
}

// ─── DB queries ───────────────────────────────────────────────────────

function queryDB(sql) {
  try {
    const json = execFileSync("sqlite3", ["-json", DB_PATH, sql], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(json || "[]");
  } catch (e) {
    if (e.status === 1 && (!e.stdout || !e.stderr)) return [];
    throw e;
  }
}

// Write helper for SQLite (mirrors queryDB without -json / JSON.parse).
// Used by runtime-preference recycling to atomically patch common_config_claude.
function execDB(sql) {
  execFileSync("sqlite3", [DB_PATH, sql], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: 2000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sqlQuote(str) {
  return "'" + String(str).replace(/'/g, "''") + "'";
}

function queryProvider(name, appType) {
  const rows = queryDB(
    `SELECT id, name, settings_config, category, meta FROM providers WHERE name = ${sqlQuote(name)} AND app_type = ${sqlQuote(appType)} ORDER BY id LIMIT 1`,
  );
  return rows[0] || null;
}

function queryProviderById(id, appType) {
  const rows = queryDB(
    `SELECT id, name, settings_config, category, meta FROM providers WHERE id = ${sqlQuote(id)} AND app_type = ${sqlQuote(appType)} LIMIT 1`,
  );
  return rows[0] || null;
}

function queryProvidersByApp(appType) {
  return queryDB(
    `SELECT id, name FROM providers WHERE app_type = ${sqlQuote(appType)} ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC`,
  );
}

// Same query, but errors PROPAGATE (queryDB's silent-catch collapses any
// sqlite3 failure — missing binary, missing table, locked DB — to [], which
// would corrupt callers that must fail open: the v1→v2 history migration
// (every live entry would be marked dead) and the TUI's alive snapshot
// (every Recent row would be flagged ✗ missing).
function queryProvidersStrict(appType) {
  const json = execFileSync("sqlite3", ["-json", DB_PATH,
    `SELECT id, name FROM providers WHERE app_type = ${sqlQuote(appType)} ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC`,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(json || "[]");
}

function queryCommonConfig(appType) {
  const key = `common_config_${appType}`;
  const rows = queryDB(`SELECT value FROM settings WHERE key = ${sqlQuote(key)}`);
  return rows[0]?.value || null;
}

// Atomically merge a patch into common_config_claude via sqlite json_patch
// (RFC 7396 merge patch: keys present in the patch override/add; absent keys
// are left untouched). A single UPDATE is atomic, so concurrent launches can't
// lose updates on disjoint keys. Only updates an existing row — never creates
// the common config if absent.
function patchCommonConfigClaude(patchObj) {
  const key = "common_config_claude";
  const patchLit = sqlQuote(JSON.stringify(patchObj));
  execDB(
    `UPDATE settings SET value = json_patch(value, json(${patchLit})) WHERE key = ${sqlQuote(key)}`,
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

// ─── Launch history (top 5 quick-launch + manual pin ordering) ─────────

const QUICK_KEYS = ["a", "s", "d", "f", "g"];

// History schema version. 2 = id-keyed entries: {cli, providerId, provider
// (name kept for display + v0.6 downgrade compat), hotkey, extraArgs, count,
// lastUsed}. Absent = 1 = the pre-0.7 name-keyed format.
const HISTORY_VERSION = 2;

// Entry/pin identity: cli + provider id when resolved, cli + stored name for
// entries whose provider no longer exists (dead rows — the name is their only
// identifier). order slots hold these key strings.
const entryKey = (e) => (e.providerId ? `${e.cli}|${e.providerId}` : `${e.cli}|${e.provider}`);

// Set when a migration attempt fails; frozen for the process lifetime. Every
// write path checks it — saving the empty in-memory history over the file
// would silently destroy all counts and pins.
let _historyFrozen = false;

// `order` is a sparse 5-slot array — a pinned entry key keeps its slot, null
// slots are filled by natural count/lastUsed ranking. Normalized from any
// stored value (missing field, dense legacy array, junk entries).
function normalizeOrder(raw) {
  const out = [null, null, null, null, null];
  if (Array.isArray(raw)) raw.slice(0, 5).forEach((v, i) => { if (typeof v === "string") out[i] = v; });
  return out;
}

function loadHistory() {
  if (_historyFrozen) return { entries: [], order: normalizeOrder(undefined) };
  let data;
  try {
    data = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  } catch {
    return { entries: [], order: normalizeOrder(undefined) }; // no file yet — fresh history
  }
  if (data?.version === HISTORY_VERSION) {
    return {
      entries: Array.isArray(data?.entries) ? data.entries : [],
      order: normalizeOrder(data?.order),
    };
  }
  // v1 (name-keyed) or unknown — migrate once, in place. Nothing is dropped:
  // names that no longer resolve become providerId:null dead rows headed for
  // the `c` cleanup, not silent deletions.
  let migrated;
  try {
    migrated = migrateHistory(data);
  } catch {
    _historyFrozen = true; // DB unavailable — never risk overwriting v1 data
    return { entries: [], order: normalizeOrder(undefined) };
  }
  try {
    // Narrow the concurrent-migration window: another switch process may have
    // migrated meanwhile; only persist when the file is still pre-v2.
    const cur = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
    if (cur?.version !== HISTORY_VERSION) saveHistory(migrated.entries, migrated.order);
  } catch {
    // unreadable now — keep the migrated view in memory only
  }
  return migrated;
}

// One-time v1→v2: resolve entry names to provider ids via the cc-switch DB.
// Strict DB access (errors propagate → loadHistory freezes writes) so a
// locked DB can't downgrade every live entry to a dead row.
function migrateHistory(data) {
  const entries = (Array.isArray(data?.entries) ? data.entries : [])
    .filter((e) => e && typeof e.cli === "string" && typeof e.provider === "string");
  const appTypes = new Set();
  for (const e of entries) {
    const t = APP_ADAPTERS[e.cli]?.appType;
    if (t) appTypes.add(t);
  }
  const idByName = new Map(); // `appType|name` → id, first wins (queryProvider's ORDER BY id semantics)
  for (const appType of appTypes) {
    for (const p of queryProvidersStrict(appType)) {
      const k = `${appType}|${p.name}`;
      if (!idByName.has(k)) idByName.set(k, p.id);
    }
  }
  const keyMap = new Map(); // old `cli|name` order-slot ids → new entryKey form
  for (const e of entries) {
    e.providerId = idByName.get(`${APP_ADAPTERS[e.cli]?.appType}|${e.provider}`) ?? null;
    if (!Array.isArray(e.extraArgs)) e.extraArgs = [];
    keyMap.set(`${e.cli}|${e.provider}`, entryKey(e));
  }
  const order = normalizeOrder(data?.order).map((slot) => (slot && keyMap.has(slot) ? keyMap.get(slot) : null));
  return { entries, order };
}

// Single write path so the manual order survives entry updates — recordLaunch
// used to rewrite the file from scratch, which would silently drop pins.
function saveHistory(entries, order) {
  atomicWrite(HISTORY_PATH, JSON.stringify({ version: HISTORY_VERSION, entries, order }, null, 2));
}

// A row is dead when its provider no longer exists in cc-switch: entries with
// a resolved id check the live id set (a rename keeps the id → stays alive);
// id-less pre-migration entries are dead by definition (their name didn't
// resolve). A missing snapshot (cli unknown or DB unavailable) means "all
// alive" — fail open, same stance as the old existingProviders.
function isDeadEntry(e, aliveByCli) {
  const snap = aliveByCli?.get(e.cli);
  if (!snap) return false;
  return e.providerId ? !snap.idSet.has(e.providerId) : true;
}

// Per-CLI alive snapshot for the TUI: cli → {idSet, nameById} | null. null =
// DB unavailable → treat everything as alive (fail open). One full-table
// query per CLI replaces the old per-call existence IN query and also feeds
// display names, so renames surface without touching history.
function snapshotAliveByCli() {
  const byCli = new Map();
  for (const [value, adapter] of Object.entries(APP_ADAPTERS)) {
    try {
      const rows = queryProvidersStrict(adapter.appType);
      byCli.set(value, {
        idSet: new Set(rows.map((r) => r.id)),
        nameById: new Map(rows.map((r) => [r.id, r.name])),
      });
    } catch {
      byCli.set(value, null);
    }
  }
  return byCli;
}

// Merge pinned slots with the natural count ranking. Rows are deduped per
// pair: among a pair's permission-mode entries only the strongest
// (count, lastUsed) shows — pinned in its slot, never again as a natural
// filler. Dead rows rank after live ones, so they only surface when live rows
// can't fill all 5 slots; pinned slots keep dead rows (the user's explicit
// placement wins, flagged red for cleanup).
function mergeTop5(entries, order, aliveByCli) {
  const valid = order.map((id) =>
    id && entries.some((e) => entryKey(e) === id) ? id : null);
  const pinnedSet = new Set(valid.filter(Boolean));
  const liveness = (e) => (isDeadEntry(e, aliveByCli) ? 0 : 1);
  const byStrength = (a, b) => (liveness(b) - liveness(a)) || (b.count - a.count) || (b.lastUsed - a.lastUsed);
  const rep = (id) => entries.filter((e) => entryKey(e) === id).sort(byStrength)[0];
  const seen = new Set();
  const natural = [];
  for (const e of [...entries].sort(byStrength)) {
    const k = entryKey(e);
    if (pinnedSet.has(k) || seen.has(k)) continue;
    seen.add(k);
    natural.push(e);
  }
  const out = [];
  let ni = 0;
  for (let i = 0; i < 5; i++) {
    if (valid[i]) out.push(rep(valid[i]));
    else if (ni < natural.length) out.push(natural[ni++]);
  }
  return out;
}

// Pins are persistent: only an explicit unpin (or removing the pair) releases
// a slot — a real launch never does. Launches update count/lastUsed/extraArgs
// and follow renames so the stored display name never goes stale.
function recordLaunch(cli, providerId, providerName, hotkey, extraArgs) {
  if (_historyFrozen) return;
  try {
    const { entries, order } = loadHistory();
    const now = Date.now();
    const hit = entries.find((e) => e.providerId === providerId && e.cli === cli && `${e.hotkey ?? ""}` === `${hotkey ?? ""}`);
    if (hit) {
      hit.count = (hit.count || 0) + 1;
      hit.lastUsed = now;
      hit.provider = providerName;
      hit.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    } else {
      entries.push({
        cli, providerId, provider: providerName, hotkey: hotkey ?? null,
        extraArgs: Array.isArray(extraArgs) ? extraArgs : [], count: 1, lastUsed: now,
      });
    }
    saveHistory(entries, order);
  } catch {
    // history is best-effort; never block launch on it
  }
}

function top5(aliveByCli) {
  const { entries, order } = loadHistory();
  return mergeTop5(entries, order, aliveByCli);
}

// Release a pin slot (idempotent — unpinning an unpinned pair is a no-op).
// The entry itself stays and returns to natural ranking. Returns the updated
// top5 rows so the caller can refresh its view in place, or null on failure.
function unpinPair(key, aliveByCli) {
  if (_historyFrozen) return null;
  try {
    const { entries, order } = loadHistory();
    const slot = order.indexOf(key);
    if (slot >= 0) {
      order[slot] = null;
      saveHistory(entries, order);
    }
    return mergeTop5(entries, order, aliveByCli);
  } catch {
    return null;
  }
}

// Drop every history trace of a pair: all permission-mode entries plus any
// manual-pin slot it holds. Used by the TUI remove confirm. Returns the
// updated top5 rows, or null on failure.
function removeHistoryPair(key, aliveByCli) {
  if (_historyFrozen) return null;
  try {
    const { entries, order } = loadHistory();
    const kept = entries.filter((e) => entryKey(e) !== key);
    const slot = order.indexOf(key);
    if (slot >= 0) order[slot] = null;
    saveHistory(kept, order);
    return mergeTop5(kept, order, aliveByCli);
  } catch {
    return null;
  }
}

// Bulk `c` cleanup: drop every dead entry in the WHOLE history (not just the
// visible 5 rows — otherwise each cleanup would just reveal another dead
// natural-filler row). Stale order slots need no handling here: mergeTop5's
// valid check drops keys with no remaining entry. Returns rows removed, or
// -1 on failure.
function removeAllDeadPairs(aliveByCli) {
  if (_historyFrozen) return -1;
  try {
    const { entries, order } = loadHistory();
    const kept = entries.filter((e) => !isDeadEntry(e, aliveByCli));
    if (kept.length === entries.length) return 0;
    saveHistory(kept, order);
    return entries.length - kept.length;
  } catch {
    return -1;
  }
}

// Pin a pair into display slot pos (1-5): materialize the currently displayed
// list, remove the pair's old position, insert at pos so later items shift
// down (the old slot 5 drops off), then project back so that only explicitly
// pinned keys keep holding slots. item = {cli, providerId, provider}. Returns
// the effective slot (1-5), or null on failure.
function insertManualOrder(item, pos, aliveByCli) {
  if (_historyFrozen) return null;
  try {
    const { entries, order } = loadHistory();
    const key = entryKey(item);
    if (!entries.some((e) => entryKey(e) === key)) {
      // Placeholder so a never-launched pair can still be pinned. A real
      // launch will create its own (hotkey-keyed) entry; this one just sits
      // at count 0 and ranks last until then.
      entries.push({
        cli: item.cli, providerId: item.providerId ?? null, provider: item.provider,
        hotkey: null, extraArgs: [], count: 0, lastUsed: 0,
      });
    }
    const displayed = mergeTop5(entries, order, aliveByCli)
      .map((e) => entryKey(e))
      .filter((x) => x !== key); // take out own old row first → re-pin moves, not duplicates
    const idx = Math.min(pos - 1, displayed.length); // clamp when fewer entries than pos
    displayed.splice(idx, 0, key);
    const nextOrder = Array(5).fill(null); // always persist the full 5-slot array
    displayed
      .slice(0, 5) // whatever falls past slot 5 loses its pin
      .forEach((x, i) => { nextOrder[i] = (x === key || order.includes(x)) ? x : null; });
    saveHistory(entries, nextOrder);
    return idx + 1;
  } catch {
    return null;
  }
}

// Compact relative age for Recent rows. count-0 pin placeholders carry
// lastUsed 0 — that's "never", not "55 years ago".
function relTime(ts) {
  const t = typeof ts === "number" && ts > 0 ? ts : 0;
  if (!t) return "never";
  const s = Math.max(0, Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function permLabel(hotkey) {
  if (hotkey === "2") return "Semi-auto";
  if (hotkey === "3") return "Full-auto ⚠";
  return "Default";
}

// ─── JSON utils (port of Rust json_deep_merge / json_is_subset) ────────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function jsonDeepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function jsonDeepMerge(target, source) {
  if (isPlainObject(target) && isPlainObject(source)) {
    for (const [key, sourceValue] of Object.entries(source)) {
      if (key in target) {
        jsonDeepMerge(target[key], sourceValue);
      } else {
        target[key] = sourceValue;
      }
    }
  }
  return target;
}

function jsonIsSubset(target, source) {
  if (isPlainObject(source)) {
    if (!isPlainObject(target)) return false;
    for (const [key, sourceValue] of Object.entries(source)) {
      if (!(key in target)) return false;
      if (!jsonIsSubset(target[key], sourceValue)) return false;
    }
    return true;
  }
  if (Array.isArray(source)) {
    if (!Array.isArray(target)) return false;
    return source.every((srcItem) =>
      target.some((tgtItem) => jsonIsSubset(tgtItem, srcItem)),
    );
  }
  return target === source;
}

// ─── TOML utils (port of Rust merge_toml_table_like) ───────────────────

function tomlDeepMerge(target, source) {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key in target && isPlainObject(target[key]) && isPlainObject(sourceValue)) {
      tomlDeepMerge(target[key], sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
  return target;
}

function tomlIsSubset(target, source) {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!(key in target)) return false;
    const targetValue = target[key];
    if (isPlainObject(sourceValue)) {
      if (!isPlainObject(targetValue)) return false;
      if (!tomlIsSubset(targetValue, sourceValue)) return false;
    } else if (Array.isArray(sourceValue)) {
      if (!Array.isArray(targetValue)) return false;
      if (!sourceValue.every((s) =>
        targetValue.some((t) => JSON.stringify(t) === JSON.stringify(s))
      )) return false;
    } else {
      if (JSON.stringify(targetValue) !== JSON.stringify(sourceValue)) return false;
    }
  }
  return true;
}

// ─── Common config detection (port of Rust provider_uses_common_config) ─

function providerUsesCommonConfig(appType, settingsConfig, meta, snippet) {
  const snippetTrimmed = (snippet || "").trim();
  if (!snippetTrimmed) return false;
  const explicit = meta?.commonConfigEnabled;
  if (explicit !== undefined && explicit !== null) {
    return explicit && snippetTrimmed.length > 0;
  }
  return settingsContainCommonConfig(appType, settingsConfig, snippetTrimmed);
}

function settingsContainCommonConfig(appType, settings, snippetTrimmed) {
  if (!snippetTrimmed) return false;
  if (appType === "claude") {
    try {
      const source = JSON.parse(snippetTrimmed);
      if (isPlainObject(source)) return jsonIsSubset(settings, source);
    } catch { return false; }
  } else if (appType === "codex") {
    const configToml = settings?.config || "";
    if (!configToml.trim()) return false;
    try {
      const targetDoc = parseToml(configToml);
      const sourceDoc = parseToml(snippetTrimmed);
      return tomlIsSubset(targetDoc, sourceDoc);
    } catch { return false; }
  }
  return false;
}

// ─── Claude config generation ─────────────────────────────────────────

const CLAUDE_SANITIZE_KEYS = [
  "api_format", "apiFormat",
  "openrouter_compat_mode", "openrouterCompatMode",
];

function sanitizeClaudeSettings(settings) {
  const v = jsonDeepClone(settings);
  if (isPlainObject(v)) {
    for (const key of CLAUDE_SANITIZE_KEYS) delete v[key];
  }
  return v;
}

function applyKimiForCodingContextDefaults(effective, providerSettings) {
  const baseUrl = providerSettings?.env?.ANTHROPIC_BASE_URL;
  if (!baseUrl || baseUrl.trim().replace(/\/$/, "") !== "https://api.kimi.com/coding") return;
  const env = effective.env || (effective.env = {});
  const providerEnv = providerSettings?.env || {};
  const KIMI_TOKENS = "262144";
  for (const key of ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"]) {
    env[key] = providerEnv[key] || KIMI_TOKENS;
  }
}

function buildClaudeEffectiveSettings(settingsConfig, meta, commonSnippet) {
  let effective = jsonDeepClone(settingsConfig);
  if (providerUsesCommonConfig("claude", settingsConfig, meta, commonSnippet)) {
    try {
      const source = JSON.parse(commonSnippet.trim());
      jsonDeepMerge(effective, source);
    } catch (e) {
      console.error(`⚠ Common config merge failed: ${e.message}`);
    }
  }
  applyKimiForCodingContextDefaults(effective, settingsConfig);
  return sanitizeClaudeSettings(effective);
}

// Build an enabledPlugins patch from an instance's runtime settings. Explicit
// true/false both propagate (so /plugin enable AND disable survive the next
// launch); absent keys are omitted (json_patch leaves them untouched), so a
// stale instance can't delete a key another provider added.
function collectEnabledPluginsPatch(ep) {
  if (!isPlainObject(ep)) return null;
  const patch = {};
  for (const [k, v] of Object.entries(ep)) {
    if (v === true || v === false) patch[k] = v;
  }
  return Object.keys(patch).length ? patch : null;
}

// ─── Codex config generation ──────────────────────────────────────────

const CODEX_OFFICIAL_PROVIDER_ID = "codex-official";
const CODEX_RESERVED_MODEL_PROVIDER_IDS = [
  "amazon-bedrock", "openai", "ollama", "lmstudio", "oss", "ollama-chat",
];
const CC_SWITCH_CATALOG_FILENAME = "cc-switch-model-catalog.json";
const CODEX_WEB_SEARCH_REJECT_HOSTS = [
  "xiaomimimo.com", "longcat.chat", "minimax.io", "minimaxi.com",
];
const CODEX_WEB_SEARCH_REJECT_MODEL_PREFIXES = ["mimo", "longcat", "minimax", "qwen3-coder"];
const ONE_M_CONTEXT_MARKER = "[1m]";

const CONFIRMED_TEXT_ONLY_TAILS = [
  "ark-code-latest", "deepseek-chat", "deepseek-reasoner",
  "deepseek-v4-flash", "deepseek-v4-pro",
  "glm-5.1", "glm-5.2",
  "kat-coder", "kat-coder-pro", "kat-coder-pro v1", "kat-coder-pro v2",
  "kat-coder-pro-v1", "kat-coder-pro-v2",
  "ling-2.5-1t", "longcat-2.0", "longcat-flash-chat",
  "minimax-m2.7", "minimax-m2.7-highspeed", "mimo-v2.5-pro",
  "qwen3-coder-480b", "qwen3-coder-480b-a35b-instruct",
  "qwen3-coder-flash", "qwen3-coder-next", "qwen3-coder-plus",
  "step-3.5-flash", "step-3.5-flash-2603", "us.deepseek.r1-v1",
];

function normalizeModelId(value) {
  let n = value.trim().replace(/^models\//, "").trim().toLowerCase();
  if (n.endsWith(ONE_M_CONTEXT_MARKER)) {
    n = n.slice(0, -ONE_M_CONTEXT_MARKER.length).trim();
  }
  return n;
}

function isConfirmedTextOnlyModel(model) {
  const normalized = normalizeModelId(model);
  const tail = normalized.split("/").pop();
  return CONFIRMED_TEXT_ONLY_TAILS.includes(tail);
}

function imageInputCapabilityFromModalities(model, modalities) {
  const declared = modalities
    ? modalities.some((m) => m.trim().toLowerCase() === "image")
    : undefined;
  if (declared === true) return "Supported";
  if (declared === false) return "Unsupported";
  if (isConfirmedTextOnlyModel(model)) return "Unsupported";
  return "Unknown";
}

function codexCatalogInputModalities(model, declaredModalities) {
  const cap = imageInputCapabilityFromModalities(model, declaredModalities);
  return cap === "Unsupported" ? ["text"] : ["text", "image"];
}

function parsePositiveU64(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value > 0 ? value : undefined;
  if (typeof value === "string") {
    const n = parseInt(value.trim(), 10);
    return !isNaN(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

function codexCatalogModelSpecs(settingsConfig) {
  const models = settingsConfig?.modelCatalog?.models;
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const specs = [];
  for (const mc of models) {
    const model = mc.model?.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    specs.push({
      model,
      displayName: [mc.displayName, mc.display_name].find((v) => v?.trim())?.trim() || undefined,
      contextWindow: parsePositiveU64([mc.contextWindow, mc.context_window].find((v) => v !== undefined)),
      supportsParallelToolCalls: [mc.supportsParallelToolCalls, mc.supports_parallel_tool_calls].find((v) => v !== undefined),
      inputModalities: [mc.inputModalities, mc.input_modalities].find((v) => v !== undefined),
      baseInstructions: [mc.baseInstructions, mc.base_instructions].find((v) => v?.trim()),
    });
  }
  return specs;
}

function resolveCodexCatalogToolProfile(provider) {
  if (provider.id === CODEX_OFFICIAL_PROVIDER_ID && provider.category === "official") {
    return "NativeResponses";
  }
  if (provider.meta?.providerType === "xai_oauth") return "NativeResponses";
  const apiFormat = provider.meta?.apiFormat;
  if (apiFormat === "anthropic") return "Anthropic";
  if (apiFormat === "openai_responses") return "NativeResponses";
  return "ProxyChat";
}

function loadTemplate(profile) {
  const filename = profile === "ProxyChat" ? "gpt5_5_template.json" : "codex_native_responses_template.json";
  return JSON.parse(readFileSync(join(RESOURCES_DIR, filename), "utf8"));
}

function codexCatalogModelEntry(template, spec, priority, profile, defaultContextWindow) {
  const entry = jsonDeepClone(template);
  const displayName = spec.displayName || spec.model;
  const contextWindow = spec.contextWindow || defaultContextWindow;
  entry.slug = spec.model;
  entry.display_name = displayName;
  entry.description = displayName;
  entry.context_window = contextWindow;
  entry.max_context_window = contextWindow;
  entry.priority = 1000 + priority;
  entry.additional_speed_tiers = [];
  entry.service_tiers = [];
  entry.availability_nux = null;
  entry.upgrade = null;
  entry.input_modalities = codexCatalogInputModalities(spec.model, spec.inputModalities);
  if (profile !== "ProxyChat") {
    for (const key of ["apply_patch_tool_type", "web_search_tool_type", "tools", "model_messages"]) {
      delete entry[key];
    }
    entry.shell_type = "shell_command";
    if (spec.baseInstructions?.trim()) entry.base_instructions = spec.baseInstructions.trim();
    if (spec.supportsParallelToolCalls !== undefined) entry.supports_parallel_tool_calls = spec.supportsParallelToolCalls;
  }
  return entry;
}

function codexModelCatalogFromSettings(settingsConfig, configText, profile) {
  const specs = codexCatalogModelSpecs(settingsConfig);
  if (specs.length === 0) return null;
  const defaultContextWindow = extractTopLevelU64(configText, "model_context_window") || 128000;
  const template = loadTemplate(profile);
  const entries = specs.map((spec, i) => codexCatalogModelEntry(template, spec, i, profile, defaultContextWindow));
  return { models: entries };
}

function extractTopLevelU64(configText, field) {
  try {
    const doc = parseToml(configText);
    const v = doc[field];
    if (typeof v === "number") return v > 0 ? v : undefined;
  } catch {}
  return undefined;
}

function extractCodexBaseUrl(configText) {
  try {
    const doc = parseToml(configText);
    const activeProvider = doc.model_provider;
    if (activeProvider && doc.model_providers?.[activeProvider]?.base_url) {
      return doc.model_providers[activeProvider].base_url;
    }
    return doc.base_url || undefined;
  } catch {}
  return undefined;
}

function codexNativeGatewayRejectsWebSearch(configText) {
  const baseUrl = extractCodexBaseUrl(configText)?.toLowerCase();
  if (baseUrl && CODEX_WEB_SEARCH_REJECT_HOSTS.some((h) => baseUrl.includes(h))) return true;
  try {
    const doc = parseToml(configText);
    const model = doc.model?.trim().toLowerCase();
    if (model) {
      const tail = model.split("/").pop();
      if (CODEX_WEB_SEARCH_REJECT_MODEL_PREFIXES.some((p) => tail.startsWith(p))) return true;
    }
  } catch {}
  return false;
}

function setCodexModelCatalogField(configObj, hasCatalog) {
  if (hasCatalog) {
    configObj.model_catalog_json = CC_SWITCH_CATALOG_FILENAME;
  } else if (configObj.model_catalog_json === CC_SWITCH_CATALOG_FILENAME) {
    delete configObj.model_catalog_json;
  }
}

function setCodexWebSearchField(configObj, disable) {
  if (disable) {
    configObj.web_search = "disabled";
  } else if (configObj.web_search === "disabled") {
    delete configObj.web_search;
  }
}

function isCustomCodexModelProviderId(id) {
  const trimmed = id.trim();
  return trimmed.length > 0 && !CODEX_RESERVED_MODEL_PROVIDER_IDS.some((r) => r.toLowerCase() === trimmed.toLowerCase());
}

function setCodexExperimentalBearerToken(configObj, token) {
  const providerId = configObj.model_provider;
  if (!providerId || !isCustomCodexModelProviderId(providerId)) {
    configObj.experimental_bearer_token = token;
    return;
  }
  if (configObj.model_providers?.[providerId]) {
    configObj.model_providers[providerId].experimental_bearer_token = token;
    return;
  }
  configObj.experimental_bearer_token = token;
}

function extractCodexAuthApiKey(auth) {
  const key = auth?.OPENAI_API_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

function codexAuthHasLoginMaterial(auth) {
  if (!isPlainObject(auth)) return false;
  for (const [key, value] of Object.entries(auth)) {
    if (key === "auth_mode") continue;
    if (key === "OPENAI_API_KEY") {
      if (typeof value === "string" && value.trim()) return true;
      continue;
    }
    if (value === null) continue;
    if (typeof value === "string" && value.trim()) return true;
    if (Array.isArray(value) && value.length) return true;
    if (isPlainObject(value) && Object.keys(value).length) return true;
    return true;
  }
  return false;
}

function buildCodexConfig(settingsConfig, meta, category, commonSnippet, provider, settings) {
  const configText = settingsConfig.config || "";
  let effectiveConfigText = configText;

  // Common config merge (TOML)
  if (providerUsesCommonConfig("codex", settingsConfig, meta, commonSnippet)) {
    try {
      const target = parseToml(configText || "");
      const source = parseToml(commonSnippet.trim());
      tomlDeepMerge(target, source);
      effectiveConfigText = stringifyToml(target);
    } catch (e) {
      console.error(`⚠ Codex common config merge failed: ${e.message}`);
    }
  }

  const profile = resolveCodexCatalogToolProfile({
    id: provider.id,
    category,
    meta: { apiFormat: meta?.apiFormat, providerType: meta?.providerType },
  });
  const catalog = codexModelCatalogFromSettings(settingsConfig, effectiveConfigText, profile);

  let configObj;
  try {
    configObj = parseToml(effectiveConfigText || "");
  } catch (e) {
    throw new Error(`Failed to parse Codex config.toml: ${e.message}`);
  }

  if (catalog) {
    setCodexModelCatalogField(configObj, true);
    let disableWebSearch = false;
    if (profile === "Anthropic") {
      disableWebSearch = true;
    } else if (profile === "NativeResponses") {
      disableWebSearch = codexNativeGatewayRejectsWebSearch(stringifyToml(configObj));
    }
    setCodexWebSearchField(configObj, disableWebSearch);
  } else {
    setCodexModelCatalogField(configObj, false);
    if (profile === "Anthropic") setCodexWebSearchField(configObj, true);
  }

  let finalConfigText = stringifyToml(configObj);
  const auth = settingsConfig.auth || {};
  const apiKey = extractCodexAuthApiKey(auth);

  // Third-party provider: inject bearer token
  if (category !== "official" && apiKey) {
    const preserveOfficialAuth = settings.preserveCodexOfficialAuthOnSwitch || false;
    if (!preserveOfficialAuth) {
      try {
        const configObj2 = parseToml(finalConfigText);
        setCodexExperimentalBearerToken(configObj2, apiKey);
        finalConfigText = stringifyToml(configObj2);
      } catch (e) {
        console.error(`⚠ Failed to inject bearer token: ${e.message}`);
      }
    }
  }

  return { configText: finalConfigText, auth, catalog, apiKey, profile };
}

// ─── Instance dir initialization ──────────────────────────────────────

function ensureSymlink(target, linkPath) {
  if (existsSync(linkPath) || isBrokenSymlink(linkPath)) {
    try {
      const stats = lstatSyncSafe(linkPath);
      if (stats?.isSymbolicLink()) {
        if (readlinkSync(linkPath) === target) return;
        unlinkSync(linkPath);
      } else {
        // Non-symlink real file/dir. Claude Code auto-creates empty dirs like
        // plugins/ on first launch; these should be replaced by symlinks.
        // But if it already has real content (non-empty), keep it and warn
        // to avoid deleting user data.
        const dirEntries = readdirSyncSafe(linkPath);
        if (dirEntries && dirEntries.length > 0) {
          console.error(`⚠ ${linkPath} already exists and is non-empty, skipping symlink (target: ${target})`);
          return;
        }
        rmSync(linkPath, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`⚠ Failed to replace ${linkPath} with symlink: ${e.message}`);
      return;
    }
  }
  try {
    symlinkSync(target, linkPath);
  } catch {}
}

function isBrokenSymlink(path) {
  try { return lstatSyncSafe(path)?.isSymbolicLink() === true; } catch { return false; }
}

function lstatSyncSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

function readdirSyncSafe(path) {
  try { return readdirSync(path); } catch { return null; }
}

// Paths shared from global ~/.claude/ into the instance dir.
// Both dirs and files are symlinked — these are device-level shared resources
// that should not be missing just because CLAUDE_CONFIG_DIR points to the instance dir.
const CLAUDE_SHARED_PATHS = [
  ".credentials.json",
  "projects",
  "plugins",
  "skills",
  "commands",
  "cache",
  "CLAUDE.md",
  "keybindings.json",
  "settings.local.json",
  "config.json",
  ".claude.json",  // contains OAuth login info (oauthAccount); missing forces re-login
];

function setupClaudeInstance(providerId) {
  const instanceDir = join(INSTANCES_DIR, "claude", providerId);
  mkdirSync(instanceDir, { recursive: true });
  const globalClaudeDir = join(HOME, ".claude");

  // .claude.json lives in two places:
  //   - Without CLAUDE_CONFIG_DIR: ~/.claude.json (HOME root)
  //   - With CLAUDE_CONFIG_DIR set: $CLAUDE_CONFIG_DIR/.claude.json
  // The global ~/.claude.json holds OAuth login info (oauthAccount);
  // missing it in the instance dir forces Claude Code to re-login.
  const globalDotClaudeJson = join(HOME, ".claude.json");
  if (existsSync(globalDotClaudeJson)) {
    ensureSymlink(globalDotClaudeJson, join(instanceDir, ".claude.json"));
  }

  for (const name of CLAUDE_SHARED_PATHS) {
    const globalPath = join(globalClaudeDir, name);
    if (existsSync(globalPath)) {
      ensureSymlink(globalPath, join(instanceDir, name));
    }
  }
  return instanceDir;
}

// Paths shared from global ~/.codex/ into the instance dir.
// These are device-level shared resources / user config that should not be
// missing just because CODEX_HOME points to the instance dir.
// auth.json is NOT included here — it is handled per-provider by the codex adapter
// (third-party providers get a standalone auth.json; official/OAuth providers symlink to global).
const CODEX_SHARED_PATHS = [
  "installation_id",       // device id; missing forces Codex to reinitialize
  "hooks.json",             // user hook config
  "models_cache.json",      // Codex CLI model cache; fallback source for catalog generation
  "rules",                  // user-defined rules (prefix_rule, etc.)
  "skills",                 // installed skills
  ".personality_migration", // migration marker
  ".sandbox_migration",     // migration marker
  "version.json",           // version-check cache
];

function setupCodexInstance(providerId) {
  const instanceDir = join(INSTANCES_DIR, "codex", providerId);
  mkdirSync(instanceDir, { recursive: true });
  const globalCodexDir = join(HOME, ".codex");
  for (const name of CODEX_SHARED_PATHS) {
    const globalPath = join(globalCodexDir, name);
    if (existsSync(globalPath)) {
      ensureSymlink(globalPath, join(instanceDir, name));
    }
  }
  return instanceDir;
}

// ─── Atomic write ──────────────────────────────────────────────────────

function atomicWrite(path, data) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.tmp.${basename(path)}.${Date.now()}.${process.pid}`);
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

// ─── Sync state snapshot (config drift detection) ─────────────────────

function sha256(str) {
  return createHash("sha256").update(str).digest("hex");
}

function loadSyncState() {
  try {
    return JSON.parse(readFileSync(SYNC_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveSyncState(state) {
  atomicWrite(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

// Shallow-compare two {pluginKey: bool} maps (undefined/missing treated as
// absent on both sides via Set union of keys).
function shallowEqualPlugins(a, b) {
  const ao = isPlainObject(a) ? a : {};
  const bo = isPlainObject(b) ? b : {};
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (ao[k] !== bo[k]) return false;
  return true;
}

// ─── App adapters (per-CLI strategy) ──────────────────────────────────
// Each CLI implements a small adapter so adding a new CLI (e.g. gemini) means
// adding one object here — runTUI / launchProvider / main stay generic. Fields:
//   appType          DB app_type value
//   label            CLI-layer display name
//   bin              executable name
//   envVar           env var that points the CLI at the instance dir
//   commonConfigKey  settings-table key for the shared config snippet
//   setupInstance()  create instance dir + symlink shared resources
//   prepare()        generate & write the instance's config files
//   launch()         spawnSync the CLI and exit
//   permissionArgs() map permission hotkey → CLI argv
// Optional (claude only): detectPluginDrift() / syncPluginsBack() — plugin
//   config drift detection & write-back into common_config (added in sync flow).
const APP_ADAPTERS = {
  claude: {
    appType: "claude",
    label: "claude",
    displayName: "Claude Code",
    bin: "claude",
    envVar: "CLAUDE_CONFIG_DIR",
    commonConfigKey: "common_config_claude",

    setupInstance: setupClaudeInstance,

    prepare(instanceDir, providerId, settingsConfig, meta, category, commonSnippet, settings) {
      normalizeInstalledPluginPaths();
      const effective = buildClaudeEffectiveSettings(settingsConfig, meta, commonSnippet);
      atomicWrite(join(instanceDir, "settings.json"), JSON.stringify(effective, null, 2));
    },

    launch(instanceDir, extraArgs) {
      process.stderr.write(`\x1b[2mCLAUDE_CONFIG_DIR=${instanceDir} claude ${extraArgs.join(" ")}\x1b[0m\n`);
      const result = spawnSync("claude", extraArgs, {
        stdio: "inherit",
        env: { ...process.env, CLAUDE_CONFIG_DIR: instanceDir },
      });
      normalizeInstalledPluginPaths();
      process.exit(result.status || 0);
    },

    permissionArgs(hotkey) {
      if (hotkey === "2") return ["--permission-mode", "acceptEdits"];
      if (hotkey === "3") return ["--dangerously-skip-permissions"];
      return [];
    },

    // Reverse of permissionArgs for history recording: which permission mode
    // (if any) the forwarded argv carries. Contract: returns undefined when no
    // permission flag is present — never "1"/default, or the same launch would
    // fork two history entries.
    inferHotkeyFromArgs(args) {
      if (args.includes("--dangerously-skip-permissions")) return "3";
      const i = args.indexOf("--permission-mode");
      if (i >= 0 && args[i + 1] === "acceptEdits") return "2";
      if (args.includes("--permission-mode=acceptEdits")) return "2";
      return undefined;
    },

    // Read the enabledPlugins this instance's settings.json currently holds
    // (used by recordInstanceBaseline() to snapshot per-instance provenance).
    readInstancePluginState(instanceDir) {
      try {
        const s = JSON.parse(readFileSync(join(instanceDir, "settings.json"), "utf8"));
        return isPlainObject(s.enabledPlugins) ? s.enabledPlugins : {};
      } catch {
        return null;
      }
    },

    // Upward drift: plugin installs/removals/toggles since the last sync.
    // Returns { added, removed, toggled, patch, installedKeys } or null.
    detectPluginDrift(state) {
      const { patch, installedKeys } = computeEnabledPluginsPatch(state);
      const prev = state?.claude || {};
      const prevEnabled = prev.enabledPlugins || {};
      const prevKeys = new Set(prev.installedPluginKeys || []);
      const curKeys = new Set(installedKeys);

      const added = installedKeys.filter((k) => !prevKeys.has(k));
      const removed = [...prevKeys].filter((k) => !curKeys.has(k));
      const toggled = [];
      for (const [k, v] of Object.entries(patch || {})) {
        if (v !== null && v !== prevEnabled[k]) toggled.push({ key: k, from: prevEnabled[k], to: v });
      }

      if (!added.length && !removed.length && !toggled.length) return null;
      return { added, removed, toggled, patch, installedKeys };
    },

    // Write-back: apply the plugin patch into common_config_claude.
    syncPluginsBack(drift) {
      applyEnabledPluginsPatch(drift.patch);
    },
  },

  codex: {
    appType: "codex",
    label: "codex",
    displayName: "Codex",
    bin: "codex",
    envVar: "CODEX_HOME",
    commonConfigKey: "common_config_codex",

    setupInstance: setupCodexInstance,

    prepare(instanceDir, providerId, settingsConfig, meta, category, commonSnippet, settings) {
      const { configText, auth, catalog, apiKey } = buildCodexConfig(
        settingsConfig, meta, category, commonSnippet, { id: providerId }, settings,
      );
      atomicWrite(join(instanceDir, "config.toml"), configText);

      const authPath = join(instanceDir, "auth.json");
      const globalAuthPath = join(HOME, ".codex", "auth.json");
      if (!apiKey && !codexAuthHasLoginMaterial(auth)) {
        if (existsSync(globalAuthPath)) {
          ensureSymlink(globalAuthPath, authPath);
        } else {
          atomicWrite(authPath, JSON.stringify({}, null, 2));
        }
      } else {
        const authContent = apiKey
          ? { OPENAI_API_KEY: apiKey }
          : codexAuthHasLoginMaterial(auth) ? auth : {};
        atomicWrite(authPath, JSON.stringify(authContent, null, 2));
      }

      if (catalog) {
        atomicWrite(join(instanceDir, CC_SWITCH_CATALOG_FILENAME), JSON.stringify(catalog, null, 2));
      }
    },

    launch(instanceDir, extraArgs) {
      process.stderr.write(`\x1b[2mCODEX_HOME=${instanceDir} codex ${extraArgs.join(" ")}\x1b[0m\n`);
      const result = spawnSync("codex", extraArgs, {
        stdio: "inherit",
        env: { ...process.env, CODEX_HOME: instanceDir },
      });
      process.exit(result.status || 0);
    },

    permissionArgs(hotkey) {
      if (hotkey === "2") return ["--approve-for-me"];
      if (hotkey === "3") return ["--dangerously-bypass-approvals-and-sandbox"];
      return [];
    },

    // See the claude adapter for the contract (undefined = no permission flag).
    inferHotkeyFromArgs(args) {
      if (args.includes("--dangerously-bypass-approvals-and-sandbox")) return "3";
      if (args.includes("--approve-for-me")) return "2";
      return undefined;
    },
  },
};

// Set of plugin keys ("name@source") with a user-scope install record — the
// source of truth for "what's installed at user level".
function readUserInstalledPluginSet() {
  try {
    const file = join(HOME, ".claude", "plugins", "installed_plugins.json");
    if (!existsSync(file)) return new Set();
    const data = JSON.parse(readFileSync(file, "utf8"));
    const set = new Set();
    for (const [k, recs] of Object.entries(data.plugins || {})) {
      if (Array.isArray(recs) && recs.some((r) => r && r.scope === "user")) set.add(k);
    }
    return set;
  } catch {
    return new Set();
  }
}

// Keys currently in common_config_claude.enabledPlugins.
function readCommonEnabledPluginKeys() {
  try {
    const snip = queryCommonConfig("claude");
    if (!snip) return [];
    return Object.keys(JSON.parse(snip).enabledPlugins || {});
  } catch {
    return [];
  }
}

// Compute the enabledPlugins patch to write back into common_config_claude,
// based on all claude instances' runtime settings + the user-scope install
// set. Pure — does not touch the DB. installed_plugins.json's user-scope
// records are the source of truth for "what's installed", so all three
// operations are captured:
//  - enable/disable: explicit true/false from any instance → merged into common.
//  - uninstall: a plugin dropped from user-scope is removed from common (null),
//    even if a stale instance still lists it as enabled.
//
// Arbitration: an instance's enabledPlugins that still matches the baseline
// recorded the last time cc-switch generated its settings.json (state.instances)
// carries no user intent — it's just a mirror of whatever common config looked
// like at prepare time — so it does not get a vote. Among instances that were
// actually edited by the user (e.g. via /plugin), the most recently modified
// settings.json wins per key. Instances with no recorded baseline (e.g. a
// sync-state.json predating this tracking) are treated as lowest priority so
// they don't clobber instances we do have provenance for.
// Returns { patch, installedKeys } — patch is a json_patch object or null.
function computeEnabledPluginsPatch(state) {
  try {
    const dir = join(INSTANCES_DIR, "claude");
    const installedUser = readUserInstalledPluginSet();
    const baselines = state?.instances?.claude || {};
    const candidates = [];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        try {
          const settingsPath = join(dir, name, "settings.json");
          const s = JSON.parse(readFileSync(settingsPath, "utf8"));
          const cur = isPlainObject(s.enabledPlugins) ? s.enabledPlugins : {};
          const baseline = baselines[name]?.enabledPlugins;
          const known = baseline !== undefined;
          if (known && shallowEqualPlugins(cur, baseline)) continue; // unchanged mirror — no vote
          const ep = collectEnabledPluginsPatch(cur);
          if (!ep) continue;
          let mtimeMs = 0;
          try { mtimeMs = lstatSync(settingsPath).mtimeMs; } catch {}
          candidates.push({ ep, known, mtimeMs });
        } catch {
          // missing/corrupt instance settings — skip
        }
      }
    }
    // Unknown-baseline candidates apply first (lowest priority); among the
    // rest, oldest-first so the most recently modified instance wins last.
    candidates.sort((a, b) => (a.known !== b.known ? (a.known ? 1 : -1) : a.mtimeMs - b.mtimeMs));

    const epPatch = {};
    let has = false;
    for (const { ep } of candidates) {
      for (const [k, v] of Object.entries(ep)) {
        // Only honor states for plugins still installed at user scope;
        // stale entries for uninstalled plugins are ignored.
        if (installedUser.has(k)) { epPatch[k] = v; has = true; }
      }
    }
    // Remove from common any plugin no longer installed at user scope.
    for (const k of readCommonEnabledPluginKeys()) {
      if (!installedUser.has(k) && !(k in epPatch)) { epPatch[k] = null; has = true; }
    }
    return { patch: has ? epPatch : null, installedKeys: [...installedUser] };
  } catch {
    // best-effort: unreadable instances dir or DB lock — return empty.
    return { patch: null, installedKeys: [] };
  }
}

// Write an enabledPlugins patch into common_config_claude (used by the sync
// flow after user confirmation). No-op on an empty patch.
function applyEnabledPluginsPatch(patch) {
  if (!patch || Object.keys(patch).length === 0) return;
  try {
    patchCommonConfigClaude({ enabledPlugins: patch });
  } catch {
    // best-effort: DB lock or unreadable — skip write-back silently.
  }
}

// Rewrite any per-instance-prefixed installPath in the shared
// installed_plugins.json back to the global ~/.claude/plugins path. cc-switch
// points CLAUDE_CONFIG_DIR at a per-instance dir, so Claude Code records newly
// installed user plugins under that instance and other instances can't resolve
// them. Idempotent (already-global paths are untouched) and best-effort.
const INSTANCE_PLUGIN_PATH_RE = /^.*?\/instances\/claude\/[0-9a-f-]+\/plugins\//;
function normalizeInstalledPluginPaths() {
  try {
    const globalPluginsDir = join(HOME, ".claude", "plugins");
    const file = join(globalPluginsDir, "installed_plugins.json");
    if (!existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, "utf8"));
    let changed = false;
    for (const recs of Object.values(data.plugins || {})) {
      if (!Array.isArray(recs)) continue;
      for (const rec of recs) {
        const ip = rec.installPath;
        if (typeof ip === "string" && INSTANCE_PLUGIN_PATH_RE.test(ip)) {
          rec.installPath = ip.replace(INSTANCE_PLUGIN_PATH_RE, `${globalPluginsDir}/`);
          changed = true;
        }
      }
    }
    if (changed) atomicWrite(file, JSON.stringify(data, null, 2));
  } catch {
    // best-effort: missing/corrupt file — silently skip.
  }
}

// ─── Config drift detection & sync ────────────────────────────────────

// Downward drift: cc-switch's common config snippet changed since a given
// instance last had its settings.json generated (state.instances[appType][id]
// .commonHash, recorded by recordInstanceBaseline() at prepare time — NOT a
// single global hash, so syncing plugins for one instance can't silently mark
// every other instance's common-config drift as resolved).
// Returns { appType: [providerId, ...] } for each app with stale instances.
function collectStaleInstanceIds(state) {
  const stale = {};
  for (const adapter of Object.values(APP_ADAPTERS)) {
    const snippet = queryCommonConfig(adapter.appType) || "";
    const hash = sha256(snippet);
    const instanceStates = state?.instances?.[adapter.appType] || {};
    const ids = Object.keys(instanceStates).filter(
      (id) => instanceStates[id]?.commonHash !== undefined && instanceStates[id].commonHash !== hash,
    );
    if (ids.length) stale[adapter.appType] = ids;
  }
  return stale;
}

// Display-facing view of collectStaleInstanceIds: provider names instead of
// ids. Returns { appType: [providerName, ...] } for each app with stale
// instances.
function detectCommonConfigDrift(state) {
  const drift = {};
  for (const [appType, ids] of Object.entries(collectStaleInstanceIds(state))) {
    const nameById = new Map(queryProvidersByApp(appType).map((p) => [p.id, p.name]));
    drift[appType] = ids.map((id) => nameById.get(id) || id);
  }
  return drift;
}

// Regenerate the live config of every stale instance so it mirrors the current
// common config again — the same setupInstance + prepare a real launch would
// do, minus actually launching. Baselines are updated in-place on `state`
// (NOT via recordInstanceBaseline, whose internal load/save would clobber the
// caller's state object); the caller persists with saveSyncState(). Providers
// whose DB row is gone get their baseline pruned instead (clean removes the
// instance dir but historically left the state entry behind). Best-effort per
// instance: a failure keeps the old baseline so the prompt fires again next
// time instead of silently hiding the problem. Returns refreshed provider
// names. Does NOT touch running sessions — they still need a restart to pick
// up the new config, which is what "restart to apply" in the prompt means.
function refreshStaleInstances(state, staleByApp) {
  const refreshed = [];
  state.instances = state.instances || {};
  for (const [appType, ids] of Object.entries(staleByApp)) {
    const adapter = Object.values(APP_ADAPTERS).find((a) => a.appType === appType);
    if (!adapter) continue;
    const commonSnippet = queryCommonConfig(appType);
    const settings = loadSettings();
    state.instances[appType] = state.instances[appType] || {};
    for (const id of ids) {
      const row = queryProviderById(id, appType);
      if (!row) {
        delete state.instances[appType][id]; // provider gone — drop the ghost baseline
        continue;
      }
      try {
        const settingsConfig = JSON.parse(row.settings_config || "{}");
        const meta = JSON.parse(row.meta || "{}");
        const instanceDir = adapter.setupInstance(row.id);
        adapter.prepare(instanceDir, row.id, settingsConfig, meta, row.category, commonSnippet, settings);
        const entry = { commonHash: sha256(commonSnippet || ""), preparedAt: Date.now() };
        if (adapter.readInstancePluginState) {
          const ep = adapter.readInstancePluginState(instanceDir);
          if (ep) entry.enabledPlugins = ep;
        }
        state.instances[appType][row.id] = entry;
        refreshed.push(row.name);
      } catch {
        // best-effort: keep the old baseline so the drift stays visible.
      }
    }
  }
  return refreshed;
}

// Record per-instance provenance right after (re)generating an instance's
// config, so later drift checks can tell "this instance mirrors the current
// common config" from "this instance is stale" or "this instance's plugin
// state was actually edited by the user". Called on every launch, for every
// app — not just claude/plugins — so codex's commonHash tracking works too.
// Best-effort: a failure here must never block a launch.
function recordInstanceBaseline(adapter, providerId, instanceDir, commonSnippet) {
  try {
    const state = loadSyncState();
    state.instances = state.instances || {};
    state.instances[adapter.appType] = state.instances[adapter.appType] || {};
    const entry = { commonHash: sha256(commonSnippet || ""), preparedAt: Date.now() };
    if (adapter.readInstancePluginState) {
      const ep = adapter.readInstancePluginState(instanceDir);
      if (ep) entry.enabledPlugins = ep;
    }
    state.instances[adapter.appType][providerId] = entry;
    state.version = 2;
    saveSyncState(state);
  } catch {
    // best-effort: DB/disk hiccup — the next launch will retry.
  }
}

// Record the current state as the sync baseline. Common-config staleness is
// tracked per instance (see recordInstanceBaseline) and is NOT touched here —
// a confirmed sync resolves it via refreshStaleInstances(), which regenerates
// each stale instance's config and updates its baseline directly on `state`.
// claude's global plugin baseline (installedKeys / enabledPlugins, used by
// detectPluginDrift's added/removed/toggled diff) is snapshotted only after a
// confirmed plugin sync.
function snapshotSyncState(state, pluginSyncedCmds) {
  if (pluginSyncedCmds.includes("claude")) {
    const { installedKeys } = computeEnabledPluginsPatch(state);
    state.claude = state.claude || {};
    state.claude.installedPluginKeys = installedKeys;
    let enabled = {};
    try {
      const snip = queryCommonConfig("claude");
      if (snip) enabled = JSON.parse(snip).enabledPlugins || {};
    } catch {}
    state.claude.enabledPlugins = enabled;
  }
  state.version = 2;
}

// Interactive yes/no confirm (TUI only). Returns true on "y", false otherwise.
function confirmSync(lines) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(false);
      return;
    }
    for (const line of lines) process.stderr.write(`  ${line}\n`);
    process.stderr.write(`\n  \x1b[1mSync these changes?\x1b[0m [y/N] `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (data) => {
      const key = data.toString();
      process.stdin.setRawMode(false);
      process.stdin.removeListener("data", onData);
      process.stderr.write(`${key.trim()}\n`);
      resolve(/^y/i.test(key.trim()));
    };
    process.stdin.on("data", onData);
  });
}

// Entry point: detect common-config + plugin drift, then prompt (TUI) or warn
// (command mode, unless quiet) or stay silent (quiet — for --sync/--no-sync
// scripted callers that only care about the return value). Returns
// { synced, drifted, refreshed? } — on a confirmed sync, `refreshed` lists the
// provider names whose stale live configs were just regenerated in place.
async function detectAndPromptSync({ tui = false, quiet = false } = {}) {
  const state = loadSyncState();

  // First run: no plugin baseline yet — establish it silently so subsequent
  // plugin changes are detectable (don't report existing plugins as "added"
  // on the very first sync). Common-config staleness needs no such bootstrap:
  // it's tracked per instance and instances without a recorded baseline are
  // simply skipped by detectCommonConfigDrift until they're next launched.
  if (!state?.claude?.installedPluginKeys) {
    snapshotSyncState(state, ["claude"]);
    saveSyncState(state);
    return { synced: false, drifted: false };
  }

  const commonDrift = detectCommonConfigDrift(state);

  const pluginDrifts = {};
  for (const [cmd, adapter] of Object.entries(APP_ADAPTERS)) {
    if (adapter.detectPluginDrift) {
      const d = adapter.detectPluginDrift(state);
      if (d) pluginDrifts[cmd] = d;
    }
  }

  const hasCommon = Object.keys(commonDrift).length > 0;
  const hasPlugin = Object.keys(pluginDrifts).length > 0;
  if (!hasCommon && !hasPlugin) return { synced: false, drifted: false };

  if (quiet) return { synced: false, drifted: true };

  // Build the change summary (dedup added/removed vs toggled).
  const lines = [];
  for (const [appType, names] of Object.entries(commonDrift)) {
    lines.push(`\x1b[33mcommon config (${appType})\x1b[0m changed — restart to apply: ${names.join(", ")}`);
  }
  for (const d of Object.values(pluginDrifts)) {
    const changedKeys = new Set([...d.added, ...d.removed]);
    for (const k of d.added) lines.push(`\x1b[32m+ plugin installed:\x1b[0m ${k}`);
    for (const k of d.removed) lines.push(`\x1b[31m- plugin uninstalled:\x1b[0m ${k}`);
    for (const t of d.toggled) {
      if (changedKeys.has(t.key)) continue;
      lines.push(`\x1b[33m~ plugin toggled:\x1b[0m ${t.key} (${t.from ?? "unset"} → ${t.to})`);
    }
  }

  if (!tui) {
    // command mode: non-blocking warning, no write-back.
    process.stderr.write(`\x1b[33m⚠ Config drift detected:\x1b[0m\n`);
    for (const line of lines) process.stderr.write(`  ${line}\n`);
    process.stderr.write(`  Run \x1b[1mswitch sync\x1b[0m (or \x1b[1mswitch --sync\x1b[0m) to review and sync.\n`);
    return { synced: false, drifted: true };
  }

  // TUI mode: interactive confirm, then write back on "y".
  const ok = await confirmSync(lines);
  if (ok) {
    const syncedCmds = [];
    for (const [cmd, d] of Object.entries(pluginDrifts)) {
      APP_ADAPTERS[cmd]?.syncPluginsBack?.(d);
      syncedCmds.push(cmd);
    }
    // Order matters: the plugin write-back above just changed common_config,
    // so staleness is recomputed AFTER it. Every stale instance — the ones
    // flagged before the confirm AND the ones the write-back just made stale —
    // gets its live config regenerated in place and its baseline refreshed,
    // so this prompt won't fire again on the next launch. Running sessions
    // still need a restart to pick up the new config.
    const refreshed = refreshStaleInstances(state, collectStaleInstanceIds(state));
    snapshotSyncState(state, syncedCmds);
    saveSyncState(state);
    return { synced: true, drifted: true, refreshed };
  }
  return { synced: false, drifted: true };
}

// ─── TUI interactive mode ──────────────────────────────────────────────

// hotkeys: [{key,label}] | undefined  (key matches a raw keypress)
// interactive: when true (provider layer), Enter drills into param region
//              instead of resolving; esc goes back. When false (CLI layer),
//              number keys jump straight to resolve.
// quickItems: [{key,label,cli,providerId,provider,hotkey,extraArgs,pairKey,
//               dead,pinned}] | undefined  (top5 quick-launch; pressing the
//               key resolves a {quick:true,...} object. dead: provider no
//               longer exists in cc-switch → selectable but not launchable;
//               Enter/key on it opens the remove confirm. pinned: row holds a
//               manual top5 slot → `*` marker + `u` unpin.)
// pinContext + onPin (provider layer): `t` pins the highlighted option into
//               the Recent top5 slots. onPin(item, pos) with item =
//               {cli, providerId, provider}; returns the effective slot 1-5,
//               or null on failure.
// quickPin + onPin/onUnpin/onRemove/onCleanup (CLI layer): `t`/`u`/`x`/`c` on
//               the Recent region. quickPin is deliberately separate from
//               pinContext so a CLI-layer `t` can never capture a plain CLI
//               option (e.g. "claude") as a pin target.
// onRefreshQuickItems(): rebuild quickItems after any history mutation so the
//               shown order/dead/pinned state matches disk. Newly surfaced
//               natural-filler rows need their dead flag from the caller's
//               alive snapshot — tuiSelect itself has no DB access.
function tuiSelect(prompt, options, optsArg) {
  // Backward-compat: accept a bare hotkeys array as 3rd arg.
  const opts = Array.isArray(optsArg) ? { hotkeys: optsArg } : (optsArg || {});
  const hotkeys = opts.hotkeys || [];
  const interactive = !!opts.interactive;
  let quickItems = opts.quickItems || []; // mutable: refreshed after mutations
  const canRemove = typeof opts.onRemove === "function";
  const canCleanup = typeof opts.onCleanup === "function";
  const canUnpin = typeof opts.onUnpin === "function";
  const pinOptions = !!opts.pinContext && typeof opts.onPin === "function"; // provider layer
  const pinQuick = !!opts.quickPin && typeof opts.onPin === "function"; // CLI layer
  const refreshQuick = typeof opts.onRefreshQuickItems === "function" ? opts.onRefreshQuickItems : null;

  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error("TUI mode requires an interactive terminal. Use command mode: switch <provider> <cmd>"));
      return;
    }

    let selected = 0;
    let mode = "select"; // "select" | "param" | "pin" | "confirm"
    let lastDrawnLines = 0;
    let pinTarget = null; // {cli, providerId, provider, label} captured entering pin mode
    let confirmAction = null; // {kind:"remove"|"cleanup"|"launch", target} in confirm mode

    const hasHint = hotkeys.length > 0;

    const navTotal = () => options.length + quickItems.length;
    // After any quickItems mutation (refresh/cleanup): an out-of-range
    // selected index would crash the Enter path (`q.dead` on undefined) with
    // raw mode still on — the terminal would hang.
    function clampSelected() {
      if (selected >= navTotal()) selected = Math.max(0, navTotal() - 1);
    }
    function refreshQuickItems() {
      if (!refreshQuick) return;
      quickItems = refreshQuick() || [];
      clampSelected();
    }

    // ANSI redraw counts LINES — a soft-wrapped row would leave ghosts on
    // every repaint. Keep generated text within the terminal width (CJK
    // counted double, matching most terminal renderers).
    function fit(str, pad) {
      const cols = (process.stdout.columns || 80) - pad;
      let w = 0;
      let out = "";
      for (const ch of str) {
        const cw = ch.codePointAt(0) > 0xff ? 2 : 1;
        if (w + cw > cols - 1) return out + "…";
        w += cw;
        out += ch;
      }
      return out;
    }

    // Lines for a given mode (without trailing newline). notice renders one
    // extra dim row below the hints — passed per-render, so it disappears on
    // the next state change without any cleanup bookkeeping.
    function buildLines(m, notice) {
      const lines = [];
      lines.push(`\x1b[1m\x1b[36m◆ ${fit(prompt, 4)}\x1b[0m`);
      lines.push("");
      const locked = m === "param" || m === "pin" || m === "confirm";
      // unified navigation space: [0..options.length-1] = options,
      // [options.length..options.length+quickItems.length-1] = quickItems
      for (let i = 0; i < options.length; i++) {
        const num = String(i + 1);
        if (locked) {
          const mark = i === selected ? "▸" : " ";
          lines.push(`\x1b[90m${mark} ${num} ${fit(options[i].label, 8)}\x1b[0m`);
        } else if (i === selected) {
          lines.push(`\x1b[36m❯ ${num} ${fit(options[i].label, 8)}\x1b[0m`);
        } else {
          lines.push(`\x1b[90m  ${num} ${fit(options[i].label, 8)}\x1b[0m`);
        }
      }
      if (m === "param") {
        lines.push("");
        lines.push(
          `  \x1b[1m\x1b[36m${fit(hotkeys.map((h) => `${h.key} ${h.label}`).join("   "), 4)}\x1b[0m`,
        );
        lines.push(`  \x1b[90mesc ← back\x1b[0m`);
      } else if (m === "pin") {
        lines.push("");
        lines.push(
          `  \x1b[1m\x1b[36m${fit(`Pin "${pinTarget.label}" into Recent top5 · press 1-5   esc cancel`, 4)}\x1b[0m`,
        );
      } else if (m === "confirm") {
        lines.push("");
        const { kind, target } = confirmAction;
        let head;
        if (kind === "launch") {
          // One keypress away from --dangerously-skip-permissions — the only
          // confirm in the TUI that guards a launch rather than a deletion.
          head = `\x1b[33m⚠ "${target.provider}" would launch Full-auto (--dangerously-skip-permissions)\x1b[0m — launch?`;
        } else if (kind === "cleanup") {
          head = `Remove ${target.count} dead ${target.count === 1 ? "entry" : "entries"} from Recent?`;
        } else if (target.dead) {
          head = `\x1b[31m✗ "${target.provider}" no longer exists in cc-switch\x1b[0m — remove from Recent?`;
        } else {
          head = `Remove "${target.provider}" from Recent?`;
        }
        lines.push(`  ${head}   \x1b[1m\x1b[36my confirm\x1b[0m\x1b[90m · any other key cancel\x1b[0m`);
      } else if (interactive) {
        lines.push("");
        const pinHint = pinOptions ? `   t pin top5` : "";
        lines.push(`  \x1b[90m${fit(`↑↓ navigate   ⏎ confirm${pinHint}   esc ← back to CLI`, 4)}\x1b[0m`);
      } else {
        // CLI layer select mode: optionally show top5 quick-launch region
        if (quickItems.length > 0) {
          lines.push("");
          lines.push(`  \x1b[90mRecent (top 5):\x1b[0m`);
          for (let i = 0; i < quickItems.length; i++) {
            const q = quickItems[i];
            const isSel = selected === options.length + i;
            // Provider deleted in cc-switch: keep the row (history + pin may
            // still be wanted) but flag it red and make it non-launchable.
            // A pinned row keeps its manual slot — marked `*` so a persistent
            // pin never reads as "the ranking is broken".
            const flag = q.dead ? `\x1b[31m ✗ missing\x1b[0m` : "";
            const pin = q.pinned ? "*" : " ";
            const text = fit(`${q.key} ${pin}${q.label}`, 6);
            if (locked) {
              const mark = isSel ? "▸" : " ";
              lines.push(`  \x1b[90m${mark} ${text}\x1b[0m${flag}`);
            } else if (isSel) {
              lines.push(`\x1b[36m❯ ${text}\x1b[0m${flag}`);
            } else {
              lines.push(`  \x1b[36m${text.slice(0, 1)}\x1b[0m \x1b[90m${text.slice(2)}\x1b[0m${flag}`);
            }
          }
        }
        lines.push("");
        // Context-sensitive hints: only the keys that apply where the cursor
        // is, and short enough that the full key list (with t/u/x/c active)
        // still fits an 80-col terminal without soft-wrapping.
        const parts = ["↑↓ nav"];
        if (quickItems.length === 0 || selected < options.length) {
          parts.push(`⏎/1-${options.length} sel`);
        }
        if (quickItems.length > 0) parts.push(`${QUICK_KEYS[0]}-${QUICK_KEYS[quickItems.length - 1]} quick`);
        if (quickItems.length > 0 && selected >= options.length) {
          if (pinQuick) parts.push("t pin");
          if (canUnpin && quickItems[selected - options.length]?.pinned) parts.push("u unpin");
          if (canRemove) parts.push("x rm");
        }
        const deadCount = quickItems.filter((q) => q.dead).length;
        if (canCleanup && deadCount > 0) parts.push("c clean dead");
        parts.push("esc exit");
        lines.push(`  \x1b[90m${fit(parts.join("   "), 4)}\x1b[0m`);
      }
      if (notice) {
        lines.push("");
        lines.push(`  \x1b[32m${fit(notice, 4)}\x1b[0m`);
      }
      return lines;
    }

    function render(m, notice) {
      if (lastDrawnLines > 0) {
        process.stdout.write(`\x1b[${lastDrawnLines}A\x1b[J`);
      }
      const lines = buildLines(m, notice);
      process.stdout.write(lines.join("\n") + "\n");
      lastDrawnLines = lines.length;
    }

    render(mode);

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (data) => {
      const key = data.toString();
      if (key === "\x03") {
        cleanup();
        reject(new Error("Cancelled"));
        return;
      }

      if (mode === "param") {
        // Param region: hotkey or Enter resolves with hotkey; esc goes back.
        if (key === "\x1b") {
          mode = "select";
          render(mode);
          return;
        }
        const hit = hotkeys.find((h) => h.key === key);
        if (hit) {
          cleanup();
          resolve({ ...options[selected], hotkey: hit.key });
          return;
        }
        if (key === "\r" || key === "\n") {
          cleanup();
          resolve({ ...options[selected], hotkey: undefined });
          return;
        }
        return; // ignore arrows/other keys in param mode
      }

      if (mode === "pin") {
        // Pin region: pick a slot 1-5, esc cancels. Never launches.
        if (key === "\x1b") {
          mode = "select";
          render(mode);
          return;
        }
        const n = parseInt(key, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= 5) {
          const slot = opts.onPin(pinTarget, n);
          mode = "select";
          // CLI layer stays put after pinning — refresh so the new order is
          // visible immediately; the provider layer re-enters via esc anyway.
          if (slot && !interactive) refreshQuickItems();
          render(
            mode,
            slot
              ? (interactive
                ? `✓ Pinned "${pinTarget.label}" to Recent #${slot} — esc back to CLI to see it`
                : `✓ Pinned "${pinTarget.label}" to Recent #${slot}`)
              : `✗ Pin failed (history write error)`,
          );
          return;
        }
        return; // ignore Enter/arrows/everything else while pinning
      }

      if (mode === "confirm") {
        // Confirm region: y executes the pending action, any other key —
        // esc, n, arrows — cancels back to select untouched.
        if (key === "y" || key === "Y") {
          const { kind, target } = confirmAction;
          confirmAction = null;
          mode = "select";
          if (kind === "launch") {
            cleanup();
            resolve({ quick: true, cli: target.cli, provider: target.provider, hotkey: target.hotkey, extraArgs: target.extraArgs });
            return;
          }
          if (kind === "cleanup") {
            const removed = opts.onCleanup();
            if (removed > 0) refreshQuickItems();
            render(
              mode,
              removed >= 0
                ? `✓ Removed ${removed} dead ${removed === 1 ? "entry" : "entries"} from Recent`
                : `✗ Cleanup failed (history write error)`,
            );
            return;
          }
          const ok = opts.onRemove(target.pairKey) !== null;
          if (ok) refreshQuickItems();
          render(mode, ok ? `✓ Removed "${target.provider}" from Recent` : `✗ Remove failed (history write error)`);
          return;
        }
        confirmAction = null;
        mode = "select";
        render(mode);
        return;
      }

      // select mode
      // esc (bare \x1b) — must check AFTER arrow sequences below in practice,
      // but arrow keys arrive as full \x1b[A / \x1b[B which don't equal bare \x1b.
      // Unified navigation space: options + quickItems (CLI layer only).
      if (key === "\x1b[A" || key === "k") {
        selected = (selected - 1 + navTotal()) % navTotal();
        render(mode);
        return;
      }
      if (key === "\x1b[B" || key === "j") {
        selected = (selected + 1) % navTotal();
        render(mode);
        return;
      }
      // Resolve a quick item: dead rows offer cleanup, Full-auto rows ask for
      // explicit confirmation (one keypress = --dangerously-skip-permissions),
      // everything else launches immediately. Dead wins over the Full-auto
      // confirm — that launch is guaranteed to fail anyway.
      const tryQuick = (q) => {
        selected = options.length + Math.max(0, quickItems.indexOf(q));
        if (q.dead) {
          confirmAction = { kind: "remove", target: q };
          mode = "confirm";
          render(mode);
          return;
        }
        if (q.hotkey === "3") {
          confirmAction = { kind: "launch", target: q };
          mode = "confirm";
          render(mode);
          return;
        }
        cleanup();
        resolve({ quick: true, cli: q.cli, provider: q.provider, hotkey: q.hotkey, extraArgs: q.extraArgs });
      };
      if (key === "\r" || key === "\n") {
        // If selection is on a quick item, resolve it as quick-launch —
        // unless the provider is gone, then offer cleanup instead.
        if (!interactive && quickItems.length > 0 && selected >= options.length) {
          tryQuick(quickItems[selected - options.length]);
          return;
        }
        if (interactive && hasHint) {
          mode = "param";
          render(mode);
          return;
        }
        cleanup();
        resolve(options[selected]);
        return;
      }
      // quick-launch key (top5, CLI layer only)
      const qHit = quickItems.find((q) => q.key === key);
      if (qHit) {
        tryQuick(qHit);
        return;
      }
      // `x`: remove the highlighted quick item from Recent (confirm follows)
      if (canRemove && key === "x" && quickItems.length > 0 && selected >= options.length) {
        confirmAction = { kind: "remove", target: quickItems[selected - options.length] };
        mode = "confirm";
        render(mode);
        return;
      }
      // `u`: unpin the highlighted Recent row (idempotent; entry stays)
      if (canUnpin && key === "u" && quickItems.length > 0 && selected >= options.length) {
        const q = quickItems[selected - options.length];
        const ok = opts.onUnpin(q.pairKey) !== null;
        if (ok) refreshQuickItems();
        render(mode, ok ? `✓ Unpinned "${q.provider}" — back to natural ranking` : `✗ Unpin failed (history write error)`);
        return;
      }
      // `c`: bulk-remove every dead entry from Recent (confirm follows)
      if (canCleanup && key === "c") {
        const deadCount = quickItems.filter((q) => q.dead).length;
        if (deadCount > 0) {
          confirmAction = { kind: "cleanup", target: { count: deadCount } };
          mode = "confirm";
          render(mode);
          return;
        }
      }
      // `t` pins into the Recent top5 slots. Two distinct layers, deliberately
      // gated separately: provider layer captures the highlighted provider;
      // CLI layer captures the highlighted Recent row. pinTarget is always a
      // structured {cli, providerId, provider} — never the display label.
      if (interactive && pinOptions && key === "t" && selected < options.length) {
        pinTarget = {
          cli: opts.pinContext,
          providerId: options[selected].value,
          provider: options[selected].label,
          label: options[selected].label,
        };
        mode = "pin";
        render(mode);
        return;
      }
      if (pinQuick && key === "t" && quickItems.length > 0 && selected >= options.length) {
        const q = quickItems[selected - options.length];
        pinTarget = { cli: q.cli, providerId: q.providerId, provider: q.provider, label: q.provider };
        mode = "pin";
        render(mode);
        return;
      }
      // number key
      const n = parseInt(key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
        selected = n - 1;
        if (interactive) {
          render(mode); // just highlight, wait for Enter
          return;
        }
        // CLI layer: number jumps straight to resolve
        cleanup();
        resolve(options[selected]);
        return;
      }
      if (key === "\x1b") {
        // bare esc in select mode
        cleanup();
        if (interactive) {
          // provider layer: go back to CLI selection
          reject(new Error("BACK_TO_CLI"));
        } else {
          // CLI layer: exit
          reject(new Error("Cancelled"));
        }
        return;
      }
    };

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("data", onData);
      if (lastDrawnLines > 0) {
        process.stdout.write(`\x1b[${lastDrawnLines}A\x1b[J`);
      }
    }

    process.stdin.on("data", onData);
  });
}

// Quick-launch rows carry everything a replay needs: the pair identity
// (providerId when known, name as fallback/display), the last permission
// mode, and the full original argv (extraArgs) so `--continue`-style flags
// survive into the next quick launch.
async function runTUI() {
  await detectAndPromptSync({ tui: true });

  const cliOptions = Object.entries(APP_ADAPTERS).map(([value, adapter]) => ({
    label: adapter.label,
    value,
  }));

  // CLI layer + provider layer loop: esc on provider goes back to CLI selection.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // One alive snapshot per loop iteration feeds both dead-flagging and
    // display names, so a cc-switch rename surfaces without touching history.
    // Fail-open: on DB error everything reads alive (launch fails loudly later).
    const aliveByCli = snapshotAliveByCli();
    const buildQuickItems = () => {
      const { order } = loadHistory();
      return top5(aliveByCli).map((e, i) => {
        const snap = aliveByCli.get(e.cli);
        const name = (e.providerId && snap?.nameById.get(e.providerId)) || e.provider;
        const permArgs = APP_ADAPTERS[e.cli]?.permissionArgs?.(e.hotkey) ?? [];
        const replay = Array.isArray(e.extraArgs) ? e.extraArgs : [];
        // "+args" marks rows whose replay goes beyond the bare permission flags
        // (--continue etc.). An empty extraArgs on a non-default mode is NOT
        // extra — quick-launch backfills the permission flags itself.
        const hasExtraArgs = replay.length > 0 && JSON.stringify(replay) !== JSON.stringify(permArgs);
        return {
          key: QUICK_KEYS[i],
          label: `${name} · ${e.cli} · ${permLabel(e.hotkey)} · ${relTime(e.lastUsed)}${hasExtraArgs ? " · +args" : ""}`,
          cli: e.cli,
          providerId: e.providerId ?? null,
          provider: name,
          hotkey: e.hotkey ?? undefined,
          extraArgs: replay,
          pairKey: entryKey(e),
          dead: isDeadEntry(e, aliveByCli),
          pinned: order.includes(entryKey(e)),
        };
      });
    };

    const cli = await tuiSelect("Select CLI tool", cliOptions, {
      quickItems: buildQuickItems(),
      quickPin: true,
      onPin: (item, pos) => insertManualOrder(item, pos, aliveByCli),
      onUnpin: (key) => unpinPair(key, aliveByCli),
      onRemove: (key) => removeHistoryPair(key, aliveByCli),
      onCleanup: () => removeAllDeadPairs(aliveByCli),
      onRefreshQuickItems: buildQuickItems,
    });

    // Quick-launch path: letter key bypasses provider + permission selection
    // and replays the recorded argv (falling back to the bare permission flags
    // for pre-extraArgs entries).
    if (cli.quick) {
      const args = cli.extraArgs.length > 0 ? cli.extraArgs : APP_ADAPTERS[cli.cli].permissionArgs(cli.hotkey);
      await launchProvider(cli.cli, cli.provider, args, null, { hotkey: cli.hotkey });
      return;
    }

    const adapter = APP_ADAPTERS[cli.value];
    if (!adapter) throw new Error(`Unsupported CLI: ${cli.value}`);

    const providers = queryProvidersByApp(adapter.appType);
    if (providers.length === 0) {
      console.error(`✗ No provider config found for ${adapter.appType}. Please configure one in cc-switch first.`);
      process.exit(1);
    }
    const providerOptions = providers.map((p) => ({ label: p.name, value: p.id }));
    let selected;
    try {
      selected = await tuiSelect(
        `Select provider (${adapter.displayName})`,
        providerOptions,
        {
          hotkeys: [
            { key: "⏎", label: "Default" },
            { key: "2", label: "Semi-auto" },
            { key: "3", label: "Full-auto ⚠" },
          ],
          interactive: true,
          pinContext: cli.value,
          onPin: (item, pos) => insertManualOrder(item, pos, aliveByCli),
        },
      );
    } catch (e) {
      if (e.message === "BACK_TO_CLI") continue; // esc on provider → back to CLI
      throw e; // Ctrl+C → propagate to main()
    }
    const provider = providers.find((p) => p.id === selected.value);
    await launchProvider(cli.value, provider.name, adapter.permissionArgs(selected.hotkey), null, { hotkey: selected.hotkey });
    return;
  }
}

// ─── Launch logic ──────────────────────────────────────────────────────

// syncFlag: null (default) = non-blocking stderr warning if drifted;
//           "on"  (--sync)    = interactive confirm before launching;
//           "off" (--no-sync) = fully silent, no warning at all.
// record: optional {hotkey} from the TUI quick/permission selection — the
//         mode the user actually picked, preferred over inferring it back
//         out of extraArgs (which quick-launch replays without flags).
async function launchProvider(cmd, providerName, extraArgs, syncFlag = null, record = null) {
  const adapter = APP_ADAPTERS[cmd];
  if (!adapter) {
    console.error(`✗ Unsupported command: ${cmd}. Supported: ${Object.keys(APP_ADAPTERS).join(", ")}`);
    process.exit(1);
  }

  await detectAndPromptSync({ tui: syncFlag === "on", quiet: syncFlag === "off" });

  const row = queryProvider(providerName, adapter.appType);
  if (!row) {
    console.error(`✗ Provider "${providerName}" not found (${adapter.appType})`);
    console.error(`  Available providers:`);
    queryProvidersByApp(adapter.appType).forEach((p) => console.error(`    ${p.name}`));
    process.exit(1);
  }

  const settingsConfig = JSON.parse(row.settings_config || "{}");
  const meta = JSON.parse(row.meta || "{}");
  const category = row.category;
  const commonSnippet = queryCommonConfig(adapter.appType);
  const settings = loadSettings();

  const instanceDir = adapter.setupInstance(row.id);
  adapter.prepare(instanceDir, row.id, settingsConfig, meta, category, commonSnippet, settings);
  recordInstanceBaseline(adapter, row.id, instanceDir, commonSnippet);
  // Record AFTER prepare succeeded (a failed prep is not a launch) and BEFORE
  // launch (adapter.launch execs and never returns). This is the single
  // recording point — both TUI and command mode pass through here, and the
  // extraArgs are stored so quick-launch replays the full original argv.
  const hotkey = record?.hotkey !== undefined ? record.hotkey : adapter.inferHotkeyFromArgs?.(extraArgs);
  recordLaunch(cmd, row.id, row.name, hotkey, extraArgs);
  adapter.launch(instanceDir, extraArgs);
}

// ─── doctor / clean ────────────────────────────────────────────────────

function which(bin) {
  try {
    const r = spawnSync("which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function collectInstances() {
  const instances = [];
  for (const adapter of Object.values(APP_ADAPTERS)) {
    const dir = join(INSTANCES_DIR, adapter.appType);
    if (!existsSync(dir)) continue;
    for (const name of readdirSyncSafe(dir) || []) {
      const full = join(dir, name);
      if (lstatSyncSafe(full)?.isDirectory()) instances.push({ name, appType: adapter.appType, path: full });
    }
  }
  return instances;
}

// Drop the drift baselines of removed instance dirs, so stale-instance
// prompts stop naming providers whose directories are gone (the dir name IS
// the providerId — see setupInstance). Best-effort: a state-file hiccup must
// not fail the clean itself.
function pruneInstanceBaselines(instances) {
  try {
    const state = loadSyncState();
    let changed = false;
    for (const { name, appType } of instances) {
      if (state.instances?.[appType]?.[name] !== undefined) {
        delete state.instances[appType][name];
        changed = true;
      }
    }
    if (changed) saveSyncState(state);
  } catch {
    // best-effort: unreadable state — the ghost entry stays, harmless.
  }
}

function runDoctor() {
  const checks = [];
  const add = (label, pass, detail) => checks.push({ label, pass, detail });

  // sqlite3
  const sqliteOk = !!which("sqlite3");
  add("sqlite3 CLI", sqliteOk, sqliteOk ? "available" : "not found on PATH — required to read the cc-switch DB");

  // DB + providers
  let dbOk = false;
  let counts = "";
  if (!existsSync(DB_PATH)) {
    counts = "DB file not found";
  } else {
    try {
      const tables = queryDB(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`);
      if (tables.length === 0) {
        counts = "providers table missing";
      } else {
        const parts = [];
        for (const adapter of Object.values(APP_ADAPTERS)) {
          parts.push(`${adapter.appType}: ${queryProvidersByApp(adapter.appType).length}`);
        }
        counts = parts.join(", ");
        dbOk = true;
      }
    } catch (e) {
      counts = e.message;
    }
  }
  add("cc-switch DB", dbOk, dbOk ? `readable (providers — ${counts})` : counts);

  // CLI binaries
  for (const adapter of Object.values(APP_ADAPTERS)) {
    const p = which(adapter.bin);
    add(`${adapter.bin} binary`, !!p, p || "not found on PATH");
  }

  // common config parse
  for (const adapter of Object.values(APP_ADAPTERS)) {
    const snip = queryCommonConfig(adapter.appType);
    if (!snip) { add(`common_config_${adapter.appType}`, true, "not set"); continue; }
    let pass = true;
    try { adapter.appType === "claude" ? JSON.parse(snip) : parseToml(snip); } catch { pass = false; }
    add(`common_config_${adapter.appType}`, pass, pass ? "parseable" : "unparseable");
  }

  // instance dirs
  const instances = collectInstances();
  add("instance dirs", true, `${instances.length} instance(s)`);

  // sync state
  add("sync-state.json", existsSync(SYNC_STATE_PATH), existsSync(SYNC_STATE_PATH) ? "present" : "not yet created (first run)");

  // render
  console.log("\n  \x1b[1mcc-switch-parallel doctor\x1b[0m\n");
  for (const c of checks) {
    const mark = c.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log("");
  const failed = checks.filter((c) => !c.pass).length;
  if (failed) {
    console.log(`  \x1b[31m${failed} issue(s) found.\x1b[0m\n`);
    process.exit(1);
  }
  console.log("  \x1b[32mAll checks passed.\x1b[0m\n");
}

async function runClean(args) {
  const instances = collectInstances();
  if (!instances.length) {
    console.log("No instance directories found.");
    return;
  }

  if (args.includes("--all") || args.includes("--yes")) {
    for (const inst of instances) rmSync(inst.path, { recursive: true, force: true });
    pruneInstanceBaselines(instances);
    console.log(`✓ Removed ${instances.length} instance director${instances.length === 1 ? "y" : "ies"}.`);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error("✗ clean requires an interactive terminal (or use --all to remove everything).");
    process.exit(1);
  }

  const options = [
    ...instances.map((i) => ({ label: `${i.appType}/${i.name}`, value: i.path })),
    { label: "Delete ALL instances", value: "__all__" },
  ];
  const choice = await tuiSelect("Select instance directory to remove", options);
  if (choice.value === "__all__") {
    for (const inst of instances) rmSync(inst.path, { recursive: true, force: true });
    pruneInstanceBaselines(instances);
    console.log(`✓ Removed ${instances.length} instance director${instances.length === 1 ? "y" : "ies"}.`);
  } else {
    rmSync(choice.value, { recursive: true, force: true });
    pruneInstanceBaselines(instances.filter((i) => i.path === choice.value));
    console.log(`✓ Removed ${choice.value}`);
  }
}

function printHelp() {
  console.log(`cc-switch-parallel — launch Claude Code / Codex with per-provider isolated configs

Usage:
  switch                                 Interactive TUI (select CLI, then provider)
  switch <provider> <cmd> [args...]     Launch a provider directly
  switch --sync <provider> <cmd> [...]  Same, but confirm config drift first
  switch --no-sync <provider> <cmd> [...] Same, but suppress the drift warning
  switch sync                           Detect & sync config drift (plugins, common config)
  switch doctor                         Diagnose the environment
  switch clean [--all]                  Remove instance directories
  switch update                         Self-update to the latest npm version
  switch -v | --version                 Show version

Commands: ${Object.keys(APP_ADAPTERS).join(", ")}

Examples:
  switch "Claude Official" claude
  switch "Zhipu GLM en" claude --continue
  switch "P&G Nezha" codex`);
}

// ─── Main entry ────────────────────────────────────────────────────────

async function runUpdate() {
  const currentVersion = VERSION;
  console.log(`Current version: v${currentVersion}`);

  let latestVersion;
  try {
    latestVersion = execSync(`npm view ${NPM_PACKAGE_NAME} version`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error("✗ Failed to query latest version. Please check your network connection.");
    process.exit(1);
  }

  if (currentVersion === latestVersion) {
    console.log("Already up to date.");
    process.exit(0);
  }

  console.log(`Updating to v${latestVersion}...`);
  try {
    execSync(`npm install -g ${NPM_PACKAGE_NAME}@latest`, { stdio: "inherit" });
  } catch (e) {
    const msg = String(e?.stderr || e?.message || "");
    if (/EACCES|EPERM|EISDIR/.test(msg)) {
      console.error(`✗ Permission denied. Try: sudo npm install -g ${NPM_PACKAGE_NAME}@latest`);
    } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|network|fetch failed/.test(msg)) {
      console.error("✗ Network error during install. Please check your connection and retry.");
    } else {
      console.error(`✗ Update failed: ${msg.trim() || "unknown error"}`);
    }
    process.exit(1);
  }
  console.log(`✓ Updated to v${latestVersion}`);
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);

  // Leading --sync / --no-sync flag (command mode only). Must be stripped
  // before any other parsing since the remainder of argv is forwarded
  // verbatim to the launched CLI (e.g. `claude --continue`) — a flag parsed
  // anywhere but the front could be mistaken for a CLI argument.
  let syncFlag = null;
  while (args.length && (args[0] === "--sync" || args[0] === "--no-sync")) {
    syncFlag = args.shift() === "--sync" ? "on" : "off";
  }

  if (args.length === 0) {
    try {
      await runTUI();
    } catch (e) {
      if (e.message !== "Cancelled") console.error(`✗ ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (args[0] === "update" || args[0] === "self-update" || args[0] === "--update") {
    await runUpdate();
    return;
  }

  if (args[0] === "sync") {
    const result = await detectAndPromptSync({ tui: true });
    if (!result.drifted) console.log("No config drift detected — everything in sync.");
    else if (result.synced) {
      console.log(
        result.refreshed?.length
          ? `✓ Synced (refreshed: ${result.refreshed.join(", ")}).`
          : "✓ Synced.",
      );
    } else console.log("Skipped — no changes written.");
    process.exit(0);
    return;
  }

  if (args[0] === "doctor") {
    runDoctor();
    return;
  }

  if (args[0] === "clean") {
    await runClean(args.slice(1));
    return;
  }

  if (args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    printHelp();
    process.exit(0);
    return;
  }

  if (args[0] === "-v" || args[0] === "--version" || args[0] === "version") {
    const v = VERSION;
    const latest = (() => {
      try {
        return execSync(`npm view ${NPM_PACKAGE_NAME} version`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch {
        return null;
      }
    })();
    console.log(`cc-switch-parallel v${v}${latest ? (v === latest ? " (latest)" : ` (latest: ${latest})`) : ""}`);
    process.exit(0);
  }

  if (args.length < 2) {
    console.error(`Usage: switch <provider> <cmd> [args...]`);
    console.error(`  Run \`switch --help\` for all commands.`);
    console.error(`Examples: switch "Claude Official" claude`);
    console.error(`          switch "Zhipu GLM en" claude --continue`);
    console.error(`          switch "P&G Nezha" codex`);
    process.exit(1);
  }

  const providerName = args[0];
  const cmd = args[1];
  const extraArgs = args.slice(2);
  await launchProvider(cmd, providerName, extraArgs, syncFlag);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
