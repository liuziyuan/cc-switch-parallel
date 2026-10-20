// ─── history (split from bin/cc-launch.mjs) ─────────────────────────────

import { readFileSync, renameSync } from "node:fs";
import { APP_ADAPTERS } from "./adapters.js";
import { queryProvidersStrict } from "./db.js";
import { withFileLockSync } from "./file-lock.js";
import { atomicWrite } from "./fs-utils.js";
import { isPlainObject } from "./json-utils.js";
import { HISTORY_PATH } from "./paths.js";

// ─── Launch history (top 5 quick-launch + manual pin ordering) ─────────

import type { HistoryEntry } from "./types.js";

const QUICK_KEYS = ["a", "s", "d", "f", "g"];

// History schema version. 2 = id-keyed entries: {cli, providerId, provider
// (name kept for display + v0.6 downgrade compat), hotkey, extraArgs, count,
// lastUsed}. Absent = 1 = the pre-0.7 name-keyed format.
const HISTORY_VERSION = 2;

// Entry/pin identity: cli + provider id when resolved, cli + stored name for
// entries whose provider no longer exists (dead rows — the name is their only
// identifier). order slots hold these key strings.
const entryKey = (e) => (e.providerId ? `${e.cli}|${e.providerId}` : `${e.cli}|${e.provider}`);

// Set when the file must not be written back in this process: unreadable /
// corrupt content, an unknown (future) schema version, or a failed migration.
// Every write path checks it — saving the empty in-memory history over the
// file would silently destroy all counts and pins.
let _historyFrozen = false;
// Read-only view for frozen loads (future versions may still render).
let _historyFrozenSnapshot: { entries: HistoryEntry[]; order: (string | null)[] } | null = null;

function frozenView() {
  const v = _historyFrozenSnapshot ?? { entries: [], order: normalizeOrder(undefined) };
  // Copy: callers must never mutate the frozen snapshot (top5 re-reads it).
  return { entries: v.entries.slice(), order: v.order.slice() };
}

// `order` is a sparse 5-slot array — a pinned entry key keeps its slot, null
// slots are filled by natural count/lastUsed ranking. Normalized from any
// stored value (missing field, dense legacy array, junk entries). Duplicate
// keys are dropped (first occurrence wins): a duplicated slot used to render
// the same Recent row twice.
function normalizeOrder(raw: any): (string | null)[] {
  const out: (string | null)[] = [null, null, null, null, null];
  const seen = new Set<string>();
  if (Array.isArray(raw)) raw.slice(0, 5).forEach((v, i) => {
    if (typeof v === "string" && !seen.has(v)) {
      out[i] = v;
      seen.add(v);
    }
  });
  return out;
}

