// ─── stack/state (split from bin/cc-launch.mjs) ─────────────────────────────

import { join } from "node:path";
import net from "node:net";
import { execDB, queryDB, queryProviderById, sqlQuote } from "../db.js";
import { atomicWrite } from "../fs-utils.js";
import { _historyFrozen, loadHistory, saveHistory } from "../history.js";
import { isPlainObject } from "../json-utils.js";
import type { ProviderRow } from "../types.js";
import { withFileLockSync } from "../file-lock.js";
import { HISTORY_PATH, STATUSLINE_PREFS_PATH, VIRTUAL_STACK_PROVIDER_ID } from "../paths.js";
import {
  AGGREGATION_IDENTITY_ENV_KEYS,
  AGGREGATION_MODEL_ALIAS_KEYS,
  aggregationBaseUrlFor,
  isAggregationProviderSettings,
  isCodexAggregationProviderSettings,
  isLoopbackBaseUrl,
  protectAggregationIdentityEnv,
  providerIsAggregation,
} from "./aggregation.js";
import { readStackState } from "./live-state.js";
export { readGlobalModelPicker, readStackState } from "./live-state.js";
import { appendVirtualStackRowCore, virtualStackProviderForCore } from "./virtual-row.js";
export {
  STACK_SETTINGS_DERIVERS,
  buildCodexStackSettingsFromGlobal,
  buildStackSettingsFromGlobal,
  codexStackDormantSettings,
} from "./virtual-row.js";
import { buildUsageQueryConfig, resolveUsageIdentity } from "./usage.js";
import { loadStatuslinePreferences } from "../statusline-colors.js";

// ─── cc-switch 4.0 aggregation (Stack) ────────────────────────────────
// Upstream cc-switch 4.0 "aggregation" runs a local HTTP proxy (default
// 127.0.0.1:15721) that publishes member providers' models into one Claude
// Code /model picker under `ccs-claude-<key>--<model>` ids. This CLI never
// enters/exits the mode (that is a desktop-app action) — it only CONSUMES its
// state so a proxy-endpoint provider behaves like any other parallel member:
//
//   • a provider whose env.ANTHROPIC_BASE_URL points at a loopback address is
//     treated as an aggregation instance: its wrapper gets a per-key usage map
//     (each member queried with its OWN credentials, direct to the member's
//     real origin — the proxy never sees usage traffic), the current key is
//     decoded at runtime from the statusline model id, and the instance
//     settings.json picks up the desktop app's `modelPicker` block (the /model
//     list lives in settings.json, NOT in /v1/models discovery).
//   • live-state.json is device-local upstream state with no stability
//     promise: every read here is fail-open (missing/corrupt/off → the
//     aggregation features silently vanish, the single-provider path runs).
//   • the TUI shows loopback providers under an aggregation label with the
//     live member names, and can auto-create the entry row when the desktop
//     app has aggregation on but no loopback provider exists yet.

// Loopback host = the aggregation proxy endpoint (a plain provider never
// points at one; a user's own local gateway would simply not match a live
// stack and fall through to the regular single-provider path).
//
// Moved to stack/aggregation.ts so usage.ts can reuse it without importing
// this module. Re-exported below to keep the public surface stable.

// `model` on a codex AGGREGATION instance is carried across prepare
// (mergeCodexRuntimeState's isAgg branch) and has no DB row to sync into
// (virtual entry, or a hand-managed proxy row) — the edit would only ever
// surface as a blocked sync prompt, and the carry means prepare does NOT
// overwrite it. Yield the path like runtime state in the guard and the drift
// diff. Plain codex rows are unaffected: their /model pick still flows
// through guard + sync write-back (established semantics).
function isCodexAggModelPath(appType, providerId, path) {
  if (appType !== "codex" || path !== "model") return false;
  if (providerId === VIRTUAL_STACK_PROVIDER_ID) return true;
  try {
    const row = queryProviderById(providerId, "codex");
    return !!row && isCodexAggregationProviderSettings(JSON.parse(row.settings_config || "{}"));
  } catch {
    return false;
  }
}

