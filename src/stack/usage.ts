// ─── stack/usage (split from bin/cc-launch.mjs) ─────────────────────────────

import { isPlainObject } from "../json-utils.js";

// ─── Provider usage snapshot (app-agnostic, statusline) ───────────────
// Optional usage segment for the instance statusline wrapper: zhipu/zai
// coding-plan quota (5h + weekly) and DeepSeek balance, rendered in the
// claude-hud bar style. Identity is resolved from the provider's OWN
// settings_config — never the common-config-merged effective.env, because
// the usage API must be queried with the provider's own token even when a
// common snippet overrides the base URL — plus the upstream desktop app's
// meta.usage_script marker, falling back to base-url host matching. The
// provider NAME never participates: it is free-form user text.
//
// Everything here is app-agnostic (inputs are {baseUrl, token, meta}-shaped
// data), so a future Codex extractor can feed the same pipeline. Codex has
// no in-TUI statusline hook today (openai/codex#17827); its interim tmux
// channel consumes CC_SWITCH_PROVIDER_ID instead (see CLAUDE.md).
//
// Safety: the resolved token is inlined into the instance-dir wrapper — the
// same directory and exposure surface as the instance settings.json, which
// already carries it — and the usage cache never contains the token. All
// usage state lives in the WRAPPER's content and the cache file;
// settings.json stays usage-blind, so the C3 prepare/guard baseline is
// untouched by construction.

const USAGE_CACHE_FILENAME = "usage-cache.json";

// Host-suffix matchers, shared vocabulary with the desktop app's
// codingPlanProviders routing table (zhipu = api.z.ai | bigmodel.cn).
const USAGE_HOST_MATCHERS = [
  { suffix: "api.z.ai", kind: "zhipu" },
  { suffix: "bigmodel.cn", kind: "zhipu" },
  { suffix: "api.deepseek.com", kind: "deepseek" },
];

// zhipu uses Bearer here even though the upstream desktop app sends the raw
// key (comment "智谱不加 Bearer 前缀"): as of 2026-10 api.z.ai answers a bare
// Authorization with HTTP 200 + {"code":401,"success":false} and only accepts
// Bearer — verified against a live coding-plan key. bigmodel.cn untested; if
// it ever needs bare, move authStyle into USAGE_HOST_MATCHERS per host.
const USAGE_AUTH_STYLE = { zhipu: "bearer", deepseek: "bearer" };

// {baseUrl, token} out of a Claude provider settings_config; null when
// either is missing (no creds → no usage segment).
function extractClaudeUsageSource(settingsConfig) {
  const env =
    isPlainObject(settingsConfig) && isPlainObject(settingsConfig.env) ? settingsConfig.env : null;
  if (!env) return null;
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL.trim() : "";
  const token =
    typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN.trim()
      ? env.ANTHROPIC_AUTH_TOKEN.trim()
      : typeof env.ANTHROPIC_API_KEY === "string"
        ? env.ANTHROPIC_API_KEY.trim()
        : "";
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

// Loopback check kept local on purpose: importing isLoopbackBaseUrl from
// stack/state.ts would create a state → usage → state cycle. Same host set.
function isLoopbackHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Query endpoint for a kind, derived from the provider's own base-url
// origin (https://api.z.ai/api/anthropic → https://api.z.ai/api/monitor/…;
// https://api.deepseek.com/anthropic → https://api.deepseek.com/user/balance).
// The usage request carries the provider token in clear, so anything other
// than https is rejected — except plain http to a loopback host, which is
// the local-proxy case. URL.origin is the string "null" for non-special
// schemes (file:, ftp: …); the protocol check below rejects those.
function usageEndpointFor(kind, baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
    return null;
  const origin = url.origin;
  if (kind === "zhipu") return origin + "/api/monitor/usage/quota/limit";
  if (kind === "deepseek") return origin + "/user/balance";
  return null;
}

// Resolve the usage identity for a provider; null = no usage segment.
// Resolution order: explicit meta marker first (upstream desktop app writes
// codingPlanProvider), then host-suffix matching. An unknown explicit value
// never guesses — it falls through to host matching. meta.usage_script with
// enabled === false is an explicit opt-out; a non-empty custom `code` means
// the desktop app runs user JS we cannot replicate, so we stay out.
function resolveUsageIdentity(settingsConfig, meta) {
  const usage = isPlainObject(meta) && isPlainObject(meta.usage_script) ? meta.usage_script : null;
  if (usage) {
    if (usage.enabled === false) return null;
    if (typeof usage.code === "string" && usage.code.trim()) return null;
  }
  const source = extractClaudeUsageSource(settingsConfig);
  if (!source) return null;
  let host = "";
  try {
    host = new URL(source.baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const matched = USAGE_HOST_MATCHERS.find(
    (m) => host === m.suffix || host.endsWith("." + m.suffix),
  );
  const explicit =
    usage && typeof usage.codingPlanProvider === "string"
      ? usage.codingPlanProvider.trim().toLowerCase()
      : "";
  const kind =
    (explicit && USAGE_AUTH_STYLE[explicit] ? explicit : "") || (matched ? matched.kind : "");
  if (!kind) return null;
  const endpoint = usageEndpointFor(kind, source.baseUrl);
  if (!endpoint) return null;
  const intervalRaw = Number(usage && usage.autoQueryInterval);
  const intervalMin =
    Number.isFinite(intervalRaw) && intervalRaw >= 1 ? Math.min(Math.round(intervalRaw), 60) : 5;
  return {
    kind,
    baseUrl: source.baseUrl,
    token: source.token,
    authStyle: USAGE_AUTH_STYLE[kind],
    intervalMin,
    endpoint,
  };
}

// Serializable runtime config inlined into the wrapper. Deterministic in
// (identity, cachePath, selfPath) — prepare and the guard's
// computeEffectiveSettings get the same inputs, so the generated wrapper is
// identical on both paths [C3].
function buildUsageQueryConfig(identity, cachePath, selfPath) {
  if (!identity) return null;
  return {
    kind: identity.kind,
    url: identity.endpoint,
    token: identity.token,
    authStyle: identity.authStyle,
    ttlMs: identity.intervalMin * 60_000,
    cachePath,
    selfPath,
    syncTimeoutMs: 1500,
    refreshTimeoutMs: 8000,
    errorBackoffMs: 60_000,
    refreshDedupMs: 15_000,
  };
}

export {
  USAGE_AUTH_STYLE,
  USAGE_CACHE_FILENAME,
  USAGE_HOST_MATCHERS,
  buildUsageQueryConfig,
  extractClaudeUsageSource,
  resolveUsageIdentity,
  usageEndpointFor,
};