function loadHistory(): { entries: HistoryEntry[]; order: (string | null)[] } {
  if (_historyFrozen) return frozenView();
  let raw: string;
  try {
    raw = readFileSync(HISTORY_PATH, "utf8");
  } catch {
    return { entries: [], order: normalizeOrder(undefined) }; // no file yet — fresh history
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    data = undefined;
  }
  if (!isPlainObject(data)) {
    // Corrupt (or not a history document): preserve the bytes for recovery
    // and freeze every write. The next recordLaunch would otherwise save the
    // empty in-memory history over the file and destroy counts/pins forever.
    _historyFrozen = true;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    try { renameSync(HISTORY_PATH, `${HISTORY_PATH}.corrupt-${stamp}`); } catch {}
    _historyFrozenSnapshot = { entries: [], order: normalizeOrder(undefined) };
    return _historyFrozenSnapshot;
  }
  const version = data.version;
  const knownVersion = version === undefined || version === null || version === 1 || version === HISTORY_VERSION;
  if (!knownVersion) {
    // A newer/unknown writer owns this file. Never migrate it down or
    // overwrite it; render the readable part in read-only mode.
    _historyFrozen = true;
    _historyFrozenSnapshot = {
      entries: Array.isArray(data.entries) ? data.entries : [],
      order: normalizeOrder(data.order),
    };
    return _historyFrozenSnapshot;
  }
  if (version === HISTORY_VERSION) {
    const entries: HistoryEntry[] = Array.isArray(data?.entries) ? data.entries : [];
    const order = normalizeOrder(data?.order);
    // Heal files written before one-shot flags were stripped at record time:
    // an already-poisoned quick-launch row cures itself on the next load
    // instead of replaying `claude --version` forever. Same concurrent-write
    // narrowing as the migration below — persist only if the file is still v2.
    if (healRecordedArgs(entries)) {
      // Re-read inside the lock: another process may have recorded a launch
      // between our load and this write.
      withFileLockSync(HISTORY_PATH, () => {
        try {
          const cur = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
          if (cur?.version === HISTORY_VERSION) {
            const curEntries: HistoryEntry[] = Array.isArray(cur.entries) ? cur.entries : [];
            const curOrder = normalizeOrder(cur.order);
            if (healRecordedArgs(curEntries)) saveHistory(curEntries, curOrder);
          }
        } catch {
          // unreadable or racing another process — heal in memory only; the
          // next recordLaunch persists the clean argv anyway
        }
      });
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
    _historyFrozenSnapshot = { entries: [], order: normalizeOrder(undefined) };
    return _historyFrozenSnapshot;
  }
  withFileLockSync(HISTORY_PATH, () => {
    try {
      // Narrow the concurrent-migration window: another switch process may have
      // migrated meanwhile; only persist when the file is still pre-v2.
      const cur = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
      if (cur?.version !== HISTORY_VERSION) saveHistory(migrated.entries, migrated.order);
    } catch {
      // unreadable now — keep the migrated view in memory only
    }
  });
  return migrated;
}

// Load for a WRITE path: a frozen history (corrupt / unknown version /
// failed migration) is read-only, so the caller must not mutate the returned
// view either (a first call can freeze mid-flight, e.g. corrupt JSON).
function loadHistoryForWrite() {
  const view = loadHistory();
  return _historyFrozen ? null : view;
}

// Read-modify-write transaction under the cross-process history lock. The
// callback always re-loads INSIDE the lock (never reuse a snapshot taken
// before the wait). Returns null when the lock timed out or the history is
// frozen; callers map that to their own failure value.
function mutateHistory<T>(fn: (entries: HistoryEntry[], order: (string | null)[]) => T): T | null {
  const result = withFileLockSync(HISTORY_PATH, () => {
    const loaded = loadHistoryForWrite();
    if (!loaded) return null;
    return fn(loaded.entries, loaded.order);
  });
  return result.acquired ? result.value : null;
}

// One-time v1→v2: resolve entry names to provider ids via the cc-switch DB.
// Strict DB access (errors propagate → loadHistory freezes writes) so a
// locked DB can't downgrade every live entry to a dead row.
//
// Names are not unique in the cc-switch DB. A name that matches more than one
// provider is left unbound (providerId:null) instead of silently picking the
// first row — those entries surface as missing and can be cleaned with `c`.
function migrateHistory(data) {
  const entries = (Array.isArray(data?.entries) ? data.entries : [])
    .filter((e) => e && typeof e.cli === "string" && typeof e.provider === "string");
  const appTypes = new Set<string>();
  for (const e of entries) {
    const t = APP_ADAPTERS[e.cli]?.appType;
    if (t) appTypes.add(t);
  }
  const idsByName = new Map<string, string[]>(); // `appType|name` → every matching id
  for (const appType of appTypes) {
    for (const p of queryProvidersStrict(appType)) {
      const k = `${appType}|${p.name}`;
      const ids = idsByName.get(k);
      if (ids) ids.push(p.id);
      else idsByName.set(k, [p.id]);
    }
  }
  const ambiguous = new Map<string, { appType: string; name: string; ids: string[] }>();
  const keyMap = new Map(); // old `cli|name` order-slot ids → new entryKey form
  for (const e of entries) {
    const appType = APP_ADAPTERS[e.cli]?.appType;
    const ids = idsByName.get(`${appType}|${e.provider}`) ?? [];
    if (ids.length === 1) {
      e.providerId = ids[0];
    } else {
      e.providerId = null;
      if (ids.length > 1) {
        ambiguous.set(`${appType}|${e.provider}`, { appType, name: e.provider, ids });
      }
    }
    if (!Array.isArray(e.extraArgs)) e.extraArgs = [];
    keyMap.set(`${e.cli}|${e.provider}`, entryKey(e));
  }
  for (const { appType, name, ids } of ambiguous.values()) {
    console.error(
      `⚠ ${ids.length} providers named "${name}" (${appType}) make history entries ambiguous ` +
      `(${ids.join(", ")}) — left unbound (shown as missing); launch with --id to rebind or rename one provider.`,
    );
  }
  const order = normalizeOrder(data?.order).map((slot) => (slot && keyMap.has(slot) ? keyMap.get(slot) : null));
  return { entries, order };
}

// Single write path so the manual order survives entry updates — recordLaunch
// used to rewrite the file from scratch, which would silently drop pins.
function saveHistory(entries, order) {
  // Single choke point for every write path: a frozen file (corrupt /
  // unknown version / failed migration) must never be replaced by whatever
  // the current process happened to parse. Some callers load and save in the
  // same call, so checking only at entry is not enough.
  if (_historyFrozen) return;
  atomicWrite(HISTORY_PATH, JSON.stringify({ version: HISTORY_VERSION, entries, order }, null, 2));
}

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
  // Duplicate slots are dropped here as well as in normalizeOrder: an entry
  // key must never render twice even if an old/migrated file holds it twice.
  const seenValid = new Set<string>();
  const valid = order.map((id) => {
    if (!id || seenValid.has(id) || !entries.some((e) => entryKey(e) === id)) return null;
    seenValid.add(id);
    return id;
  });
  const pinnedSet = new Set(valid.filter(Boolean));
  const cmp = (a, b) => byStrength(a, b, aliveByCli);
  const rep = (id) => entries.filter((e) => entryKey(e) === id).sort(cmp)[0];
  const seen = new Set<string>();
  const natural: HistoryEntry[] = [];
  for (const e of [...entries].sort(cmp)) {
    const k = entryKey(e);
    if (pinnedSet.has(k) || seen.has(k)) continue;
    seen.add(k);
    natural.push(e);
  }
  const out: HistoryEntry[] = [];
  let ni = 0;
  for (let i = 0; i < 5; i++) {
    if (valid[i]) out.push(rep(valid[i]));
    else if (ni < natural.length) out.push(natural[ni++]);
  }
  return out;
}

