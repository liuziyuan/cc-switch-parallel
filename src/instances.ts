// ─── instances ─────────────────────────────────────────────────────────
// Instance-directory and running-session helpers shared by doctor, ps and the
// TUI. Kept below command modules so none of them has to import another.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP_TYPES } from "./cli-meta.js";
import { lstatSyncSafe, readdirSyncSafe } from "./fs-utils.js";
import { INSTANCES_DIR } from "./paths.js";
import { readSessions, saveSyncState, sessionIsAlive, withSyncStateLock } from "./sessions.js";
import type { InstanceInfo } from "./types.js";

function collectInstances(): InstanceInfo[] {
  const instances: InstanceInfo[] = [];
  for (const appType of APP_TYPES) {
    const dir = join(INSTANCES_DIR, appType);
    if (!existsSync(dir)) continue;
    for (const name of readdirSyncSafe(dir) || []) {
      const full = join(dir, name);
      if (lstatSyncSafe(full)?.isDirectory()) instances.push({ name, appType, path: full });
    }
  }
  return instances;
}

function buildRunningSet() {
  const running = new Set();
  for (const inst of collectInstances()) {
    for (const { session } of readSessions(inst.path)) {
      if (sessionIsAlive(session)) {
        running.add(inst.name);
        break;
      }
    }
  }
  return running;
}

// Drop the drift baselines of removed instance dirs, so stale-instance
// prompts stop naming providers whose directories are gone (the dir name IS
// the providerId — see setupInstance). Best-effort: a state-file hiccup must
// not fail the clean itself.
function pruneInstanceBaselines(instances: any) {
  try {
    withSyncStateLock((state) => {
      let changed = false;
      for (const { name, appType } of instances) {
        if (state.instances?.[appType]?.[name] !== undefined) {
          delete state.instances[appType][name];
          changed = true;
        }
      }
      if (changed) saveSyncState(state);
    });
  } catch {
    // best-effort: unreadable state — the ghost entry stays, harmless.
  }
}

export { buildRunningSet, collectInstances, pruneInstanceBaselines };