// 300ms TCP probe of a base URL's host:port. Warn-only by design — the
// aggregation proxy lives and dies with the desktop app (README: "re-open
// the desktop app"), so an unreachable proxy must gate nothing, just say so.
async function probeTcpReachable(baseUrl: string, timeoutMs = 300): Promise<boolean> {
  try {
    const u = new URL(baseUrl);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (!u.hostname || !Number.isFinite(port)) return false;
    return await new Promise((resolve) => {
      const socket = net.connect({ host: u.hostname, port });
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        done(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        done(false);
      });
    });
  } catch {
    return false;
  }
}

// Derive the virtual aggregation row with the DB names injected. The file-only
// halves live in stack/live-state and stack/virtual-row, so db.ts can use them
// without importing this module (breaks the db → state cycle).
function takenProviderNames(appType) {
  try {
    return queryDB(`SELECT name FROM providers WHERE app_type = ${sqlQuote(appType)}`).map(
      (r) => r.name,
    );
  } catch {
    return [];
  }
}

function virtualStackProviderFor(appType) {
  return virtualStackProviderForCore(appType, takenProviderNames(appType));
}

function appendVirtualStackRow(rows, appType) {
  return appendVirtualStackRowCore(rows, appType, takenProviderNames(appType));
}

// Per-member usage config map for an aggregation instance. Each member is
// resolved with its OWN settings_config + meta (never the aggregation row's
// proxy placeholder token) — the same resolveUsageIdentity the member would
// get as a direct provider. Members without a resolvable identity are simply
// absent from the map (no usage cell for them, never an error).
function buildStackUsageConfig(stack, instanceDir, wrapperPath) {
  const map: Record<string, any> = {};
  const names: Record<string, any> = {};
  for (const [key, providerId] of Object.entries(stack.keys) as [string, string][]) {
    let row: ProviderRow | null = null;
    try {
      row = queryProviderById(providerId, "claude");
    } catch {
      row = null;
    }
    if (!row) continue;
    let sc: any = null;
    let meta: any = null;
    try {
      sc = JSON.parse(row.settings_config);
    } catch {
      sc = null;
    }
    try {
      meta = JSON.parse(row.meta);
    } catch {
      meta = null;
    }
    const cfg = buildUsageQueryConfig(
      resolveUsageIdentity(sc, meta),
      join(instanceDir, `usage-stack-${key}.json`),
      wrapperPath,
    );
    if (!cfg) continue;
    map[key] = cfg;
    names[key] = row.name;
  }
  if (!Object.keys(map).length) return null;
  let defaultKey: string | null = null;
  if (stack.proxyRoute) {
    defaultKey = Object.keys(stack.keys).find((k) => stack.keys[k] === stack.proxyRoute) || null;
    if (defaultKey && !map[defaultKey]) defaultKey = null;
  }
  return { defaultKey, names, map, selfPath: wrapperPath };
}

// TUI helper: the aggregation group for an app's provider list. The entry is
// the RUNTIME-VIRTUAL row (virtualStackProviderFor) — never written to the DB,
// so the desktop GUI sees nothing — plus any DB rows matching the loopback +
// PROXY_MANAGED signature (legacy auto-created rows pending one-time cleanup,
// and hand-made ones, which today already take the aggregation label). Every
// loopback provider is labeled with the live member names — "◆ Aggregation ·
// Stack (DeepSeek + Z.AI GLM)", or "(inactive)" when the desktop app has the
// stack off (the entry still launches; it just proxies nothing until
// re-enabled). Returns { ids: Set, labels: Map<id, label> }, or null when no
// aggregation provider exists at all.
function buildAggregationGroup(appType) {
  const rows = queryDB(
    `SELECT id, name, settings_config FROM providers WHERE app_type = ${sqlQuote(appType)}`,
  );
  const aggRows: any[] = [];
  for (const r of rows) {
    try {
      if (providerIsAggregation(appType, JSON.parse(r.settings_config))) aggRows.push(r);
    } catch {}
  }
  const virtual = virtualStackProviderFor(appType);
  if (virtual && !aggRows.some((r) => r.id === virtual.id)) aggRows.push(virtual);
  if (!aggRows.length) return null;
  const stack = readStackState(appType);
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const memberIds = stack ? [...new Set(stack.members)] : [];
  const members = memberIds.map((id) => nameById.get(id)).filter(Boolean);
  // A member whose provider row is gone renders as a silent short-list
  // today — say so, or the missing usage segment reads as a bug.
  const missingCount = memberIds.length - members.length;
  const missingText = stack && missingCount > 0 ? `, ${missingCount} member(s) missing` : "";
  const memberText = members.length
    ? ` (${members.join(" + ")}${missingText})`
    : stack
      ? missingCount > 0
        ? ` (${missingCount} member(s) missing)`
        : ""
      : " (inactive)";
  return {
    ids: new Set(aggRows.map((r) => r.id)),
    labels: new Map(aggRows.map((r) => [r.id, `◆ Aggregation · ${r.name}${memberText}`])),
  };
}

