// ─── stack/legacy-cleanup ──────────────────────────────────────────────
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
//
// Lives outside stack/state so state no longer has to import history.

import { execDB, queryDB, sqlQuote } from "../db.js";
import { atomicWrite } from "../fs-utils.js";
import { withFileLockSync } from "../file-lock.js";
import { _historyFrozen, loadHistory, saveHistory } from "../history.js";
import { isPlainObject } from "../json-utils.js";
import { HISTORY_PATH, STATUSLINE_PREFS_PATH, VIRTUAL_STACK_PROVIDER_ID } from "../paths.js";
import { loadStatuslinePreferences } from "../statusline-colors.js";
import { isAggregationProviderSettings } from "./aggregation.js";

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

export { cleanupLegacyStackRows, reportLegacyStackCleanup };
