// ─── stack/virtual-row ─────────────────────────────────────────────────
// Derivation of the runtime-virtual aggregation row. Kept free of the DB:
// callers inject the provider names that are already taken, which is what
// lets db.ts depend on this module instead of stack/state (no cycle).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../json-utils.js";
import {
  HOME,
  INSTANCES_DIR,
  STACK_FALLBACK_BASE_URL,
  VIRTUAL_STACK_APPS,
  VIRTUAL_STACK_PROVIDER_ID,
} from "../paths.js";
import { parseToml, stringifyToml } from "../toml.js";
import {
  AGGREGATION_MODEL_ALIAS_KEYS,
  CC_SWITCH_CATALOG_FILENAME,
  PROXY_MANAGED_TOKEN,
  isCustomCodexModelProviderId,
  isLoopbackBaseUrl,
} from "./aggregation.js";
import { readGlobalModelPicker, readStackState } from "./live-state.js";

// Derive the aggregation routing contract from the GLOBAL ~/.claude/settings.json
// the desktop app writes when its stack is live (loopback env + ccs alias tiers
// + modelPicker). Extraction of the derive half of the old ensureStackProviderRow
// — now the single source the virtual row computes from on every query, so a
// desktop re-point or member swap surfaces on the next TUI open / launch with no
// mirror step. Returns { settings: {env[, modelPicker]}, baseUrl }, or null when
// the global env is missing/not loopback (no usable contract to derive).
function buildStackSettingsFromGlobal() {
  let globalEnv: any = null;
  try {
    globalEnv =
      JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"))?.env || null;
  } catch {
    globalEnv = null;
  }
  if (!isPlainObject(globalEnv) || !isLoopbackBaseUrl(globalEnv.ANTHROPIC_BASE_URL)) return null;
  const env: Record<string, any> = {
    ANTHROPIC_AUTH_TOKEN: PROXY_MANAGED_TOKEN,
    ANTHROPIC_BASE_URL: globalEnv.ANTHROPIC_BASE_URL,
  };
  for (const k of AGGREGATION_MODEL_ALIAS_KEYS) {
    if (typeof globalEnv[k] === "string") env[k] = globalEnv[k];
  }
  const settings: any = { env };
  const picker = readGlobalModelPicker();
  if (picker && picker.options.length) settings.modelPicker = picker;
  return { settings, baseUrl: globalEnv.ANTHROPIC_BASE_URL };
}

