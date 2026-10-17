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
  chmodSync,
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
// Owned by this CLI alone (the desktop app owns settings.json and may
// rewrite providers.meta) — TUI-set statusline tag colors live here.
const STATUSLINE_PREFS_PATH = join(CC_SWITCH_DIR, "statusline-preferences.json");
const STATUSLINE_PREFS_VERSION = 1;

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
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const order = normalizeOrder(data?.order);
    // Heal files written before one-shot flags were stripped at record time:
    // an already-poisoned quick-launch row cures itself on the next load
    // instead of replaying `claude --version` forever. Same concurrent-write
    // narrowing as the migration below — persist only if the file is still v2.
    if (healRecordedArgs(entries)) {
      try {
        const cur = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
        if (cur?.version === HISTORY_VERSION) saveHistory(entries, order);
      } catch {
        // unreadable or racing another process — heal in memory only; the
        // next recordLaunch persists the clean argv anyway
      }
    }
    return { entries, order };
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

// ─── Statusline tag colors (TUI preference) ────────────────────────────
// The wrapper's provider tag color: "auto" (FNV-1a by name, the default) or
// one of the ANSI classic codes 30-37 / 90-97. Stored per provider ID (a
// rename keeps the color, same semantics as launch_history) in a file this
// CLI owns exclusively. Every read path fails open to "auto" — a corrupt or
// missing file must never change what prepare writes differently between
// its two callers (prepare and the guard's computeEffectiveSettings).

const STATUSLINE_COLOR_CHOICES = [
  { value: "auto", label: "auto — hash by name", swatch: "\x1b[90m" },
  { value: "30", label: "black", swatch: "\x1b[30m" },
  { value: "31", label: "red", swatch: "\x1b[31m" },
  { value: "32", label: "green", swatch: "\x1b[32m" },
  { value: "33", label: "yellow", swatch: "\x1b[33m" },
  { value: "34", label: "blue", swatch: "\x1b[34m" },
  { value: "35", label: "magenta", swatch: "\x1b[35m" },
  { value: "36", label: "cyan", swatch: "\x1b[36m" },
  { value: "37", label: "white", swatch: "\x1b[37m" },
  { value: "90", label: "bright black (gray)", swatch: "\x1b[90m" },
  { value: "91", label: "bright red", swatch: "\x1b[91m" },
  { value: "92", label: "bright green", swatch: "\x1b[92m" },
  { value: "93", label: "bright yellow", swatch: "\x1b[93m" },
  { value: "94", label: "bright blue", swatch: "\x1b[94m" },
  { value: "95", label: "bright magenta", swatch: "\x1b[95m" },
  { value: "96", label: "bright cyan", swatch: "\x1b[96m" },
  { value: "97", label: "bright white", swatch: "\x1b[97m" },
];

function isValidStatuslineColor(v) {
  return typeof v === "string"
    && (v === "auto" || /^(3[0-7]|9[0-7])$/.test(v));
}

function loadStatuslinePreferences() {
  try {
    const prefs = JSON.parse(readFileSync(STATUSLINE_PREFS_PATH, "utf8"));
    if (prefs?.version !== STATUSLINE_PREFS_VERSION || !isPlainObject(prefs.colors)) return null;
    return prefs;
  } catch {
    return null;
  }
}

