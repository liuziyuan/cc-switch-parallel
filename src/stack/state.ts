// ─── stack/state (split from bin/cc-launch.mjs) ─────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import net from "node:net";
import { execDB, queryDB, queryProviderById, sqlQuote } from "../db.js";
import { atomicWrite } from "../fs-utils.js";
import { _historyFrozen, loadHistory, saveHistory } from "../history.js";
import { isPlainObject } from "../json-utils.js";
import type { ProviderRow } from "../types.js";
import { withFileLockSync } from "../file-lock.js";
import { HOME, HISTORY_PATH, INSTANCES_DIR, LIVE_STATE_PATH, STACK_FALLBACK_BASE_URL, STATUSLINE_PREFS_PATH, VIRTUAL_STACK_APPS, VIRTUAL_STACK_PROVIDER_ID } from "../paths.js";
import { CC_SWITCH_CATALOG_FILENAME, codexAggregationRoute, isCustomCodexModelProviderId } from "./aggregation.js";
import { buildUsageQueryConfig, resolveUsageIdentity } from "./usage.js";
import { loadStatuslinePreferences } from "../statusline-colors.js";
import { parseToml, stringifyToml } from "../toml.js";

// ─── cc-switch 4.0 aggregation (Stack) ────────────────────────────────
// Upstream cc-switch 4.0 "aggregation" runs a local HTTP proxy (default
// 127.0.0.1:15721) that publishes member providers' models into one Claude
// Code /model picker under `ccs-claude-<key>--<model>` ids. This CLI never
// enters/exits the mode (that is a desktop-app action) — it only CONSUMES its
// state so a proxy-endpoint provider behaves like any other parallel member:
//
//   • a provider whose env.ANTHROPIC_BASE_URL points at a loopback address is
//     treated as an aggregation instance: its wrapper gets a per-key usage map
//     (each member queried with its OWN credentials, direct to the member's
//     real origin — the proxy never sees usage traffic), the current key is
//     decoded at runtime from the statusline model id, and the instance
//     settings.json picks up the desktop app's `modelPicker` block (the /model
//     list lives in settings.json, NOT in /v1/models discovery).
//   • live-state.json is device-local upstream state with no stability
//     promise: every read here is fail-open (missing/corrupt/off → the
//     aggregation features silently vanish, the single-provider path runs).
//   • the TUI shows loopback providers under an aggregation label with the
//     live member names, and can auto-create the entry row when the desktop
//     app has aggregation on but no loopback provider exists yet.

