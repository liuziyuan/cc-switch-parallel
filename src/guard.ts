// ─── guard (split from bin/cc-launch.mjs) ─────────────────────────────

import { readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, ensurePrivateDir, readdirSyncSafe } from "./fs-utils.js";
import { deepEqualJson, diffSettingsLeaves, isPlainObject, parseJsonObject } from "./json-utils.js";
import { CC_SWITCH_DIR } from "./paths.js";
import { loadSyncState } from "./sessions.js";
import { isCodexAggModelPath } from "./stack/state.js";

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
    ensurePrivateDir(dir);
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
// target: "common" | "shared-live" | "provider" | "blocked-sensitive" | "blocked-virtual".
// The two blocked flavors must not share wording: a sensitive field is
// intentionally not synced (edit it in cc-switch), whereas a virtual-row edit
// has no DB row to land in and is rebuilt from desktop state next launch.
function formatSettingsChangeLine(ch, target) {
  const mark = ch.op === "add" ? "+" : ch.op === "remove" ? "-" : "~";
  const color = ch.op === "add" ? "\x1b[32m" : ch.op === "remove" ? "\x1b[31m" : "\x1b[33m";
  const targetTag =
    target === "common" ? " \x1b[2m(→ common config)\x1b[0m"
    : target === "shared-live" ? " \x1b[2m(→ global live config)\x1b[0m"
    : target === "blocked-virtual" ? " \x1b[33m(⚠ aggregation virtual row — not written back to the database)\x1b[0m"
    : target === "blocked-sensitive" || target === "blocked"
      ? " \x1b[33m(⚠ sensitive — NOT synced, edit in cc-switch)\x1b[0m"
    : " \x1b[2m(→ provider)\x1b[0m";
  return `${color}${mark} settings\x1b[0m ${ch.path}${targetTag}`;
}

// Overwrite guard, CLI-agnostic: right before prepare regenerates an
// instance's main config file, diff what sits on disk against the recorded
// baseline. Unsynchronized edits get a warning + a backup instead of
// vanishing silently. Channel-owned [C6] and runtime-state paths are
// filtered out. Capability-probed (C2 + C3), never appType-branched —
// an adapter without both is v2-shaped and skips the guard entirely.
function guardInstanceConfigBeforeOverwrite(adapter, row, instanceDir, shared, settings) {
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
        parseJsonObject(row.settings_config) ?? {}, parseJsonObject(row.meta) ?? {},
        row.category, shared, row.id, settings,
      );
      const backfilled = effective != null && deepEqualJson(effective, current);
      if (!backfilled) {
        const bak = backupInstanceSettings(adapter.appType, row.id, instanceDir, adapter.instanceSettingsFileName);
        process.stderr.write(`\x1b[2m${adapter.instanceSettingsFileName} for "${row.name}" differs from the cc-switch config; a backup was saved${bak ? ` (${bak})` : " (backup FAILED)"} before overwriting.\x1b[0m\n`);
      }
      return;
    }

    const changes = diffSettingsLeaves(entry.preparedSettings, current).filter(
      (ch) => !adapter.channelOwnedPath?.(ch.path) && !adapter.runtimeStatePath?.(ch.path, ch)
        && !isCodexAggModelPath(adapter.appType, row.id, ch.path),
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


export { BACKUPS_DIR, BACKUP_KEEP, backupDirFor, backupInstanceSettings, formatSettingsChangeLine, guardInstanceConfigBeforeOverwrite, isPluginChannelPath, pruneInstanceSettingsBackups };
