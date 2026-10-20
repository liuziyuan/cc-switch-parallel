// ─── stack/live-state ──────────────────────────────────────────────────
// File-only reads of the desktop app's live state and global model picker.
// Kept below stack/state so db and the virtual-row derivation can use them
// without importing the DB layer.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../json-utils.js";
import { HOME, LIVE_STATE_PATH } from "../paths.js";

// {keys: key→providerId, members: [providerId], proxyRoute} when aggregation
// is enabled for the app, else null. Everything tolerates shape drift: a
// missing file, a renamed field or a disabled switch all read as "off".
// Contract gate: an unknown version (file-level or the app's contract block)
// is a schema this build cannot interpret — read as "off" rather than guess.
function readStackState(appType) {
  try {
    const raw = JSON.parse(readFileSync(LIVE_STATE_PATH, "utf8"));
    if (!isPlainObject(raw)) return null;
    if (raw.version !== undefined && raw.version !== 1) return null;
    const app =
      isPlainObject(raw.apps) && isPlainObject(raw.apps[appType]) ? raw.apps[appType] : null;
    const contract = isPlainObject(app?.contract) ? app.contract : null;
    if (contract?.version !== undefined && contract.version !== 1) return null;
    const stack = app && isPlainObject(app.stack) ? app.stack : null;
    if (!stack || stack.enabled !== true) return null;
    const keys = isPlainObject(stack.keys)
      ? Object.fromEntries(Object.entries(stack.keys).filter(([, id]) => typeof id === "string"))
      : {};
    const members = Array.isArray(stack.members)
      ? stack.members.filter(
          (id) => typeof id === "string" && keys && Object.values(keys).includes(id),
        )
      : [];
    if (!Object.keys(keys).length || !members.length) return null;
    const proxyRoute = typeof app!.proxy_route === "string" ? app!.proxy_route : null;
    return { keys, members, proxyRoute };
  } catch {
    return null;
  }
}

// The aggregation /model list the desktop app writes into the GLOBAL
// ~/.claude/settings.json (`modelPicker`: replaceBuiltInOptions + options with
// ccs ids). Aggregation instances sync it on every prepare so member changes
// in the desktop app surface without touching the provider row's snapshot.
// Contract: a picker with an `options` ARRAY is returned even when EMPTY —
// the desktop app clearing the list back to built-in models is a legal
// state, and callers honor it by dropping their own picker. null means
// "no modelPicker at all" (absence — callers leave whatever they carry).
function readGlobalModelPicker() {
  try {
    const g = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"));
    const picker = isPlainObject(g) ? g.modelPicker : null;
    return isPlainObject(picker) && Array.isArray(picker.options) ? picker : null;
  } catch {
    return null;
  }
}

export { readGlobalModelPicker, readStackState };