// One-time migration for the pre-virtualization era: versions ≤0.19 INSERTed a
// real DB row for the aggregation entry (randomUUID id, loopback + PROXY_MANAGED
// signature). The virtual entry replaces it — the DB row would keep showing up
// in the desktop GUI forever, so it is deleted here and every id-keyed reference
// (launch history entries + pin slots, statusline colors) moves to the stable
// virtual id. Runs on TUI open and before every claude launch (command mode
// never opens the TUI). Idempotent: no signature rows → null, zero output.
// Skips is_current rows (the desktop app is actively pointed at them — deleting
// would dangle its current-provider state). Fail-open: a locked/unreadable DB
// or a frozen history just skips this pass; the next run retries.
// Old instance dirs (UUID-named) are deliberately NOT renamed — a running
// session keeps working; `switch clean` reaps them once the session ends.
function cleanupLegacyStackRows() {
  let rows: any[] = [];
  try {
    rows = queryDB(
      "SELECT id, name, settings_config, is_current FROM providers WHERE app_type = 'claude'",
    );
  } catch {
    return null; // DB unavailable — retry next run
  }
  const legacy: any[] = [];
  for (const r of rows) {
    try {
      if (isAggregationProviderSettings(JSON.parse(r.settings_config))) legacy.push(r);
    } catch {}
  }
  if (!legacy.length) return null;
  const removed: any[] = [];
  const skippedCurrent: any[] = [];
  for (const r of legacy) {
    if (r.is_current) {
      skippedCurrent.push(r.name);
      continue;
    }
    try {
      execDB(`DELETE FROM providers WHERE id = ${sqlQuote(r.id)} AND app_type = 'claude'`);
      removed.push({ id: r.id, name: r.name });
    } catch {
      // locked mid-write — the row survives this pass, next run retries
    }
  }
  if (!removed.length)
    return { removed, skippedCurrent, migratedHistory: false, migratedColors: false };

  // launch_history: point entries and pin slots at the virtual id; entries that
  // collide after the rewrite (same cli|id|hotkey) merge keeping the stronger
  // count/lastUsed. Frozen history (failed migration at load) is left alone —
  // the rows are already deleted, so those entries read dead until cleanup.
  let migratedHistory = false;
  if (!_historyFrozen) {
    try {
      const locked = withFileLockSync(HISTORY_PATH, () => {
        const removedIds = new Set(removed.map((r) => r.id));
        const { entries, order } = loadHistory();
        let touched = false;
        for (const e of entries) {
          if (e.providerId && removedIds.has(e.providerId)) {
            e.providerId = VIRTUAL_STACK_PROVIDER_ID;
            touched = true;
          }
        }
        // merge duplicates born from the rewrite: prefer count, then lastUsed
        const byKey = new Map();
        const merged: any[] = [];
        for (const e of entries) {
          const k = `${e.cli}|${e.providerId ?? e.provider}|${e.hotkey ?? ""}`;
          const prev = byKey.get(k);
          if (!prev) {
            byKey.set(k, e);
            merged.push(e);
            continue;
          }
          if (
            (e.count || 0) > (prev.count || 0) ||
            ((e.count || 0) === (prev.count || 0) && (e.lastUsed || 0) > (prev.lastUsed || 0))
          ) {
            byKey.set(k, e);
            merged[merged.indexOf(prev)] = e;
          }
          touched = true;
        }
        // Several legacy ids map to the same virtual id: dedupe the slots,
        // otherwise the same Recent row renders twice.
        const slotMap = new Map(
          removed.map((r) => [`claude|${r.id}`, `claude|${VIRTUAL_STACK_PROVIDER_ID}`]),
        );
        const seenOrder = new Set();
        let orderChanged = false;
        const nextOrder = order.map((slot) => {
          const mapped = slot && slotMap.has(slot) ? slotMap.get(slot) : slot;
          if (mapped !== slot) orderChanged = true;
          if (mapped && seenOrder.has(mapped)) {
            orderChanged = true;
            return null;
          }
          if (mapped) seenOrder.add(mapped);
          return mapped;
        });
        if (touched || orderChanged) saveHistory(merged, nextOrder);
        return touched || orderChanged;
      });
      migratedHistory = locked.acquired ? locked.value : false;
    } catch {
      /* history is best-effort — never block on it */
    }
  }

  // statusline colors: same id-keyed move, existing value for the virtual id wins
  let migratedColors = false;
  try {
    const locked = withFileLockSync(STATUSLINE_PREFS_PATH, () => {
      const prefs = loadStatuslinePreferences();
      if (!prefs || !isPlainObject(prefs.colors?.claude)) return false;
      const bucket = prefs.colors.claude;
      let changed = false;
      for (const oldId of removed.map((r) => r.id)) {
        if (bucket[oldId] === undefined) continue;
        if (bucket[VIRTUAL_STACK_PROVIDER_ID] === undefined)
          bucket[VIRTUAL_STACK_PROVIDER_ID] = bucket[oldId];
        delete bucket[oldId];
        changed = true;
      }
      if (changed) atomicWrite(STATUSLINE_PREFS_PATH, JSON.stringify(prefs, null, 2));
      return changed;
    });
    migratedColors = locked.acquired ? locked.value : false;
  } catch {
    /* best-effort */
  }

  return { removed, skippedCurrent, migratedHistory, migratedColors };
}

