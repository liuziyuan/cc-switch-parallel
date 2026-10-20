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
const backupDirFor = (appType: any, providerId: any) => join(BACKUPS_DIR, appType, providerId);

function backupInstanceSettings(
  appType: any,
  providerId: any,
  instanceDir: any,
  fileName = "settings.json",
) {
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
    for (const name of keep) {
      try {
        unlinkSync(join(dir, name));
      } catch {}
    }
    return dest;
  } catch {
    return null;
  }
}

// Remove the backup tree of instances whose provider row is gone — called
// from clean's baseline pruning, same best-effort contract (a state-file
// hiccup must not fail the clean itself).
function pruneInstanceSettingsBackups(instances: any) {
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
function isPluginChannelPath(path: any) {
  return path === "enabledPlugins" || path.startsWith("enabledPlugins.");
}

// Format one diff entry as a display line for the warning/prompt lists.
// target: "common" | "shared-live" | "provider" | "blocked-sensitive" | "blocked-virtual".
// The two blocked flavors must not share wording: a sensitive field is
// intentionally not synced (edit it in cc-switch), whereas a virtual-row edit
// has no DB row to land in and is rebuilt from desktop state next launch.
function formatSettingsChangeLine(ch: any, target: any) {
  const mark = ch.op === "add" ? "+" : ch.op === "remove" ? "-" : "~";
  const color = ch.op === "add" ? "\x1b[32m" : ch.op === "remove" ? "\x1b[31m" : "\x1b[33m";
  const targetTag =
    target === "common"
      ? " \x1b[2m(→ common config)\x1b[0m"
      : target === "shared-live"
        ? " \x1b[2m(→ global live config)\x1b[0m"
        : target === "blocked-virtual"
          ? " \x1b[33m(⚠ aggregation virtual row — not written back to the database)\x1b[0m"
          : target === "blocked-sensitive" || target === "blocked"
            ? " \x1b[33m(⚠ sensitive — NOT synced, edit in cc-switch)\x1b[0m"
            : " \x1b[2m(→ provider)\x1b[0m";
  return `${color}${mark} settings\x1b[0m ${ch.path}${targetTag}`;
}

// ─── Overwrite classification ─────────────────────────────────────────
// A warning is only truthful when the value about to be written differs
// from what the user currently has. Comparing the baseline with the file
// alone cannot tell that: an in-session edit that already equals the shared
// config (e.g. hooks installed both globally and inside the instance) shows
// up as "changed since baseline" even though prepare writes the same value
// back. So classify against THREE trees:
//   B = preparedSettings (last prepare's output)
//   C = the instance file on disk
//   T = computeEffectiveSettings(...) — exactly what prepare will write
// User edits in diff(B,C) whose paths also differ in diff(T,C) are the only
// ones the overwrite can actually destroy.

type GuardResultKind =
  | "unsupported"
  | "no-current"
  | "ambiguous"
  | "unchanged"
  | "preserved"
  | "lossy"
  | "unknown-target"
  | "error";

type GuardResult = {
  kind: GuardResultKind;
  changes: any[];
  targetChanges?: any[];
  backupPath?: string | null;
};

// Channel-owned [C6] and runtime-state paths never participate in the
// guard's classification — the same filter must apply to BOTH diffs.
function filterGuardChanges(adapter: any, providerId: any, changes: any[]) {
  return changes.filter(
    (ch) =>
      !adapter.channelOwnedPath?.(ch.path) &&
      !adapter.runtimeStatePath?.(ch.path, ch) &&
      !isCodexAggModelPath(adapter.appType, providerId, ch.path),
  );
}

// True when one dotted path is the other or an ancestor of it. Segments come
// from diffSettingsLeaves, so keys containing dots can't be misread as a
// prefix match. Either direction counts: a whole-subtree change covers an
// edit inside it, and an edit covering a subtree covers a leaf change.
function segmentsOverlap(a: any[] = [], b: any[] = []) {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Single entry point for "what would prepare write". writeWrapper:false keeps
// the claude derivation from touching the statusline wrapper file as a side
// effect (codex ignores the option). A failed derivation returns null and the
// caller falls back to the conservative baseline diff.
function computeGuardTarget(adapter: any, row: any, shared: any, settings: any) {
  if (typeof adapter.computeEffectiveSettings !== "function") return null;
  try {
    return (
      adapter.computeEffectiveSettings(
        parseJsonObject(row.settings_config) ?? {},
        parseJsonObject(row.meta) ?? {},
        row.category,
        shared,
        row.id,
        settings,
        { writeWrapper: false },
      ) ?? null
    );
  } catch {
    return null;
  }
}

// Pure classifier (exported for tests). `userChanges` is already filtered
// diff(B,C); the returned `changes` are the subset that T will overwrite.
function classifyOverwrite(
  adapter: any,
  providerId: any,
  userChanges: any[],
  current: any,
  target: any | null,
): {
  kind: "unchanged" | "preserved" | "lossy" | "unknown-target";
  changes: any[];
  targetChanges: any[];
} {
  if (userChanges.length === 0) return { kind: "unchanged", changes: [], targetChanges: [] };
  if (target == null) return { kind: "unknown-target", changes: userChanges, targetChanges: [] };
  const targetChanges = filterGuardChanges(
    adapter,
    providerId,
    diffSettingsLeaves(target, current),
  );
  const lost = userChanges.filter((u) =>
    targetChanges.some((t) => segmentsOverlap(u.segments, t.segments)),
  );
  return lost.length
    ? { kind: "lossy", changes: lost, targetChanges }
    : { kind: "preserved", changes: [], targetChanges };
}

// Overwrite guard, CLI-agnostic: right before prepare regenerates an
// instance's main config file, classify what sits on disk against both the
// recorded baseline and the value prepare is about to write. Only edits that
// the write will actually replace get a warning + a backup; edits already
// reflected in the target are reported with one dim line (or silently when
// the file is an untouched stale mirror). Channel-owned [C6] and
// runtime-state paths are filtered out. Capability-probed (C2 + C3), never
// appType-branched — an adapter without both is v2-shaped and skips the guard
// entirely. The return value is diagnostic only: callers must still prepare.
function guardInstanceConfigBeforeOverwrite(
  adapter: any,
  row: any,
  instanceDir: any,
  shared: any,
  settings: any,
): GuardResult {
  try {
    if (!adapter.readInstanceSettingsSnapshot || !adapter.computeEffectiveSettings)
      return { kind: "unsupported", changes: [] };
    const current = adapter.readInstanceSettingsSnapshot(instanceDir);
    if (!current) return { kind: "no-current", changes: [] }; // missing/corrupt — nothing to protect

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
      const effective = computeGuardTarget(adapter, row, shared, settings);
      const backfilled = effective != null && deepEqualJson(effective, current);
      if (!backfilled) {
        const bak = backupInstanceSettings(
          adapter.appType,
          row.id,
          instanceDir,
          adapter.instanceSettingsFileName,
        );
        process.stderr.write(
          `\x1b[2m${adapter.instanceSettingsFileName} for "${row.name}" differs from the cc-switch config; a backup was saved${bak ? ` (${bak})` : " (backup FAILED)"} before overwriting.\x1b[0m\n`,
        );
        return { kind: "ambiguous", changes: [], backupPath: bak };
      }
      return { kind: "ambiguous", changes: [] };
    }

    const userChanges = filterGuardChanges(
      adapter,
      row.id,
      diffSettingsLeaves(entry.preparedSettings, current),
    );
    if (userChanges.length === 0) return { kind: "unchanged", changes: [] }; // faithful mirror — overwrite silently

    const target = computeGuardTarget(adapter, row, shared, settings);
    const result = classifyOverwrite(adapter, row.id, userChanges, current, target);

    if (result.kind === "unchanged") return result;

    if (result.kind === "preserved") {
      // Nothing the user wrote is lost. When the target is identical there is
      // no write to back up; when it picks up shared-config changes, keep a
      // silent backup as insurance for the C3 contract.
      if (result.targetChanges.length > 0) {
        const bak = backupInstanceSettings(
          adapter.appType,
          row.id,
          instanceDir,
          adapter.instanceSettingsFileName,
        );
        process.stderr.write(
          `\x1b[2m${adapter.instanceSettingsFileName} for "${row.name}" will pick up ${result.targetChanges.length} field(s) from the updated shared config; local edits are already reflected.\x1b[0m\n`,
        );
        return { ...result, backupPath: bak };
      }
      process.stderr.write(
        `\x1b[2m${adapter.instanceSettingsFileName} for "${row.name}" already matches the config about to be written — no unsynced edits.\x1b[0m\n`,
      );
      return result;
    }

    // lossy / unknown-target: these edits really are about to vanish.
    const bak = backupInstanceSettings(
      adapter.appType,
      row.id,
      instanceDir,
      adapter.instanceSettingsFileName,
    );
    process.stderr.write(
      `\x1b[33m⚠ Instance ${adapter.instanceSettingsFileName} for "${row.name}" has edits that will be overwritten:\x1b[0m\n`,
    );
    const shown = result.changes.slice(0, 10);
    for (const ch of shown) {
      const mark =
        ch.op === "add"
          ? "\x1b[32m+\x1b[0m"
          : ch.op === "remove"
            ? "\x1b[31m-\x1b[0m"
            : "\x1b[33m~\x1b[0m";
      process.stderr.write(`    ${mark} ${ch.path}\n`);
    }
    if (result.changes.length > shown.length) {
      process.stderr.write(`    … and ${result.changes.length - shown.length} more\n`);
    }
    process.stderr.write(
      bak ? `  Backup saved: ${bak}\n` : `  \x1b[31mBackup FAILED — edits will be lost.\x1b[0m\n`,
    );
    process.stderr.write(
      `  Run \x1b[1mswitch sync\x1b[0m to merge these edits back into cc-switch before they are lost.\n`,
    );
    return { ...result, backupPath: bak };
  } catch {
    // best-effort: guard must never block a launch.
    return { kind: "error", changes: [] };
  }
}

export {
  BACKUPS_DIR,
  BACKUP_KEEP,
  backupDirFor,
  backupInstanceSettings,
  classifyOverwrite,
  computeGuardTarget,
  filterGuardChanges,
  formatSettingsChangeLine,
  guardInstanceConfigBeforeOverwrite,
  isPluginChannelPath,
  pruneInstanceSettingsBackups,
  segmentsOverlap,
};