// Loopback host = the aggregation proxy endpoint (a plain provider never
// points at one; a user's own local gateway would simply not match a live
// stack and fall through to the regular single-provider path).
function isLoopbackBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return false;
  try {
    // URL.hostname keeps the brackets on IPv6 literals ("[::1]").
    const host = new URL(baseUrl.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

// Deterministic Stack-row signature: loopback base URL + the upstream
// placeholder token (the shape the desktop live projection and the virtual
// entry write). Loopback alone cannot tell a Stack row from a user's own
// local gateway (LiteLLM, one-api …) — the earlier loopback-only test
// mistook gateway rows for Stack rows (forced common merge, picker
// injection, the old auto-create swallowing the gateway row as the
// "existing" Stack). Still no readStackState here: the merge decision must
// not flip with desktop state (prepare determinism).
function isAggregationProviderSettings(settingsConfig) {
  const env = isPlainObject(settingsConfig) && isPlainObject(settingsConfig.env) ? settingsConfig.env : null;
  return !!env && isLoopbackBaseUrl(env.ANTHROPIC_BASE_URL) && env.ANTHROPIC_AUTH_TOKEN === "PROXY_MANAGED";
}

// Codex mirror of isAggregationProviderSettings — same signature, TOML shape:
// the ACTIVE provider table's base_url is loopback AND its bearer token is the
// upstream placeholder. Loopback alone does NOT make an aggregation row (a
// user's own local gateway would false-positive otherwise). Reads the
// settings_config JSON envelope ({config: "<TOML>", auth}) — never live-state,
// so the merge/launch decisions stay deterministic under prepare.
function isCodexAggregationProviderSettings(settingsConfig) {
  if (!isPlainObject(settingsConfig) || typeof settingsConfig.config !== "string") return false;
  const r = codexAggregationRoute(settingsConfig.config);
  return !!r && isLoopbackBaseUrl(r.baseUrl) && r.bearer === "PROXY_MANAGED";
}

// per-app dispatch over the two signature shapes above — claude reads the
// env object, codex parses the config TOML. TUI grouping and the doctor's
// legacy-row count key on this instead of hardcoding the claude test.
function providerIsAggregation(appType, settingsConfig) {
  return appType === "codex"
    ? isCodexAggregationProviderSettings(settingsConfig)
    : isAggregationProviderSettings(settingsConfig);
}

// Base URL of an aggregation row, for the pre-launch TCP probe. Returns null
// for non-aggregation rows (the caller skips the probe entirely).
function aggregationBaseUrlFor(appType, settingsConfig) {
  if (appType === "codex") {
    if (!isCodexAggregationProviderSettings(settingsConfig)) return null;
    return codexAggregationRoute(settingsConfig.config)?.baseUrl ?? null;
  }
  if (!isAggregationProviderSettings(settingsConfig)) return null;
  return settingsConfig.env.ANTHROPIC_BASE_URL ?? null;
}

// Identity keys the aggregation merge must never let the common config win
// or plant: the row's env IS the routing identity. A common BASE_URL would
// bypass the proxy; a common AUTH_TOKEN/API_KEY would re-auth it (the Claude
// CLI ranks AUTH_TOKEN/Bearer above API_KEY/x-api-key, so an unrequested
// common Bearer hijacks auth even when the row carries API_KEY) — keys the
// row lacks are deleted outright, not just overwritten.
const AGGREGATION_IDENTITY_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
];

// The ccs model aliases the virtual entry copies from the global env
// (ANTHROPIC_DEFAULT_*_MODEL/_NAME) route default models through the proxy's
// key map — a common scalar would silently swap them and mis-attribute
// billing. Row value wins when present; when the row lacks a key the common
// value is harmless (no delete), unlike the identity keys above.
const AGGREGATION_MODEL_ALIAS_KEYS = [
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
];

// Post-merge guard for aggregation rows (called from
// buildClaudeEffectiveSettings only after mergeCommonOverProvider ran).
// effective.env can be non-object when a scalar/mismatched common `env`
// full-overwrote the row's env through the merge fallthrough — rebuild it
// from the row's env in that case rather than crash on the restore below.
function protectAggregationIdentityEnv(effective, settingsConfig) {
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
    const app = isPlainObject(raw.apps) && isPlainObject(raw.apps[appType])
      ? raw.apps[appType]
      : null;
    const contract = isPlainObject(app?.contract) ? app.contract : null;
    if (contract?.version !== undefined && contract.version !== 1) return null;
    const stack = app && isPlainObject(app.stack) ? app.stack : null;
    if (!stack || stack.enabled !== true) return null;
    const keys = isPlainObject(stack.keys)
      ? Object.fromEntries(Object.entries(stack.keys).filter(([, id]) => typeof id === "string"))
      : {};
    const members = Array.isArray(stack.members)
      ? stack.members.filter((id) => typeof id === "string" && keys && Object.values(keys).includes(id))
      : [];
    if (!Object.keys(keys).length || !members.length) return null;
    const proxyRoute = typeof app!.proxy_route === "string" ? app!.proxy_route : null;
    return { keys, members, proxyRoute };
  } catch {
    return null;
  }
}