function reportLegacyStackCleanup(result) {
  if (!result) return;
  for (const r of result.removed) {
    console.error(
      `◇ Removed legacy aggregation provider row "${r.name}" (now served by runtime virtual entry ${VIRTUAL_STACK_PROVIDER_ID}; no longer shown in the desktop GUI)`,
    );
  }
  if (result.migratedHistory) {
    console.error(
      `  Launch history and pins migrated to virtual entry ${VIRTUAL_STACK_PROVIDER_ID}`,
    );
  }
  if (result.migratedColors) {
    console.error(
      `  Statusline color preferences migrated to virtual entry ${VIRTUAL_STACK_PROVIDER_ID}`,
    );
  }
  for (const name of result.skippedCurrent) {
    console.error(
      `\x1b[33m⚠ Aggregation row "${name}" is in use by the desktop app (is_current) — kept; it will be cleaned up on the next run after you switch away in the desktop app\x1b[0m`,
    );
  }
}

export {
  AGGREGATION_IDENTITY_ENV_KEYS,
  AGGREGATION_MODEL_ALIAS_KEYS,
  aggregationBaseUrlFor,
  appendVirtualStackRow,
  buildAggregationGroup,
  buildStackUsageConfig,
  cleanupLegacyStackRows,
  isAggregationProviderSettings,
  isCodexAggModelPath,
  isCodexAggregationProviderSettings,
  isLoopbackBaseUrl,
  probeTcpReachable,
  protectAggregationIdentityEnv,
  providerIsAggregation,
  reportLegacyStackCleanup,
  virtualStackProviderFor,
};
