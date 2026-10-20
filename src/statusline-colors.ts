// ─── statusline-colors (split from bin/cc-launch.mjs) ─────────────────────────────

import { readFileSync } from "node:fs";
import { withFileLockSync } from "./file-lock.js";
import { atomicWrite } from "./fs-utils.js";
import { isPlainObject } from "./json-utils.js";
import {
  GLOBAL_CLAUDE_SETTINGS_PATH,
  STATUSLINE_PREFS_PATH,
  STATUSLINE_PREFS_VERSION,
} from "./paths.js";

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
  return typeof v === "string" && (v === "auto" || /^(3[0-7]|9[0-7])$/.test(v));
}

function loadStatuslinePreferences() {
  try {
    const prefs = JSON.parse(readFileSync(STATUSLINE_PREFS_PATH, "utf8"));
    if (prefs?.version !== STATUSLINE_PREFS_VERSION) return null;
    // `colors` predates the display section: a file written by an older
    // version always has it, but a display-only file must not invalidate the
    // whole read. A present-but-broken colors value is still a corrupt file.
    if ("colors" in prefs && !isPlainObject(prefs.colors)) return null;
    if (!isPlainObject(prefs.colors)) prefs.colors = {};
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
    const result = withFileLockSync(STATUSLINE_PREFS_PATH, () => {
      // Re-read inside the lock: another TUI may have saved a different
      // provider's color since this process's last load.
      const prefs = loadStatuslinePreferences() || {
        version: STATUSLINE_PREFS_VERSION,
        colors: {},
      };
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
    });
    return result.acquired ? result.value : null;
  } catch {
    return null;
  }
}

// ─── Statusline display preferences (TUI) ──────────────────────────────
// Field names mirror claude-hud's config.json so the two tools feel like one
// system: display.showModel / showProject / showContextBar / contextValue /
// showUsage / usageBarEnabled / usageValue / modelFormat, gitStatus.*, and
// pathLevels. `showContext` is ours (claude-hud controls the row through
// elementOrder instead). Only the boolean switches are exposed in the TUI;
// the remaining fields are honoured when hand-edited, read fail-open.

const DISPLAY_DEFAULTS = {
  display: {
    showModel: true,
    showProject: true,
    showContext: true,
    showContextBar: true,
    contextValue: "percent",
    showUsage: true,
    usageBarEnabled: true,
    usageValue: "percent",
    showTokenBreakdown: true,
    modelFormat: "full",
  },
  gitStatus: {
    enabled: true,
    showDirty: true,
    showAheadBehind: false,
    showFileStats: false,
  },
  pathLevels: 1,
};

// The five switches the TUI panel exposes. Keys are dotted paths into the
// preferences document; values are booleans only, so a save can never write
// an unvalidated shape. Order is the panel order.
const STATUSLINE_DISPLAY_ITEMS = [
  { key: "display.showModel", label: "Model name" },
  { key: "display.showProject", label: "Project name" },
  { key: "gitStatus.enabled", label: "Git branch" },
  { key: "display.showContext", label: "Context usage" },
  { key: "display.showUsage", label: "Provider usage (Z.AI / DeepSeek)" },
];

// The full boolean surface of the schema (the TUI exposes a subset; the rest
// are settable by hand once written).
const DISPLAY_BOOLEAN_KEYS = new Set([
  "display.showModel",
  "display.showProject",
  "display.showContext",
  "display.showContextBar",
  "display.showUsage",
  "display.usageBarEnabled",
  "display.showTokenBreakdown",
  "gitStatus.enabled",
  "gitStatus.showDirty",
  "gitStatus.showAheadBehind",
  "gitStatus.showFileStats",
]);

const CONTEXT_VALUE_MODES = ["percent", "tokens", "remaining", "both"];
const USAGE_VALUE_MODES = ["percent", "remaining"];
const MODEL_FORMATS = ["full", "compact", "short"];
const PATH_LEVELS = [1, 2, 3, "full"];

