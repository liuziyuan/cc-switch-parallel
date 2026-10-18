// ─── statusline-colors (split from bin/cc-launch.mjs) ─────────────────────────────

import { readFileSync } from "node:fs";
import { atomicWrite } from "./fs-utils.js";
import { isPlainObject } from "./json-utils.js";
import { STATUSLINE_PREFS_PATH, STATUSLINE_PREFS_VERSION } from "./paths.js";

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

export { STATUSLINE_COLOR_CHOICES, isValidStatuslineColor, loadStatuslinePreferences, saveStatuslineColor, statuslineColorFor };
