// ─── stack/aggregation ────────────────────────────────────────────────
// Low-level aggregation primitives shared by stack/state and stack/catalog.
// Keeping them here breaks the state ↔ catalog import cycle: both modules
// import this file, and this file imports neither of them.

import { isPlainObject } from "../json-utils.js";
import { parseToml } from "../toml.js";

const CODEX_RESERVED_MODEL_PROVIDER_IDS = [
  "amazon-bedrock",
  "openai",
  "ollama",
  "lmstudio",
  "oss",
  "ollama-chat",
];

const CC_SWITCH_CATALOG_FILENAME = "cc-switch-model-catalog.json";

// Single parse used by signature checks, derivation and the launch probe:
// reads the ACTIVE provider table first, then the top-level fallback keys.
// Null on unparsable input; baseUrl/bearer are non-empty strings or null.
function codexAggregationRoute(configText: any) {
  let doc;
  try {
    doc = parseToml(configText || "");
  } catch {
    return null;
  }
  if (!isPlainObject(doc)) return null;
  const pid = typeof doc.model_provider === "string" ? doc.model_provider.trim() : "";
  const table = pid && isPlainObject(doc.model_providers?.[pid]) ? doc.model_providers[pid] : null;
  const pickStr = (v: any) => (typeof v === "string" && v.trim() ? v : null);
  return {
    providerId: pid || null,
    table,
    baseUrl: pickStr(table?.base_url ?? doc.base_url),
    bearer: pickStr(table?.experimental_bearer_token ?? doc.experimental_bearer_token),
  };
}

function isCustomCodexModelProviderId(id: any) {
  const trimmed = id.trim();
  return (
    trimmed.length > 0 &&
    !CODEX_RESERVED_MODEL_PROVIDER_IDS.some((r) => r.toLowerCase() === trimmed.toLowerCase())
  );
}

// The upstream placeholder token that marks an aggregation row.
const PROXY_MANAGED_TOKEN = "PROXY_MANAGED";

// Loopback host = the aggregation proxy endpoint (a plain provider never
// points at one; a user's own local gateway would simply not match a live
// stack and fall through to the regular single-provider path).
function isLoopbackHost(hostname: any) {
  if (typeof hostname !== "string") return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLoopbackBaseUrl(baseUrl: any) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
  try {
    // URL.hostname keeps the brackets on IPv6 literals ("[::1]").
    return isLoopbackHost(new URL(baseUrl.trim()).hostname);
  } catch {
    return false;
  }
}

// Deterministic Stack-row signature: loopback base URL + the upstream
// placeholder token (the shape the desktop live projection and the virtual
// entry write). Loopback alone cannot tell a Stack row from a user's own
// local gateway (LiteLLM, one-api …). No readStackState here: the merge
// decision must not flip with desktop state (prepare determinism).
function isAggregationProviderSettings(settingsConfig: any) {
  const env =
    isPlainObject(settingsConfig) && isPlainObject(settingsConfig.env) ? settingsConfig.env : null;
  return (
    !!env &&
    isLoopbackBaseUrl(env.ANTHROPIC_BASE_URL) &&
    env.ANTHROPIC_AUTH_TOKEN === PROXY_MANAGED_TOKEN
  );
}

// Codex mirror of isAggregationProviderSettings — same signature, TOML shape:
// the ACTIVE provider table's base_url is loopback AND its bearer token is the
// upstream placeholder. Reads the settings_config JSON envelope
// ({config: "<TOML>", auth}) — never live-state, so decisions stay
// deterministic under prepare.
function isCodexAggregationProviderSettings(settingsConfig: any) {
  if (!isPlainObject(settingsConfig) || typeof settingsConfig.config !== "string") return false;
  const r = codexAggregationRoute(settingsConfig.config);
  return !!r && isLoopbackBaseUrl(r.baseUrl) && r.bearer === PROXY_MANAGED_TOKEN;
}