// Codex twin of buildStackSettingsFromGlobal: derive the aggregation routing
// contract from the GLOBAL ~/.codex/config.toml as a WHITELIST projection —
// only the routing identity, never the runtime/general keys (projects trust,
// hook hashes, [tui], model_reasoning_effort …) that would fossilize into the
// row and fire drift. The catalog is NOT stored on the row (no modelCatalog
// key): prepare copies the global cc-switch-model-catalog.json verbatim, and
// model_catalog_json is pinned to the constant so prepare/guard derive
// identically regardless of whether that file exists. The bearer token is
// FORCED to PROXY_MANAGED and auth to {} — no real credential ever enters the
// row. Returns null (no usable contract) when the file is missing/corrupt,
// model_provider is missing or a reserved id (the desktop pointing Codex at
// the official API must never yield a proxy row), the active table is absent,
// or the base URL is not loopback. The global bearer itself is NOT required —
// same looseness as the claude derive, which only checks loopback and forces
// the token.
function buildCodexStackSettingsFromGlobal() {
  let doc: any = null;
  try {
    doc = parseToml(readFileSync(join(HOME, ".codex", "config.toml"), "utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(doc)) return null;
  const providerId = typeof doc.model_provider === "string" ? doc.model_provider.trim() : "";
  if (!providerId || !isCustomCodexModelProviderId(providerId)) return null;
  const table: any = isPlainObject(doc.model_providers?.[providerId])
    ? doc.model_providers[providerId]
    : null;
  const baseUrl = typeof table?.base_url === "string" ? table.base_url.trim() : "";
  if (!baseUrl || !isLoopbackBaseUrl(baseUrl)) return null;
  const proj: any = {
    model_provider: providerId,
    model_catalog_json: CC_SWITCH_CATALOG_FILENAME,
    model_providers: {
      [providerId]: {
        name: typeof table.name === "string" && table.name.trim() ? table.name : providerId,
        base_url: baseUrl,
        wire_api: table.wire_api === "chat" ? "chat" : "responses",
        experimental_bearer_token: PROXY_MANAGED_TOKEN,
        requires_openai_auth: false,
      },
    },
  };
  if (typeof doc.model === "string" && doc.model.trim()) proj.model = doc.model.trim();
  if (typeof doc.web_search === "string" || typeof doc.web_search === "boolean") {
    proj.web_search = doc.web_search;
  }
  return { settings: { config: stringifyToml(proj), auth: {} }, baseUrl };
}

// Dormant-row settings for codex (stack off but a __stack__ instance dir
// exists): the claude dormant row carries no aliases/picker — here, no model/
// web_search. The provider id is a synthesized non-reserved one so the
// projection still parses as a custom provider table; the launch probe warns
// the proxy is down (or the stack off) and the entry is only ever reached
// with the instance dir present.
function codexStackDormantSettings(baseUrl) {
  const proj = {
    model_provider: "cc-switch-stack",
    model_catalog_json: CC_SWITCH_CATALOG_FILENAME,
    model_providers: {
      "cc-switch-stack": {
        name: "cc-switch-stack",
        base_url: baseUrl,
        wire_api: "responses",
        experimental_bearer_token: PROXY_MANAGED_TOKEN,
        requires_openai_auth: false,
      },
    },
  };
  return { config: stringifyToml(proj), auth: {} };
}

// Per-app settings derivation for the virtual aggregation row — the three-
// state skeleton below stays single-source; only the "derive from global
// config" and "dormant settings" halves differ per app (claude: env object;
// codex: TOML whitelist projection).
const STACK_SETTINGS_DERIVERS = {
  claude: {
    fromGlobal: buildStackSettingsFromGlobal,
    dormant(baseUrl) {
      return { env: { ANTHROPIC_AUTH_TOKEN: PROXY_MANAGED_TOKEN, ANTHROPIC_BASE_URL: baseUrl } };
    },
  },
  codex: {
    fromGlobal: buildCodexStackSettingsFromGlobal,
    dormant: (baseUrl) => codexStackDormantSettings(baseUrl),
  },
};

// The virtual aggregation provider row (appType-parameterized). Same shape as a
// DB row so every consumer — prepare, guard, statusline injection, drift —
// treats it like any other provider, plus `is_virtual: true` (never written to
// the DB; the query layer and write-back paths key on it). meta carries
// stackManaged:true so the existing buildClaudeEffectiveSettings behaviors
// (forced common merge, picker drop-with-stack-off) apply unchanged. Three
// states:
//   stack on + loopback global env        → full live row (contract derived fresh)
//   stack off + a __stack__ instance dir  → dormant row (fallback base URL, no
//                                           aliases/picker) — "(inactive)", still
//                                           launchable, probe warns
//   otherwise                             → null (aggregation never used: zero noise)
// `takenNames` are the provider names already in the DB for this app; the
// caller injects them so this module never needs the DB (avoids a cycle).
// Computed on every call — no cache; the CLI calls it a handful of times per run.
function virtualStackProviderForCore(appType, takenNames: string[] = []) {
  if (!VIRTUAL_STACK_APPS.has(appType)) return null;
  try {
    const deriver = STACK_SETTINGS_DERIVERS[appType];
    let settings: any = null;
    let baseUrl: string | null = null;
    if (readStackState(appType)) {
      const derived = deriver.fromGlobal();
      if (derived) ({ settings, baseUrl } = derived);
    }
    if (!settings) {
      // Dormant path: only surface the entry when the user actually used
      // aggregation before (the instance dir is the durable trace; live-state
      // and the DB row both come and go with the desktop app).
      const dir = join(INSTANCES_DIR, appType, VIRTUAL_STACK_PROVIDER_ID);
      if (!existsSync(dir)) return null;
      baseUrl = STACK_FALLBACK_BASE_URL;
      settings = deriver.dormant(baseUrl);
    }
    // Avoid colliding with an unrelated provider that already owns the name
    // (same dodge the old auto-created row used). DB-first everywhere: a real
    // row named "Stack" keeps the name, the virtual entry shows as "Stack 2".
    let name = "Stack";
    const taken = new Set(takenNames);
    for (let i = 2; taken.has(name); i++) name = `Stack ${i}`;
    return {
      id: VIRTUAL_STACK_PROVIDER_ID,
      app_type: appType,
      name,
      settings_config: JSON.stringify(settings),
      category: null,
      meta: '{"stackManaged":true}',
      is_virtual: true,
    };
  } catch {
    return null; // fail-open: construction trouble = "no aggregation entry"
  }
}

// Query-exit merge helper: append the virtual row to a DB result set unless the
// DB itself already carries an id-addressable row for it (defensive — a future
// desktop that writes its own row wins). `rows` keeps the caller's projection
// shape ({id, name} for the list queries; full rows for the single-row ones).
// is_virtual stays on the row — the drift split and write-back paths key on it.
function appendVirtualStackRowCore(rows, appType, takenNames: string[] = []) {
  const v = virtualStackProviderForCore(appType, takenNames);
  if (!v) return rows;
  if (rows.some((r) => r.id === VIRTUAL_STACK_PROVIDER_ID)) return rows;
  return [...rows, v];
}

export {
  STACK_SETTINGS_DERIVERS,
  appendVirtualStackRowCore,
  buildCodexStackSettingsFromGlobal,
  buildStackSettingsFromGlobal,
  codexStackDormantSettings,
  virtualStackProviderForCore,
};