// The Recent rows, one per quick slot. Single constructor for both surfaces —
// the TUI's `a s d f g` keys and the command line's `switch a|s|d|f|g` must
// resolve a slot to the same provider, argv and mode; two copies of this
// projection would drift on pin order, renames and dead rows.
// `running` (● live) is TUI-only presentation state and is added by the caller.
function quickItemsFor(entries, order, aliveByCli) {
  return mergeTop5(entries, order, aliveByCli).map((e, i) => {
    const snap = aliveByCli?.get(e.cli);
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
    mutateHistory((entries, order) => {
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
    });
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
function stripPermissionArgs(args: string[]): string[] {
  const single = new Set([
    "--dangerously-skip-permissions",
    "--approve-for-me",
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  const out: string[] = [];
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
    return mutateHistory((entries, order) => {
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
    });
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
    return mutateHistory((entries, order) => {
      const slot = order.indexOf(key);
      if (slot >= 0) {
        order[slot] = null;
        saveHistory(entries, order);
      }
      return mergeTop5(entries, order, aliveByCli);
    });
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
    return mutateHistory((entries, order) => {
      const kept = entries.filter((e) => entryKey(e) !== key);
      const slot = order.indexOf(key);
      if (slot >= 0) order[slot] = null;
      saveHistory(kept, order);
      return mergeTop5(kept, order, aliveByCli);
    });
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
    const removed = mutateHistory((entries, order) => {
      const kept = entries.filter((e) => !isDeadEntry(e, aliveByCli));
      if (kept.length === entries.length) return 0;
      saveHistory(kept, order);
      return entries.length - kept.length;
    });
    return removed === null ? -1 : removed;
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
    return mutateHistory((entries, order) => {
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
    });
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


export { HISTORY_VERSION, ONE_SHOT_FLAGS, QUICK_KEYS, _historyFrozen, byStrength, entryKey, healRecordedArgs, insertManualOrder, isDeadEntry, loadHistory, mergeTop5, migrateHistory, normalizeOrder, permLabel, quickItemsFor, recordLaunch, relTime, removeAllDeadPairs, removeHistoryPair, saveHistory, setEntryHotkey, snapshotAliveByCli, stripOneShotFlags, stripPermissionArgs, top5, unpinPair };
