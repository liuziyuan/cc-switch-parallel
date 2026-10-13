#!/usr/bin/env node
// switch: Claude Code / Codex multi-provider parallel launcher
//
// Usage:
//   switch                                 # TUI interactive mode: select CLI then provider
//   switch update                          # Self-update to the latest npm version
//   switch ps                              # List running switch-launched sessions
//   switch customize <provider>            # Instance-only CLAUDE.md for a provider
//   switch <provider> <cmd> [args...]     # Command mode: specify provider and CLI directly
//
// Reads provider config from ~/.cc-switch/cc-switch.db, generates isolated instance dirs,
// and launches via CLAUDE_CONFIG_DIR / CODEX_HOME env var isolation.
// Different terminals use their own provider configs without interference.

import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
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
  realpathSync,
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
// ".timeout 3000" is a sqlite3 dot-command setting the busy timeout — the
// 2s `timeout` option below only bounds the PROCESS, and can't make sqlite
// wait out a lock held by the cc-switch desktop app mid-write.
function execDB(sql) {
  execFileSync("sqlite3", [DB_PATH, ".timeout 3000", sql], {
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

// Atomically merge a patch into one provider's settings_config via sqlite
// json_patch (RFC 7396 — same contract as patchCommonConfigClaude, but the
// target is providers.settings_config, a TEXT column holding JSON). A single
// UPDATE is atomic, so concurrent launches can't lose updates on disjoint
// keys. Only updates an existing row — never INSERTs a provider.
function patchProviderSettingsConfig(providerId, appType, patchObj) {
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

// Row strength for natural ranking and "which entry of a pair is displayed":
// live before dead, then count, then recency. Shared by mergeTop5 and
// setEntryHotkey (the latter needs the SAME displayed-entry choice, or an
// edit would land on a different row than the one the user highlighted).
function byStrength(a, b, aliveByCli) {
  const liveness = (e) => (isDeadEntry(e, aliveByCli) ? 0 : 1);
  return (liveness(b) - liveness(a)) || (b.count - a.count) || (b.lastUsed - a.lastUsed);
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
  const cmp = (a, b) => byStrength(a, b, aliveByCli);
  const rep = (id) => entries.filter((e) => entryKey(e) === id).sort(cmp)[0];
  const seen = new Set();
  const natural = [];
  for (const e of [...entries].sort(cmp)) {
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
      // Pin placeholders carry the exact signature hotkey:null + count:0 +
      // lastUsed:0 (see insertManualOrder). Upgrade one in place instead of
      // pushing a sibling entry — otherwise the first real launch of a pinned
      // pair forks history into two rows. count>0 null-hotkey entries are real
      // Default history, never placeholders — the count===0 guard protects them.
      const ph = entries.find((e) =>
        e.providerId === providerId && e.cli === cli && e.hotkey == null && (e.count || 0) === 0);
      if (ph) {
        ph.hotkey = hotkey ?? null;
        ph.count = 1;
        ph.lastUsed = now;
        ph.provider = providerName;
        ph.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
      } else {
        entries.push({
          cli, providerId, provider: providerName, hotkey: hotkey ?? null,
          extraArgs: Array.isArray(extraArgs) ? extraArgs : [], count: 1, lastUsed: now,
        });
      }
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

// Remove every permission flag a launch argv might carry — both CLIs, both
// spellings (separated `--permission-mode VALUE` and joined `=VALUE`), so the
// non-permission tail (`--continue` etc.) survives a mode edit intact.
function stripPermissionArgs(args) {
  const single = new Set([
    "--dangerously-skip-permissions",
    "--approve-for-me",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (single.has(a)) continue;
    if (a === "--permission-mode") { i++; continue; } // flag + separate value
    if (a.startsWith("--permission-mode=")) continue; // joined = form
    out.push(a);
  }
  return out;
}

// `e` edit: switch a Recent row's launch mode in place. Targets the DISPLAYED
// entry of the pair (the strongest one — the same row mergeTop5 shows), keeps
// its slot/count/lastUsed (a count-0 placeholder stays recognizable for
// recordLaunch's upgrade path), and rebuilds extraArgs as
// [non-permission tail, new permission flags] so quick-launch replays the
// right argv. Returns the updated top5 rows, or null on failure.
function setEntryHotkey(pairKey, hotkey, cli, aliveByCli) {
  if (_historyFrozen) return null;
  try {
    const { entries, order } = loadHistory();
    const target = entries
      .filter((e) => entryKey(e) === pairKey)
      .sort((a, b) => byStrength(a, b, aliveByCli))[0];
    if (!target) return null;
    target.hotkey = hotkey ?? null; // undefined (Default) normalizes to null
    target.extraArgs = [
      ...stripPermissionArgs(Array.isArray(target.extraArgs) ? target.extraArgs : []),
      ...(APP_ADAPTERS[cli]?.permissionArgs?.(hotkey ?? null) ?? []),
    ];
    saveHistory(entries, order);
    return mergeTop5(entries, order, aliveByCli);
  } catch {
    return null;
  }
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

// 1:1 port of the upstream Rust json_deep_merge (services/provider/live.rs,
// 69ff69d^): two plain objects recurse per key of source (missing keys are
// inserted, existing keys recurse); EVERY other shape — scalar vs object,
// object vs scalar, arrays, type mismatches — falls through to a full source
// overwrite. The old jsonDeepMerge above got that fallthrough wrong (the
// target kept its value), which inverted the common-over-provider semantics
// of buildClaudeEffectiveSettings. Do NOT "fix" jsonDeepMerge in place:
// detectSettingsDrift's providerPatches accumulation still calls it and
// relies on target-wins for merging nested patches. Two functions, two
// contracts, kept separate on purpose.
// Contract: returns the merged value; the caller must assign it back
// (`x = mergeCommonOverProvider(x, src)`) because the scalar-overwrite
// branch cannot mutate the caller's binding. source is always a JSON.parse
// result, so jsonDeepClone (JSON round-trip) is safe on every branch.
function mergeCommonOverProvider(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return jsonDeepClone(source);
  }
  for (const [key, sourceValue] of Object.entries(source)) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = mergeCommonOverProvider(target[key], sourceValue);
    } else {
      target[key] = jsonDeepClone(sourceValue);
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

// Strict structural equality for the instance-settings guard & diff: objects
// recurse per key; arrays are atomic, order-sensitive leaves. The array
// semantics are deliberate — settings arrays like permissions.allow or hooks
// have no reliable element-level merge under RFC 7396 (json_patch has no
// array patch primitive), so "did the user change this array" is answered
// whole-block. jsonIsSubset is the WRONG tool here: its fuzzy array matching
// (every source item matches SOME target item) would call different arrays
// equal, which is exactly the false negative the overwrite guard must never
// produce.
function deepEqualJson(a, b) {
  if (a === b) return true;
  // Arrays: still atomic leaves for DIFF purposes (a changed array is one
  // whole-block change), but equality is CONTENT equality, element-wise —
  // baseline and runtime settings come from two separate JSON.parse calls,
  // so `a === b` would call two identical arrays unequal and turn every
  // unchanged permissions.allow/hooks block into a phantom diff (false
  // overwrite-guard warnings, idempotent-but-noisy sync writes).
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJson(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqualJson(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// Leaf-level diff of two parsed settings objects, from a baseline to the
// current state: [{path, op: "add"|"change"|"remove", from, to}] where path
// is a dotted key path ("env.ANTHROPIC_AUTH_TOKEN"). Objects recurse per
// key; arrays are atomic — the path stops at the array's key and from/to
// carry the whole array (same semantics as deepEqualJson, so "what changed"
// and "is it equal" can never disagree).
// Removal folding: a level whose changes are ALL removes collapses into
// ONE remove at the subtree root — otherwise a json_patch built from
// per-leaf nulls would leave empty-object husks behind ({"hooks": {}}
// after deleting every hook). Folded only when the level is exclusively
// removal (any add/change keeps per-leaf granularity so mixed edits stay
// visible).
// Callers filter the enabledPlugins subtree themselves — the plugin channel
// owns that path, and this function must not know about channels.
function diffSettingsLeaves(baseline, current, prefix = "") {
  const changes = [];
  const b = isPlainObject(baseline) ? baseline : {};
  const c = isPlainObject(current) ? current : {};

  const keys = new Set([...Object.keys(b), ...Object.keys(c)]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const inB = Object.prototype.hasOwnProperty.call(b, k);
    const inC = Object.prototype.hasOwnProperty.call(c, k);
    if (inB && inC) {
      const bv = b[k];
      const cv = c[k];
      if (isPlainObject(bv) && isPlainObject(cv)) {
        changes.push(...diffSettingsLeaves(bv, cv, path));
      } else if (!deepEqualJson(bv, cv)) {
        // Arrays & scalars are leaves; deepEqualJson's non-object branch is
        // strict ===, which is the right comparison for both.
        changes.push({ path, op: "change", from: bv, to: cv });
      }
    } else if (inC) {
      changes.push({ path, op: "add", from: undefined, to: c[k] });
    } else {
      changes.push({ path, op: "remove", from: b[k], to: undefined });
    }
  }

  // Fold an all-remove level into a single root remove. Trigger only when
  // every change below this prefix is a remove AND they all hang off ONE
  // key of this prefix (a mixed subtree keeps leaf granularity). The folded
  // "from" is rebuilt so the display line can still show what was deleted.
  if (prefix && changes.length > 0 && changes.every((ch) => ch.op === "remove")) {
    const roots = new Set(changes.map((ch) => ch.path.split(".")[prefix.split(".").length]));
    if (roots.size === 1) {
      const from = {};
      for (const ch of changes) {
        const rel = ch.path.slice(prefix.length + 1).split(".");
        let cur = from;
        for (let i = 0; i < rel.length - 1; i++) cur = cur[rel[i]] = cur[rel[i]] || {};
        cur[rel[rel.length - 1]] = ch.from;
      }
      return [{ path: prefix, op: "remove", from, to: undefined }];
    }
  }
  return changes;
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
      effective = mergeCommonOverProvider(effective, source);
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
        // Non-symlink real file/dir. Real FILES are deliberate content (a
        // customized CLAUDE.md, user-placed config) — always keep them.
        // Dirs: Claude Code auto-creates empty ones like plugins/ on first
        // launch; those are replaced by symlinks, while non-empty dirs stay
        // (warn) to avoid deleting user data.
        if (stats.isDirectory()) {
          const dirEntries = readdirSyncSafe(linkPath);
          if (dirEntries && dirEntries.length > 0) {
            console.error(`⚠ ${linkPath} already exists and is non-empty, skipping symlink (target: ${target})`);
            return;
          }
          rmSync(linkPath, { recursive: true, force: true });
        }
        return;
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

// ─── Instance settings backups (overwrite guard) ──────────────────────

// Copy an instance's settings.json to ~/.cc-switch/backups/<appType>/<id>/
// right before the launch path overwrites it, and prune to the most recent
// BACKUP_KEEP copies. Kept OUTSIDE the instance dir on purpose: `switch
// clean` removes instance dirs wholesale, so a backup living there would be
// deleted by the very flow that needs it; a sibling .bak file also risks
// being picked up by Claude Code when it scans its config dir. Best-effort —
// returns the backup path, or null on failure (the guard prints a louder
// warning then, but never blocks the launch).
const BACKUPS_DIR = join(CC_SWITCH_DIR, "backups");
const BACKUP_KEEP = 10;
const backupDirFor = (appType, providerId) => join(BACKUPS_DIR, appType, providerId);

function backupInstanceSettings(appType, providerId, instanceDir) {
  try {
    const src = join(instanceDir, "settings.json");
    if (!existsSync(src)) return null;
    const dir = backupDirFor(appType, providerId);
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const dest = join(dir, `settings.json.${ts}`);
    atomicWrite(dest, readFileSync(src, "utf8"));
    const keep = (readdirSyncSafe(dir) || [])
      .filter((n) => n.startsWith("settings.json."))
      .sort()
      .slice(0, -BACKUP_KEEP);
    for (const name of keep) { try { unlinkSync(join(dir, name)); } catch {} }
    return dest;
  } catch {
    return null;
  }
}

// Remove the backup tree of instances whose provider row is gone — called
// from clean's baseline pruning, same best-effort contract (a state-file
// hiccup must not fail the clean itself).
function pruneInstanceSettingsBackups(instances) {
  try {
    for (const { name, appType } of instances) {
      rmSync(backupDirFor(appType, name), { recursive: true, force: true });
    }
  } catch {
    // best-effort: unreadable backup dir — stays behind, harmless.
  }
}

// ─── Tracked launch & session files ───────────────────────────────────

// Records of live switch-launched sessions, consumed by `switch ps` and the
// TUI live marker. One file per session (a provider can run concurrently in
// several terminals), inside the instance dir (same precedent as
// settings.json), so `clean` removes them with the directory.
const SESSIONS_SUBDIR = ".cc-switch-sessions";
const LEGACY_SESSION_FILENAME = ".cc-switch-session.json";
const sessionsDir = (instanceDir) => join(instanceDir, SESSIONS_SUBDIR);
const legacySessionFilePath = (instanceDir) => join(instanceDir, LEGACY_SESSION_FILENAME);

// One ps(1) field lookup; null on any hiccup. Used for lstart (the PID-reuse
// guard) and for the parent's tty.
function psField(pid, field) {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() || null : null;
  } catch {
    return null;
  }
}

// Writes this session's own file (named after pid+ms, so concurrent sessions
// never collide) and returns its path — null on failure. Callers only ever
// remove the path they got back, never a shared file.
function writeSessionFile(instanceDir, pid, bin, extraArgs) {
  try {
    let file = join(sessionsDir(instanceDir), `${pid}-${Date.now()}.json`);
    for (let n = 2; existsSync(file); n++) file = join(sessionsDir(instanceDir), `${pid}-${Date.now()}-${n}.json`);
    atomicWrite(file, JSON.stringify({
      pid,
      lstart: psField(pid, "lstart"),
      cli: bin,
      providerId: basename(instanceDir),
      startedAt: Date.now(),
      extraArgs,
      tty: psField(process.pid, "tty"),
      cwd: process.cwd(),
    }, null, 2));
    return file;
  } catch {
    // best-effort: a tracking failure must never block the launch
    return null;
  }
}

function removeSessionFile(sessionFilePath) {
  try { unlinkSync(sessionFilePath); } catch {}
}

// All sessions of an instance: the per-session files plus the legacy
// single-file record from older versions. A file that fails to parse (parent
// killed mid-write) yields { session: null } so the caller cleans it up.
function readSessions(instanceDir) {
  const out = [];
  const names = readdirSyncSafe(sessionsDir(instanceDir)) || [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".tmp.")) continue;
    const path = join(sessionsDir(instanceDir), name);
    try {
      const s = JSON.parse(readFileSync(path, "utf8"));
      out.push({ path, session: isPlainObject(s) ? s : null });
    } catch {
      out.push({ path, session: null });
    }
  }
  try {
    const s = JSON.parse(readFileSync(legacySessionFilePath(instanceDir), "utf8"));
    if (isPlainObject(s)) out.push({ path: legacySessionFilePath(instanceDir), session: s });
  } catch {}
  return out;
}

// Alive = pid exists AND its recorded lstart matches (kill(0) alone would
// false-positive once the OS reuses the pid).
function sessionIsAlive(session) {
  if (!session || typeof session.pid !== "number") return false;
  try {
    process.kill(session.pid, 0);
  } catch {
    return false;
  }
  if (!session.lstart) return true;
  return psField(session.pid, "lstart") === session.lstart;
}

// Foreground replacement for the former spawnSync launch: stdio and exit-code
// semantics unchanged, but the child's pid is recorded while it runs and its
// session file is removed on a clean exit — only its own, so concurrent
// sessions of the same provider stay tracked. A crashed parent (kill -9)
// leaves the file behind — `switch ps` cleans those up as stale.
function launchTracked(bin, extraArgs, instanceDir, envKey, onExit) {
  // Belt-and-suspenders for the flowing-stdin hazard: any missed cleanup
  // upstream would let the parent keep consuming (and discarding) keystrokes
  // that belong to the spawned CLI. pause() is idempotent and cheap.
  try { process.stdin.pause(); } catch {}
  const child = spawn(bin, extraArgs, {
    stdio: "inherit",
    env: { ...process.env, [envKey]: instanceDir },
  });
  const sessionFile = child.pid ? writeSessionFile(instanceDir, child.pid, bin, extraArgs) : null;
  child.on("error", (e) => {
    if (sessionFile) removeSessionFile(sessionFile);
    console.error(`✗ Failed to launch ${bin}: ${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => {
    if (sessionFile) removeSessionFile(sessionFile);
    try { onExit?.(code); } catch {}
    process.exit(code || 0);
  });
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

// ─── Overwrite guard (launch-time safety net) ─────────────────────────
// Called immediately before prepare() overwrites an instance's settings.json
// (launch path AND refreshStaleInstances — the latter is an existing blind
// spot: a confirmed sync regenerates OTHER stale instances in place, silently
// wiping their own unsynced edits). Detects edits beyond enabledPlugins (the
// plugin channel reports those separately — double-reporting teaches users
// to ignore warnings), backs the file up, and warns. Never blocks the launch:
// same philosophy as command-mode drift warnings.

// Filter the enabledPlugins subtree out of a leaf-diff (the plugin channel
// owns that path — the field channel must neither report nor vote on it).
function isPluginChannelPath(path) {
  return path === "enabledPlugins" || path.startsWith("enabledPlugins.");
}

// Format one diff entry as a display line for the warning/prompt lists.
function formatSettingsChangeLine(ch, target) {
  const mark = ch.op === "add" ? "+" : ch.op === "remove" ? "-" : "~";
  const color = ch.op === "add" ? "\x1b[32m" : ch.op === "remove" ? "\x1b[31m" : "\x1b[33m";
  const targetTag =
    target === "common" ? " \x1b[2m(→ common config)\x1b[0m"
    : target === "blocked" ? " \x1b[33m(⚠ sensitive — NOT synced, edit in cc-switch)\x1b[0m"
    : " \x1b[2m(→ provider)\x1b[0m";
  return `${color}${mark} settings\x1b[0m ${ch.path}${targetTag}`;
}

function guardClaudeSettingsBeforeOverwrite(adapter, row, instanceDir, commonSnippet) {
  try {
    if (adapter.appType !== "claude") return; // v3 guard is claude-only this cycle
    const current = adapter.readInstanceSettingsSnapshot(instanceDir);
    if (!current) return; // missing/corrupt — nothing to protect

    const state = loadSyncState();
    const entry = state.instances?.claude?.[row.id];

    // v2 → v3 upgrade: no preparedSettings yet. Recompute what prepare WOULD
    // write from the current DB and compare. Equal → the file is a faithful
    // mirror, silently backfill the v3 baseline (one-time, self-healing).
    // Not equal → ambiguous (user edits, or the common config changed in the
    // desktop app since — the latter is legitimate downward drift): we can't
    // tell, so NO warning (avoid false alarms during the upgrade window),
    // just one silent backup + a dim note. After this launch the baseline is
    // v3 either way and future guards are exact.
    if (!isPlainObject(entry?.preparedSettings)) {
      const effective = buildClaudeEffectiveSettings(
        JSON.parse(row.settings_config || "{}"), JSON.parse(row.meta || "{}"), commonSnippet,
      );
      const backfilled = deepEqualJson(effective, current);
      if (!backfilled) {
        const bak = backupInstanceSettings("claude", row.id, instanceDir);
        process.stderr.write(`\x1b[2msettings.json for "${row.name}" differs from the cc-switch config; a backup was saved${bak ? ` (${bak})` : " (backup FAILED)"} before overwriting.\x1b[0m\n`);
      }
      return;
    }

    const changes = diffSettingsLeaves(entry.preparedSettings, current).filter(
      (ch) => !isPluginChannelPath(ch.path),
    );
    if (changes.length === 0) return; // faithful mirror — overwrite silently

    const bak = backupInstanceSettings("claude", row.id, instanceDir);
    process.stderr.write(`\x1b[33m⚠ Instance settings.json for "${row.name}" has edits that will be overwritten:\x1b[0m\n`);
    const shown = changes.slice(0, 10);
    for (const ch of shown) {
      const mark = ch.op === "add" ? "\x1b[32m+\x1b[0m" : ch.op === "remove" ? "\x1b[31m-\x1b[0m" : "\x1b[33m~\x1b[0m";
      process.stderr.write(`    ${mark} ${ch.path}\n`);
    }
    if (changes.length > shown.length) {
      process.stderr.write(`    … and ${changes.length - shown.length} more\n`);
    }
    process.stderr.write(
      bak
        ? `  Backup saved: ${bak}\n`
        : `  \x1b[31mBackup FAILED — edits will be lost.\x1b[0m\n`,
    );
    process.stderr.write(`  Run \x1b[1mswitch sync\x1b[0m to merge these edits back into cc-switch before they are lost.\n`);
  } catch {
    // best-effort: guard must never block a launch.
  }
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
// Optional (claude only): detectSettingsDrift() / syncSettingsBack() — the
//   settings-field upward channel: full leaf-level diff of each instance's
//   runtime settings.json against its recorded baseline, arbitrated across
//   instances, then split between common_config and provider settings_config.
// Optional (claude only): readInstanceSettingsSnapshot() — let the baseline
//   record the full parsed settings prepare just wrote (v3); without it an
//   adapter stays v2-shaped and skips the guard + settings-field sync.
//   readInstancePluginState() lets the baseline record plugin state.
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
      launchTracked("claude", extraArgs, instanceDir, "CLAUDE_CONFIG_DIR", () => normalizeInstalledPluginPaths());
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
      const snap = this.readInstanceSettingsSnapshot(instanceDir);
      if (!snap) return null;
      return isPlainObject(snap.enabledPlugins) ? snap.enabledPlugins : {};
    },

    // Read the full parsed settings.json this instance currently holds. Used
    // by buildInstanceBaselineEntry() right after prepare — the file on disk
    // at that moment IS what we handed down, so the recorded snapshot is the
    // ground truth the overwrite guard and the settings-field sync diff
    // against. Returns null on missing/corrupt file (treated as "no v3
    // baseline" by every consumer — never a drift report).
    readInstanceSettingsSnapshot(instanceDir) {
      try {
        return JSON.parse(readFileSync(join(instanceDir, "settings.json"), "utf8"));
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

    // Upward drift, channel 2: non-plugin settings fields edited inside a
    // session. Leaf-level diff of every instance's runtime settings.json
    // against its v3 baseline (instances without one are skipped — pre-v3
    // edits can't be told apart from mirrors), arbitrated across instances,
    // then smart-split between common config and provider settings_config.
    // Mirrors computeEnabledPluginsPatch's arbitration: a faithful mirror
    // gets no vote; among voting instances the most recent edit (mtime) wins
    // per path; the plugin channel's subtree is excluded so the two channels
    // never double-report or double-vote.
    // Returns { instances: [{providerId, name, changes, mtimeMs}],
    //           commonPatch, providerPatches, conflicts: {path: count} } or null.
    detectSettingsDrift(state) {
      const dir = join(INSTANCES_DIR, "claude");
      const baselines = state?.instances?.claude || {};
      if (!existsSync(dir)) return null;

      // Parse the current common snippet once; used both for split decisions
      // and for "already equal in DB" filtering.
      let commonObj = {};
      try {
        const snip = queryCommonConfig("claude");
        if (snip) commonObj = JSON.parse(snip);
      } catch {}

      const candidates = [];
      for (const name of readdirSyncSafe(dir) || []) {
        try {
          const settingsPath = join(dir, name, "settings.json");
          const current = JSON.parse(readFileSync(settingsPath, "utf8"));
          const baseline = baselines[name]?.preparedSettings;
          if (!isPlainObject(baseline)) continue; // no v3 baseline — no vote
          if (deepEqualJson(current, baseline)) continue; // unchanged mirror
          const changes = diffSettingsLeaves(baseline, current).filter(
            (ch) => !isPluginChannelPath(ch.path),
          );
          if (changes.length === 0) continue; // only plugin edits — channel 1's beat
          let mtimeMs = 0;
          try { mtimeMs = lstatSync(settingsPath).mtimeMs; } catch {}
          candidates.push({ providerId: name, changes, mtimeMs });
        } catch {
          // missing/corrupt instance settings — skip
        }
      }
      if (candidates.length === 0) return null;

      // Per-path vote: a candidate that never changed a path relative to ITS
      // OWN baseline has no say on that path (it only diverges from the
      // group, not from what it was given). Winner = newest mtime.
      const votes = new Map(); // path → [{candidate, change}]
      for (const cand of candidates) {
        for (const ch of cand.changes) {
          if (!votes.has(ch.path)) votes.set(ch.path, []);
          votes.get(ch.path).push({ cand, ch });
        }
      }
      const commonPatch = {};
      const providerPatches = {};
      const conflicts = {};
      const rejectedPaths = [];
      const reported = [];
      for (const [path, voters] of votes.entries()) {
        voters.sort((a, b) => a.cand.mtimeMs - b.cand.mtimeMs);
        const winner = voters[voters.length - 1];
        if (voters.length > 1) conflicts[path] = voters.length;

        const row = queryProviderById(winner.cand.providerId, "claude");
        const providerSettings = row ? JSON.parse(row.settings_config || "{}") : null;
        if (!providerSettings) continue; // provider row gone — provider-target path is dropped

        const { commonPatch: cp, providerPatch: pp, rejected: rj } = splitChangesByTarget(
          [winner.ch], winner.cand.providerId, commonObj, providerSettings,
        );
        Object.assign(commonPatch, cp);
        if (rj.length) rejectedPaths.push(...rj.map((ch) => ch.path));
        // pp is ONE change's nested patch object (path-keyed), not {pid: patch} —
        // merge it under the WINNING provider's id.
        if (Object.keys(pp).length) {
          providerPatches[winner.cand.providerId] = jsonDeepMerge(
            providerPatches[winner.cand.providerId] || {}, pp,
          );
        }
        reported.push({ providerId: winner.cand.providerId, change: winner.ch });
      }
      // All-rejected drift must still surface: every change was refused, but
      // the prompt has to say so instead of going silent.
      if (!Object.keys(commonPatch).length && !Object.keys(providerPatches).length && !rejectedPaths.length) return null;

      // Display-facing: one entry per candidate instance with its (filtered)
      // changes, plus the name resolution for the prompt lines.
      const nameById = new Map(queryProvidersByApp("claude").map((p) => [p.id, p.name]));
      const instances = candidates.map((c) => ({
        providerId: c.providerId,
        name: nameById.get(c.providerId) || c.providerId,
        changes: c.changes,
        mtimeMs: c.mtimeMs,
      }));
      return { instances, commonPatch, providerPatches, conflicts, rejected: rejectedPaths };
    },

    // Write-back: apply the split patches. Runs in detectAndPromptSync's
    // confirmed branch AFTER the plugin channel and BEFORE
    // refreshStaleInstances — the write-back makes other instances stale,
    // and refresh rebuilds their baselines so this prompt doesn't re-fire.
    syncSettingsBack(drift) {
      applySettingsFieldPatches(drift.commonPatch, drift.providerPatches);
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
      launchTracked("codex", extraArgs, instanceDir, "CODEX_HOME");
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

// ─── Settings-field upward channel (detect → arbitrate → split → write) ─

// Does a dotted path exist in the parsed common-config snippet? The parent
// object existing is enough — smart-split routes a field to common only when
// common already owns that key, otherwise prepare's jsonDeepMerge(effective,
// commonSource) wouldn't have sourced it from common in the first place.
function pathExistsInSnippet(snippetObj, path) {
  if (!isPlainObject(snippetObj) || !path) return false;
  const parts = path.split(".");
  let cur = snippetObj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur) || !(parts[i] in cur)) return false;
    cur = cur[parts[i]];
  }
  return isPlainObject(cur) && (parts[parts.length - 1] in cur);
}

// Sensitive-key gate for the smart split's common direction — 1:1 port of
// Rust ProviderService::is_sensitive_config_key. Deliberately over-broad:
// blocking one shareable key only costs that key not being shared (small,
// recoverable), while leaking one credential into common_config reaches
// EVERY provider that consumes the snippet (unrecoverable). Pattern classes,
// not name enumeration — enumerating `*_API_KEY` would miss the next one.
function isSensitiveConfigKey(name) {
  const upper = String(name).toUpperCase();
  const SENSITIVE_SUFFIXES = [
    "_KEY", "_API_KEY", "_ACCESS_KEY", "_ACCESS_KEY_ID", "_KEY_ID",
    "_PRIVATE_KEY", "_APIKEY", "_ACCESSKEY", "_SECRETKEY", "_APITOKEN",
    "_AUTH_TOKEN", "_TOKEN", "_PAT", "_PWD", "_PASS", "_PASSPHRASE",
    "_CREDS", "_CUSTOM_HEADERS",
  ];
  const SENSITIVE_EXACT = ["APIKEY", "API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIALS", "HEADERS"];
  const SENSITIVE_CONTAINS = ["SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE_KEY", "BEARER_TOKEN", "COOKIE", "AUTHORIZATION"];
  return SENSITIVE_EXACT.includes(upper)
    || SENSITIVE_SUFFIXES.some((s) => upper.endsWith(s))
    || SENSITIVE_CONTAINS.some((c) => upper.includes(c));
}

// Dotted-path variant for the smart split: every segment of a change path is
// a map key at some nesting level, and Rust strips sensitive keys at EVERY
// level — so a hit on any segment routes the change out of common's direction.
function isSensitiveConfigPath(path) {
  return String(path || "").split(".").some((seg) => isSensitiveConfigKey(seg));
}

// Rebuild a nested patch object from leaf-level changes (RFC 7396: remove =
// null; deep adds materialize intermediate objects; inner nulls survive
// deepEqual-style folds because diffSettingsLeaves already collapsed them).
function buildPatchFromChanges(changes) {
  const patch = {};
  for (const ch of changes) {
    const parts = ch.path.split(".");
    let cur = patch;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = ch.op === "remove" ? null : ch.to;
  }
  return patch;
}

// Read the value at a dotted path inside a parsed object (undefined if absent).
function getPathValue(obj, path) {
  let cur = obj;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Write-back orchestration for the settings-field channel. Common and each
// provider patch go through SEPARATE try blocks: one DB hiccup must not
// abort the rest, and — unlike the plugin channel's silent best-effort —
// failures are REPORTED, because the user just explicitly confirmed these
// writes; losing one silently is worse than an error line.
function applySettingsFieldPatches(commonPatch, providerPatches) {
  if (commonPatch && Object.keys(commonPatch).length) {
    try {
      patchCommonConfigClaude(commonPatch);
    } catch (e) {
      process.stderr.write(`\x1b[31m✗ Failed to write common config: ${e.message}\x1b[0m\n`);
    }
  }
  for (const [providerId, patchObj] of Object.entries(providerPatches || {})) {
    if (!patchObj || !Object.keys(patchObj).length) continue;
    try {
      patchProviderSettingsConfig(providerId, "claude", patchObj);
    } catch (e) {
      process.stderr.write(`\x1b[31m✗ Failed to write provider ${providerId} settings: ${e.message}\x1b[0m\n`);
    }
  }
}

// Apply the smart split to one instance's winning changes: a path that
// exists in the parsed common snippet goes to commonPatch (else next prepare
// would overwrite the provider row with common's stale value — the change
// would be lost); everything else goes to this provider's patch. Entries
// already equal to the current DB value are dropped (avoids pointless writes
// and phantom "refreshed" reports).
// Sensitive gate (common direction ONLY): an add/change to a path whose name
// matches isSensitiveConfigPath is refused into commonPatch — it goes
// NOWHERE (not the provider row either: common already owns the key, so the
// next prepare would clobber the provider copy anyway and the "saved" edit
// would silently revert). The edit stays in the instance file; the launch
// guard warns before it is ever overwritten. remove stays allowed: deleting
// a sensitive key FROM common clears a historical leak. providerPatch is
// never gated — provider rows are per-provider secrets by construction.
// Returns { commonPatch, providerPatch, rejected } — rejected carries the
// refused changes so the prompt can say so BEFORE the user confirms.
function splitChangesByTarget(changes, providerId, commonObj, providerSettings) {
  const commonPatch = {};
  const providerPatch = {};
  const rejected = [];
  for (const ch of changes) {
    if (pathExistsInSnippet(commonObj, ch.path)) {
      if (ch.op !== "remove" && isSensitiveConfigPath(ch.path)) {
        rejected.push(ch);
        continue;
      }
      if (!deepEqualJson(getPathValue(commonObj, ch.path), ch.op === "remove" ? undefined : ch.to)) {
        buildNestedAssign(commonPatch, ch.path, ch.op === "remove" ? null : ch.to);
      }
    } else {
      const cur = getPathValue(providerSettings, ch.path);
      if (!deepEqualJson(cur, ch.op === "remove" ? undefined : ch.to)) {
        buildNestedAssign(providerPatch, ch.path, ch.op === "remove" ? null : ch.to);
      }
    }
  }
  return { commonPatch, providerPatch, rejected };
}

// Assign a value at a dotted path inside a patch object, creating
// intermediate objects as needed (inverse of getPathValue for patch
// construction; separate from buildPatchFromChanges because this works on a
// shared, partially-populated patch across changes).
function buildNestedAssign(patch, path, value) {
  const parts = path.split(".");
  let cur = patch;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// List every path of a patch object, INCLUDING intermediate ones: a change's
// path may stop at an object (e.g. an added statusLine), which materializes
// as a nested object in the patch — listing only leaves would yield
// statusLine.type and never match the change's statusLine. Nulls are leaves
// (RFC 7396 removals). Used to tag sync-prompt lines with their write target.
function collectPatchPaths(patch, prefix = "") {
  const out = [];
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    if (v !== null && isPlainObject(v)) out.push(...collectPatchPaths(v, path));
  }
  return out;
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
        // Guard BEFORE prepare overwrites — this refresh path historically
        // wiped other instances' own unsynced edits with zero warning.
        guardClaudeSettingsBeforeOverwrite(adapter, row, instanceDir, commonSnippet);
        adapter.prepare(instanceDir, row.id, settingsConfig, meta, row.category, commonSnippet, settings);
        state.instances[appType][row.id] = buildInstanceBaselineEntry(
          adapter, instanceDir, commonSnippet,
        );
        refreshed.push(row.name);
      } catch {
        // best-effort: keep the old baseline so the drift stays visible.
      }
    }
  }
  return refreshed;
}

// Build one baseline entry for an instance whose config was just (re)generated.
// Shared by recordInstanceBaseline (launch path) and refreshStaleInstances
// (sync path) — both must record the IDENTICAL structure or the two paths'
// drift behavior forks. The snapshot fields are read back from the file
// prepare just wrote, so they are ground truth, not a re-derivation. v3 adds
// preparedSettings (the full parsed settings as handed down) — the basis for
// the overwrite guard and the settings-field sync diff. Adapters without
// readInstanceSettingsSnapshot (codex) record v2-shaped entries and simply
// don't participate in settings-field sync.
function buildInstanceBaselineEntry(adapter, instanceDir, commonSnippet) {
  const entry = { commonHash: sha256(commonSnippet || ""), preparedAt: Date.now() };
  if (adapter.readInstanceSettingsSnapshot) {
    const snap = adapter.readInstanceSettingsSnapshot(instanceDir);
    if (snap) entry.preparedSettings = snap;
  }
  if (adapter.readInstancePluginState) {
    const ep = adapter.readInstancePluginState(instanceDir);
    if (ep) entry.enabledPlugins = ep;
  }
  return entry;
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
    state.instances[adapter.appType][providerId] = buildInstanceBaselineEntry(
      adapter, instanceDir, commonSnippet,
    );
    state.version = 3;
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
  state.version = 3;
}

// Interactive yes/no confirm (TTY only). Returns true on "y", false otherwise.
function confirmSync(lines, question = "Sync these changes?") {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(false);
      return;
    }
    for (const line of lines) process.stderr.write(`  ${line}\n`);
    process.stderr.write(`\n  \x1b[1m${question}\x1b[0m [y/N] `);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (data) => {
      const key = data.toString();
      process.stdin.setRawMode(false);
      process.stdin.removeListener("data", onData);
      // pause() is required, not just removeListener: stdin stays in flowing
      // mode after the earlier resume(), and a flowing stream with no data
      // listeners still READS and DISCARDS tty bytes — the spawned CLI would
      // lose keystrokes. (Masked for years by spawnSync freezing the event
      // loop; surfaced when launch switched to async spawn.)
      process.stdin.pause();
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

  // Channel 2: non-plugin settings fields (claude only, v3 baselines).
  const settingsDrifts = {};
  for (const [cmd, adapter] of Object.entries(APP_ADAPTERS)) {
    if (adapter.detectSettingsDrift) {
      const d = adapter.detectSettingsDrift(state);
      if (d) settingsDrifts[cmd] = d;
    }
  }

  const hasCommon = Object.keys(commonDrift).length > 0;
  const hasPlugin = Object.keys(pluginDrifts).length > 0;
  const hasSettings = Object.keys(settingsDrifts).length > 0;
  if (!hasCommon && !hasPlugin && !hasSettings) return { synced: false, drifted: false };

  if (quiet) return { synced: false, drifted: true };

  // Build the change summary (dedup added/removed vs toggled).
  const lines = [];
  for (const [appType, names] of Object.entries(commonDrift)) {
    lines.push(`\x1b[33mcommon config (${appType})\x1b[0m changed — restart to apply: ${names.join(", ")}`);
  }
  for (const d of Object.values(settingsDrifts)) {
    // Per-instance settings lines, target-tagged so the user knows where each
    // edit lands BEFORE confirming. Only winning paths (the ones in the
    // patches) are shown; mirror-instance noise is already filtered upstream.
    const providerPatchByPath = new Map();
    for (const [pid, patchObj] of Object.entries(d.providerPatches || {})) {
      collectPatchPaths(patchObj, "").forEach((p) => providerPatchByPath.set(p, pid));
    }
    const commonPaths = new Set(collectPatchPaths(d.commonPatch || {}, ""));
    const blockedPaths = new Set(d.rejected || []);
    for (const inst of d.instances) {
      const shown = inst.changes.slice(0, 15);
      for (const ch of shown) {
        const target = blockedPaths.has(ch.path) ? "blocked"
          : commonPaths.has(ch.path) ? "common"
          : providerPatchByPath.has(ch.path) ? "provider" : null;
        if (!target) continue; // losing vote / already equal in DB — not written
        lines.push(formatSettingsChangeLine(ch, target));
      }
      if (inst.changes.length > shown.length) {
        lines.push(`\x1b[2m… and ${inst.changes.length - shown.length} more fields for ${inst.name}\x1b[0m`);
      }
    }
    for (const [path, count] of Object.entries(d.conflicts || {})) {
      lines.push(`\x1b[2m(${count} instances disagree on ${path} — most recent edit wins)\x1b[0m`);
    }
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
    // Settings-field write-back runs AFTER the plugin channel and BEFORE
    // refreshStaleInstances — same ordering constraint as below: the write
    // just changed common_config / provider rows, so every instance the
    // write-back made stale must be refreshed in this same run or the prompt
    // would re-fire.
    for (const [cmd, d] of Object.entries(settingsDrifts)) {
      APP_ADAPTERS[cmd]?.syncSettingsBack?.(d);
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
// onEditParam (CLI layer): `e` on a live Recent row re-enters the param region
//               in edit context — ⏎/2/3 then calls onEditParam(q, hotkey)
//               (q = the quick item; hotkey undefined = Default). Returns
//               non-null on success, null on failure (notice shows the error).
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
  const canEditParam = typeof opts.onEditParam === "function"; // CLI layer `e`
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
    let paramEdit = null; // {q} Recent row being mode-edited — param mode, edit context

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
        const head = paramEdit
          ? `Edit "${paramEdit.q.provider}" · ${permLabel(paramEdit.q.hotkey)} → pick new mode`
          : hotkeys.map((h) => `${h.key} ${h.label}`).join("   ");
        lines.push(`  \x1b[1m\x1b[36m${fit(head, 4)}\x1b[0m`);
        if (paramEdit) {
          lines.push(
            `  \x1b[1m\x1b[36m${fit(hotkeys.map((h) => `${h.key} ${h.label}`).join("   "), 4)}\x1b[0m`,
          );
        }
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
            const flag = q.dead ? `\x1b[31m ✗ missing\x1b[0m` : q.running ? `\x1b[32m ● live\x1b[0m` : "";
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
          if (canEditParam && !quickItems[selected - options.length]?.dead) parts.push("e edit");
          if (canRemove) parts.push("x rm");
        }
        const deadCount = quickItems.filter((q) => q.dead).length;
        if (canCleanup && deadCount > 0) parts.push("c clean");
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
        // Two contexts share the region: launching a highlighted option (the
        // resolve path) and `e` mode-editing a Recent row (the paramEdit path —
        // writes history, refreshes the row, stays in the TUI).
        if (key === "\x1b") {
          mode = "select";
          paramEdit = null;
          render(mode);
          return;
        }
        const hit = hotkeys.find((h) => h.key === key);
        if (hit || key === "\r" || key === "\n") {
          const hk = hit ? hit.key : undefined; // ⏎ = Default
          if (paramEdit) {
            const { q } = paramEdit;
            paramEdit = null;
            mode = "select";
            const ok = opts.onEditParam(q, hk) !== null;
            if (ok) refreshQuickItems();
            render(
              mode,
              ok
                ? `✓ "${q.provider}" → ${permLabel(hk)}${hk === "3" ? " — will confirm before launch" : ""}`
                : `✗ Edit failed (history write error)`,
            );
            return;
          }
          cleanup();
          resolve({ ...options[selected], hotkey: hk });
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
          // Provider layer: a pin used to strand the user back on the select
          // list with no way to pick a launch mode — esc from there discards
          // the selection entirely. Drop straight into the param region
          // instead: the very next keypress (⏎/2/3) launches the pinned pair.
          if (slot && interactive && hasHint) {
            mode = "param";
            render(mode, `✓ Pinned "${pinTarget.label}" to Recent #${slot} — pick launch mode`);
            return;
          }
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
      // `e`: edit the highlighted Recent row's launch mode (param region
      // follows). Dead rows are silently ignored — they can't launch, so a
      // mode is meaningless there.
      if (canEditParam && key === "e" && quickItems.length > 0 && selected >= options.length) {
        const q = quickItems[selected - options.length];
        if (!q.dead) {
          paramEdit = { q };
          mode = "param";
          render(mode);
        }
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
      // pause() is required, not just removeListener: stdin is still in
      // flowing mode from the resume() at entry, and a flowing stream with no
      // data listeners keeps READING tty bytes (discarding them) — the spawned
      // CLI would lose keystrokes. Masked for years by spawnSync freezing the
      // event loop; surfaced when launch switched to async spawn.
      process.stdin.pause();
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
    const runningSet = buildRunningSet();
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
          running: runningSet.has(e.providerId),
        };
      });
    };

    const cli = await tuiSelect("Select CLI tool", cliOptions, {
      quickItems: buildQuickItems(),
      quickPin: true,
      // hotkeys power the `e` mode-edit param region (CLI-layer Enter never
      // enters it: interactive=false), keyed off the same ⏎/2/3 hotkeys the
      // provider layer uses.
      hotkeys: [
        { key: "⏎", label: "Default" },
        { key: "2", label: "Semi-auto" },
        { key: "3", label: "Full-auto ⚠" },
      ],
      onPin: (item, pos) => insertManualOrder(item, pos, aliveByCli),
      onUnpin: (key) => unpinPair(key, aliveByCli),
      onEditParam: (q, hotkey) => setEntryHotkey(q.pairKey, hotkey, q.cli, aliveByCli),
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
  // Guard BEFORE prepare overwrites settings.json — user edits beyond plugins
  // get a warning + backup instead of vanishing silently.
  guardClaudeSettingsBeforeOverwrite(adapter, row, instanceDir, commonSnippet);
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

// ─── switch ps ────────────────────────────────────────────────────────

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d${String(h % 24).padStart(2, "0")}h`;
}

// Live providerIds across all instances — feeds the TUI ● live marker.
// Same per-iteration-snapshot pattern as snapshotAliveByCli. Read-only: any
// session alive marks the provider; cleanup is `runPs`'s job.
function buildRunningSet() {
  const running = new Set();
  for (const inst of collectInstances()) {
    for (const { session } of readSessions(inst.path)) {
      if (sessionIsAlive(session)) { running.add(inst.name); break; }
    }
  }
  return running;
}

// tty → tmux session name, one lookup for the whole `ps` run. Empty map when
// tmux is absent or errors — caller then falls back to the raw tty.
function tmuxSessionByTty() {
  const map = new Map();
  try {
    const r = spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_tty}\t#{session_name}"], { encoding: "utf8" });
    if (r.status !== 0) return map;
    for (const line of (r.stdout || "").split("\n")) {
      // #{pane_tty} reports "/dev/ttysNNN"; ps(1) reports "ttysNNN". Normalize
      // to the ps form so session.tty lookups hit.
      const [tty, session] = line.split("\t");
      if (tty && session) map.set(tty.replace(/^\/dev\//, ""), session);
    }
  } catch {}
  return map;
}

function runPs() {
  const running = [];
  for (const inst of collectInstances()) {
    for (const { path, session } of readSessions(inst.path)) {
      if (sessionIsAlive(session)) {
        running.push({ inst, session });
      } else {
        // A crashed parent (kill -9) leaves no exit event behind — clean up
        // here. Only the dead session's own file, never its siblings.
        try { unlinkSync(path); } catch {}
      }
    }
  }
  if (!running.length) {
    console.log("✓ No running instances");
    return;
  }
  const tmuxByTty = tmuxSessionByTty();
  const home = process.env.HOME;
  const shorten = (p) => (home && p && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const rows = running.map(({ inst, session }) => {
    let name = session.providerId || inst.name;
    try {
      const p = queryProviderById(inst.name, inst.appType);
      if (p?.name) name = p.name;
    } catch {} // dead DB row → fall back to the id
    return {
      cli: inst.appType,
      name,
      tmux: (session.tty && tmuxByTty.get(session.tty)) || session.tty || "-",
      dir: shorten(session.cwd) || "-",
      up: formatDuration(Date.now() - (session.startedAt || Date.now())),
      args: Array.isArray(session.extraArgs) && session.extraArgs.length
        ? ` ${session.extraArgs.join(" ")}`
        : "",
    };
  });
  const w = (xs) => Math.max(...xs.map((x) => x.length), 1);
  const wCli = w(rows.map((r) => r.cli));
  const wName = w(rows.map((r) => r.name));
  const wTmux = w(rows.map((r) => r.tmux));
  const wDir = w(rows.map((r) => r.dir));
  const wUp = w(rows.map((r) => r.up));
  console.log("");
  for (const r of rows) {
    console.log(`  ${r.cli.padEnd(wCli)}  ${r.name.padEnd(wName)}  ${r.tmux.padEnd(wTmux)}  ${r.dir.padEnd(wDir)}  up ${r.up.padEnd(wUp)}  ${r.cli}${r.args}`);
  }
  console.log("");
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
    pruneInstanceSettingsBackups(instances);
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
    pruneInstanceSettingsBackups(instances);
    console.log(`✓ Removed ${instances.length} instance director${instances.length === 1 ? "y" : "ies"}.`);
  } else {
    rmSync(choice.value, { recursive: true, force: true });
    const removed = instances.filter((i) => i.path === choice.value);
    pruneInstanceBaselines(removed);
    pruneInstanceSettingsBackups(removed);
    console.log(`✓ Removed ${choice.value}`);
  }
}

// ─── Instance-only CLAUDE.md (customize / uncustomize) ────────────────

// claude-only: codex instructions (AGENTS.md) work differently.
function findClaudeProviderOrExit(name, usage) {
  if (!name) {
    console.error(usage);
    process.exit(1);
  }
  const row = queryProvider(name, "claude");
  if (!row) {
    console.error(`✗ Provider "${name}" not found (claude)`);
    console.error(`  Available providers:`);
    queryProvidersByApp("claude").forEach((p) => console.error(`    ${p.name}`));
    process.exit(1);
  }
  return row;
}

const instanceClaudeMdPath = (providerId) => join(INSTANCES_DIR, "claude", providerId, "CLAUDE.md");

// First run writes the import template (global CLAUDE.md via @import + an
// instance-only section below) and opens the editor; later runs open the
// existing file directly. The real file survives every later launch because
// ensureSymlink preserves non-symlink files instead of re-linking the shared
// global one.
function runCustomize(args) {
  const row = findClaudeProviderOrExit(args[0], "Usage: switch customize <provider>");
  mkdirSync(join(INSTANCES_DIR, "claude", row.id), { recursive: true });
  const file = instanceClaudeMdPath(row.id);
  const stats = lstatSyncSafe(file);
  if (stats?.isDirectory()) {
    console.error(`✗ ${file} is a directory — refusing to touch it`);
    process.exit(1);
  }
  if (!stats || stats.isSymbolicLink()) {
    const globalMd = join(HOME, ".claude", "CLAUDE.md");
    if (!existsSync(globalMd)) {
      console.error(`⚠ ${globalMd} not found — the @import line will resolve once it exists`);
    }
    atomicWrite(file, [
      `@${globalMd}`,
      "",
      "<!-- ── instance-only instructions (below this line) ── -->",
      "<!-- delete this file to fall back to the shared global CLAUDE.md -->",
      "",
      "",
    ].join("\n"));
  }
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const r = spawnSync(editor, [file], { stdio: "inherit" });
  if (r.error) {
    console.error(`✗ Failed to open editor "${editor}": ${r.error.message}`);
    console.error(`  Edit the file manually: ${file}`);
    process.exit(1);
  }
  console.log(`✓ customized — applies to new sessions`);
  process.exit(0);
}

async function runUncustomize(args) {
  const yes = args.includes("--yes");
  const row = findClaudeProviderOrExit(
    args.find((a) => a !== "--yes"),
    "Usage: switch uncustomize <provider> [--yes]",
  );
  const file = instanceClaudeMdPath(row.id);
  const stats = lstatSyncSafe(file);
  if (!stats) {
    console.log(`not customized (no instance CLAUDE.md)`);
    return;
  }
  if (stats.isSymbolicLink()) {
    console.log(`not customized (CLAUDE.md is the shared global symlink)`);
    return;
  }
  if (stats.isDirectory()) {
    console.error(`✗ ${file} is a directory — refusing to touch it`);
    process.exit(1);
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("✗ uncustomize requires an interactive terminal (or use --yes).");
      process.exit(1);
    }
    const ok = await confirmSync(
      [`Remove instance CLAUDE.md for "${row.name}"?`, `  ${file}`],
      "Remove it?",
    );
    if (!ok) {
      console.error("aborted");
      process.exit(1);
    }
  }
  try {
    unlinkSync(file);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  setupClaudeInstance(row.id); // restore the shared symlink immediately
  console.log(`✓ restored to shared global CLAUDE.md`);
  process.exit(0);
}

function printHelp() {
  console.log(`cc-switch-parallel — launch Claude Code / Codex with per-provider isolated configs

Usage:
  switch                                 Interactive TUI (select CLI, then provider)
  switch <provider> <cmd> [args...]     Launch a provider directly
  switch --sync <provider> <cmd> [...]  Same, but confirm config drift first
  switch --no-sync <provider> <cmd> [...] Same, but suppress the drift warning
  switch sync                           Detect & sync config drift (plugins, settings fields, common config)
  switch doctor                         Diagnose the environment
  switch clean [--all]                  Remove instance directories
  switch ps                             List running switch-launched sessions
  switch customize <provider>           Instance-only CLAUDE.md (opens editor)
  switch uncustomize <provider> [--yes] Back to the shared global CLAUDE.md
  switch update                         Self-update to the latest npm version
  switch -v | --version                 Show version

Commands: ${Object.keys(APP_ADAPTERS).join(", ")}

Examples:
  switch "Claude Official" claude
  switch "Zhipu GLM en" claude --continue
  switch "P&G Nezha" codex`);
}

// ─── Main entry ────────────────────────────────────────────────────────

// A volta-managed install (`volta install <pkg>`) execs this script from
// ~/.volta/tools/image/packages/...; the copy `npm install -g` updates lives
// under image/node/<ver>/lib/ instead, which the volta shim never reads — so
// updating that copy silently does nothing for the shim. Detect it here so
// `switch update` goes through volta itself.
function isVoltaManagedInstall() {
  try {
    return realpathSync(process.argv[1] || "").includes("/.volta/tools/image/packages/");
  } catch {
    return false;
  }
}

// Version actually on disk at the location this install mode executes from.
// The update confirmation reads this — not what npm claimed — so a silent
// partial install can't pass as a success.
function readInstalledVersion() {
  let pkgJsonPath = null;
  if (isVoltaManagedInstall()) {
    pkgJsonPath = join(HOME, ".volta", "tools", "image", "packages", NPM_PACKAGE_NAME,
      "lib", "node_modules", NPM_PACKAGE_NAME, "package.json");
  } else {
    try {
      pkgJsonPath = join(execSync("npm root -g", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(), NPM_PACKAGE_NAME, "package.json");
    } catch {}
  }
  try {
    const v = JSON.parse(readFileSync(pkgJsonPath, "utf8")).version;
    if (typeof v === "string" && v) return v;
  } catch {}
  return null;
}

// Shared tail for both update paths: confirm against what is really on disk,
// and fail loudly (non-zero) when the disk still disagrees.
function reportUpdateOutcome(latestVersion) {
  const installed = readInstalledVersion();
  if (installed === latestVersion) {
    console.log(`✓ Updated to v${latestVersion}`);
    process.exit(0);
  }
  console.error(`⚠ Update command finished, but the install on disk reads v${installed ?? "unknown"} — restart your terminal and run \`switch update\` again if it still shows the old version.`);
  process.exit(1);
}

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

  if (isVoltaManagedInstall()) {
    const r = spawnSync("volta", ["install", `${NPM_PACKAGE_NAME}@latest`], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`✗ Update failed — try running \`volta install ${NPM_PACKAGE_NAME}@latest\` manually.`);
      process.exit(r.status || 1);
    }
    reportUpdateOutcome(latestVersion);
  }

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
  reportUpdateOutcome(latestVersion);
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

  if (args[0] === "ps") {
    runPs();
    return;
  }

  if (args[0] === "customize") {
    runCustomize(args.slice(1));
    return;
  }

  if (args[0] === "uncustomize") {
    await runUncustomize(args.slice(1));
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

// ─── CLI entry ─────────────────────────────────────────────────────────
// Guarded so test/*.test.mjs can import this file as a plain ESM module:
// `node --test` imports it with CC_LAUNCH_SKIP_MAIN set, and the top level
// is side-effect-free apart from main() itself.
if (!process.env.CC_LAUNCH_SKIP_MAIN) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}

// Test-only export surface. A static export costs nothing at CLI runtime;
// the bag stays frozen so callers can't reach into the module's internals.
export const __test = Object.freeze({
  mergeCommonOverProvider,
  jsonDeepMerge,
  deepEqualJson,
  isSensitiveConfigKey,
  isSensitiveConfigPath,
  splitChangesByTarget,
  pathExistsInSnippet,
});
