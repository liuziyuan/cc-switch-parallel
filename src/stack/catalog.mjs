// ─── stack/catalog (split from bin/cc-launch.mjs) ─────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { providerUsesCommonConfig } from "../claude-config.mjs";
import { atomicWrite } from "../fs-utils.mjs";
import { isPlainObject, jsonDeepClone, jsonDeepMerge } from "../json-utils.mjs";
import { HOME, INSTANCES_DIR, RESOURCES_DIR } from "../paths.mjs";
import { isCodexAggregationProviderSettings, readStackState } from "./state.mjs";
import { parseToml, stringifyToml } from "../toml.mjs";
import { tomlDeepMerge } from "../toml-utils.mjs";

// ─── Codex config generation ──────────────────────────────────────────

const CODEX_OFFICIAL_PROVIDER_ID = "codex-official";
const CODEX_RESERVED_MODEL_PROVIDER_IDS = [
  "amazon-bedrock", "openai", "ollama", "lmstudio", "oss", "ollama-chat",
];
const CC_SWITCH_CATALOG_FILENAME = "cc-switch-model-catalog.json";
const CODEX_WEB_SEARCH_REJECT_HOSTS = [
  "xiaomimimo.com", "longcat.chat", "minimax.io", "minimaxi.com",
];
const CODEX_WEB_SEARCH_REJECT_MODEL_PREFIXES = ["mimo", "longcat", "minimax", "qwen3-coder"];
const ONE_M_CONTEXT_MARKER = "[1m]";

const CONFIRMED_TEXT_ONLY_TAILS = [
  "ark-code-latest", "deepseek-chat", "deepseek-reasoner",
  "deepseek-v4-flash", "deepseek-v4-pro",
  "glm-5.1", "glm-5.2",
  "kat-coder", "kat-coder-pro", "kat-coder-pro v1", "kat-coder-pro v2",
  "kat-coder-pro-v1", "kat-coder-pro-v2",
  "ling-2.5-1t", "longcat-2.0", "longcat-flash-chat",
  "minimax-m2.7", "minimax-m2.7-highspeed", "mimo-v2.5-pro",
  "qwen3-coder-480b", "qwen3-coder-480b-a35b-instruct",
  "qwen3-coder-flash", "qwen3-coder-next", "qwen3-coder-plus",
  "step-3.5-flash", "step-3.5-flash-2603", "us.deepseek.r1-v1",
];