// `model` on a codex AGGREGATION instance is carried across prepare
// (mergeCodexRuntimeState's isAgg branch) and has no DB row to sync into
// (virtual entry, or a hand-managed proxy row) — the edit would only ever
// surface as a blocked sync prompt, and the carry means prepare does NOT
// overwrite it. Yield the path like runtime state in the guard and the drift
// diff. Plain codex rows are unaffected: their /model pick still flows
// through guard + sync write-back (established semantics).
function isCodexAggModelPath(appType, providerId, path) {
  if (appType !== "codex" || path !== "model") return false;
  if (providerId === VIRTUAL_STACK_PROVIDER_ID) return true;
  try {
    const row = queryProviderById(providerId, "codex");
    return !!row && isCodexAggregationProviderSettings(JSON.parse(row.settings_config || "{}"));
  } catch { return false; }
}

// 300ms TCP probe of a base URL's host:port. Warn-only by design — the
// aggregation proxy lives and dies with the desktop app (README: "re-open
// the desktop app"), so an unreachable proxy must gate nothing, just say so.
async function probeTcpReachable(baseUrl: string, timeoutMs = 300): Promise<boolean> {
  try {
    const u = new URL(baseUrl);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (!u.hostname || !Number.isFinite(port)) return false;
    return await new Promise((resolve) => {
      const socket = net.connect({ host: u.hostname, port });
      const done = (ok) => { socket.destroy(); resolve(ok); };
      const timer = setTimeout(() => done(false), timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); done(true); });
      socket.once("error", () => { clearTimeout(timer); done(false); });
    });
  } catch {
    return false;
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
    globalEnv = JSON.parse(readFileSync(join(HOME, ".claude", "settings.json"), "utf8"))?.env || null;
  } catch { globalEnv = null; }
  if (!isPlainObject(globalEnv) || !isLoopbackBaseUrl(globalEnv.ANTHROPIC_BASE_URL)) return null;
  const env: Record<string, any> = {
    ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
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
  try { doc = parseToml(readFileSync(join(HOME, ".codex", "config.toml"), "utf8")); } catch { return null; }
  if (!isPlainObject(doc)) return null;
  const providerId = typeof doc.model_provider === "string" ? doc.model_provider.trim() : "";
  if (!providerId || !isCustomCodexModelProviderId(providerId)) return null;
  const table: any = isPlainObject(doc.model_providers?.[providerId]) ? doc.model_providers[providerId] : null;
  const baseUrl = typeof table?.base_url === "string" ? table.base_url.trim() : "";
  if (!baseUrl || !isLoopbackBaseUrl(baseUrl)) return null;
  const proj: any = {
    model_provider: providerId,
    model_catalog_json: CC_SWITCH_CATALOG_FILENAME,
    model_providers: {
      [providerId]: {
        name: (typeof table.name === "string" && table.name.trim()) ? table.name : providerId,
        base_url: baseUrl,
        wire_api: table.wire_api === "chat" ? "chat" : "responses",
        experimental_bearer_token: "PROXY_MANAGED",
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
        experimental_bearer_token: "PROXY_MANAGED",
        requires_openai_auth: false,
      },
    },
  };
  return { config: stringifyToml(proj), auth: {} };
}

