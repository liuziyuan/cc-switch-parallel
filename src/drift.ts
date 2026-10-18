// ─── drift (split from bin/cc-launch.mjs) ─────────────────────────────

import { join, resolve } from "node:path";
import { APP_ADAPTERS, computeEnabledPluginsPatch } from "./adapters.js";
import { loadSettings, queryCommonConfig, queryProviderById, queryProvidersByApp } from "./db.js";
import { formatSettingsChangeLine, guardInstanceConfigBeforeOverwrite } from "./guard.js";
import { VIRTUAL_STACK_PROVIDER_ID } from "./paths.js";
import { loadSyncState, saveSyncState, sha256, withSyncStateLock } from "./sessions.js";
import { classifyConfirmKey, fitLine, sanitizeAnsiLine, sanitizeText } from "./terminal-utils.js";
import { parseJsonObject } from "./json-utils.js";
import { collectPatchPaths } from "./upward.js";

// ─── Config drift detection & sync ────────────────────────────────────

// Downward drift: cc-switch's common config snippet changed since a given
// instance last had its settings.json generated (state.instances[appType][id]
// .commonHash, recorded by recordInstanceBaseline() at prepare time — NOT a
// single global hash, so syncing plugins for one instance can't silently mark
// every other instance's common-config drift as resolved).
// Returns { appType: [providerId, ...] } for each app with stale instances.
function collectStaleInstanceIds(state: any): Record<string, string[]> {
  const stale: Record<string, string[]> = {};
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
function detectCommonConfigDrift(state: any): Record<string, string[]> {
  const drift: Record<string, string[]> = {};
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
function refreshStaleInstances(state: any, staleByApp: Record<string, string[]>) {
  const refreshed: string[] = [];
  const refreshedIds: Record<string, string[]> = {};
  const removedIds: Record<string, string[]> = {};
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
        (removedIds[appType] ||= []).push(id);
        continue;
      }
      try {
        const parsedSettings = parseJsonObject(row.settings_config);
        const parsedMeta = parseJsonObject(row.meta);
        if (!parsedSettings || !parsedMeta) {
          console.error(`⚠ Provider "${row.name || row.id}" has malformed ${!parsedSettings ? "settings_config" : "meta"} JSON — skipping refresh.`);
          continue; // keep the old baseline so the drift stays visible
        }
        const settingsConfig = parsedSettings;
        const meta = parsedMeta;
        const instanceDir = adapter.setupInstance(row.id);
        // Guard BEFORE prepare overwrites — this refresh path historically
        // wiped other instances' own unsynced edits with zero warning.
        guardInstanceConfigBeforeOverwrite(adapter, row, instanceDir, commonSnippet, settings);
        adapter.prepare(instanceDir, row.id, settingsConfig, meta, row.category, commonSnippet, settings);
        state.instances[appType][row.id] = buildInstanceBaselineEntry(
          adapter, instanceDir, commonSnippet,
        );
        (refreshedIds[appType] ||= []).push(row.id);
        refreshed.push(row.name);
      } catch {
        // best-effort: keep the old baseline so the drift stays visible.
      }
    }
  }
  return { refreshed, refreshedIds, removedIds };
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
function buildInstanceBaselineEntry(adapter: any, instanceDir: string, commonSnippet: string): any {
  const entry: any = { commonHash: sha256(commonSnippet || ""), preparedAt: Date.now() };
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
    withSyncStateLock((state) => {
      state.instances = state.instances || {};
      state.instances[adapter.appType] = state.instances[adapter.appType] || {};
      state.instances[adapter.appType][providerId] = buildInstanceBaselineEntry(
        adapter, instanceDir, commonSnippet,
      );
      state.version = 3;
      saveSyncState(state);
    });
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

// Persist the sync result WITHOUT clobbering concurrent writers: the user
// interaction can take arbitrarily long, so the state read at entry is stale
// by now. Take the lock, re-read, and merge only what this run actually
// touched — refreshed/removed instance baselines and, when the plugin channel
// ran, the claude plugin baseline. Everything else stays as on disk.
function mergeAndSaveSyncState(
  local: any,
  refreshedIds: Record<string, string[]>,
  removedIds: Record<string, string[]>,
  pluginSynced: boolean,
) {
  const result = withSyncStateLock((fresh) => {
    fresh.instances = fresh.instances || {};
    for (const [appType, ids] of Object.entries(removedIds || {})) {
      for (const id of ids) {
        if (fresh.instances[appType]) delete fresh.instances[appType][id];
      }
    }
    for (const [appType, ids] of Object.entries(refreshedIds || {})) {
      fresh.instances[appType] = fresh.instances[appType] || {};
      for (const id of ids) {
        const localEntry = local.instances?.[appType]?.[id];
        if (!localEntry) continue;
        const freshEntry = fresh.instances[appType][id];
        // Another process may have refreshed the same instance later; keep
        // the newer baseline.
        if (!freshEntry || (localEntry.preparedAt || 0) >= (freshEntry.preparedAt || 0)) {
          fresh.instances[appType][id] = localEntry;
        }
      }
    }
    if (pluginSynced && local.claude) fresh.claude = local.claude;
    fresh.version = Math.max(3, fresh.version || 0);
    saveSyncState(fresh);
    return true;
  });
  return result === true;
}

// Interactive yes/no confirm (TTY only). Returns:
//   yes       — user pressed y/Y
//   no        — any other key (or a non-TTY caller)
//   interrupt — Ctrl-C: the caller must abort, not continue as "no"
//   eof       — stdin closed while waiting
function confirmSync(
  lines,
  question = "Sync these changes?",
  io: { stdin?: any; stdout?: any; stderr?: any } = {},
): Promise<"yes" | "no" | "interrupt" | "eof"> {
  const stdin = io.stdin || process.stdin;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  return new Promise((resolve) => {
    if (!stdin.isTTY || !stdout.isTTY) {
      resolve("no");
      return;
    }
    const cols = Math.max(20, (stderr.columns || stdout.columns || 80) - 2);
    for (const line of lines) stderr.write(`  ${fitLine(sanitizeAnsiLine(line), cols)}\n`);
    stderr.write(`\n  \x1b[1m${fitLine(sanitizeText(question), cols)}\x1b[0m [y/N] `);

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      try { stdin.setRawMode(false); } catch {}
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      stdin.removeListener("error", onEnd);
      // pause() is required, not just removeListener: stdin stays in flowing
      // mode after the earlier resume(), and a flowing stream with no data
      // listeners still READS and DISCARDS tty bytes — the spawned CLI would
      // lose keystrokes.
      try { stdin.pause(); } catch {}
    };
    const onData = (data) => {
      const key = data.toString();
      const outcome = classifyConfirmKey(key);
      cleanup();
      stderr.write(outcome === "interrupt" ? "^C\n" : `${key.trim()}\n`);
      resolve(outcome);
    };
    const onEnd = () => {
      cleanup();
      resolve("eof");
    };
    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.on("close", onEnd);
      stdin.on("error", onEnd);
    } catch {
      cleanup();
      resolve("no");
    }
  });
}