function normalizeModelId(value) {
  let n = value.trim().replace(/^models\//, "").trim().toLowerCase();
  if (n.endsWith(ONE_M_CONTEXT_MARKER)) {
    n = n.slice(0, -ONE_M_CONTEXT_MARKER.length).trim();
  }
  return n;
}

function isConfirmedTextOnlyModel(model) {
  const normalized = normalizeModelId(model);
  const tail = normalized.split("/").pop();
  return CONFIRMED_TEXT_ONLY_TAILS.includes(tail);
}

function imageInputCapabilityFromModalities(model, modalities) {
  const declared = modalities
    ? modalities.some((m) => m.trim().toLowerCase() === "image")
    : undefined;
  if (declared === true) return "Supported";
  if (declared === false) return "Unsupported";
  if (isConfirmedTextOnlyModel(model)) return "Unsupported";
  return "Unknown";
}

function codexCatalogInputModalities(model, declaredModalities) {
  const cap = imageInputCapabilityFromModalities(model, declaredModalities);
  return cap === "Unsupported" ? ["text"] : ["text", "image"];
}

function parsePositiveU64(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value > 0 ? value : undefined;
  if (typeof value === "string") {
    const n = parseInt(value.trim(), 10);
    return !isNaN(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

function codexCatalogModelSpecs(settingsConfig) {
  const models = settingsConfig?.modelCatalog?.models;
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const specs = [];
  for (const mc of models) {
    const model = mc.model?.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    specs.push({
      model,
      displayName: [mc.displayName, mc.display_name].find((v) => v?.trim())?.trim() || undefined,
      contextWindow: parsePositiveU64([mc.contextWindow, mc.context_window].find((v) => v !== undefined)),
      supportsParallelToolCalls: [mc.supportsParallelToolCalls, mc.supports_parallel_tool_calls].find((v) => v !== undefined),
      inputModalities: [mc.inputModalities, mc.input_modalities].find((v) => v !== undefined),
      baseInstructions: [mc.baseInstructions, mc.base_instructions].find((v) => v?.trim()),
    });
  }
  return specs;
}

function resolveCodexCatalogToolProfile(provider) {
  if (provider.id === CODEX_OFFICIAL_PROVIDER_ID && provider.category === "official") {
    return "NativeResponses";
  }
  if (provider.meta?.providerType === "xai_oauth") return "NativeResponses";
  const apiFormat = provider.meta?.apiFormat;
  if (apiFormat === "anthropic") return "Anthropic";
  if (apiFormat === "openai_responses") return "NativeResponses";
  return "ProxyChat";
}

function loadTemplate(profile) {
  const filename = profile === "ProxyChat" ? "gpt5_5_template.json" : "codex_native_responses_template.json";
  return JSON.parse(readFileSync(join(RESOURCES_DIR, filename), "utf8"));
}

function codexCatalogModelEntry(template, spec, priority, profile, defaultContextWindow) {
  const entry = jsonDeepClone(template);
  const displayName = spec.displayName || spec.model;
  const contextWindow = spec.contextWindow || defaultContextWindow;
  entry.slug = spec.model;
  entry.display_name = displayName;
  entry.description = displayName;
  entry.context_window = contextWindow;
  entry.max_context_window = contextWindow;
  entry.priority = 1000 + priority;
  entry.additional_speed_tiers = [];
  entry.service_tiers = [];
  entry.availability_nux = null;
  entry.upgrade = null;
  entry.input_modalities = codexCatalogInputModalities(spec.model, spec.inputModalities);
  if (profile !== "ProxyChat") {
    for (const key of ["apply_patch_tool_type", "web_search_tool_type", "tools", "model_messages"]) {
      delete entry[key];
    }
    entry.shell_type = "shell_command";
    if (spec.baseInstructions?.trim()) entry.base_instructions = spec.baseInstructions.trim();
    if (spec.supportsParallelToolCalls !== undefined) entry.supports_parallel_tool_calls = spec.supportsParallelToolCalls;
  }
  return entry;
}

function codexModelCatalogFromSettings(settingsConfig, configText, profile) {
  const specs = codexCatalogModelSpecs(settingsConfig);
  if (specs.length === 0) return null;
  const defaultContextWindow = extractTopLevelU64(configText, "model_context_window") || 128000;
  const template = loadTemplate(profile);
  const entries = specs.map((spec, i) => codexCatalogModelEntry(template, spec, i, profile, defaultContextWindow));
  return { models: entries };
}

// ─── Aggregation catalog copy (verbatim, never regenerated) ───────────
// The desktop app writes the full aggregation /model catalog (member-prefixed
// ccs ids, comp_hash, multi_agent_version, truncation_policy …) into the
// GLOBAL ~/.codex/cc-switch-model-catalog.json — 11+ keys the template
// regeneration would drop. Aggregation instances copy that file BYTE FOR
// BYTE. The config's model_catalog_json is pinned to the constant by the
// projection/protection, so the derivation never depends on this file
// existing; a failed copy keeps the instance's previous copy (stale list
// beats no list) and warns.

function readGlobalCodexCatalogText() {
  try {
    const text = readFileSync(join(HOME, ".codex", CC_SWITCH_CATALOG_FILENAME), "utf8");
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) return null;
    return text;
  } catch {
    return null;
  }
}

function copyGlobalCodexCatalogIntoInstance(instanceDir) {
  const text = readGlobalCodexCatalogText();
  const dest = join(instanceDir, CC_SWITCH_CATALOG_FILENAME);
  if (text !== null) {
    atomicWrite(dest, text);
    return { copied: true };
  }
  const keptExisting = existsSync(dest);
  console.error(keptExisting
    ? `⚠ 全局 ${CC_SWITCH_CATALOG_FILENAME} 缺失或损坏 — 实例保留现有副本，/model 列表可能过期（请在桌面端修复后重进实例）`
    : `⚠ 全局 ${CC_SWITCH_CATALOG_FILENAME} 缺失或损坏 — 实例将没有聚合模型列表（请在桌面端修复后重进实例）`);
  return { copied: false };
}

function extractTopLevelU64(configText, field) {
  try {
    const doc = parseToml(configText);
    const v = doc[field];
    if (typeof v === "number") return v > 0 ? v : undefined;
  } catch {}
  return undefined;
}

// The active routing triple of a Codex config.toml: provider id, its table,
// base_url and bearer token — table-first, top-level fallback, mirroring the
// WRITE priority of setCodexExperimentalBearerToken so signature checks,
// derivation and the launch probe all agree on one parse. Null on unparsable
// input. baseUrl/bearer are non-empty strings or null.
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

function extractCodexBaseUrl(configText) {
  try {
    const doc = parseToml(configText);
    const activeProvider = doc.model_provider;
    if (activeProvider && doc.model_providers?.[activeProvider]?.base_url) {
      return doc.model_providers[activeProvider].base_url;
    }
    return doc.base_url || undefined;
  } catch {}
  return undefined;
}

function codexNativeGatewayRejectsWebSearch(configText) {
  const baseUrl = extractCodexBaseUrl(configText)?.toLowerCase();
  if (baseUrl && CODEX_WEB_SEARCH_REJECT_HOSTS.some((h) => baseUrl.includes(h))) return true;
  try {
    const doc = parseToml(configText);
    const model = doc.model?.trim().toLowerCase();
    if (model) {
      const tail = model.split("/").pop();
      if (CODEX_WEB_SEARCH_REJECT_MODEL_PREFIXES.some((p) => tail.startsWith(p))) return true;
    }
  } catch {}
  return false;
}

function setCodexModelCatalogField(configObj, hasCatalog) {
  if (hasCatalog) {
    configObj.model_catalog_json = CC_SWITCH_CATALOG_FILENAME;
  } else if (configObj.model_catalog_json === CC_SWITCH_CATALOG_FILENAME) {
    delete configObj.model_catalog_json;
  }
}

function setCodexWebSearchField(configObj, disable) {
  if (disable) {
    configObj.web_search = "disabled";
  } else if (configObj.web_search === "disabled") {
    delete configObj.web_search;
  }
}

// Codex's native TUI status line ([tui] status_line in config.toml, Codex CLI
// ≥ 0.105.0) only selects from built-in items — there is no external-command
// rendering (upstream openai/codex#17827), so no provider tag is possible
// here. What switch guarantees is that the status line is ON with useful
// items. Fill-if-absent: explicit values in the provider/common TOML win
// (the item set is a fixed enum, so unlike claude's statusLine there is no
// relay wrapper that could honor user config AND add a tag — user values
// must take precedence); `status_line = []` opts out entirely.
const CODEX_STATUS_LINE_ITEMS = ["model-with-reasoning", "current-dir"];

function applyCodexStatusLineInjection(configObj) {
  const tui = isPlainObject(configObj.tui) ? configObj.tui : (configObj.tui = {});
  if (tui.status_line === undefined) tui.status_line = [...CODEX_STATUS_LINE_ITEMS];
  if (tui.status_line_use_colors === undefined) tui.status_line_use_colors = true;
  return configObj;
}

// [C6 for the codex statusline channel] — the settings-field sync and the
// overwrite guard must neither report nor vote on this subtree. Exact match +
// dotted-suffix (never a bare "tui." prefix) so the user's own [tui] keys
// (notifications, terminal_title, …) keep syncing normally.
function isCodexStatusLineChannelPath(path) {
  return path === "tui.status_line" || path.startsWith("tui.status_line.")
    || path === "tui.status_line_use_colors";
}

// [Runtime-state filter for the codex settings channel] — keys the Codex CLI
// itself writes into the instance config.toml while running, NOT user config:
// project trust records (one per directory ever launched from, grows forever),
// hook trust hashes (keyed by absolute paths that only exist inside this
// instance dir), and one-shot TUI markers. Syncing them upward is what fired
// the 2026-10-17 "Sync these changes?" prompt on every new project, and the
// prompt's write-back corrupted the provider row (dotted-key bug). Listed
// exactly rather than tui-subtree-wide so user-configured [tui] keys
// (terminal_title, notifications, …) keep syncing normally.
function isCodexRuntimeStatePath(path) {
  return path.startsWith("projects.")
    || path.startsWith("hooks.state.")
    || path === "tui.screen_reader_detection_done"
    || path.startsWith("tui.model_availability_nux.");
}

// Leaf diffing reports the PARENT path, not leaves, when one side lacks the
// whole subtree (e.g. baseline has no hooks, the first session writes
// [hooks.state] → { path: "hooks", op: "add" }). The path-only filter above
// then misses it (`"hooks"` does not start with `"hooks.state."`), and the
// runtime write is mistaken for a user edit — the 2026-10-18 "every launch
// asks to sync hooks" bug. Classify such whole-subtree changes by value:
// - projects: every entry is a CLI-written trust record;
// - hooks: runtime ONLY when the table holds nothing but `state` (hook
//   definitions live in hooks.json, not config.toml) — any other key means
//   real user hook config, which must keep syncing;
// - tui.model_availability_nux: the whole table is one-shot nux markers.
// `change` is optional so existing path-only callers keep working.
function isCodexRuntimeStateChange(path, change) {
  if (isCodexRuntimeStatePath(path)) return true;
  if (path === "projects" || path === "tui.model_availability_nux") return true;
  if (path === "hooks") {
    const value = change?.op === "remove" ? change.from : change?.to;
    return isPlainObject(value) && Object.keys(value).every((k) => k === "state");
  }
  return false;
}

// Carry the instance's Codex-written runtime state (project trust, hook trust
// hashes, TUI markers — isCodexRuntimeStatePath) across a full config.toml
// regeneration. prepare rebuilds the document from the DB, which would wipe
// that state: hook trust hashes would vanish → every session re-prompts
// "Hooks need review", project trust would re-prompt per directory. The file's
// live values win over anything the DB carries (runtime state is per-machine
// fact, the DB copy is at best a stale echo — and after the dotted-key bug it
// may be a CORRUPTED echo). Fail-safe: any parse error returns the input
// unchanged. Paired with computeEffectiveSettings (same derivation) so the
// overwrite guard's comparison [C3] sees what prepare actually writes.
//
// `isAgg` (aggregation row) additionally carries the instance-local /model
// pick (top-level `model`): the virtual row has no DB row to sync back into
// (virtualBlocked), so without the carry every relaunch would reset the
// member the user picked in /model. A pick pointing at a stack key that is no
// longer live (stack off, member removed) is dropped — it would fail at the
// proxy on every request. Plain rows do NOT carry model: their pick flows
// through the guard + sync write-back instead (established semantics).
function mergeCodexRuntimeState(configText, instanceDir, isAgg = false) {
  try {
    const current = parseToml(readFileSync(join(instanceDir, "config.toml"), "utf8"));
    const generated = parseToml(configText);
    let changed = false;
    for (const key of ["projects", "hooks"]) {
      if (isPlainObject(current[key])) {
        generated[key] = jsonDeepMerge(isPlainObject(generated[key]) ? generated[key] : {}, current[key]);
        changed = true;
      }
    }
    const curTui = isPlainObject(current.tui) ? current.tui : {};
    if (curTui.screen_reader_detection_done !== undefined) {
      generated.tui = isPlainObject(generated.tui) ? generated.tui : {};
      generated.tui.screen_reader_detection_done = curTui.screen_reader_detection_done;
      changed = true;
    }
    if (isPlainObject(curTui.model_availability_nux)) {
      generated.tui = isPlainObject(generated.tui) ? generated.tui : {};
      generated.tui.model_availability_nux = jsonDeepMerge(
        isPlainObject(generated.tui.model_availability_nux) ? generated.tui.model_availability_nux : {},
        curTui.model_availability_nux,
      );
      changed = true;
    }
    if (isAgg && typeof current.model === "string" && current.model) {
      // Dangling ccs pick fallback: key liveness mirrors the proxy's routing
      // (ccs-<key>/<model> — key never contains "/"). Runs here, not at the
      // write site, so prepare AND computeEffectiveSettings drop it identically.
      let model = current.model;
      const ccs = model.match(/^ccs-([a-z0-9-]+)\//i);
      if (ccs) {
        const stack = readStackState("codex");
        const key = ccs[1].toLowerCase();
        if (!stack || !(key in stack.keys)) {
          console.error(`\x1b[2mℹ 聚合模型 "${model}" 已不在当前聚合栈中（栈已关闭或成员被移除）— 本次启动回退默认模型，恢复后请在 /model 重选\x1b[0m`);
          model = null;
        }
      }
      if (model && model !== generated.model) {
        generated.model = model;
        changed = true;
      }
    }
    return changed ? stringifyToml(generated) : configText;
  } catch {
    return configText;
  }
}

// Instance dir derivation shared by prepare and computeEffectiveSettings —
// same expression, so the guard's comparison [C3] stays identical by
// construction (applyStatusLineInjection derives claude's the same way).
function codexInstanceDirFor(providerId) {
  return join(INSTANCES_DIR, "codex", providerId);
}

function isCustomCodexModelProviderId(id) {
  const trimmed = id.trim();
  return trimmed.length > 0 && !CODEX_RESERVED_MODEL_PROVIDER_IDS.some((r) => r.toLowerCase() === trimmed.toLowerCase());
}

function setCodexExperimentalBearerToken(configObj, token) {
  const providerId = configObj.model_provider;
  if (!providerId || !isCustomCodexModelProviderId(providerId)) {
    configObj.experimental_bearer_token = token;
    return;
  }
  if (configObj.model_providers?.[providerId]) {
    configObj.model_providers[providerId].experimental_bearer_token = token;
    return;
  }
  configObj.experimental_bearer_token = token;
}

function extractCodexAuthApiKey(auth) {
  const key = auth?.OPENAI_API_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

function codexAuthHasLoginMaterial(auth) {
  if (!isPlainObject(auth)) return false;
  for (const [key, value] of Object.entries(auth)) {
    if (key === "auth_mode") continue;
    if (key === "OPENAI_API_KEY") {
      if (typeof value === "string" && value.trim()) return true;
      continue;
    }
    if (value === null) continue;
    if (typeof value === "string" && value.trim()) return true;
    if (Array.isArray(value) && value.length) return true;
    if (isPlainObject(value) && Object.keys(value).length) return true;
    return true;
  }
  return false;
}

// Post-merge guard for codex aggregation rows (called from buildCodexConfig
// after the common merge). The row's config IS the routing identity — the
// codex mirror of protectAggregationIdentityEnv. Restoration semantics:
//   model_provider / web_search      hard — row value restored, else deleted
//   model_providers.<activeId>       hard — WHOLE-TABLE deep clone replace, so
//                                    a common config cannot plant auth-bypass
//                                    keys (env_key, http_headers, …) into the
//                                    proxy table; absent on the row → deleted
//   model_catalog_json               restore-or-SET to the constant (never
//                                    file-existence-dependent: prepare copies
//                                    the file separately, the config must
//                                    derive identically with or without it)
//   top-level base_url / wire_api /  deleted unconditionally — Codex's
//   experimental_bearer_token /      fallback identity channel; the identity
//   requires_openai_auth             lives only in the provider table
//   model                            soft — row value wins when present, the
//                                    common value stands otherwise
// Mutates and returns configObj. Idempotent when the common merge didn't run.
const CODEX_AGG_TOPLEVEL_FALLBACK_KEYS = ["base_url", "wire_api", "experimental_bearer_token", "requires_openai_auth"];

function protectCodexAggregationIdentity(configObj, settingsConfig) {
  let rowDoc = null;
  try { rowDoc = parseToml(settingsConfig?.config || ""); } catch {}
  if (!isPlainObject(rowDoc)) rowDoc = {};
  const pid = typeof rowDoc.model_provider === "string" ? rowDoc.model_provider : null;
  if (pid) configObj.model_provider = pid;
  else delete configObj.model_provider;
  if (!isPlainObject(configObj.model_providers)) configObj.model_providers = {};
  const rowTable = pid && isPlainObject(rowDoc.model_providers?.[pid]) ? rowDoc.model_providers[pid] : null;
  if (rowTable) configObj.model_providers[pid] = jsonDeepClone(rowTable);
  else if (pid) delete configObj.model_providers[pid];
  // Also drop any table the row doesn't carry — a common config cannot plant
  // provider tables into an aggregation instance (inert while model_provider
  // is pinned, but noise at best and a footgun at worst).
  const rowTables = isPlainObject(rowDoc.model_providers) ? rowDoc.model_providers : {};
  for (const k of Object.keys(configObj.model_providers)) {
    if (!(k in rowTables)) delete configObj.model_providers[k];
  }
  if (!Object.keys(configObj.model_providers).length) delete configObj.model_providers;
  configObj.model_catalog_json = CC_SWITCH_CATALOG_FILENAME;
  if (rowDoc.web_search !== undefined) configObj.web_search = rowDoc.web_search;
  else delete configObj.web_search;
  for (const k of CODEX_AGG_TOPLEVEL_FALLBACK_KEYS) delete configObj[k];
  if (rowDoc.model !== undefined) configObj.model = rowDoc.model;
  return configObj;
}

function buildCodexConfig(settingsConfig, meta, category, commonSnippet, provider, settings) {
  const configText = settingsConfig.config || "";
  // Aggregation rows (codex signature: loopback active table + PROXY_MANAGED)
  // always merge the common config — same reasoning as claude's
  // buildClaudeEffectiveSettings: the row carries only routing identity, so
  // the subset fallback can never see the common content, and an explicit
  // commonConfigEnabled:false still wins. Not gated on readStackState.
  const isAgg = isCodexAggregationProviderSettings(settingsConfig);
  let effectiveConfigText = configText;

  // Common config merge (TOML)
  const snippetTrimmed = (commonSnippet || "").trim();
  if (snippetTrimmed && (
    (isAgg && meta?.commonConfigEnabled !== false) ||
    providerUsesCommonConfig("codex", settingsConfig, meta, commonSnippet)
  )) {
    try {
      const target = parseToml(configText || "");
      const source = parseToml(commonSnippet.trim());
      tomlDeepMerge(target, source);
      effectiveConfigText = stringifyToml(target);
    } catch (e) {
      console.error(`⚠ Codex common config merge failed: ${e.message}`);
    }
  }

  const profile = resolveCodexCatalogToolProfile({
    id: provider.id,
    category,
    meta: { apiFormat: meta?.apiFormat, providerType: meta?.providerType },
  });
  // Aggregation rows carry no modelCatalog — the catalog comes from copying
  // the global cc-switch-model-catalog.json verbatim in prepare (stackCatalog
  // flag below), never from the template regeneration that would drop the
  // desktop-written keys (comp_hash, multi_agent_version, priorities …).
  const catalog = isAgg ? null : codexModelCatalogFromSettings(settingsConfig, effectiveConfigText, profile);

  let configObj;
  try {
    configObj = parseToml(effectiveConfigText || "");
  } catch (e) {
    throw new Error(`Failed to parse Codex config.toml: ${e.message}`);
  }

  // Identity protection right after the parse — before any other rewrite, and
  // idempotent when no common merge ran (plain re-projection of the row).
  if (isAgg) protectCodexAggregationIdentity(configObj, settingsConfig);

  if (isAgg) {
    // model_catalog_json pinned to the constant; web_search rides the
    // whitelist projection + the hard protection above — the profile-based
    // disable logic below is for regenerated catalogs only.
    setCodexModelCatalogField(configObj, true);
  } else if (catalog) {
    setCodexModelCatalogField(configObj, true);
    let disableWebSearch = false;
    if (profile === "Anthropic") {
      disableWebSearch = true;
    } else if (profile === "NativeResponses") {
      disableWebSearch = codexNativeGatewayRejectsWebSearch(stringifyToml(configObj));
    }
    setCodexWebSearchField(configObj, disableWebSearch);
  } else {
    setCodexModelCatalogField(configObj, false);
    if (profile === "Anthropic") setCodexWebSearchField(configObj, true);
  }
  applyCodexStatusLineInjection(configObj);

  let finalConfigText = stringifyToml(configObj);
  // Aggregation row: auth stays {} — the real credentials live in the member
  // rows and the proxy; a misconfigured OPENAI_API_KEY must never overwrite
  // PROXY_MANAGED (bearer injection below is likewise skipped).
  const auth = isAgg ? {} : (settingsConfig.auth || {});
  const apiKey = isAgg ? undefined : extractCodexAuthApiKey(auth);

  // Third-party provider: inject bearer token
  if (!isAgg && category !== "official" && apiKey) {
    const preserveOfficialAuth = settings.preserveCodexOfficialAuthOnSwitch || false;
    if (!preserveOfficialAuth) {
      try {
        const configObj2 = parseToml(finalConfigText);
        setCodexExperimentalBearerToken(configObj2, apiKey);
        finalConfigText = stringifyToml(configObj2);
      } catch (e) {
        console.error(`⚠ Failed to inject bearer token: ${e.message}`);
      }
    }
  }

  return { configText: finalConfigText, auth, catalog, apiKey, profile, stackCatalog: isAgg };
}


export { CC_SWITCH_CATALOG_FILENAME, CODEX_AGG_TOPLEVEL_FALLBACK_KEYS, CODEX_OFFICIAL_PROVIDER_ID, CODEX_RESERVED_MODEL_PROVIDER_IDS, CODEX_STATUS_LINE_ITEMS, CODEX_WEB_SEARCH_REJECT_HOSTS, CODEX_WEB_SEARCH_REJECT_MODEL_PREFIXES, CONFIRMED_TEXT_ONLY_TAILS, ONE_M_CONTEXT_MARKER, applyCodexStatusLineInjection, buildCodexConfig, codexAggregationRoute, codexAuthHasLoginMaterial, codexCatalogInputModalities, codexCatalogModelEntry, codexCatalogModelSpecs, codexInstanceDirFor, codexModelCatalogFromSettings, codexNativeGatewayRejectsWebSearch, copyGlobalCodexCatalogIntoInstance, extractCodexAuthApiKey, extractCodexBaseUrl, extractTopLevelU64, imageInputCapabilityFromModalities, isCodexRuntimeStateChange, isCodexRuntimeStatePath, isCodexStatusLineChannelPath, isConfirmedTextOnlyModel, isCustomCodexModelProviderId, loadTemplate, mergeCodexRuntimeState, normalizeModelId, parsePositiveU64, protectCodexAggregationIdentity, readGlobalCodexCatalogText, resolveCodexCatalogToolProfile, setCodexExperimentalBearerToken, setCodexModelCatalogField, setCodexWebSearchField };