// Per-app settings derivation for the virtual aggregation row — the three-
// state skeleton in virtualStackProviderFor stays single-source; only the
// "derive from global config" and "dormant settings" halves differ per app
// (claude: env object; codex: TOML whitelist projection).
const STACK_SETTINGS_DERIVERS = {
  claude: {
    fromGlobal: buildStackSettingsFromGlobal,
    dormant(baseUrl) {
      return { env: { ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED", ANTHROPIC_BASE_URL: baseUrl } };
    },
  },
  codex: {
    fromGlobal: buildCodexStackSettingsFromGlobal,
    dormant: (baseUrl) => codexStackDormantSettings(baseUrl),
  },
};

// The virtual aggregation provider row (appType-parameterized). Same shape as a DB row so every consumer — prepare, guard,
// statusline injection, drift — treats it like any other provider, plus
// `is_virtual: true` (never written to the DB; the query layer and write-back
// paths key on it). meta carries stackManaged:true so the existing
// buildClaudeEffectiveSettings behaviors (forced common merge, picker
// drop-with-stack-off) apply unchanged. Three states:
//   stack on + loopback global env        → full live row (contract derived fresh)
//   stack off + a __stack__ instance dir  → dormant row (fallback base URL, no
//                                           aliases/picker) — "(inactive)", still
//                                           launchable, probe warns
//   otherwise                             → null (aggregation never used: zero noise)
// Computed on every call — no cache; the CLI calls it a handful of times per run.
function virtualStackProviderFor(appType) {
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
    try {
      const taken = new Set(queryDB(
        `SELECT name FROM providers WHERE app_type = ${sqlQuote(appType)}`,
      ).map((r) => r.name));
      for (let i = 2; taken.has(name); i++) name = `Stack ${i}`;
    } catch { /* DB unavailable — plain "Stack" is fine */ }
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
function appendVirtualStackRow(rows, appType) {
  const v = virtualStackProviderFor(appType);
  if (!v) return rows;
  if (rows.some((r) => r.id === VIRTUAL_STACK_PROVIDER_ID)) return rows;
  return [...rows, v];
}

// Per-member usage config map for an aggregation instance. Each member is
// resolved with its OWN settings_config + meta (never the aggregation row's
// proxy placeholder token) — the same resolveUsageIdentity the member would
// get as a direct provider. Members without a resolvable identity are simply
// absent from the map (no usage cell for them, never an error).
function buildStackUsageConfig(stack, instanceDir, wrapperPath) {
  const map: Record<string, any> = {};
  const names: Record<string, any> = {};
  for (const [key, providerId] of Object.entries(stack.keys) as [string, string][]) {
    let row: ProviderRow | null = null;
    try {
      row = queryProviderById(providerId, "claude");
    } catch {
      row = null;
    }
    if (!row) continue;
    let sc: any = null;
    let meta: any = null;
    try { sc = JSON.parse(row.settings_config); } catch { sc = null; }
    try { meta = JSON.parse(row.meta); } catch { meta = null; }
    const cfg = buildUsageQueryConfig(
      resolveUsageIdentity(sc, meta),
      join(instanceDir, `usage-stack-${key}.json`),
      wrapperPath,
    );
    if (!cfg) continue;
    map[key] = cfg;
    names[key] = row.name;
  }
  if (!Object.keys(map).length) return null;
  let defaultKey: string | null = null;
  if (stack.proxyRoute) {
    defaultKey = Object.keys(stack.keys).find((k) => stack.keys[k] === stack.proxyRoute) || null;
    if (defaultKey && !map[defaultKey]) defaultKey = null;
  }
  return { defaultKey, names, map, selfPath: wrapperPath };
}

// TUI helper: the aggregation group for an app's provider list. The entry is
// the RUNTIME-VIRTUAL row (virtualStackProviderFor) — never written to the DB,
// so the desktop GUI sees nothing — plus any DB rows matching the loopback +
// PROXY_MANAGED signature (legacy auto-created rows pending one-time cleanup,
// and hand-made ones, which today already take the aggregation label). Every
// loopback provider is labeled with the live member names — "◆ Aggregation ·
// Stack (DeepSeek + Z.AI GLM)", or "(inactive)" when the desktop app has the
// stack off (the entry still launches; it just proxies nothing until
// re-enabled). Returns { ids: Set, labels: Map<id, label> }, or null when no
// aggregation provider exists at all.
function buildAggregationGroup(appType) {
  const rows = queryDB(`SELECT id, name, settings_config FROM providers WHERE app_type = ${sqlQuote(appType)}`);
  const aggRows: any[] = [];
  for (const r of rows) {
    try {
      if (providerIsAggregation(appType, JSON.parse(r.settings_config))) aggRows.push(r);
    } catch {}
  }
  const virtual = virtualStackProviderFor(appType);
  if (virtual && !aggRows.some((r) => r.id === virtual.id)) aggRows.push(virtual);
  if (!aggRows.length) return null;
  const stack = readStackState(appType);
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const memberIds = stack ? [...new Set(stack.members)] : [];
  const members = memberIds.map((id) => nameById.get(id)).filter(Boolean);
  // A member whose provider row is gone renders as a silent short-list
  // today — say so, or the missing usage segment reads as a bug.
  const missingCount = memberIds.length - members.length;
  const missingText = stack && missingCount > 0 ? `, ${missingCount} member(s) missing` : "";
  const memberText = members.length
    ? ` (${members.join(" + ")}${missingText})`
    : stack ? (missingCount > 0 ? ` (${missingCount} member(s) missing)` : "") : " (inactive)";
  return {
    ids: new Set(aggRows.map((r) => r.id)),
    labels: new Map(aggRows.map((r) => [r.id, `◆ Aggregation · ${r.name}${memberText}`])),
  };
}

// One-time migration for the pre-virtualization era: versions ≤0.19 INSERTed a
// real DB row for the aggregation entry (randomUUID id, loopback + PROXY_MANAGED
// signature). The virtual entry replaces it — the DB row would keep showing up
// in the desktop GUI forever, so it is deleted here and every id-keyed reference
// (launch history entries + pin slots, statusline colors) moves to the stable
// virtual id. Runs on TUI open and before every claude launch (command mode
// never opens the TUI). Idempotent: no signature rows → null, zero output.
// Skips is_current rows (the desktop app is actively pointed at them — deleting
// would dangle its current-provider state). Fail-open: a locked/unreadable DB
// or a frozen history just skips this pass; the next run retries.
// Old instance dirs (UUID-named) are deliberately NOT renamed — a running
// session keeps working; `switch clean` reaps them once the session ends.
function cleanupLegacyStackRows() {
  let rows: any[] = [];
  try {
    rows = queryDB(
      "SELECT id, name, settings_config, is_current FROM providers WHERE app_type = 'claude'",
    );
  } catch {
    return null; // DB unavailable — retry next run
  }
  const legacy: any[] = [];
  for (const r of rows) {
    try {
      if (isAggregationProviderSettings(JSON.parse(r.settings_config))) legacy.push(r);
    } catch {}
  }
  if (!legacy.length) return null;
  const removed: any[] = [];
  const skippedCurrent: any[] = [];
  for (const r of legacy) {
    if (r.is_current) { skippedCurrent.push(r.name); continue; }
    try {
      execDB(`DELETE FROM providers WHERE id = ${sqlQuote(r.id)} AND app_type = 'claude'`);
      removed.push({ id: r.id, name: r.name });
    } catch {
      // locked mid-write — the row survives this pass, next run retries
    }
  }
  if (!removed.length) return { removed, skippedCurrent, migratedHistory: false, migratedColors: false };

  // launch_history: point entries and pin slots at the virtual id; entries that
  // collide after the rewrite (same cli|id|hotkey) merge keeping the stronger
  // count/lastUsed. Frozen history (failed migration at load) is left alone —
  // the rows are already deleted, so those entries read dead until cleanup.
  let migratedHistory = false;
  if (!_historyFrozen) {
    try {
      const locked = withFileLockSync(HISTORY_PATH, () => {
        const removedIds = new Set(removed.map((r) => r.id));
        const { entries, order } = loadHistory();
        let touched = false;
        for (const e of entries) {
          if (e.providerId && removedIds.has(e.providerId)) {
            e.providerId = VIRTUAL_STACK_PROVIDER_ID;
            touched = true;
          }
        }
        // merge duplicates born from the rewrite: prefer count, then lastUsed
        const byKey = new Map();
        const merged: any[] = [];
        for (const e of entries) {
          const k = `${e.cli}|${e.providerId ?? e.provider}|${e.hotkey ?? ""}`;
          const prev = byKey.get(k);
          if (!prev) { byKey.set(k, e); merged.push(e); continue; }
          if ((e.count || 0) > (prev.count || 0) || ((e.count || 0) === (prev.count || 0) && (e.lastUsed || 0) > (prev.lastUsed || 0))) {
            byKey.set(k, e);
            merged[merged.indexOf(prev)] = e;
          }
          touched = true;
        }
        // Several legacy ids map to the same virtual id: dedupe the slots,
        // otherwise the same Recent row renders twice.
        const slotMap = new Map(removed.map((r) => [ `claude|${r.id}`, `claude|${VIRTUAL_STACK_PROVIDER_ID}` ]));
        const seenOrder = new Set();
        let orderChanged = false;
        const nextOrder = order.map((slot) => {
          const mapped = slot && slotMap.has(slot) ? slotMap.get(slot) : slot;
          if (mapped !== slot) orderChanged = true;
          if (mapped && seenOrder.has(mapped)) { orderChanged = true; return null; }
          if (mapped) seenOrder.add(mapped);
          return mapped;
        });
        if (touched || orderChanged) saveHistory(merged, nextOrder);
        return touched || orderChanged;
      });
      migratedHistory = locked.acquired ? locked.value : false;
    } catch { /* history is best-effort — never block on it */ }
  }

  // statusline colors: same id-keyed move, existing value for the virtual id wins
  let migratedColors = false;
  try {
    const locked = withFileLockSync(STATUSLINE_PREFS_PATH, () => {
      const prefs = loadStatuslinePreferences();
      if (!prefs || !isPlainObject(prefs.colors?.claude)) return false;
      const bucket = prefs.colors.claude;
      let changed = false;
      for (const oldId of removed.map((r) => r.id)) {
        if (bucket[oldId] === undefined) continue;
        if (bucket[VIRTUAL_STACK_PROVIDER_ID] === undefined) bucket[VIRTUAL_STACK_PROVIDER_ID] = bucket[oldId];
        delete bucket[oldId];
        changed = true;
      }
      if (changed) atomicWrite(STATUSLINE_PREFS_PATH, JSON.stringify(prefs, null, 2));
      return changed;
    });
    migratedColors = locked.acquired ? locked.value : false;
  } catch { /* best-effort */ }

  return { removed, skippedCurrent, migratedHistory, migratedColors };
}

function reportLegacyStackCleanup(result) {
  if (!result) return;
  for (const r of result.removed) {
    console.error(`◇ Removed legacy aggregation provider row "${r.name}" (now served by runtime virtual entry ${VIRTUAL_STACK_PROVIDER_ID}; no longer shown in the desktop GUI)`);
  }
  if (result.migratedHistory) {
    console.error(`  Launch history and pins migrated to virtual entry ${VIRTUAL_STACK_PROVIDER_ID}`);
  }
  if (result.migratedColors) {
    console.error(`  Statusline color preferences migrated to virtual entry ${VIRTUAL_STACK_PROVIDER_ID}`);
  }
  for (const name of result.skippedCurrent) {
    console.error(`\x1b[33m⚠ Aggregation row "${name}" is in use by the desktop app (is_current) — kept; it will be cleaned up on the next run after you switch away in the desktop app\x1b[0m`);
  }
}


export { AGGREGATION_IDENTITY_ENV_KEYS, AGGREGATION_MODEL_ALIAS_KEYS, STACK_SETTINGS_DERIVERS, aggregationBaseUrlFor, appendVirtualStackRow, buildAggregationGroup, buildCodexStackSettingsFromGlobal, buildStackSettingsFromGlobal, buildStackUsageConfig, cleanupLegacyStackRows, codexStackDormantSettings, isAggregationProviderSettings, isCodexAggModelPath, isCodexAggregationProviderSettings, isLoopbackBaseUrl, probeTcpReachable, protectAggregationIdentityEnv, providerIsAggregation, readGlobalModelPicker, readStackState, reportLegacyStackCleanup, virtualStackProviderFor };
