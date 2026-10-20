// ─── shared-config (cc-switch 4.0 live shared settings) ────────────────
// cc-switch 4.0 removed the "common config snippet" feature: shared settings
// now live in the client's OWN live config file (~/.claude/settings.json,
// ~/.codex/config.toml), and the DB's settings.common_config_<app> is a
// FROZEN snapshot kept only for old versions / Lite / CLI consumers.
//
// This module is the single source of truth for where `switch` reads shared
// settings from:
//
//   schema user_version >= 20  → live  (projected user keys of the live file)
//   schema <= 19 / unreadable  → legacy (settings.common_config_<app>)
//
// The live projection mirrors upstream src-tauri/src/live/floor.rs: key
// fields (address, credentials, model, protocol) belong to the provider and
// never enter the shared projection; everything else is a user key. In
// particular `statusLine` is a user key — it stays in the live file, where
// the generated statusline wrapper reads it at render time. Excluding it here
// is what keeps a frozen claude-hud statusLine from being resurrected.
//
// Old call sites/tests pass a raw common-config string; sharedSnippetText()
// keeps that legacy behavior byte-identical.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { queryCommonConfig, readSchemaUserVersion } from "./db.js";
import { isPlainObject, jsonDeepClone } from "./json-utils.js";
import { GLOBAL_CLAUDE_SETTINGS_PATH, GLOBAL_CODEX_CONFIG_PATH } from "./paths.js";
import { parseToml, stringifyToml } from "./toml.js";

type SharedConfigMode = "live" | "legacy";

type SharedConfig = {
  mode: SharedConfigMode;
  /** Text handed to prepare/guard (legacy: DB snippet; live: projected keys). */
  text: string;
  /** Parsed shared document (claude JSON / codex TOML), dependency-free. */
  parsed: any;
  /** True when the live file is missing/unreadable in live mode. */
  unavailable: boolean;
  /** Live file path; null in legacy mode. */
  sourcePath: string | null;
};

// ─── Floor rules (1:1 mirror of upstream live/floor.rs) ────────────────

const CLAUDE_PROTOCOL_SELECTORS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
];

const CLAUDE_FLOOR_ENV_PREFIXES = ["ANTHROPIC_", "AWS_", "VERTEX_REGION_"];

const CLAUDE_FLOOR_ENV_KEYS = [
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
];

const CLAUDE_FLOOR_TOP = [
  "apiKeyHelper",
  "apiBaseUrl",
  "primaryModel",
  "smallFastModel",
  "apiKey",
  "model",
  "fallbackModel",
  "modelOverrides",
  "modelPicker",
  "advisorModel",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
];

const CLAUDE_EXCLUSIVE_ENV = [
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
  "CLAUDE_CODE_DISABLE_ARTIFACT",
  "ENABLE_TOOL_SEARCH",
  "CLAUDE_CODE_DISABLE_THINKING",
  "DISABLE_INTERLEAVED_THINKING",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_EXTRA_BODY",
  "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING",
  "CLAUDE_CODE_AUTO_MODE_SERVER",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
];

const CODEX_FLOOR_TOP = [
  "model_provider",
  "openai_base_url",
  "model",
  "review_model",
  "model_reasoning_effort",
  "plan_mode_reasoning_effort",
  "disable_response_storage",
  "model_catalog_json",
  "experimental_bearer_token",
  "base_url",
  "wire_api",
];

const CODEX_FLOOR_NESTED = [
  ["agents", "default_subagent_model"],
  ["agents", "default_subagent_reasoning_effort"],
  ["memories", "extract_model"],
  ["memories", "consolidation_model"],
];

const CODEX_EXCLUSIVE_TOP = [
  "web_search",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_supports_reasoning_summaries",
  "model_verbosity",
];

function claudeFloorTop(key: string): boolean {
  return CLAUDE_FLOOR_TOP.includes(key);
}

