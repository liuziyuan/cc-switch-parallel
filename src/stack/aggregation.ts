// ─── stack/aggregation ────────────────────────────────────────────────
// Low-level aggregation primitives shared by stack/state and stack/catalog.
// Keeping them here breaks the state ↔ catalog import cycle: both modules
// import this file, and this file imports neither of them.

import { isPlainObject } from "../json-utils.js";
import { parseToml } from "../toml.js";

const CODEX_RESERVED_MODEL_PROVIDER_IDS = [
  "amazon-bedrock", "openai", "ollama", "lmstudio", "oss", "ollama-chat",
];

const CC_SWITCH_CATALOG_FILENAME = "cc-switch-model-catalog.json";

// Single parse used by signature checks, derivation and the launch probe:
// reads the ACTIVE provider table first, then the top-level fallback keys.
// Null on unparsable input; baseUrl/bearer are non-empty strings or null.
function codexAggregationRoute(configText) {
  let doc;
  try { doc = parseToml(configText || ""); } catch { return null; }
  if (!isPlainObject(doc)) return null;
  const pid = typeof doc.model_provider === "string" ? doc.model_provider.trim() : "";
  const table = pid && isPlainObject(doc.model_providers?.[pid]) ? doc.model_providers[pid] : null;
  const pickStr = (v) => (typeof v === "string" && v.trim() ? v : null);
  return {
    providerId: pid || null,
    table,
    baseUrl: pickStr(table?.base_url ?? doc.base_url),
    bearer: pickStr(table?.experimental_bearer_token ?? doc.experimental_bearer_token),
  };
}

function isCustomCodexModelProviderId(id) {
  const trimmed = id.trim();
  return trimmed.length > 0 && !CODEX_RESERVED_MODEL_PROVIDER_IDS.some((r) => r.toLowerCase() === trimmed.toLowerCase());
}


export { CC_SWITCH_CATALOG_FILENAME, CODEX_RESERVED_MODEL_PROVIDER_IDS, codexAggregationRoute, isCustomCodexModelProviderId };