// per-app dispatch over the two signature shapes above — claude reads the
// env object, codex parses the config TOML.
function providerIsAggregation(appType: any, settingsConfig: any) {
  return appType === "codex"
    ? isCodexAggregationProviderSettings(settingsConfig)
    : isAggregationProviderSettings(settingsConfig);
}

// Base URL of an aggregation row, for the pre-launch TCP probe. Returns null
// for non-aggregation rows (the caller skips the probe entirely).
function aggregationBaseUrlFor(appType: any, settingsConfig: any) {
  if (appType === "codex") {
    if (!isCodexAggregationProviderSettings(settingsConfig)) return null;
    return codexAggregationRoute(settingsConfig.config)?.baseUrl ?? null;
  }
  if (!isAggregationProviderSettings(settingsConfig)) return null;
  return settingsConfig.env.ANTHROPIC_BASE_URL ?? null;
}

// Identity keys the aggregation merge must never let the common config win
// or plant: the row's env IS the routing identity. A common BASE_URL would
// bypass the proxy; a common AUTH_TOKEN/API_KEY would re-auth it — keys the
// row lacks are deleted outright, not just overwritten.
const AGGREGATION_IDENTITY_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
];

// The ccs model aliases the virtual entry copies from the global env. Row
// value wins when present; when the row lacks a key the common value is
// harmless (no delete), unlike the identity keys above.
const AGGREGATION_MODEL_ALIAS_KEYS = [
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
];

// Post-merge guard for aggregation rows (called from
// buildClaudeEffectiveSettings only after mergeCommonOverProvider ran).
// effective.env can be non-object when a scalar/mismatched common `env`
// full-overwrote the row's env through the merge fallthrough — rebuild it
// from the row's env in that case rather than crash on the restore below.
function protectAggregationIdentityEnv(effective: any, settingsConfig: any) {
  const rowEnv = isPlainObject(settingsConfig?.env) ? settingsConfig.env : {};
  if (!isPlainObject(effective.env)) effective.env = {};
  for (const key of AGGREGATION_IDENTITY_ENV_KEYS) {
    if (rowEnv[key] !== undefined) effective.env[key] = rowEnv[key];
    else delete effective.env[key];
  }
  for (const key of AGGREGATION_MODEL_ALIAS_KEYS) {
    if (rowEnv[key] !== undefined) effective.env[key] = rowEnv[key];
  }
}

// Shared ccs model-id patterns. The statusline wrapper embeds the SOURCE
// text in generated code, so keep the exact source (byte-identical output).
const CCS_CLAUDE_MODEL_ID_SOURCE = "^ccs-claude-([a-z0-9-]+?)--";
const CCS_CODEX_MODEL_ID_SOURCE = "^ccs-([a-z0-9-]+)/";

function ccsClaudeKeyFromModel(model: any) {
  if (typeof model !== "string") return null;
  const m = model.match(new RegExp(CCS_CLAUDE_MODEL_ID_SOURCE, "i"));
  return m ? m[1].toLowerCase() : null;
}

function ccsCodexKeyFromModel(model: any) {
  if (typeof model !== "string") return null;
  const m = model.match(new RegExp(CCS_CODEX_MODEL_ID_SOURCE, "i"));
  return m ? m[1].toLowerCase() : null;
}

export {
  AGGREGATION_IDENTITY_ENV_KEYS,
  AGGREGATION_MODEL_ALIAS_KEYS,
  CC_SWITCH_CATALOG_FILENAME,
  CCS_CLAUDE_MODEL_ID_SOURCE,
  CCS_CODEX_MODEL_ID_SOURCE,
  CODEX_RESERVED_MODEL_PROVIDER_IDS,
  PROXY_MANAGED_TOKEN,
  aggregationBaseUrlFor,
  ccsClaudeKeyFromModel,
  ccsCodexKeyFromModel,
  codexAggregationRoute,
  isAggregationProviderSettings,
  isCodexAggregationProviderSettings,
  isCustomCodexModelProviderId,
  isLoopbackBaseUrl,
  isLoopbackHost,
  protectAggregationIdentityEnv,
  providerIsAggregation,
};
