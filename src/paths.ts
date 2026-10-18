// ─── paths (split from bin/cc-launch.mjs) ─────────────────────────────

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// ─── Path constants ────────────────────────────────────────────────────

function getHomeDir() {
  const testHome = process.env.CC_SWITCH_TEST_HOME;
  if (testHome && testHome.trim()) return testHome.trim();
  return homedir();
}

const HOME = getHomeDir();
const CC_SWITCH_DIR = join(HOME, ".cc-switch");
const DB_PATH = join(CC_SWITCH_DIR, "cc-switch.db");
const SETTINGS_PATH = join(CC_SWITCH_DIR, "settings.json");
const INSTANCES_DIR = join(CC_SWITCH_DIR, "instances");
const HISTORY_PATH = join(CC_SWITCH_DIR, "launch_history.json");
const SYNC_STATE_PATH = join(CC_SWITCH_DIR, "sync-state.json");
// Owned by this CLI alone (the desktop app owns settings.json and may
// rewrite providers.meta) — TUI-set statusline tag colors live here.
const STATUSLINE_PREFS_PATH = join(CC_SWITCH_DIR, "statusline-preferences.json");
const STATUSLINE_PREFS_VERSION = 1;
// cc-switch 4.0 aggregation (Stack) device-local state — written only by the
// desktop app; this CLI reads it fail-open (missing/corrupt = aggregation off).
const LIVE_STATE_PATH = join(CC_SWITCH_DIR, "live-state.json");
// The aggregation entry is a RUNTIME-VIRTUAL provider row: never stored in the
// cc-switch DB (which the desktop GUI renders — an auto-generated row would
// show up there as a non-user entry), derived on every query from live-state +
// the global ~/.claude/settings.json projection. Fixed id so instance dirs,
// launch history and statusline colors key on something stable.
const VIRTUAL_STACK_PROVIDER_ID = "__stack__";
// Upstream's default proxy port — only used when the stack is OFF but the
// virtual entry still shows (a `__stack__` instance dir exists): live-state
// carries no port then, and this is what the desktop app writes a fresh
// projection with. Same value the docs and warnings already name.
const STACK_FALLBACK_BASE_URL = "http://127.0.0.1:15721";
// Apps whose aggregation entry goes through the virtual layer. The layer
// below is appType-parameterized: per-app settings derivation lives in
// STACK_SETTINGS_DERIVERS.
const VIRTUAL_STACK_APPS = new Set(["claude", "codex"]);

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const RESOURCES_DIR = join(SCRIPT_DIR, "..", "resources");

const NPM_PACKAGE_NAME = "cc-switch-parallel";

// Injected at build time by build.mjs; "__VERSION__" placeholder for source runs.
const VERSION = "__VERSION__";


export { CC_SWITCH_DIR, DB_PATH, HISTORY_PATH, HOME, INSTANCES_DIR, LIVE_STATE_PATH, NPM_PACKAGE_NAME, RESOURCES_DIR, SCRIPT_DIR, SETTINGS_PATH, STACK_FALLBACK_BASE_URL, STATUSLINE_PREFS_PATH, STATUSLINE_PREFS_VERSION, SYNC_STATE_PATH, VERSION, VIRTUAL_STACK_APPS, VIRTUAL_STACK_PROVIDER_ID, __filename, getHomeDir };