function statuslineColorFor(cli, providerId) {
  try {
    const v = loadStatuslinePreferences()?.colors?.[cli]?.[providerId];
    return isValidStatuslineColor(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

function saveStatuslineColor(cli, providerId, value) {
  if (!isValidStatuslineColor(value)) return null;
  try {
    const prefs = loadStatuslinePreferences() || { version: STATUSLINE_PREFS_VERSION, colors: {} };
    prefs.version = STATUSLINE_PREFS_VERSION;
    prefs.colors = isPlainObject(prefs.colors) ? prefs.colors : {};
    prefs.colors[cli] = isPlainObject(prefs.colors[cli]) ? prefs.colors[cli] : {};
    if (value === "auto") {
      delete prefs.colors[cli][providerId]; // auto is the default — store nothing
    } else {
      prefs.colors[cli][providerId] = value;
    }
    atomicWrite(STATUSLINE_PREFS_PATH, JSON.stringify(prefs, null, 2));
    return value;
  } catch {
    return null;
  }
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

// One-shot informational flags must never enter launch history: replaying
// `claude --version` prints and exits — the CLI never opens — and every replay
// re-records the flag, so one accidental `switch <p> claude --version` turns
// the quick-launch row into a permanently version-printing entry (a real
// history file showed such a row at count 56). Stripped at the single history
// write point (recordLaunch) and healed on load for files written before.
const ONE_SHOT_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h"]);

// Raw launch argv → the argv worth replaying. Non-arrays normalize to the
// empty-array form every recordLaunch write site expects.
function stripOneShotFlags(args) {
  if (!Array.isArray(args)) return [];
  return args.filter((a) => !ONE_SHOT_FLAGS.has(a));
}

// In-place heal of loaded entries; returns true when anything changed.
function healRecordedArgs(entries) {
  let dirty = false;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!Array.isArray(e?.extraArgs) || e.extraArgs.length === 0) continue;
    const cleaned = stripOneShotFlags(e.extraArgs);
    if (cleaned.length !== e.extraArgs.length) {
      e.extraArgs = cleaned;
      dirty = true;
    }
  }
  return dirty;
}

// Pins are persistent: only an explicit unpin (or removing the pair) releases
// a slot — a real launch never does. Launches update count/lastUsed/extraArgs
// and follow renames so the stored display name never goes stale.
function recordLaunch(cli, providerId, providerName, hotkey, extraArgs) {
  if (_historyFrozen) return;
  try {
    const { entries, order } = loadHistory();
    const now = Date.now();
    const stored = stripOneShotFlags(extraArgs);
    const hit = entries.find((e) => e.providerId === providerId && e.cli === cli && `${e.hotkey ?? ""}` === `${hotkey ?? ""}`);
    if (hit) {
      hit.count = (hit.count || 0) + 1;
      hit.lastUsed = now;
      hit.provider = providerName;
      hit.extraArgs = stored;
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
        ph.extraArgs = stored;
      } else {
        entries.push({
          cli, providerId, provider: providerName, hotkey: hotkey ?? null,
          extraArgs: stored, count: 1, lastUsed: now,
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

// JSON round-trip normalizer for cross-parse comparisons. smol-toml can
// produce Date/NaN instances; two parse calls of the SAME text yield
// structurally equal but reference-distinct values, and deepEqualJson's
// `===` leaf check would call them unequal — a full false-drift. Round-
// tripping BOTH sides (snapshot and recomputed baseline) through this
// makes equality deterministic: Date → ISO string, NaN/Infinity → null,
// top-level undefined → null. Circular structures throw → null (a corrupt
// document is "no snapshot", never a drift report).
function jsonNormalize(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

// True RFC 7396 merge-patch application — the thing jsonDeepMerge above
// deliberately is NOT (it drops the recursive return value in the `key in
// target` branch, so a null never deletes). Contract: non-object patch →
// whole-value replace; object patch → null deletes the key, plain objects
// recurse, everything else (arrays included — they are scalars under
// 7396) overwrites. Mutates target and returns it, like jsonDeepMerge.
// Used by the TOML write-back path; jsonDeepMerge keeps its own
// target-wins contract for providerPatches accumulation — two functions,
// two contracts, kept separate on purpose.
function applyMergePatch(target, patch) {
  if (!isPlainObject(patch)) return jsonDeepClone(patch ?? null);
  if (!isPlainObject(target)) target = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
    } else if (isPlainObject(value)) {
      target[key] = applyMergePatch(isPlainObject(target[key]) ? target[key] : {}, value);
    } else {
      target[key] = jsonDeepClone(value);
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
// NO removal folding here: folded subtree removes once made "delete one key"
// read as "delete the whole parent" — a folded {env:null} patch wiped every
// SIBLING the user never touched from common_config (unrecoverable: the
// overwrite-guard backup only covers instance files, not the DB row), and
// the folded parent path also bypassed the sensitive-key gate. Diffing stays
// per-leaf; empty-husk prevention moved to foldAllNullSubtrees at patch
// build time.
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

// Codex write-back core (pure): apply an RFC 7396 patch to a TOML document
// IN TEXT form — parse, patch, re-serialize. The re-serialization loses
// comments and reorders keys; that cost is accepted and documented at the
// confirmation prompt, because no format-preserving TOML editor exists in
// the JS ecosystem and this is a single-file CLI. Throws on parse failure —
// the DB write-back shells let that surface as a reported error, never a
// silent partial write.
function applyTomlPatchText(tomlText, patchObj) {
  return stringifyToml(applyMergePatch(parseToml(tomlText || ""), jsonDeepClone(patchObj)));
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

// providerName/providerId: when both are given, the effective settings get
// the instance statusline injected (see applyStatusLineInjection). prepare()
// and the guard's computeEffectiveSettings [C3] MUST pass the same pair —
// C3 exists to recompute exactly what prepare would write, and a fork
// between the two derivations makes the overwrite guard misfire.
function buildClaudeEffectiveSettings(settingsConfig, meta, commonSnippet, providerName, providerId) {
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
  effective = sanitizeClaudeSettings(effective);
  if (providerName !== undefined && providerId !== undefined) {
    applyStatusLineInjection(effective, providerName, providerId, settingsConfig, meta);
  }
  return effective;
}

// ─── Instance statusline (claude) ──────────────────────────────────────
// Every prepared instance settings.json carries a generated statusLine whose
// command is a per-instance wrapper script. The wrapper prints the provider
// name first, then relays whatever the user's GLOBAL statusLine (~/.claude/
// settings.json — claude-hud, ccstatusline, anything) renders, passing the
// statusline JSON from Claude Code through untouched. The global tool stays
// the single source of truth for how the rest of the line looks; the provider
// tag is the only thing switch adds.
//
// The injection lives ONLY in the instance copy: the wrapper script is
// written into the instance dir and the statusLine entry is regenerated on
// every prepare — it is never written back into the cc-switch DB, because
// statusLine is a channel-owned path (isStatusLineChannelPath): the overwrite
// guard ignores it and the upward settings sync yields it, exactly like the
// plugin channel.

const STATUSLINE_WRAPPER_FILENAME = "statusline-wrapper.mjs";

// [C6 for the statusline channel] — the settings-field sync and the
// overwrite guard must neither report nor vote on this subtree.
function isStatusLineChannelPath(path) {
  return path === "statusLine" || path.startsWith("statusLine.");
}

function claudeProviderName(providerId) {
  try {
    return queryProviderById(providerId, "claude")?.name || providerId;
  } catch {
    return providerId; // DB hiccup — the id still identifies the instance
  }
}

// Single-quote for /bin/sh; paths only ever get safer under this.
function shQuote(path) {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function buildStatusLineWrapperScript(providerName, globalSettingsPath, relayCommand, colorCode = "auto", usageConfig = null) {
  return [
    `#!/usr/bin/env node`,
    `// Generated by cc-switch-parallel — do not edit; regenerated on every launch.`,
    `// Instance statusline: prints the provider name, then relays the user's`,
    `// statusline tool (claude-hud, ccstatusline, …) after it, passing the`,
    `// statusline JSON from Claude Code through untouched.`,
    `import { spawnSync } from "node:child_process";`,
    `import { readFileSync } from "node:fs";`,
    `const PROVIDER = ${JSON.stringify(providerName)};`,
    `const SELF_MARKER = ${JSON.stringify(STATUSLINE_WRAPPER_FILENAME)};`,
    `const GLOBAL_SETTINGS = ${JSON.stringify(globalSettingsPath)};`,
    `// Explicit statusLine from the cc-switch config (inlined at generation`,
    `// time) — takes precedence over the global settings.json fallback.`,
    `const RELAY_COMMAND = ${JSON.stringify(relayCommand || null)};`,
    `// Tag color: "auto" hashes the provider name (FNV-1a over the bright`,
    `// palette); any ANSI classic code (30-37 / 90-97) is used verbatim.`,
    `const COLOR = ${JSON.stringify(isValidStatuslineColor(colorCode) ? colorCode : "auto")};`,
    ``,
    `const PALETTE = [96, 92, 93, 95, 94, 91];`,
    `let hash = 2166136261;`,
    `for (const ch of PROVIDER) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }`,
    `const code = COLOR === "auto" ? PALETTE[hash % PALETTE.length] : parseInt(COLOR, 10);`,
    `const tag = "\\x1b[1m\\x1b[" + code + "m[" + PROVIDER + "]\\x1b[0m";`,
    ``,
    `let input = "";`,
    `try { input = readFileSync(0, "utf8"); } catch {}`,
    ``,
    `// Relay the user's statusline: the inlined RELAY_COMMAND (from the`,
    `// cc-switch config) wins; otherwise fall back to the global`,
    `// ~/.claude/settings.json — and never relay this wrapper itself (loop`,
    `// guard).`,
    `let relayed = "";`,
    `try {`,
    `  let cmd = RELAY_COMMAND || "";`,
    `  if (!cmd) {`,
    `    const sl = JSON.parse(readFileSync(GLOBAL_SETTINGS, "utf8")).statusLine;`,
    `    cmd = sl && sl.type === "command" && typeof sl.command === "string" ? sl.command.trim() : "";`,
    `  }`,
    `  if (cmd && !cmd.includes(SELF_MARKER)) {`,
    `    const r = spawnSync("/bin/sh", ["-c", cmd], { input, encoding: "utf8", timeout: 4000 });`,
    `    if (r.stdout && r.stdout.trim()) relayed = r.stdout;`,
    `  }`,
    `} catch {}`,
    ``,
    `// Placement: when the relayed line LEADS with the model indicator (e.g.`,
    `// claude-hud's "[Opus] │ …", possibly behind its own ANSI codes or`,
    `// leading indent), glue the tag in front of it — [provider][model]. The`,
    `// lead check runs on an ANSI-stripped view and walks back over ALL`,
    `// non-alphanumeric characters, so indent or codes before the "[" don't`,
    `// break it; a mid-line model stops at the preceding word and falls back.`,
    `// Anywhere else the tag sits at the start of the line with a space —`,
    `// visible first, never mangling the relayed text.`,
    `let dn = "";`,
    `try { dn = JSON.parse(input)?.model?.display_name || ""; } catch {}`,
    ``,
    `const lines = relayed.replace(/\\n+$/, "").split("\\n");`,
    `const line0 = lines[0] || "";`,
    `let glue = false;`,
    `if (line0 && dn) {`,
    `  const text = line0.replace(/\\x1b\\[[0-9;]*m/g, "");`,
    `  const i = text.indexOf(dn);`,
    `  if (i > 0) {`,
    `    let j = i;`,
    `    while (j > 0 && !/[0-9A-Za-z]/.test(text[j - 1])) j--;`,
    `    glue = j === 0;`,
    `  }`,
    `}`,
    // With a resolved usage identity the whole tail — imports, usage
    // runtime, and line composition — comes from buildUsageWrapperLines;
    // without one, these four lines are byte-identical to the pre-usage
    // wrapper (a hard guarantee the tests assert on).
    ...(usageConfig ? buildUsageWrapperLines(usageConfig) : [
      `const first = glue`,
      `  ? tag + line0.replace(/^\\s+/, "") // drop the relay's leading indent`,
      `  : tag + (line0 ? " " + line0 : "");`,
      `process.stdout.write([first].concat(lines.slice(1)).join("\\n") + "\\n");`,
    ]),
  ].join("\n");
}

// Tail of the wrapper script when a usage identity was resolved: the USAGE
// runtime (cache read/write, fetch, parse, claude-hud-style rendering,
// context-segment insertion) plus the usage-aware composition of the first
// line. Runs cache-first with stale-while-revalidate: a fresh TTL hit renders
// with zero network, a stale cache renders last-known values while a
// detached self-spawn refreshes in the background, and only the very first
// render (no cache at all) pays one short sync fetch — failures stay silent
// and leave the statusline byte-identical to the no-usage shape.
function buildUsageWrapperLines(usageConfig) {
  return [
    `// ─── Provider usage segment (generated by cc-switch-parallel) ────────`,
    `import { spawn } from "node:child_process";`,
    `import { writeFileSync, renameSync } from "node:fs";`,
    `const USAGE = ${JSON.stringify(usageConfig)};`,
    ``,
    `function usageReadCache() {`,
    `  try {`,
    `    const c = JSON.parse(readFileSync(USAGE.cachePath, "utf8"));`,
    `    if (c && c.v === 1 && c.data && c.data.kind === USAGE.kind) return c;`,
    `  } catch {}`,
    `  return null;`,
    `}`,
    ``,
    `// tmp + rename, mirroring the launcher's atomicWrite; racy double-writes`,
    `// from overlapping renders are harmless (equivalent content).`,
    `function usageWriteCache(fields) {`,
    `  try {`,
    `    let cur = {};`,
    `    try { cur = JSON.parse(readFileSync(USAGE.cachePath, "utf8")) || {}; } catch {}`,
    `    const merged = { v: 1, ts: 0, refreshTs: 0, errTs: 0, data: null, ...cur, ...fields };`,
    `    const tmp = USAGE.cachePath + ".tmp";`,
    `    writeFileSync(tmp, JSON.stringify(merged));`,
    `    renameSync(tmp, USAGE.cachePath);`,
    `  } catch {}`,
    `}`,
    ``,
    `function usageParse(body) {`,
    `  try {`,
    `    if (USAGE.kind === "zhipu") {`,
    `      if (body && body.success === false) return null; // business-level error (e.g. code 401 token rejected)`,
    `      // zhipu wraps the payload: {"code":200,"data":{"limits":[...]}}`,
    `      const payload = body && body.data && typeof body.data === "object" ? body.data : body;`,
    `      const limits = Array.isArray(payload && payload.limits) ? payload.limits : [];`,
    `      const pct = (l) => Math.max(0, Math.min(100, Math.round(Number(l && l.percentage) || 0)));`,
    `      let five = null;`,
    `      let weekly = null;`,
    `      for (const l of limits) {`,
    `        if (!l || l.type !== "TOKENS_LIMIT") continue;`,
    `        if (l.unit === 3 && l.number === 5) five = pct(l);`,
    `        else if (l.unit === 6 && l.number === 1) weekly = pct(l);`,
    `      }`,
    `      if (five === null) return null;`,
    `      return { kind: "zhipu", fiveH: five, weekly };`,
    `    }`,
    `    if (USAGE.kind === "deepseek") {`,
    `      const infos = Array.isArray(body && body.balance_infos) ? body.balance_infos : [];`,
    `      const info = infos[0];`,
    `      const bal = info && typeof info.total_balance === "string" ? info.total_balance.trim() : "";`,
    `      if (!bal) return null;`,
    `      const currency = info.currency || "";`,
    `      const sym = { USD: "$", CNY: "¥" }[currency] || "";`,
    `      return { kind: "deepseek", balance: bal, currency, sym };`,
    `    }`,
    `  } catch {}`,
    `  return null;`,
    `}`,
    ``,
    `async function usageFetch(timeoutMs) {`,
    `  try {`,
    `    const headers = { "Content-Type": "application/json" };`,
    `    headers.Authorization = USAGE.authStyle === "bearer" ? "Bearer " + USAGE.token : USAGE.token;`,
    `    if (USAGE.kind === "zhipu") headers["Accept-Language"] = "en-US,en";`,
    `    const res = await fetch(USAGE.url, { headers, signal: AbortSignal.timeout(timeoutMs) });`,
    `    if (!res.ok) return null;`,
    `    return usageParse(await res.json());`,
    `  } catch {}`,
    `  return null;`,
    `}`,
    ``,
    `function usageBar(pct, width) {`,
    `  const w = Math.max(3, Math.min(20, width));`,
    `  const fill = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));`,
    `  return "█".repeat(fill) + "░".repeat(w - fill);`,
    `}`,
    ``,
    `// claude-hud bar style: "5h ███░░░ 40% · W ████░░ 52%" / deepseek "[$12.34]".`,
    `// Fill color thresholds: <70 green, 70-89 yellow, >=90 red; the bar width`,
    `// follows the relay line's own context bar when one is present.`,
    `function usageSegmentText(data, relayLine) {`,
    `  const dim = "\\x1b[2m";`,
    `  const off = "\\x1b[0m";`,
    `  let width = 6;`,
    `  const bar = (relayLine || "").replace(/\\x1b\\[[0-9;]*m/g, "").match(/[█▓▒░]{3,}/);`,
    `  if (bar) width = bar[0].length;`,
    `  if (data.kind === "zhipu") {`,
    `    const color = (p) => (p >= 90 ? "\\x1b[91m" : p >= 70 ? "\\x1b[93m" : "\\x1b[32m");`,
    `    const cell = (label, p) => dim + label + " " + off + color(p) + usageBar(p, width) + off + dim + " " + p + "%" + off;`,
    `    let t = cell("5h", data.fiveH);`,
    `    if (data.weekly !== null && data.weekly !== undefined) t += dim + " · " + off + cell("W", data.weekly);`,
    `    return t;`,
    `  }`,
    `  if (data.kind === "deepseek") {`,
    `    const amount = data.sym ? data.sym + data.balance : data.balance + (data.currency ? " " + data.currency : "");`,
    `    return dim + "[" + off + "\\x1b[97m" + amount + off + dim + "]" + off;`,
    `  }`,
    `  return "";`,
    `}`,
    ``,
    `// Splice the usage segment after the relay line's context segment.`,
    `// claude-hud joins segments with " │ " (some tools use "|"); the split`,
    `// keeps the separators so the original spacing survives, and the usage`,
    `// cell reuses the separator style of the line it lands in.`,
    `const USAGE_CONTEXT_RE = /(context|ctx|上下文)/i;`,
    `function usageInsertIntoLine(line, usageText) {`,
    `  const strippedOf = (s) => s.replace(/\\x1b\\[[0-9;]*m/g, "");`,
    `  for (const sep of ["│", "|"]) {`,
    `    if (!line.includes(sep)) continue;`,
    `    const parts = line.split(new RegExp("(" + (sep === "|" ? "\\\\|" : sep) + ")"));`,
    `    for (let i = 0; i < parts.length; i += 2) {`,
    `      if (USAGE_CONTEXT_RE.test(strippedOf(parts[i]))) {`,
    `        parts.splice(i + 2, 0, " " + usageText + " ", parts[i + 1] || sep);`,
    `        return parts.join("");`,
    `      }`,
    `    }`,
    `  }`,
    `  return "";`,
    `}`,
    ``,
    `let usageData = null;`,
    `if (process.env.CC_LAUNCH_USAGE_REFRESH === "1") {`,
    `  // Detached refresh mode: fetch with the long timeout, persist, exit.`,
    `  const ok = await usageFetch(USAGE.refreshTimeoutMs);`,
    `  usageWriteCache(ok`,
    `    ? { ts: Date.now(), refreshTs: Date.now(), errTs: 0, data: ok }`,
    `    : { refreshTs: Date.now(), errTs: Date.now() });`,
    `  process.exit(0);`,
    `}`,
    `{`,
    `  const now = Date.now();`,
    `  const cache = usageReadCache();`,
    `  const fresh = cache && now - cache.ts < USAGE.ttlMs;`,
    `  const backedOff = !!(cache && cache.errTs && now - cache.errTs < USAGE.errorBackoffMs);`,
    `  if (fresh) usageData = cache.data;`,
    `  else if (cache) {`,
    `    usageData = cache.data; // stale — show last known, refresh in background`,
    `    if (!backedOff && (!cache.refreshTs || now - cache.refreshTs > USAGE.refreshDedupMs)) {`,
    `      usageWriteCache({ refreshTs: now });`,
    `      try {`,
    `        spawn(process.execPath, [USAGE.selfPath], {`,
    `          detached: true,`,
    `          stdio: "ignore",`,
    `          env: { ...process.env, CC_LAUNCH_USAGE_REFRESH: "1" },`,
    `        }).unref();`,
    `      } catch {}`,
    `    }`,
    `  } else if (!backedOff) {`,
    `    usageData = await usageFetch(USAGE.syncTimeoutMs);`,
    `    if (usageData) usageWriteCache({ ts: now, refreshTs: now, data: usageData });`,
    `    else usageWriteCache({ refreshTs: now, errTs: now });`,
    `  }`,
    `}`,
    `const usageText = usageData ? usageSegmentText(usageData, line0) : "";`,
    `let l0 = line0;`,
    `if (usageText && l0) {`,
    `  const inserted = usageInsertIntoLine(l0, usageText);`,
    `  l0 = inserted || (l0 + (l0.includes("│") ? " │ " : " | ") + usageText);`,
    `}`,
    `const first = !line0 && usageText`,
    `  ? tag + " " + usageText`,
    `  : glue`,
    `    ? tag + l0.replace(/^\\s+/, "") // drop the relay's leading indent`,
    `    : tag + (l0 ? " " + l0 : "");`,
    `process.stdout.write([first].concat(lines.slice(1)).join("\\n") + "\\n");`,
  ];
}

// Regenerate the wrapper script + statusLine entry inside `effective`.
// instanceDir is re-derived from providerId (same expression as
// setupClaudeInstance) because the guard's computeEffectiveSettings [C3]
// path has no instanceDir argument — both call sites must land on the same
// wrapper path for the derivations to compare equal. settingsConfig and
// meta feed the usage identity the same way: both call sites pass the
// provider's own values, so the generated wrapper stays identical on both
// paths, and settings.json itself stays usage-blind.
function applyStatusLineInjection(effective, providerName, providerId, settingsConfig, meta) {
  try {
    const instanceDir = join(INSTANCES_DIR, "claude", providerId);
    const wrapperPath = join(instanceDir, STATUSLINE_WRAPPER_FILENAME);
    const existing = effective.statusLine;
    // An explicit statusLine in the provider/common config is not a reason
    // to skip the injection — it becomes the wrapper's preferred relay
    // source (inlined at generation time), so deliberate configuration
    // keeps rendering while the provider tag is still added. Only a command
    // that IS the wrapper (a previous injection) relays nothing extra.
    let relayCommand = null;
    if (
      isPlainObject(existing) &&
      typeof existing.command === "string" && existing.command.trim() &&
      !existing.command.includes(STATUSLINE_WRAPPER_FILENAME)
    ) relayCommand = existing.command;
    mkdirSync(instanceDir, { recursive: true });
    // Tag color comes from the TUI preference file (fail-open "auto"). It is
    // inlined into the WRAPPER's content only — never into settings.json —
    // so the guard/baseline comparison of settings.json cannot see it and
    // prepare vs computeEffectiveSettings stay identical by construction.
    const colorCode = statuslineColorFor("claude", providerId);
    // Same channel for usage: resolved from the provider's own
    // settings_config + meta, inlined into the wrapper only. A throw here
    // (shouldn't happen — resolution is guarded) means no usage segment,
    // never a failed injection.
    let usageConfig = null;
    try {
      usageConfig = buildUsageQueryConfig(
        resolveUsageIdentity(settingsConfig, meta),
        join(instanceDir, USAGE_CACHE_FILENAME),
        wrapperPath,
      );
    } catch {}
    atomicWrite(wrapperPath, buildStatusLineWrapperScript(providerName, join(HOME, ".claude", "settings.json"), relayCommand, colorCode, usageConfig) + "\n");
    try { chmodSync(wrapperPath, 0o755); } catch {}
    // Keep display-related fields the user tuned (refreshInterval, padding)
    // when upgrading a previous injection; drop nothing else.
    effective.statusLine = {
      ...(isPlainObject(existing) ? existing : {}),
      type: "command",
      command: `${shQuote(process.execPath)} ${shQuote(wrapperPath)}`,
    };
  } catch {
    // best-effort: a failed injection leaves the config untouched — the
    // next launch retries. Never block a launch over a statusline.
  }
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

// ─── Provider usage snapshot (app-agnostic, statusline) ───────────────
// Optional usage segment for the instance statusline wrapper: zhipu/zai
// coding-plan quota (5h + weekly) and DeepSeek balance, rendered in the
// claude-hud bar style. Identity is resolved from the provider's OWN
// settings_config — never the common-config-merged effective.env, because
// the usage API must be queried with the provider's own token even when a
// common snippet overrides the base URL — plus the upstream desktop app's
// meta.usage_script marker, falling back to base-url host matching. The
// provider NAME never participates: it is free-form user text.
//
// Everything here is app-agnostic (inputs are {baseUrl, token, meta}-shaped
// data), so a future Codex extractor can feed the same pipeline. Codex has
// no in-TUI statusline hook today (openai/codex#17827); its interim tmux
// channel consumes CC_SWITCH_PROVIDER_ID instead (see CLAUDE.md).
//
// Safety: the resolved token is inlined into the instance-dir wrapper — the
// same directory and exposure surface as the instance settings.json, which
// already carries it — and the usage cache never contains the token. All
// usage state lives in the WRAPPER's content and the cache file;
// settings.json stays usage-blind, so the C3 prepare/guard baseline is
// untouched by construction.

const USAGE_CACHE_FILENAME = "usage-cache.json";

// Host-suffix matchers, shared vocabulary with the desktop app's
// codingPlanProviders routing table (zhipu = api.z.ai | bigmodel.cn).
const USAGE_HOST_MATCHERS = [
  { suffix: "api.z.ai", kind: "zhipu" },
  { suffix: "bigmodel.cn", kind: "zhipu" },
  { suffix: "api.deepseek.com", kind: "deepseek" },
];

// zhipu uses Bearer here even though the upstream desktop app sends the raw
// key (comment "智谱不加 Bearer 前缀"): as of 2026-10 api.z.ai answers a bare
// Authorization with HTTP 200 + {"code":401,"success":false} and only accepts
// Bearer — verified against a live coding-plan key. bigmodel.cn untested; if
// it ever needs bare, move authStyle into USAGE_HOST_MATCHERS per host.
const USAGE_AUTH_STYLE = { zhipu: "bearer", deepseek: "bearer" };

// {baseUrl, token} out of a Claude provider settings_config; null when
// either is missing (no creds → no usage segment).
function extractClaudeUsageSource(settingsConfig) {
  const env = isPlainObject(settingsConfig) && isPlainObject(settingsConfig.env) ? settingsConfig.env : null;
  if (!env) return null;
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL.trim() : "";
  const token = typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN.trim()
    ? env.ANTHROPIC_AUTH_TOKEN.trim()
    : typeof env.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.trim() : "";
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

// Query endpoint for a kind, derived from the provider's own base-url
// origin (https://api.z.ai/api/anthropic → https://api.z.ai/api/monitor/…;
// https://api.deepseek.com/anthropic → https://api.deepseek.com/user/balance).
function usageEndpointFor(kind, baseUrl) {
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { return null; }
  if (origin !== "null" && !/^https?:\/\//.test(origin)) return null;
  if (kind === "zhipu") return origin + "/api/monitor/usage/quota/limit";
  if (kind === "deepseek") return origin + "/user/balance";
  return null;
}

// Resolve the usage identity for a provider; null = no usage segment.
// Resolution order: explicit meta marker first (upstream desktop app writes
// codingPlanProvider), then host-suffix matching. An unknown explicit value
// never guesses — it falls through to host matching. meta.usage_script with
// enabled === false is an explicit opt-out; a non-empty custom `code` means
// the desktop app runs user JS we cannot replicate, so we stay out.
function resolveUsageIdentity(settingsConfig, meta) {
  const usage = isPlainObject(meta) && isPlainObject(meta.usage_script) ? meta.usage_script : null;
  if (usage) {
    if (usage.enabled === false) return null;
    if (typeof usage.code === "string" && usage.code.trim()) return null;
  }
  const source = extractClaudeUsageSource(settingsConfig);
  if (!source) return null;
  let host = "";
  try { host = new URL(source.baseUrl).hostname.toLowerCase(); } catch { return null; }
  const matched = USAGE_HOST_MATCHERS.find((m) => host === m.suffix || host.endsWith("." + m.suffix));
  const explicit = usage && typeof usage.codingPlanProvider === "string" ? usage.codingPlanProvider.trim().toLowerCase() : "";
  const kind = (explicit && USAGE_AUTH_STYLE[explicit] ? explicit : "") || (matched ? matched.kind : "");
  if (!kind) return null;
  const endpoint = usageEndpointFor(kind, source.baseUrl);
  if (!endpoint) return null;
  const intervalRaw = Number(usage && usage.autoQueryInterval);
  const intervalMin = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? Math.min(Math.round(intervalRaw), 60) : 5;
  return { kind, baseUrl: source.baseUrl, token: source.token, authStyle: USAGE_AUTH_STYLE[kind], intervalMin, endpoint };
}

// Serializable runtime config inlined into the wrapper. Deterministic in
// (identity, cachePath, selfPath) — prepare and the guard's
// computeEffectiveSettings get the same inputs, so the generated wrapper is
// identical on both paths [C3].
function buildUsageQueryConfig(identity, cachePath, selfPath) {
  if (!identity) return null;
  return {
    kind: identity.kind,
    url: identity.endpoint,
    token: identity.token,
    authStyle: identity.authStyle,
    ttlMs: identity.intervalMin * 60_000,
    cachePath,
    selfPath,
    syncTimeoutMs: 1500,
    refreshTimeoutMs: 8000,
    errorBackoffMs: 60_000,
    refreshDedupMs: 15_000,
  };
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

// Codex's native TUI status line ([tui] status_line in config.toml, Codex CLI
// ≥ 0.105.0) only selects from built-in items — there is no external-command
// rendering (upstream openai/codex#17827), so no provider tag is possible
// here. What switch guarantees is that the status line is ON with useful
// items. Fill-if-absent: explicit values in the provider/common TOML win
// (the item set is a fixed enum, so unlike claude's statusLine there is no
// relay wrapper that could honor user config AND add a tag — user values
// must take precedence); `status_line = []` opts out entirely.
const CODEX_STATUS_LINE_ITEMS = ["model-with-reasoning", "current-dir"];

function applyCodexStatusLineInjection(configObj) {
  const tui = isPlainObject(configObj.tui) ? configObj.tui : (configObj.tui = {});
  if (tui.status_line === undefined) tui.status_line = [...CODEX_STATUS_LINE_ITEMS];
  if (tui.status_line_use_colors === undefined) tui.status_line_use_colors = true;
  return configObj;
}

// [C6 for the codex statusline channel] — the settings-field sync and the
// overwrite guard must neither report nor vote on this subtree. Exact match +
// dotted-suffix (never a bare "tui." prefix) so the user's own [tui] keys
// (notifications, terminal_title, …) keep syncing normally.
function isCodexStatusLineChannelPath(path) {
  return path === "tui.status_line" || path.startsWith("tui.status_line.")
    || path === "tui.status_line_use_colors";
}

// [Runtime-state filter for the codex settings channel] — keys the Codex CLI
// itself writes into the instance config.toml while running, NOT user config:
// project trust records (one per directory ever launched from, grows forever),
// hook trust hashes (keyed by absolute paths that only exist inside this
// instance dir), and one-shot TUI markers. Syncing them upward is what fired
// the 2026-10-17 "Sync these changes?" prompt on every new project, and the
// prompt's write-back corrupted the provider row (dotted-key bug). Listed
// exactly rather than tui-subtree-wide so user-configured [tui] keys
// (terminal_title, notifications, …) keep syncing normally.
function isCodexRuntimeStatePath(path) {
  return path.startsWith("projects.")
    || path.startsWith("hooks.state.")
    || path === "tui.screen_reader_detection_done"
    || path.startsWith("tui.model_availability_nux.");
}

// Carry the instance's Codex-written runtime state (project trust, hook trust
// hashes, TUI markers — isCodexRuntimeStatePath) across a full config.toml
// regeneration. prepare rebuilds the document from the DB, which would wipe
// that state: hook trust hashes would vanish → every session re-prompts
// "Hooks need review", project trust would re-prompt per directory. The file's
// live values win over anything the DB carries (runtime state is per-machine
// fact, the DB copy is at best a stale echo — and after the dotted-key bug it
// may be a CORRUPTED echo). Fail-safe: any parse error returns the input
// unchanged. Paired with computeEffectiveSettings (same derivation) so the
// overwrite guard's comparison [C3] sees what prepare actually writes.
function mergeCodexRuntimeState(configText, instanceDir) {
  try {
    const current = parseToml(readFileSync(join(instanceDir, "config.toml"), "utf8"));
    const generated = parseToml(configText);
    let changed = false;
    for (const key of ["projects", "hooks"]) {
      if (isPlainObject(current[key])) {
        generated[key] = jsonDeepMerge(isPlainObject(generated[key]) ? generated[key] : {}, current[key]);
        changed = true;
      }
    }
    const curTui = isPlainObject(current.tui) ? current.tui : {};
    if (curTui.screen_reader_detection_done !== undefined) {
      generated.tui = isPlainObject(generated.tui) ? generated.tui : {};
      generated.tui.screen_reader_detection_done = curTui.screen_reader_detection_done;
      changed = true;
    }
    if (isPlainObject(curTui.model_availability_nux)) {
      generated.tui = isPlainObject(generated.tui) ? generated.tui : {};
      generated.tui.model_availability_nux = jsonDeepMerge(
        isPlainObject(generated.tui.model_availability_nux) ? generated.tui.model_availability_nux : {},
        curTui.model_availability_nux,
      );
      changed = true;
    }
    return changed ? stringifyToml(generated) : configText;
  } catch {
    return configText;
  }
}

// Instance dir derivation shared by prepare and computeEffectiveSettings —
// same expression, so the guard's comparison [C3] stays identical by
// construction (applyStatusLineInjection derives claude's the same way).
function codexInstanceDirFor(providerId) {
  return join(INSTANCES_DIR, "codex", providerId);
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
  applyCodexStatusLineInjection(configObj);

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
  "AGENTS.md",              // global instructions ($CODEX_HOME/AGENTS.md); a
                            // customize'd instance replaces this symlink with
                            // a real file — ensureSymlink never overwrites
                            // real files, and uncustomize restores the link.
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

function backupInstanceSettings(appType, providerId, instanceDir, fileName = "settings.json") {
  try {
    const src = join(instanceDir, fileName);
    if (!existsSync(src)) return null;
    const dir = backupDirFor(appType, providerId);
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const dest = join(dir, `${fileName}.${ts}`);
    atomicWrite(dest, readFileSync(src, "utf8"));
    const keep = (readdirSyncSafe(dir) || [])
      .filter((n) => n.startsWith(`${fileName}.`))
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

// Env injected into every launched CLI session. The CLI's own hooks inherit
// these — that's the entire transport: the tmuxclihook status bar captures
// CC_SWITCH_PROVIDER / CC_SWITCH_PROVIDER_ID from the hook's environment into
// per-pane tmux options and renders the provider tag there (claude's wrapper
// tag and codex's native status_line both can't reach the tmux aggregate
// view). Ids are stable across renames; consumers wanting the tag color read
// statusline-preferences.json by id, exactly like the claude wrapper does.
function buildLaunchExtraEnv(providerName, providerId) {
  const env = {};
  if (providerName) env.CC_SWITCH_PROVIDER = String(providerName);
  if (providerId) env.CC_SWITCH_PROVIDER_ID = String(providerId);
  return env;
}

// Foreground replacement for the former spawnSync launch: stdio and exit-code
// semantics unchanged, but the child's pid is recorded while it runs and its
// session file is removed on a clean exit — only its own, so concurrent
// sessions of the same provider stay tracked. A crashed parent (kill -9)
// leaves the file behind — `switch ps` cleans those up as stale.
function launchTracked(bin, extraArgs, instanceDir, envKey, onExit, extraEnv) {
  // Belt-and-suspenders for the flowing-stdin hazard: any missed cleanup
  // upstream would let the parent keep consuming (and discarding) keystrokes
  // that belong to the spawned CLI. pause() is idempotent and cheap.
  try { process.stdin.pause(); } catch {}
  const child = spawn(bin, extraArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      [envKey]: instanceDir,
      ...(isPlainObject(extraEnv) ? extraEnv : {}),
    },
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

// Overwrite guard, CLI-agnostic: right before prepare regenerates an
// instance's main config file, diff what sits on disk against the recorded
// baseline. Unsynchronized edits get a warning + a backup instead of
// vanishing silently. Capability-probed (C2 + C3), never appType-branched —
// an adapter without both is v2-shaped and skips the guard entirely.
function guardInstanceConfigBeforeOverwrite(adapter, row, instanceDir, commonSnippet, settings) {
  try {
    if (!adapter.readInstanceSettingsSnapshot || !adapter.computeEffectiveSettings) return;
    const current = adapter.readInstanceSettingsSnapshot(instanceDir);
    if (!current) return; // missing/corrupt — nothing to protect

    const state = loadSyncState();
    const entry = state.instances?.[adapter.appType]?.[row.id];

    // Upgrade window (v2-shaped entry: no preparedSettings baseline yet —
    // includes every codex instance recorded before baselines existed).
    // Recompute what prepare WOULD write from the current DB and compare.
    // Equal → the file is a faithful mirror, silently backfill the baseline
    // (one-time, self-healing — the real write happens in
    // recordInstanceBaseline right after). Not equal → ambiguous (user
    // edits, or the common config changed in the desktop app since — the
    // latter is legitimate downward drift): we can't tell, so NO warning
    // (avoid false alarms during the upgrade window), just one silent
    // backup + a dim note. After this launch the baseline is v3 either way
    // and future guards are exact.
    if (!isPlainObject(entry?.preparedSettings)) {
      const effective = adapter.computeEffectiveSettings(
        JSON.parse(row.settings_config || "{}"), JSON.parse(row.meta || "{}"),
        row.category, commonSnippet, row.id, settings,
      );
      const backfilled = effective != null && deepEqualJson(effective, current);
      if (!backfilled) {
        const bak = backupInstanceSettings(adapter.appType, row.id, instanceDir, adapter.instanceSettingsFileName);
        process.stderr.write(`\x1b[2m${adapter.instanceSettingsFileName} for "${row.name}" differs from the cc-switch config; a backup was saved${bak ? ` (${bak})` : " (backup FAILED)"} before overwriting.\x1b[0m\n`);
      }
      return;
    }

    const changes = diffSettingsLeaves(entry.preparedSettings, current).filter(
      (ch) => !adapter.channelOwnedPath?.(ch.path) && !adapter.runtimeStatePath?.(ch.path),
    );
    if (changes.length === 0) return; // faithful mirror — overwrite silently

    const bak = backupInstanceSettings(adapter.appType, row.id, instanceDir, adapter.instanceSettingsFileName);
    process.stderr.write(`\x1b[33m⚠ Instance ${adapter.instanceSettingsFileName} for "${row.name}" has edits that will be overwritten:\x1b[0m\n`);
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
// Optional capability interfaces — the guard and sync flows NEVER branch on
// appType; they capability-probe these. An adapter lacking an interface is
// "v2-shaped" for that layer and simply skips it:
//   instanceSettingsFileName   name of the instance's main config file
//                              (guard backups, drift mtime). [C1]
//   readInstanceSettingsSnapshot(dir) → parsed semantic tree of the main
//                              config as it sits on disk NOW; null = missing
//                              or corrupt. MUST be jsonNormalize()-ed so two
//                              parses compare equal under deepEqualJson.
//                              Contract: right after prepare, the file IS
//                              the ground truth of what was handed down.
//                              Without it an adapter skips the overwrite
//                              guard and the settings-field sync. [C2]
//   computeEffectiveSettings(settingsConfig, meta, category, commonSnippet,
//                              providerId, settings) → the semantic tree
//                              prepare WOULD write, normalized identically
//                              to C2 — lets the guard's backfill branch
//                              recompute without a snapshot. [C3]
//   parseCommonSnippet(text) → parsed common-config snippet, or null. [C4]
//   providerDocFromSettingsConfig(settingsConfigObj) → the diffable provider
//                              config document extracted from the DB row's
//                              parsed settings_config. [C5]
//   channelOwnedPath(path) → paths owned by a dedicated channel (claude:
//                              the plugin channel); the field channel must
//                              yield them to avoid double reporting. [C6]
//   syncSettingsBack(drift) → write confirmed {commonPatch, providerPatches}
//                              back into the DB. [C7]
//   instructions         instance-level instruction-file capability for
//                              customize/uncustomize: { fileName,
//                              globalPath(), missingGlobalWarn(p),
//                              buildTemplate(globalText, globalPathDisplay),
//                              refreshSnapshot?(existing, globalText,
//                              globalPathDisplay) — null = don't touch }. [C8]
//   fullAutoFlag         the CLI's full-auto permission flag, used verbatim
//                              in TUI confirmation copy. [C9]
// Claude-only channel (no codex counterpart — Codex has no plugin concept):
//   detectPluginDrift() / syncPluginsBack() / readInstancePluginState().
// Statusline channels per app (both owned via C6, both generated by prepare):
//   claude → the statusLine entry + wrapper (isStatusLineChannelPath),
//   codex  → the [tui] status_line subtree (isCodexStatusLineChannelPath).
const APP_ADAPTERS = {
  claude: {
    appType: "claude",
    label: "claude",
    displayName: "Claude Code",
    bin: "claude",
    envVar: "CLAUDE_CONFIG_DIR",
    commonConfigKey: "common_config_claude",

    // Capability interfaces [C1][C9] — see the comment block above the table.
    instanceSettingsFileName: "settings.json",
    fullAutoFlag: "--dangerously-skip-permissions",

    setupInstance: setupClaudeInstance,

    prepare(instanceDir, providerId, settingsConfig, meta, category, commonSnippet, settings) {
      normalizeInstalledPluginPaths();
      const effective = buildClaudeEffectiveSettings(
        settingsConfig, meta, commonSnippet, claudeProviderName(providerId), providerId,
      );
      atomicWrite(join(instanceDir, "settings.json"), JSON.stringify(effective, null, 2));
    },

    launch(instanceDir, extraArgs, ctx) {
      process.stderr.write(`\x1b[2mCLAUDE_CONFIG_DIR=${instanceDir} claude ${extraArgs.join(" ")}\x1b[0m\n`);
      launchTracked(
        "claude", extraArgs, instanceDir, "CLAUDE_CONFIG_DIR",
        () => normalizeInstalledPluginPaths(),
        buildLaunchExtraEnv(ctx?.providerName, ctx?.providerId),
      );
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

    // Semantic tree prepare WOULD write (guard backfill branch) — the JSON
    // source is naturally normalized, so no jsonNormalize needed here. [C3]
    // providerName/providerId must match prepare's pair exactly, or the
    // statusline injection makes the two derivations fork.
    computeEffectiveSettings(settingsConfig, meta, _category, commonSnippet, providerId, _settings) {
      return jsonNormalize(buildClaudeEffectiveSettings(
        settingsConfig, meta, commonSnippet, claudeProviderName(providerId), providerId,
      ));
    },

    // [C6] — claude's settings_config IS the diffable document.
    parseCommonSnippet(text) {
      try { return JSON.parse(text); } catch { return null; }
    },
    providerDocFromSettingsConfig(settingsConfigObj) {
      return isPlainObject(settingsConfigObj) ? settingsConfigObj : null;
    },
    channelOwnedPath: (path) => isPluginChannelPath(path) || isStatusLineChannelPath(path),

    // [C8] Instance instruction file. The @import line is LIVE — global
    // edits flow through without touching the instance file, so there is
    // no snapshot region and no refreshSnapshot.
    instructions: {
      fileName: "CLAUDE.md",
      globalPath() { return join(HOME, ".claude", "CLAUDE.md"); },
      missingGlobalWarn(p) { return `⚠ ${p} not found — the @import line will resolve once it exists`; },
      buildTemplate(_globalText, globalPath) {
        return [
          `@${globalPath}`,
          "",
          "<!-- ── instance-only instructions (below this line) ── -->",
          "<!-- delete this file to fall back to the shared global CLAUDE.md -->",
          "",
          "",
        ].join("\n");
      },
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
    // Upward drift of non-plugin fields — thin delegation to the shared
    // generic pipeline below (extracted verbatim from this adapter when
    // codex joined the capability set; the leaf diff, per-path mtime
    // arbitration, and the smart split are CLI-agnostic). Call shape
    // matters: `this` relies on method invocation (the APP_ADAPTERS loop),
    // so don't destructure the adapter out of the table.
    detectSettingsDrift(state) {
      return detectConfigDriftGeneric(this, state);
    },

    // Write-back: apply the split patches. Runs in detectAndPromptSync's
    // confirmed branch AFTER the plugin channel and BEFORE
    // refreshStaleInstances — the write-back makes other instances stale,
    // and refresh rebuilds their baselines so this prompt doesn't re-fire.
    syncSettingsBack(drift) {
      applyClaudeSettingsFieldPatches(drift.commonPatch, drift.providerPatches);
    },
  },

  codex: {
    appType: "codex",
    label: "codex",
    displayName: "Codex",
    bin: "codex",
    envVar: "CODEX_HOME",
    commonConfigKey: "common_config_codex",

    // Capability interfaces [C1][C2][C3][C4][C5][C6][C7][C9] — see the
    // comment block above the table. Codex has no plugin concept (that
    // channel never engages), but C6 now owns the injected [tui] status_line
    // subtree (isCodexStatusLineChannelPath): the guard ignores it and the
    // upward settings sync yields it, mirroring claude's statusLine channel.
    instanceSettingsFileName: "config.toml",
    fullAutoFlag: "--dangerously-bypass-approvals-and-sandbox",
    // common_config_codex is a TOML text: write-back re-serializes the whole
    // document (parse → patch → stringify), so comments/formatting are lost.
    // Surfaced at the sync prompt; no format-preserving TOML editor exists.
    rewritesCommonOnSync: true,
    channelOwnedPath: isCodexStatusLineChannelPath,
    // Runtime state the Codex CLI writes itself (project trust, hook trust
    // hashes, TUI markers) — filtered from the guard and the upward sync, and
    // carried across prepare's full regeneration instead of synced as config.
    runtimeStatePath: isCodexRuntimeStatePath,

    parseCommonSnippet(text) {
      try { return jsonNormalize(parseToml(text || "")); } catch { return null; }
    },
    // The diffable document is the `config` TOML inside the settings_config
    // JSON envelope ({config, auth, modelCatalog}) — auth and modelCatalog
    // are out of the field channel's scope.
    providerDocFromSettingsConfig(settingsConfigObj) {
      try {
        return jsonNormalize(parseToml(settingsConfigObj?.config || ""));
      } catch {
        return null;
      }
    },

    setupInstance: setupCodexInstance,

    prepare(instanceDir, providerId, settingsConfig, meta, category, commonSnippet, settings) {
      const { configText, auth, catalog, apiKey } = buildCodexConfig(
        settingsConfig, meta, category, commonSnippet, { id: providerId }, settings,
      );
      atomicWrite(join(instanceDir, "config.toml"), mergeCodexRuntimeState(configText, instanceDir));

      const authPath = join(instanceDir, "auth.json");
      const globalAuthPath = join(HOME, ".codex", "auth.json");
      const hasLoginMaterial = codexAuthHasLoginMaterial(auth);
      if (!apiKey && !hasLoginMaterial) {
        // No credentials in the DB: share whatever the global auth holds.
        if (existsSync(globalAuthPath)) {
          ensureSymlink(globalAuthPath, authPath);
        } else {
          atomicWrite(authPath, JSON.stringify({}, null, 2));
        }
      } else if (!apiKey && hasLoginMaterial && !settings.preserveCodexOfficialAuthOnSwitch) {
        // PURE OAuth credentials (no OPENAI_API_KEY — note that the login-
        // material check is true for ANY non-empty auth, so the apiKey guard
        // must come first or API-key auth would get linked too): link the
        // GLOBAL auth file — the same shape as claude's .credentials.json. The CLI rotates tokens
        // by rewriting auth.json mid-session; a per-instance copy dies on
        // the next prepare, which resurrects the DB's stale refresh token
        // and forces a re-login. One shared live file makes the rotation
        // permanent. First run seeds the global file from the DB's stored
        // login material; from then on the DB copy is never handed down
        // again. Trade-off (documented in the README): providers with
        // DIFFERENT ChatGPT accounts can no longer hold independent logins;
        // `preserveCodexOfficialAuthOnSwitch` keeps the legacy per-instance
        // behavior for those who need it.
        if (!existsSync(globalAuthPath)) {
          atomicWrite(globalAuthPath, JSON.stringify(auth, null, 2));
        }
        ensureSymlink(globalAuthPath, authPath);
      } else {
        // API-key credentials (or the preserve opt-out): a deterministic DB
        // artifact the CLI never rewrites — an independent file is correct.
        const authContent = apiKey
          ? { OPENAI_API_KEY: apiKey }
          : hasLoginMaterial ? auth : {};
        atomicWrite(authPath, JSON.stringify(authContent, null, 2));
      }

      if (catalog) {
        atomicWrite(join(instanceDir, CC_SWITCH_CATALOG_FILENAME), JSON.stringify(catalog, null, 2));
      }
    },

    launch(instanceDir, extraArgs, ctx) {
      process.stderr.write(`\x1b[2mCODEX_HOME=${instanceDir} codex ${extraArgs.join(" ")}\x1b[0m\n`);
      launchTracked(
        "codex", extraArgs, instanceDir, "CODEX_HOME", null,
        buildLaunchExtraEnv(ctx?.providerName, ctx?.providerId),
      );
    },

    // Semantic tree prepare WOULD write: run buildCodexConfig, carry the
    // instance's runtime state across (same merge prepare does), and parse
    // the TOML, normalized identically to the C2 snapshot so the guard's
    // backfill comparison is deterministic. [C3]
    computeEffectiveSettings(settingsConfig, meta, category, commonSnippet, providerId, settings) {
      try {
        const { configText } = buildCodexConfig(
          settingsConfig, meta, category, commonSnippet, { id: providerId }, settings,
        );
        return jsonNormalize(parseToml(mergeCodexRuntimeState(configText, codexInstanceDirFor(providerId))));
      } catch {
        return null;
      }
    },

    // Parsed semantic tree of the instance's config.toml as it sits on disk
    // NOW. TOML comments/whitespace are not semantic — smol-toml may also
    // yield Date/NaN instances, hence the jsonNormalize round-trip (same
    // normalization on the C3 side). Returns null on missing/corrupt file
    // (treated as "no v3 baseline" by every consumer — never a drift
    // report). [C2]
    readInstanceSettingsSnapshot(instanceDir) {
      try {
        return jsonNormalize(parseToml(readFileSync(join(instanceDir, "config.toml"), "utf8")));
      } catch {
        return null;
      }
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

    // Same shared pipeline as claude's — method-invocation `this` binding.
    detectSettingsDrift(state) {
      return detectConfigDriftGeneric(this, state);
    },

    // [C7] Write-back goes through the TOML shells below: sqlite's
    // json_patch cannot touch TOML, so common_config_codex and each
    // provider's settings_config.config are read-patched-written with a
    // compare-and-swap on the original text.
    syncSettingsBack(drift) {
      applyCodexSettingsFieldPatches(drift);
    },

    // [C8] Instance instruction file. Codex has no @import mechanism — the
    // template embeds a MARKED snapshot of the global file (refreshable by
    // re-running customize) above the instance-only section.
    instructions: {
      fileName: "AGENTS.md",
      globalPath() { return join(HOME, ".codex", "AGENTS.md"); },
      missingGlobalWarn(p) { return `⚠ ${p} not found — the snapshot block will note it until it exists`; },
      buildTemplate(globalText, globalPath) {
        return buildCodexInstructionsTemplate(globalText, globalPath);
      },
      refreshSnapshot(existingText, newGlobalText, globalPath) {
        return refreshCodexInstructionsSnapshot(existingText, newGlobalText, globalPath);
      },
    },
  },
};

// Settings-field upward drift, CLI-agnostic — extracted verbatim from the
// claude adapter when codex joined the C1-C5 capability set. The leaf diff,
// per-path mtime arbitration, and the smart split are shared unchanged; the
// adapter supplies only instance dir, baseline map, common-snippet parsing
// [C4], provider-document extraction [C5], and the channel filter [C6].
// Reads instance files + DB; writes nothing.
function detectConfigDriftGeneric(adapter, state) {
  const dir = join(INSTANCES_DIR, adapter.appType);
  const baselines = state?.instances?.[adapter.appType] || {};
  if (!existsSync(dir)) return null;

  // Parse the current common snippet once; used both for split decisions
  // and for "already equal in DB" filtering.
  const commonObj = adapter.parseCommonSnippet(queryCommonConfig(adapter.appType)) ?? {};

  const candidates = [];
  for (const name of readdirSyncSafe(dir) || []) {
    try {
      const instDir = join(dir, name);
      const current = adapter.readInstanceSettingsSnapshot(instDir);
      const baseline = baselines[name]?.preparedSettings;
      if (!isPlainObject(baseline)) continue; // no v3 baseline — no vote
      if (current === null || deepEqualJson(current, baseline)) continue; // unchanged/corrupt mirror
      const changes = diffSettingsLeaves(baseline, current).filter(
        (ch) => !adapter.channelOwnedPath?.(ch.path) && !adapter.runtimeStatePath?.(ch.path),
      );
      if (changes.length === 0) continue; // only channel-owned edits
      let mtimeMs = 0;
      try { mtimeMs = lstatSync(join(instDir, adapter.instanceSettingsFileName)).mtimeMs; } catch {}
      candidates.push({ providerId: name, changes, mtimeMs });
    } catch {
      // missing/corrupt instance config — skip
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
  for (const [path, voters] of votes.entries()) {
    voters.sort((a, b) => a.cand.mtimeMs - b.cand.mtimeMs);
    const winner = voters[voters.length - 1];
    if (voters.length > 1) conflicts[path] = voters.length;

    const row = queryProviderById(winner.cand.providerId, adapter.appType);
    const providerSettings = row
      ? adapter.providerDocFromSettingsConfig(JSON.parse(row.settings_config || "{}"))
      : null;
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
  }
  // All-rejected drift must still surface: every change was refused, but
  // the prompt has to say so instead of going silent.
  if (!Object.keys(commonPatch).length && !Object.keys(providerPatches).length && !rejectedPaths.length) return null;

  // Display-facing: one entry per candidate instance with its (filtered)
  // changes, plus the name resolution for the prompt lines.
  const nameById = new Map(queryProvidersByApp(adapter.appType).map((p) => [p.id, p.name]));
  const instances = candidates.map((c) => ({
    providerId: c.providerId,
    name: nameById.get(c.providerId) || c.providerId,
    changes: c.changes,
    mtimeMs: c.mtimeMs,
  }));
  return { instances, commonPatch, providerPatches, conflicts, rejected: rejectedPaths };
}

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
// Dotted path → the tree's REAL key sequence. The path string is ambiguous
// when a key itself contains dots — codex TOML `[hooks.state."<abs path>"]`
// keys are absolute file paths ("/…/.cc-switch/…/hooks.json:pre_tool_use:0:0"),
// so a naive split("") explodes one flat key into nested levels. That is
// exactly how the 2026-10-17 sync corrupted the provider row: the write-back
// re-serialized a single TOML key as three nested tables. Resolution against
// the actual tree: prefer the exact next segment; otherwise accept a dotted
// key that swallows several segments when the remainder then resolves
// (backtracking — two sibling keys may both be dotted-prefix candidates).
// Returns the naive split when nothing fits, so dot-free paths (the
// overwhelming majority) behave byte-identically to before.
function resolvePathSegments(obj, path) {
  const parts = String(path).split(".");
  function walk(node, i) {
    if (!isPlainObject(node)) return null;
    if (i === parts.length - 1) return parts[i] in node ? [parts[i]] : null;
    const exact = Object.prototype.hasOwnProperty.call(node, parts[i])
      ? walk(node[parts[i]], i + 1) : null;
    if (exact) return [parts[i], ...exact];
    for (const k of Object.keys(node)) {
      if (!k.includes(".")) continue;
      let consumed = parts[i];
      // j = tail start; consumed === parts[i..j-1].join("."). j may reach
      // parts.length: a dotted key can swallow ALL remaining segments (the
      // path's leaf IS that key — an add/change reported at the key itself).
      for (let j = i + 1; j <= parts.length; j++) {
        if (consumed === k) {
          if (j === parts.length) return [k];
          const tail = walk(node[k], j);
          if (tail) return [k, ...tail];
        }
        if (j < parts.length) consumed += "." + parts[j];
      }
    }
    return null;
  }
  return walk(obj, 0) || parts;
}

function pathExistsInSnippet(snippetObj, path) {
  if (!isPlainObject(snippetObj) || !path) return false;
  const parts = resolvePathSegments(snippetObj, path);
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

// Read the value at a dotted path inside a parsed object (undefined if absent).
// Resolution is tree-aware — see resolvePathSegments for why the naive split
// misreads keys that themselves contain dots.
function getPathValue(obj, path) {
  let cur = obj;
  for (const part of resolvePathSegments(obj, path)) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Write-back orchestration for the settings-field channel, CLAUDE flavor:
// common_config via json_patch (single-statement atomic) and each provider's
// settings_config likewise. (Codex has its own shell — applyCodexSettings-
// FieldPatches — because TOML cannot go through sqlite's json_patch.)
// Common and each provider patch go through SEPARATE try blocks: one DB
// hiccup must not abort the rest, and — unlike the plugin channel's silent
// best-effort — failures are REPORTED, because the user just explicitly
// confirmed these writes; losing one silently is worse than an error line.
function applyClaudeSettingsFieldPatches(commonPatch, providerPatches) {
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

// ─── Codex write-back (TOML) ───────────────────────────────────────────
// sqlite's json_patch only speaks JSON; common_config_codex is a TOML text
// and each codex provider's settings_config carries the config as a TOML
// string inside a JSON envelope. The equivalent of claude's single-statement
// atomic json_patch is therefore a read-modify-write anchored by a
// COMPARE-AND-SWAP: the UPDATE's WHERE clause requires the column to still
// hold the exact text we read, and `SELECT changes()` confirms the row was
// actually replaced. A concurrent writer (the desktop app) between our read
// and write yields 0 rows → re-read, re-patch, retry. No partial writes, no
// lost updates; two failed retries surface as a reported error (same
// report-don't-swallow contract as applyClaudeSettingsFieldPatches above).

function execDBWithChanges(sql) {
  try {
    // Trailing semicolon is REQUIRED: without it the appended SELECT would
    // parse as one (invalid) statement and the whole batch would error out
    // into the catch below — a silent always-0 that fails every CAS.
    const out = execFileSync("sqlite3", [DB_PATH, ".timeout 3000", `${sql};\nSELECT changes();`], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 2000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const n = parseInt(String(out).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function patchCodexCommonConfig(patchObj) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = queryCommonConfig("codex");
    if (cur === null || cur === undefined) {
      throw new Error("common_config_codex row does not exist in the settings table");
    }
    const next = applyTomlPatchText(cur, patchObj);
    const n = execDBWithChanges(
      `UPDATE settings SET value = ${sqlQuote(next)} WHERE key = 'common_config_codex' AND value = ${sqlQuote(cur)}`,
    );
    if (n === 1) return;
  }
  throw new Error("common_config_codex kept changing under us (desktop app writing concurrently?) — run switch sync again");
}

function patchCodexProviderConfig(providerId, patchObj) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = queryProviderById(providerId, "codex");
    if (!row) return; // provider gone — nothing to write (mirrors the generic drift drop)
    const original = row.settings_config;
    let sc;
    try {
      sc = JSON.parse(original || "{}");
    } catch {
      throw new Error(`provider "${providerId}" settings_config is not valid JSON`);
    }
    // Patch ONLY the config document; auth and modelCatalog pass through
    // untouched — the field channel never owns them.
    sc.config = applyTomlPatchText(sc.config || "", patchObj);
    const casClause = original == null ? "settings_config IS NULL" : `settings_config = ${sqlQuote(original)}`;
    const n = execDBWithChanges(
      `UPDATE providers SET settings_config = ${sqlQuote(JSON.stringify(sc))} WHERE id = ${sqlQuote(providerId)} AND app_type = 'codex' AND ${casClause}`,
    );
    if (n === 1) return;
  }
  throw new Error(`provider "${providerId}" config kept changing under us — run switch sync again`);
}

// Thin shell mirroring applyClaudeSettingsFieldPatches: same separate
// try-blocks, same report-don't-swallow error style.
function applyCodexSettingsFieldPatches(drift) {
  if (drift.commonPatch && Object.keys(drift.commonPatch).length) {
    try {
      patchCodexCommonConfig(drift.commonPatch);
    } catch (e) {
      process.stderr.write(`\x1b[31m✗ Failed to write common config: ${e.message}\x1b[0m\n`);
    }
  }
  for (const [providerId, patchObj] of Object.entries(drift.providerPatches || {})) {
    if (!patchObj || !Object.keys(patchObj).length) continue;
    try {
      patchCodexProviderConfig(providerId, patchObj);
    } catch (e) {
      process.stderr.write(`\x1b[31m✗ Failed to write provider ${providerId} config: ${e.message}\x1b[0m\n`);
    }
  }
}

// Collapse a patch subtree into one null (RFC 7396 whole-subtree remove)
// ONLY when the patch deletes every key the target object actually holds at
// that level. Per-leaf nulls alone would leave empty husks ({"hooks": {}}
// after deleting every hook), but an unconditional all-null-in-patch fold
// would delete siblings the user never touched — the patch does not carry
// them, so "all-null inside the patch" is NOT "all gone in the target";
// the fold must consult the object the patch will be applied to. The TOP
// level never folds: an RFC 7396 patch IS an object, a top-level null is
// an invalid patch.
function foldRemovalPatch(patch, target) {
  if (!isPlainObject(patch)) return;
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (!isPlainObject(pv)) continue; // leaves (values and nulls) stay as-is
    const targetChild = isPlainObject(target) ? target[k] : undefined;
    foldRemovalPatch(pv, targetChild);
    const pvKeys = Object.keys(pv);
    if (
      pvKeys.length > 0 &&
      pvKeys.every((key) => pv[key] === null) &&
      isPlainObject(targetChild) &&
      Object.keys(targetChild).length === pvKeys.length &&
      pvKeys.every((key) => key in targetChild)
    ) {
      patch[k] = null;
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
        buildNestedAssign(commonPatch, ch.path, ch.op === "remove" ? null : ch.to, commonObj);
      }
    } else {
      const cur = getPathValue(providerSettings, ch.path);
      if (!deepEqualJson(cur, ch.op === "remove" ? undefined : ch.to)) {
        buildNestedAssign(providerPatch, ch.path, ch.op === "remove" ? null : ch.to, providerSettings);
      }
    }
  }
  // Husk prevention + precise removals: a subtree the patch empties
  // COMPLETELY (all of the target's keys are being removed) folds to one
  // null so json_patch deletes it whole with no {} husk; partially-emptied
  // subtrees stay per-leaf so untouched siblings in the target survive.
  foldRemovalPatch(commonPatch, commonObj);
  foldRemovalPatch(providerPatch, providerSettings);
  return { commonPatch, providerPatch, rejected };
}

// Assign a value at a dotted path inside a patch object, creating
// intermediate objects as needed (inverse of getPathValue for patch
// construction; works on a shared, partially-populated patch across
// changes — unlike a fresh-patch builder). refObj (the tree the path was
// diffed against) anchors tree-aware segment resolution: without it a key
// containing dots would be re-nested into levels that don't exist in the
// target document, corrupting it on write-back.
function buildNestedAssign(patch, path, value, refObj) {
  const parts = resolvePathSegments(refObj, path);
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
        guardInstanceConfigBeforeOverwrite(adapter, row, instanceDir, commonSnippet, settings);
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
// preparedSettings (the full parsed config as handed down — settings.json
// for claude, config.toml's semantic tree for codex) — the basis for the
// overwrite guard and the settings-field sync diff. Adapters without
// readInstanceSettingsSnapshot record v2-shaped entries and simply don't
// participate in settings-field sync.
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
  // on the very first sync). The plugin baseline is claude's concept (codex
  // has no plugin channel), but this early-return must NOT skip the rest of
  // the flow: common-config drift for EVERY app is checked below, and
  // skipping it here used to hide codex staleness on the first run.
  if (!state?.claude?.installedPluginKeys) {
    snapshotSyncState(state, ["claude"]);
    saveSyncState(state);
    // fall through: the plugin baseline is now established, so the plugin
    // channel below won't misreport pre-existing plugins as "added" — but
    // per-instance baselines are simply absent until each instance is next
    // launched, and instances without one are skipped, not flagged.
  }

  const commonDrift = detectCommonConfigDrift(state);

  const pluginDrifts = {};
  for (const [cmd, adapter] of Object.entries(APP_ADAPTERS)) {
    if (adapter.detectPluginDrift) {
      const d = adapter.detectPluginDrift(state);
      if (d) pluginDrifts[cmd] = d;
    }
  }

  // Channel 2: non-plugin config fields (every adapter with C2-C5; v3 baselines).
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
  for (const [cmd, d] of Object.entries(settingsDrifts)) {
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
    // Adapters whose common snippet is a re-serialized document (codex TOML)
    // lose comments/formatting on write-back — say so BEFORE the confirm.
    if (APP_ADAPTERS[cmd]?.rewritesCommonOnSync && Object.keys(d.commonPatch || {}).length) {
      lines.push(`\x1b[2m(note: write-back rewrites common config (${cmd}) — comments and formatting in the TOML will be lost)\x1b[0m`);
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
// colorContext + onColor + getCurrentColor (provider layer): `o` opens the
//               tag-color picker for the highlighted provider. onColor(item,
//               value) persists the choice (returns non-null on success);
//               getCurrentColor(item) returns the stored value ("auto" default)
//               so the cursor and the ● mark land on the current choice.
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
  const canColor = typeof opts.onColor === "function" && typeof opts.getCurrentColor === "function"; // provider layer `o`
  const refreshQuick = typeof opts.onRefreshQuickItems === "function" ? opts.onRefreshQuickItems : null;

  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error("TUI mode requires an interactive terminal. Use command mode: switch <provider> <cmd>"));
      return;
    }

    let selected = 0;
    let mode = "select"; // "select" | "param" | "pin" | "confirm" | "color"
    let lastDrawnLines = 0;
    let pinTarget = null; // {cli, providerId, provider, label} captured entering pin mode
    let confirmAction = null; // {kind:"remove"|"cleanup"|"launch", target} in confirm mode
    let paramEdit = null; // {q} Recent row being mode-edited — param mode, edit context
    let colorTarget = null; // {cli, providerId, provider, label} captured entering color mode
    let colorIndex = 0; // STATUSLINE_COLOR_CHOICES cursor
    let colorCurrentValue = "auto"; // stored preference when color mode was entered — renders the ● mark

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
      const locked = m === "param" || m === "pin" || m === "confirm" || m === "color";
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
      } else if (m === "color") {
        // Single-column list of 17 choices with true-color-free ANSI swatches
        // (██ renders in the terminal's own palette) — same ↑↓/jk semantics
        // as the select list, so no arrow-key relearning.
        lines.push("");
        lines.push(
          `  \x1b[1m\x1b[36m${fit(`Tag color for "${colorTarget.label}" · ⏎ apply   esc cancel`, 4)}\x1b[0m`,
        );
        for (let i = 0; i < STATUSLINE_COLOR_CHOICES.length; i++) {
          const c = STATUSLINE_COLOR_CHOICES[i];
          const swatch = `${c.swatch}██\x1b[0m`;
          const cur = c.value === colorCurrentValue ? " \x1b[32m● current\x1b[0m" : "";
          lines.push(
            i === colorIndex
              ? `\x1b[36m❯ ${swatch} ${c.label}${cur}\x1b[0m`
              : `\x1b[90m  ${swatch} ${c.label}${cur}\x1b[0m`,
          );
        }
      } else if (m === "confirm") {
        lines.push("");
        const { kind, target } = confirmAction;
        let head;
        if (kind === "launch") {
          // One keypress away from the adapter's full-auto flag — the only
          // confirm in the TUI that guards a launch rather than a deletion.
          const flag = APP_ADAPTERS[target.cli]?.fullAutoFlag ?? "--dangerously-skip-permissions";
          head = `\x1b[33m⚠ "${target.provider}" would launch Full-auto (${flag})\x1b[0m — launch?`;
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
        const colorHint = canColor ? `   o tag color` : "";
        lines.push(`  \x1b[90m${fit(`↑↓ navigate   ⏎ confirm${pinHint}${colorHint}   esc ← back to CLI`, 4)}\x1b[0m`);
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

      if (mode === "color") {
        // Color region: navigate the 17 choices, ⏎ saves the preference, esc
        // cancels. Never launches; every other key is ignored (same stance
        // as pinning) so stray input can't mutate state.
        if (key === "\x1b[A" || key === "k") {
          colorIndex = (colorIndex - 1 + STATUSLINE_COLOR_CHOICES.length) % STATUSLINE_COLOR_CHOICES.length;
          render(mode);
          return;
        }
        if (key === "\x1b[B" || key === "j") {
          colorIndex = (colorIndex + 1) % STATUSLINE_COLOR_CHOICES.length;
          render(mode);
          return;
        }
        if (key === "\r" || key === "\n") {
          const choice = STATUSLINE_COLOR_CHOICES[colorIndex];
          mode = "select";
          const ok = opts.onColor(colorTarget, choice.value) !== null;
          render(
            mode,
            ok
              ? `✓ Tag color for "${colorTarget.label}" → ${choice.label} — next launch`
              : `✗ Failed to save color preference`,
          );
          return;
        }
        if (key === "\x1b") {
          mode = "select";
          render(mode);
          return;
        }
        return; // ignore everything else while choosing a color
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
      // `o` colors the highlighted provider's statusline tag (provider layer
      // only). colorTarget mirrors pinTarget's structured shape; the cursor
      // lands on the stored choice so re-entering shows where you are.
      if (interactive && canColor && key === "o" && selected < options.length) {
        colorTarget = {
          cli: opts.colorContext,
          providerId: options[selected].value,
          provider: options[selected].label,
          label: options[selected].label,
        };
        colorCurrentValue = opts.getCurrentColor(colorTarget);
        const at = STATUSLINE_COLOR_CHOICES.findIndex((c) => c.value === colorCurrentValue);
        colorIndex = at >= 0 ? at : 0;
        mode = "color";
        render(mode);
        return;
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
          // `o` tag color — both CLIs. claude's color is consumed by the
          // wrapper at prepare time; codex's native status_line has no custom
          // text/color slot (upstream #17827), so the codex color is consumed
          // by the tmuxclihook status bar's provider segment instead (same
          // statusline-preferences.json, per-CLI buckets).
          colorContext: cli.value,
          onColor: (target, value) => saveStatuslineColor(cli.value, target.providerId, value),
          getCurrentColor: (target) => statuslineColorFor(cli.value, target.providerId),
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
  // Guard BEFORE prepare overwrites the main config file — user edits beyond
  // plugins get a warning + backup instead of vanishing silently.
  guardInstanceConfigBeforeOverwrite(adapter, row, instanceDir, commonSnippet, settings);
  adapter.prepare(instanceDir, row.id, settingsConfig, meta, category, commonSnippet, settings);
  recordInstanceBaseline(adapter, row.id, instanceDir, commonSnippet);
  // Record AFTER prepare succeeded (a failed prep is not a launch) and BEFORE
  // launch (adapter.launch execs and never returns). This is the single
  // recording point — both TUI and command mode pass through here, and the
  // extraArgs are stored so quick-launch replays the full original argv.
  const hotkey = record?.hotkey !== undefined ? record.hotkey : adapter.inferHotkeyFromArgs?.(extraArgs);
  recordLaunch(cmd, row.id, row.name, hotkey, extraArgs);
  adapter.launch(instanceDir, extraArgs, { providerName: row.name, providerId: row.id });
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

  // instructions files (per-adapter, capability-driven): the global file's
  // readability, plus every existing instance instructions file being either
  // the shared symlink or a real file — a BROKEN symlink means the global
  // moved and the instance is silently without instructions. (Codex's global
  // AGENTS.md loading itself has a known upstream reliability issue —
  // openai/codex#8759 — so surface the file state explicitly here.)
  for (const adapter of Object.values(APP_ADAPTERS)) {
    if (!adapter.instructions) continue;
    const globalPath = adapter.instructions.globalPath();
    const globalOk = existsSync(globalPath);
    add(
      `${adapter.appType} global ${adapter.instructions.fileName}`,
      globalOk,
      globalOk ? globalPath : `${globalPath} not found (instances fall back to empty snapshots)`,
    );
    let broken = [];
    for (const inst of collectInstances().filter((i) => i.appType === adapter.appType)) {
      const p = instanceInstructionsPath(adapter.appType, inst.name);
      const st = lstatSyncSafe(p);
      if (st?.isSymbolicLink() && !existsSync(p)) broken.push(inst.name);
    }
    add(
      `${adapter.appType} instance ${adapter.instructions.fileName} links`,
      broken.length === 0,
      broken.length === 0 ? "all symlinks resolve" : `broken symlink(s): ${broken.join(", ")}`,
    );
  }

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

// ─── Instance-only instructions file (customize / uncustomize) ────────

// Marks the boundary between the refreshable global snapshot and the
// user's instance-only section in a codex AGENTS.md template.
const CODEX_INSTRUCTIONS_INSTANCE_MARK =
  "<!-- ── instance-only instructions (below this line) ── -->";

// Pure arg parsing, shared by customize/uncustomize: an explicit app name is
// consumed only when it names an adapter AND a provider name follows;
// otherwise the command defaults to claude (backward compatible with the
// claude-only syntax). A bare "claude"/"codex" is ambiguous — an app name
// without a provider — so the caller must ask for
// `switch customize claude claude` explicitly in that corner case.
function parseCustomizeArgs(args) {
  const rest = args.filter((a) => a !== "--yes");
  if (rest.length === 0) return null;
  if (APP_ADAPTERS[rest[0]]) {
    if (rest.length < 2) return null; // app named but no provider
    return { cmd: rest[0], providerName: rest[1] };
  }
  return { cmd: "claude", providerName: rest[0] };
}

function instanceInstructionsPath(appType, providerId) {
  return join(INSTANCES_DIR, appType, providerId, APP_ADAPTERS[appType].instructions.fileName);
}

function findCustomizeProviderOrExit(cmd, providerName, usage) {
  if (!providerName) {
    console.error(usage);
    process.exit(1);
  }
  const adapter = APP_ADAPTERS[cmd];
  const row = queryProvider(providerName, adapter.appType);
  if (!row) {
    console.error(`✗ Provider "${providerName}" not found (${adapter.appType})`);
    console.error(`  Available providers:`);
    queryProvidersByApp(adapter.appType).forEach((p) => console.error(`    ${p.name}`));
    process.exit(1);
  }
  return row;
}

// Codex has no @import mechanism, so an instance AGENTS.md must EMBED the
// global content: a marked snapshot block on top (refreshable), the user's
// instance-only section below (preserved byte-for-byte across refreshes).
function buildCodexInstructionsTemplate(globalText, globalPathDisplay) {
  const body = (globalText || "").trimEnd();
  return [
    `<!-- cc-switch: snapshot of ${globalPathDisplay} — re-run \`switch customize codex <provider>\` to refresh this block -->`,
    body || "(global AGENTS.md is missing or empty — this snapshot will stay as-is until refreshed)",
    "",
    CODEX_INSTRUCTIONS_INSTANCE_MARK,
    "<!-- delete this file to fall back to the shared global AGENTS.md -->",
    "",
    "",
  ].join("\n");
}

// Rewrite ONLY the snapshot region; anything below the instance marker is
// kept byte-for-byte. Returns null when the file doesn't carry our marker
// (a hand-written file) — the caller must not touch it.
function refreshCodexInstructionsSnapshot(existingText, newGlobalText, globalPathDisplay) {
  const instanceIdx = existingText.indexOf(CODEX_INSTRUCTIONS_INSTANCE_MARK);
  if (instanceIdx < 0) return null;
  const tail = existingText.slice(instanceIdx);
  const body = (newGlobalText || "").trimEnd();
  return [
    `<!-- cc-switch: snapshot of ${globalPathDisplay} — re-run \`switch customize codex <provider>\` to refresh this block -->`,
    body || "(global AGENTS.md is missing or empty — this snapshot will stay as-is until refreshed)",
    "",
    tail,
  ].join("\n");
}

// First run writes the template (claude: live @import; codex: marked
// snapshot + instance section) and opens the editor; later runs open the
// existing file directly — and, for adapters with refreshSnapshot, first
// refresh the snapshot region in place. The real file survives every later
// launch because ensureSymlink preserves non-symlink files instead of
// re-linking the shared global one.
function runCustomize(args) {
  const parsed = parseCustomizeArgs(args);
  const usage = "Usage: switch customize [claude|codex] <provider>";
  if (!parsed) {
    console.error(usage);
    process.exit(1);
  }
  const adapter = APP_ADAPTERS[parsed.cmd];
  const inst = adapter.instructions;
  const row = findCustomizeProviderOrExit(parsed.cmd, parsed.providerName, usage);
  mkdirSync(join(INSTANCES_DIR, adapter.appType, row.id), { recursive: true });
  const file = instanceInstructionsPath(adapter.appType, row.id);
  const stats = lstatSyncSafe(file);
  if (stats?.isDirectory()) {
    console.error(`✗ ${file} is a directory — refusing to touch it`);
    process.exit(1);
  }
  const globalPath = inst.globalPath();
  let globalText = "";
  try { globalText = readFileSync(globalPath, "utf8"); } catch {}
  if (!stats || stats.isSymbolicLink()) {
    if (!existsSync(globalPath)) {
      console.error(inst.missingGlobalWarn(globalPath));
    }
    atomicWrite(file, inst.buildTemplate(globalText, globalPath));
  } else if (inst.refreshSnapshot) {
    const refreshed = inst.refreshSnapshot(readFileSync(file, "utf8"), globalText, globalPath);
    if (refreshed !== null) atomicWrite(file, refreshed);
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
  const parsed = parseCustomizeArgs(args);
  const usage = "Usage: switch uncustomize [claude|codex] <provider> [--yes]";
  if (!parsed) {
    console.error(usage);
    process.exit(1);
  }
  const adapter = APP_ADAPTERS[parsed.cmd];
  const inst = adapter.instructions;
  const row = findCustomizeProviderOrExit(parsed.cmd, parsed.providerName, usage);
  const file = instanceInstructionsPath(adapter.appType, row.id);
  const stats = lstatSyncSafe(file);
  if (!stats) {
    console.log(`not customized (no instance ${inst.fileName})`);
    return;
  }
  if (stats.isSymbolicLink()) {
    console.log(`not customized (${inst.fileName} is the shared global symlink)`);
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
      [`Remove instance ${inst.fileName} for "${row.name}"?`, `  ${file}`],
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
  adapter.setupInstance(row.id); // restore the shared symlink immediately
  console.log(`✓ restored to shared global ${inst.fileName}`);
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
  switch customize [claude|codex] <provider>   Instance-only instructions file (CLAUDE.md / AGENTS.md; opens editor)
  switch uncustomize [claude|codex] <provider> [--yes]  Back to the shared global instructions file
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
  applyMergePatch,
  jsonNormalize,
  applyTomlPatchText,
  deepEqualJson,
  isSensitiveConfigKey,
  isSensitiveConfigPath,
  stripOneShotFlags,
  healRecordedArgs,
  splitChangesByTarget,
  buildNestedAssign,
  pathExistsInSnippet,
  getPathValue,
  foldRemovalPatch,
  diffSettingsLeaves,
  guardInstanceConfigBeforeOverwrite,
  parseCustomizeArgs,
  buildCodexInstructionsTemplate,
  refreshCodexInstructionsSnapshot,
  buildClaudeEffectiveSettings,
  applyStatusLineInjection,
  buildStatusLineWrapperScript,
  isStatusLineChannelPath,
  claudeProviderName,
  statuslineColorFor,
  saveStatuslineColor,
  loadStatuslinePreferences,
  buildLaunchExtraEnv,
  STATUSLINE_COLOR_CHOICES,
  applyCodexStatusLineInjection,
  isCodexStatusLineChannelPath,
  isCodexRuntimeStatePath,
  mergeCodexRuntimeState,
  codexInstanceDirFor,
  resolvePathSegments,
  extractClaudeUsageSource,
  resolveUsageIdentity,
  usageEndpointFor,
  buildUsageQueryConfig,
  buildUsageWrapperLines,
  USAGE_CACHE_FILENAME,
  APP_ADAPTERS,
});