// Entry point: detect common-config + plugin drift, then prompt (TUI) or warn
// (command mode, unless quiet) or stay silent (quiet — for --sync/--no-sync
// scripted callers that only care about the return value). Returns
// { synced, drifted, refreshed? } — on a confirmed sync, `refreshed` lists the
// provider names whose stale live configs were just regenerated in place.
async function detectAndPromptSync({ tui = false, quiet = false } = {}) {
  let state = loadSyncState();

  // First run: no plugin baseline yet — establish it silently so subsequent
  // plugin changes are detectable (don't report existing plugins as "added"
  // on the very first sync). The plugin baseline is claude's concept (codex
  // has no plugin channel), but this early-return must NOT skip the rest of
  // the flow: common-config drift for EVERY app is checked below, and
  // skipping it here used to hide codex staleness on the first run.
  if (!state?.claude?.installedPluginKeys) {
    // Re-check inside the lock: another terminal may have established the
    // baseline between our load and this write.
    const fresh = withSyncStateLock((s) => {
      if (!s?.claude?.installedPluginKeys) {
        snapshotSyncState(s, ["claude"]);
        saveSyncState(s);
      }
      return s;
    });
    if (fresh) state = fresh;
    // fall through: the plugin baseline is now established, so the plugin
    // channel below won't misreport pre-existing plugins as "added" — but
    // per-instance baselines are simply absent until each instance is next
    // launched, and instances without one are skipped, not flagged.
  }

  const commonDrift = detectCommonConfigDrift(state);

  const pluginDrifts: Record<string, any> = {};
  for (const [cmd, adapter] of Object.entries(APP_ADAPTERS)) {
    if ((adapter as any).detectPluginDrift) {
      const d = (adapter as any).detectPluginDrift(state);
      if (d) pluginDrifts[cmd] = d;
    }
  }

  // Channel 2: non-plugin config fields (every adapter with C2-C5; v3 baselines).
  const settingsDrifts: Record<string, any> = {};
  for (const [cmd, adapter] of Object.entries(APP_ADAPTERS)) {
    if ((adapter as any).detectSettingsDrift) {
      const d = (adapter as any).detectSettingsDrift(state);
      if (d) settingsDrifts[cmd] = d;
    }
  }

  const hasCommon = Object.keys(commonDrift).length > 0;
  const hasPlugin = Object.keys(pluginDrifts).length > 0;
  const hasSettings = Object.keys(settingsDrifts).length > 0;
  if (!hasCommon && !hasPlugin && !hasSettings) return { synced: false, drifted: false };

  if (quiet) return { synced: false, drifted: true };

  // Build the change summary (dedup added/removed vs toggled).
  const lines: string[] = [];
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
        const target = blockedPaths.has(ch.path)
          ? (d.rejectedReasons?.[ch.path] === "virtual" ? "blocked-virtual" : "blocked-sensitive")
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
    // Virtual Stack entry: provider-target edits have no DB row to land in —
    // shown as blocked above; spell out why so it doesn't read as a bug.
    if (d.virtualBlocked) {
      lines.push(`\x1b[2m(聚合入口「${VIRTUAL_STACK_PROVIDER_ID}」为运行时虚拟行，不写回数据库——实例配置每次启动由桌面端状态重新生成)\x1b[0m`);
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

  // TUI mode: interactive confirm, then write back on "y". The TTY check is
  // AFTER drift detection so a scripted `switch sync` with nothing to sync
  // still exits 0 instead of demanding a terminal.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { synced: false, drifted: true, needsTTY: true };
  }
  const outcome = await confirmSync(lines);
  if (outcome === "interrupt") return { synced: false, drifted: true, interrupted: true };
  if (outcome === "eof") return { synced: false, drifted: true, inputClosed: true };
  if (outcome === "yes") {
    const syncedCmds: string[] = [];
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
    const refreshResult = refreshStaleInstances(state, collectStaleInstanceIds(state));
    snapshotSyncState(state, syncedCmds);
    const stateSaved = mergeAndSaveSyncState(
      state, refreshResult.refreshedIds, refreshResult.removedIds, syncedCmds.includes("claude"),
    );
    return {
      synced: true, drifted: true, refreshed: refreshResult.refreshed,
      stateSkipped: !stateSaved,
    };
  }
  return { synced: false, drifted: true };
}


export { buildInstanceBaselineEntry, collectStaleInstanceIds, confirmSync, detectAndPromptSync, detectCommonConfigDrift, mergeAndSaveSyncState, recordInstanceBaseline, refreshStaleInstances, snapshotSyncState };