function claudeFloorEnv(key: string): boolean {
  return CLAUDE_FLOOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    || CLAUDE_PROTOCOL_SELECTORS.includes(key)
    || CLAUDE_FLOOR_ENV_KEYS.includes(key)
    || (key.startsWith("CLAUDE_CODE_SKIP_") && key.endsWith("_AUTH"));
}

function claudeExclusiveEnv(key: string): boolean {
  return CLAUDE_EXCLUSIVE_ENV.includes(key);
}

// ─── Live projections ──────────────────────────────────────────────────

// Claude: keep every user key except statusLine (channel-owned; the wrapper
// reads the live file at render time) and the provider key fields. The env
// container itself is a user key, but its provider-keyed entries are not.
function projectClaudeSharedKeys(live: any): any {
  if (!isPlainObject(live)) return {};
  const out: any = {};
  for (const [key, value] of Object.entries(live)) {
    if (key === "statusLine" || key === "env") continue;
    if (claudeFloorTop(key)) continue;
    out[key] = jsonDeepClone(value);
  }
  if (isPlainObject(live.env)) {
    const env: any = {};
    for (const [key, value] of Object.entries(live.env)) {
      if (claudeFloorEnv(key) || claudeExclusiveEnv(key)) continue;
      env[key] = jsonDeepClone(value);
    }
    if (Object.keys(env).length) out.env = env;
  }
  return out;
}

function deletePath(root: any, segments: string[]): void {
  let cur = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, segments[i])) return;
    cur = cur[segments[i]];
  }
  if (!isPlainObject(cur)) return;
  delete cur[segments[segments.length - 1]];
  // Prune only the parent chain that this deletion may have emptied. A table
  // the user wrote empty on purpose is never on this chain unless we deleted
  // its only key, which is exactly the case worth pruning.
  for (let i = segments.length - 2; i >= 0; i--) {
    let parent = root;
    for (let j = 0; j < i; j++) {
      if (!isPlainObject(parent)) return;
      parent = parent[segments[j]];
    }
    if (!isPlainObject(parent) || !isPlainObject(parent[segments[i]])) return;
    if (Object.keys(parent[segments[i]]).length === 0) delete parent[segments[i]];
    else return;
  }
}

// Codex: provider routing/model/protocol keys and the provider table stay
// with the provider; runtime-state tables (projects, hook trust, TUI markers)
// are carried separately by mergeCodexRuntimeState and must not leak from the
// live global file into every instance.
function projectCodexSharedKeys(doc: any): any {
  if (!isPlainObject(doc)) return {};
  const out = jsonDeepClone(doc);
  for (const key of CODEX_FLOOR_TOP) delete out[key];
  for (const key of CODEX_EXCLUSIVE_TOP) delete out[key];
  // The whole provider table is routing identity, and `profile` can override
  // model_provider — a global profile must not hijack an instance's route.
  delete out.model_providers;
  delete out.profile;
  delete out.projects;
  for (const segments of CODEX_FLOOR_NESTED) deletePath(out, segments);
  deletePath(out, ["hooks", "state"]);
  deletePath(out, ["tui", "screen_reader_detection_done"]);
  deletePath(out, ["tui", "model_availability_nux"]);
  return out;
}

// ─── Mode detection & hashing ──────────────────────────────────────────

function detectSharedConfigMode(): SharedConfigMode {
  // Escape hatch for 4.0.0/4.0.1 (schema 19, same as 3.20.4) and for
  // troubleshooting: env wins over DB inspection.
  const override = (process.env.CC_SWITCH_SHARED_SOURCE || "").trim().toLowerCase();
  if (override === "live" || override === "legacy") return override;
  const version = readSchemaUserVersion();
  return version !== null && version >= 20 ? "live" : "legacy";
}

function canonicalJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(text: string): string {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

// legacy: hash the raw snippet (byte-identical to the old commonHash, so
// existing baselines keep working). live: canonical JSON of the projection
// (key order/TOML formatting must not cause false staleness; provider key
// fields and statusLine are already excluded, so desktop-side switching or
// statusline edits do not mark every instance stale).
function sharedConfigHash(shared: SharedConfig): string {
  return shared.mode === "legacy"
    ? sha256(shared.text || "")
    : sha256(canonicalJson(shared.parsed || {}));
}

// ─── Readers ───────────────────────────────────────────────────────────

const warnedUnavailable = new Set<string>();

function emptyShared(mode: SharedConfigMode, sourcePath: string | null, unavailable: boolean): SharedConfig {
  return { mode, text: "", parsed: {}, unavailable, sourcePath };
}

function readLegacyShared(appType: string): SharedConfig {
  const text = queryCommonConfig(appType) || "";
  let parsed: any = {};
  try {
    parsed = appType === "claude"
      ? (isPlainObject(JSON.parse(text)) ? JSON.parse(text) : {})
      : (text.trim() ? parseToml(text) : {});
  } catch {
    parsed = {};
  }
  return { mode: "legacy", text, parsed, unavailable: false, sourcePath: null };
}

function readLiveShared(appType: string): SharedConfig {
  const sourcePath = appType === "claude" ? GLOBAL_CLAUDE_SETTINGS_PATH : GLOBAL_CODEX_CONFIG_PATH;
  try {
    if (!existsSync(sourcePath)) throw new Error("file not found");
    const raw = readFileSync(sourcePath, "utf8");
    if (appType === "claude") {
      const doc = JSON.parse(raw);
      if (!isPlainObject(doc)) throw new Error("not a JSON object");
      const parsed = projectClaudeSharedKeys(doc);
      const text = Object.keys(parsed).length ? JSON.stringify(parsed, null, 2) : "";
      return { mode: "live", text, parsed, unavailable: false, sourcePath };
    }
    const doc = parseToml(raw);
    const parsed = projectCodexSharedKeys(doc);
    const text = Object.keys(parsed).length ? stringifyToml(parsed) : "";
    return { mode: "live", text, parsed, unavailable: false, sourcePath };
  } catch (e: any) {
    // Deliberately NO fallback to the frozen DB snippet: that snapshot is
    // exactly what the 4.0 migration stopped maintaining. An unreadable live
    // file means "no shared config this run", never "use the stale copy".
    if (!warnedUnavailable.has(appType)) {
      warnedUnavailable.add(appType);
      process.stderr.write(
        `\x1b[2mℹ Shared config (${appType}) unavailable at ${sourcePath}: ${e.message} — launching without shared settings\x1b[0m\n`,
      );
    }
    return emptyShared("live", sourcePath, true);
  }
}

function readSharedConfig(appType: string): SharedConfig {
  return detectSharedConfigMode() === "live"
    ? readLiveShared(appType)
    : readLegacyShared(appType);
}

// ─── Compatibility helpers ─────────────────────────────────────────────

function isLiveSharedSnippet(shared: any): boolean {
  return !!shared && typeof shared === "object" && shared.mode === "live";
}

// Call sites/tests that still hand in the raw legacy snippet string keep
// working unchanged.
function sharedSnippetText(shared: any): string {
  if (shared === null || shared === undefined) return "";
  if (typeof shared === "string") return shared;
  return typeof shared.text === "string" ? shared.text : "";
}

// Test-only reset: warnings are per-process by design, but the suite runs
// many fixtures in one process.
function resetSharedConfigWarnings(): void {
  warnedUnavailable.clear();
}

export {
  CLAUDE_EXCLUSIVE_ENV, CLAUDE_FLOOR_ENV_KEYS, CLAUDE_FLOOR_ENV_PREFIXES,
  CLAUDE_FLOOR_TOP, CLAUDE_PROTOCOL_SELECTORS, CODEX_EXCLUSIVE_TOP,
  CODEX_FLOOR_NESTED, CODEX_FLOOR_TOP,
  claudeExclusiveEnv, claudeFloorEnv, claudeFloorTop,
  detectSharedConfigMode, isLiveSharedSnippet, projectClaudeSharedKeys,
  projectCodexSharedKeys, readSharedConfig, resetSharedConfigWarnings,
  sharedConfigHash, sharedSnippetText,
};
export type { SharedConfig, SharedConfigMode };