function boolOr(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeDisplayPreferences(prefs) {
  const d = isPlainObject(prefs?.display) ? prefs.display : {};
  const g = isPlainObject(prefs?.gitStatus) ? prefs.gitStatus : {};
  const defaults = DISPLAY_DEFAULTS;
  return {
    display: {
      showModel: boolOr(d.showModel, defaults.display.showModel),
      showProject: boolOr(d.showProject, defaults.display.showProject),
      showContext: boolOr(d.showContext, defaults.display.showContext),
      showContextBar: boolOr(d.showContextBar, defaults.display.showContextBar),
      contextValue: oneOf(d.contextValue, CONTEXT_VALUE_MODES, defaults.display.contextValue),
      showUsage: boolOr(d.showUsage, defaults.display.showUsage),
      usageBarEnabled: boolOr(d.usageBarEnabled, defaults.display.usageBarEnabled),
      usageValue: oneOf(d.usageValue, USAGE_VALUE_MODES, defaults.display.usageValue),
      showTokenBreakdown: boolOr(d.showTokenBreakdown, defaults.display.showTokenBreakdown),
      modelFormat: oneOf(d.modelFormat, MODEL_FORMATS, defaults.display.modelFormat),
    },
    gitStatus: {
      enabled: boolOr(g.enabled, defaults.gitStatus.enabled),
      showDirty: boolOr(g.showDirty, defaults.gitStatus.showDirty),
      showAheadBehind: boolOr(g.showAheadBehind, defaults.gitStatus.showAheadBehind),
      showFileStats: boolOr(g.showFileStats, defaults.gitStatus.showFileStats),
    },
    pathLevels: oneOf(prefs?.pathLevels, PATH_LEVELS, defaults.pathLevels),
  };
}

function loadStatuslineDisplay() {
  return normalizeDisplayPreferences(loadStatuslinePreferences());
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function saveStatuslineDisplay(key, value) {
  if (!DISPLAY_BOOLEAN_KEYS.has(key) || typeof value !== "boolean") return null;
  try {
    const result = withFileLockSync(STATUSLINE_PREFS_PATH, () => {
      // Re-read inside the lock so a concurrent color save is never lost.
      const prefs = loadStatuslinePreferences() || {
        version: STATUSLINE_PREFS_VERSION,
        colors: {},
      };
      prefs.version = STATUSLINE_PREFS_VERSION;
      setPath(prefs, key, value);
      atomicWrite(STATUSLINE_PREFS_PATH, JSON.stringify(prefs, null, 2));
      return value;
    });
    return result.acquired ? result.value : null;
  } catch {
    return null;
  }
}

// What the TUI panel shows: whether a global statusline will take over the
// model/project/git/context content. The wrapper makes the same decision at
// render time from its actual relay (an inline provider statusLine wins);
// this is the global-config view used for the panel notice.
function detectStatuslineRelay() {
  try {
    const settings = JSON.parse(readFileSync(GLOBAL_CLAUDE_SETTINGS_PATH, "utf8"));
    const sl = settings?.statusLine;
    const cmd =
      isPlainObject(sl) && sl.type === "command" && typeof sl.command === "string"
        ? sl.command.trim()
        : "";
    if (!cmd || cmd.includes("statusline-wrapper.mjs")) return { kind: "none", command: null };
    return {
      kind: cmd.toLowerCase().includes("claude-hud") ? "claude-hud" : "other",
      command: cmd,
    };
  } catch {
    return { kind: "none", command: null };
  }
}

// A row is dead when its provider no longer exists in cc-switch: entries with
// a resolved id check the live id set (a rename keeps the id → stays alive);
// id-less pre-migration entries are dead by definition (their name didn't
// resolve). A missing snapshot (cli unknown or DB unavailable) means "all
// alive" — fail open, same stance as the old existingProviders.

export {
  STATUSLINE_COLOR_CHOICES,
  STATUSLINE_DISPLAY_ITEMS,
  detectStatuslineRelay,
  isValidStatuslineColor,
  loadStatuslineDisplay,
  loadStatuslinePreferences,
  normalizeDisplayPreferences,
  saveStatuslineColor,
  saveStatuslineDisplay,
  statuslineColorFor,
};
