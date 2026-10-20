import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (CC_SWITCH_DIR, INSTANCES_DIR) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-codex-stack-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { APP_ADAPTERS } = await import("../src/adapters.ts");
const { queryProviderById, queryProviderMatches, queryProvidersByApp, queryProvidersStrict } = await import("../src/db.ts");
const { codexAggregationRoute } = await import("../src/stack/aggregation.ts");
const { protectCodexAggregationIdentity, copyGlobalCodexCatalogIntoInstance, readGlobalCodexCatalogText, mergeCodexRuntimeState } = await import("../src/stack/catalog.ts");
const { isCodexAggregationProviderSettings, providerIsAggregation, aggregationBaseUrlFor, buildCodexStackSettingsFromGlobal, codexStackDormantSettings, isCodexAggModelPath, virtualStackProviderFor, appendVirtualStackRow, readStackState, buildAggregationGroup } = await import("../src/stack/state.ts");
const { codexAggregationDoctorChecks } = await import("../src/commands/doctor.ts");
const { VIRTUAL_STACK_PROVIDER_ID } = await import("../src/paths.ts");

const CC = join(testHome, ".cc-switch");
const CODEX_DIR = join(testHome, ".codex");
const GLOBAL_CONFIG = join(CODEX_DIR, "config.toml");
const GLOBAL_CATALOG = join(CODEX_DIR, "cc-switch-model-catalog.json");
const LIVE_STATE = join(CC, "live-state.json");
const CODEX_INSTANCES = join(CC, "instances", "codex");
const codex = APP_ADAPTERS.codex;

// The real desktop projection, shape-verified against the live machine:
// routing identity + runtime/general keys that must NOT leak into the row.
const GLOBAL_CONFIG_FULL = `model_provider = "custom"
model = "glm-5.3-flash"
model_reasoning_effort = "high"
model_catalog_json = "cc-switch-model-catalog.json"
web_search = "disabled"

[model_providers.custom]
name = "custom"
base_url = "http://127.0.0.1:15721/v1"
wire_api = "responses"
experimental_bearer_token = "PROXY_MANAGED"
requires_openai_auth = false

[projects."/Users/x/proj"]
trust_level = "trusted"

[hooks.state."/Users/x/.codex/hooks.json:pre_tool_use:0:0"]
trusted_hash = "sha256:abc"

[tui]
status_line = ["model-with-reasoning", "current-dir"]

[tui.model_availability_nux]
"gpt-5.6-sol" = 2
`;

const CATALOG_FIXTURE = JSON.stringify({
  models: [
    { slug: "glm-5.3", display_name: "GLM-5.3", priority: 1, comp_hash: "aa", multi_agent_version: "v1" },
    { slug: "ccs-deepseek/deepseek-flash", display_name: "DeepSeek V4.1 Flash（DeepSeek）", priority: 3 },
  ],
}, null, 2);

function sql(statement) {
  return execFileSync("sqlite3", [join(CC, "cc-switch.db"), ".timeout 3000", statement], { encoding: "utf8" });
}

function ensureDB() {
  mkdirSync(CC, { recursive: true });
  sql(`CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
    created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0, provider_type TEXT,
    PRIMARY KEY (id, app_type));`);
  sql(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
}

function insertCodexRow(id, name, configToml, meta = {}) {
  ensureDB();
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta)
    VALUES ('${id}', 'codex', '${name}',
    '${JSON.stringify({ config: configToml, auth: {} }).replace(/'/g, "''")}',
    '${JSON.stringify(meta).replace(/'/g, "''")}');`);
}

function cleanCodexState() {
  rmSync(GLOBAL_CONFIG, { force: true });
  rmSync(GLOBAL_CATALOG, { force: true });
  rmSync(LIVE_STATE, { force: true });
  rmSync(join(CODEX_INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true, force: true });
  try { sql(`DELETE FROM providers WHERE app_type = 'codex'`); } catch {}
}

function writeCodexLiveState(stack, proxyRoute) {
  mkdirSync(CC, { recursive: true });
  // Both app buckets: proves the codex reads only apps.codex (isolation).
  writeFileSync(LIVE_STATE, JSON.stringify({
    version: 1,
    apps: {
      claude: { mode: "direct" },
      codex: { mode: "proxy", ...(proxyRoute ? { proxy_route: proxyRoute } : {}), stack },
    },
  }));
}

function writeGlobalConfig(text) {
  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(GLOBAL_CONFIG, text);
}

function writeGlobalCatalog(text) {
  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(GLOBAL_CATALOG, text);
}

// The member rows the desktop stack routes between — real upstreams, unlike
// the aggregation row (loopback + PROXY_MANAGED).
const DEEPSEEK_CONFIG = `model_provider = "deepseek"
model = "deepseek-chat"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/v1"
wire_api = "chat"
`;
const ZHIPU_CONFIG = `model_provider = "zhipu"
model = "glm-5.3"

[model_providers.zhipu]
name = "zhipu"
base_url = "https://open.bigmodel.cn/api/coding/paas/v4"
wire_api = "chat"
`;
const STACK_ROW_CONFIG = GLOBAL_CONFIG_FULL.replace('model_provider = "custom"', 'model_provider = "custom"');

let stderrBuf = "";
function captureStderr(fn) {
  stderrBuf = "";
  const orig = process.stderr.write;
  process.stderr.write = (s) => { stderrBuf += s; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
}

// ─── 1. signature ──────────────────────────────────────────────────────

test("codex aggregation unit: signature = loopback active table + PROXY_MANAGED", () => {
  const aggRow = { config: GLOBAL_CONFIG_FULL, auth: {} };
  assert.equal(isCodexAggregationProviderSettings(aggRow), true);
  assert.equal(providerIsAggregation("codex", aggRow), true);
  // top-level fallback shape (no table): bearer + loopback via top-level keys
  assert.equal(isCodexAggregationProviderSettings({
    config: `model_provider = "custom"
base_url = "http://127.0.0.1:15721/v1"
experimental_bearer_token = "PROXY_MANAGED"
`,
    auth: {},
  }), true, "top-level fallback shape still matches");
  // loopback + REAL token = a user's own gateway, NOT aggregation
  assert.equal(isCodexAggregationProviderSettings({
    config: GLOBAL_CONFIG_FULL.replace('"PROXY_MANAGED"', '"sk-real"'),
    auth: {},
  }), false);
  // non-loopback + PROXY_MANAGED is not one either
  assert.equal(isCodexAggregationProviderSettings({
    config: GLOBAL_CONFIG_FULL.replace("http://127.0.0.1:15721/v1", "https://api.z.ai/v1"),
    auth: {},
  }), false);
  // plain member rows are not aggregation rows
  assert.equal(isCodexAggregationProviderSettings({ config: DEEPSEEK_CONFIG, auth: {} }), false);
  assert.equal(isCodexAggregationProviderSettings({ config: ZHIPU_CONFIG, auth: {} }), false);
  // garbage inputs
  assert.equal(isCodexAggregationProviderSettings({}), false);
  assert.equal(isCodexAggregationProviderSettings({ config: "not [ valid", auth: {} }), false);
  assert.equal(isCodexAggregationProviderSettings(null), false);
});

test("codex aggregation unit: codexAggregationRoute resolves table-first with top-level fallback", () => {
  // table wins
  const r = codexAggregationRoute(GLOBAL_CONFIG_FULL);
  assert.equal(r.providerId, "custom");
  assert.equal(r.baseUrl, "http://127.0.0.1:15721/v1");
  assert.equal(r.bearer, "PROXY_MANAGED");
  // top-level fallback when the table lacks the keys
  const r2 = codexAggregationRoute(`model_provider = "custom"

[model_providers.custom]
name = "custom"
`);
  assert.equal(r2.baseUrl, null);
  assert.equal(r2.bearer, null);
  // no active table → table null, top-level still read
  const r3 = codexAggregationRoute(`model_provider = "custom"
base_url = "http://127.0.0.1:9/v1"
`);
  assert.equal(r3.table, null);
  assert.equal(r3.baseUrl, "http://127.0.0.1:9/v1");
  assert.equal(codexAggregationRoute("not [ valid"), null);
});

// ─── 2. whitelist projection ───────────────────────────────────────────

test("codex aggregation: buildCodexStackSettingsFromGlobal projects the whitelist only", () => {
  cleanCodexState();
  // no global config → null
  assert.equal(buildCodexStackSettingsFromGlobal(), null);
  // full real-world shape → whitelist projection
  writeGlobalConfig(GLOBAL_CONFIG_FULL);
  writeGlobalCatalog(CATALOG_FIXTURE);
  const d = buildCodexStackSettingsFromGlobal();
  assert.ok(d, "live stack shape derives a contract");
  assert.equal(d.baseUrl, "http://127.0.0.1:15721/v1");
  assert.equal(d.settings.auth && Object.keys(d.settings.auth).length, 0, "auth is {}");
  const doc = parseToml(d.settings.config);
  assert.equal(doc.model_provider, "custom");
  assert.equal(doc.model, "glm-5.3-flash", "top-level model rides the whitelist");
  assert.equal(doc.web_search, "disabled", "web_search rides the whitelist");
  assert.equal(doc.model_catalog_json, "cc-switch-model-catalog.json");
  assert.equal(doc.model_reasoning_effort, undefined, "general prefs stay out");
  assert.equal(doc.projects, undefined, "runtime state stays out");
  assert.equal(doc.hooks, undefined, "runtime state stays out");
  assert.equal(doc.tui, undefined, "runtime state stays out");
  assert.deepEqual(doc.model_providers.custom, {
    name: "custom",
    base_url: "http://127.0.0.1:15721/v1",
    wire_api: "responses",
    experimental_bearer_token: "PROXY_MANAGED",
    requires_openai_auth: false,
  }, "only the whitelist table keys, bearer/requires forced");
  assert.equal(Object.keys(doc.model_providers).length, 1);
  // wire_api "chat" passes through; missing table name falls back to the id
  writeGlobalConfig(`model_provider = "custom"

[model_providers.custom]
base_url = "http://localhost:15721/v1"
wire_api = "chat"
`);
  const d2 = buildCodexStackSettingsFromGlobal();
  const doc2 = parseToml(d2.settings.config);
  assert.equal(doc2.model_providers.custom.wire_api, "chat");
  assert.equal(doc2.model_providers.custom.name, "custom", "missing name falls back to the id");
  assert.equal(doc2.model, undefined, "no model in global → none in the row");
  assert.equal(doc2.web_search, undefined);
});

test("codex aggregation: buildCodexStackSettingsFromGlobal failure matrix", () => {
  cleanCodexState();
  // corrupt TOML
  writeGlobalConfig("not [ valid");
  assert.equal(buildCodexStackSettingsFromGlobal(), null);
  // official provider id — the desktop pointing codex at the official API
  // must never yield a proxy row
  writeGlobalConfig(`model_provider = "openai"
`);
  assert.equal(buildCodexStackSettingsFromGlobal(), null);
  // missing model_provider
  writeGlobalConfig(`[model_providers.custom]
name = "custom"
base_url = "http://127.0.0.1:15721/v1"
`);
  assert.equal(buildCodexStackSettingsFromGlobal(), null);
  // active table absent
  writeGlobalConfig(`model_provider = "custom"
`);
  assert.equal(buildCodexStackSettingsFromGlobal(), null);
  // base_url not loopback
  writeGlobalConfig(`model_provider = "custom"

[model_providers.custom]
base_url = "https://api.z.ai/v1"
`);
  assert.equal(buildCodexStackSettingsFromGlobal(), null);
  // base_url missing
  writeGlobalConfig(`model_provider = "custom"

[model_providers.custom]
name = "custom"
`);
  assert.equal(buildCodexStackSettingsFromGlobal(), null);
});

// ─── 3. virtual row three states + name dodging + four query exits ─────

test("codex aggregation: virtualStackProviderFor three states + per-app isolation", () => {
  cleanCodexState();
  ensureDB();
  // never used aggregation (no stack, no __stack__ instance dir) → null
  assert.equal(virtualStackProviderFor("codex"), null);
  assert.equal(buildAggregationGroup("codex"), null);
  // dormant: stack off but the instance dir exists → fallback base URL row
  mkdirSync(join(CODEX_INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true });
  const dormant = virtualStackProviderFor("codex");
  assert.ok(dormant);
  assert.equal(dormant.id, VIRTUAL_STACK_PROVIDER_ID);
  assert.equal(dormant.app_type, "codex");
  assert.equal(dormant.name, "Stack");
  assert.equal(dormant.is_virtual, true);
  assert.equal(dormant.category, null);
  assert.equal(JSON.parse(dormant.meta).stackManaged, true);
  const dormantDoc = parseToml(JSON.parse(dormant.settings_config).config);
  assert.equal(dormantDoc.model_provider, "cc-switch-stack");
  assert.equal(dormantDoc.model_providers["cc-switch-stack"].base_url, "http://127.0.0.1:15721");
  assert.equal(dormantDoc.model_providers["cc-switch-stack"].experimental_bearer_token, "PROXY_MANAGED");
  assert.equal(dormantDoc.model, undefined, "dormant row carries no model");
  assert.deepEqual(JSON.parse(dormant.settings_config).auth, {});
  // live: stack on + loopback global config → full derived row
  writeGlobalConfig(GLOBAL_CONFIG_FULL);
  writeCodexLiveState(
    { enabled: true, members: ["m-ds", "m-zai"], keys: { deepseek: "m-ds", zhipu: "m-zai" } },
    "m-zai",
  );
  insertCodexRow("m-ds", "DeepSeek", DEEPSEEK_CONFIG);
  insertCodexRow("m-zai", "Z.AI GLM", ZHIPU_CONFIG);
  const live = virtualStackProviderFor("codex");
  const liveDoc = parseToml(JSON.parse(live.settings_config).config);
  assert.equal(liveDoc.model_providers.custom.base_url, "http://127.0.0.1:15721/v1");
  assert.equal(liveDoc.model, "glm-5.3-flash");
  assert.equal(readStackState("codex").proxyRoute, "m-zai");
  // claude never sees codex's stack: no claude stack in live-state → the
  // claude virtual row stays null here (claude has no __stack__ dir either)
  assert.equal(virtualStackProviderFor("claude"), null, "per-app isolation");
  // name dodging: a codex DB row already named "Stack" → "Stack 2"
  insertCodexRow("m-stackname", "Stack", DEEPSEEK_CONFIG);
  const dodged = virtualStackProviderFor("codex");
  assert.equal(dodged.name, "Stack 2");
  sql(`DELETE FROM providers WHERE id = 'm-stackname'`);
  cleanCodexState();
});

test("codex aggregation: query exits merge the virtual row, DB wins on id collision", () => {
  cleanCodexState();
  ensureDB();
  mkdirSync(join(CODEX_INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true });
  // dormant entry exists → merged onto projections at all four exits
  const list = appendVirtualStackRow([{ id: "m-ds", name: "DeepSeek" }], "codex");
  assert.deepEqual(list.map((r) => r.id), ["m-ds", VIRTUAL_STACK_PROVIDER_ID]);
  const byApp = queryProvidersByApp("codex");
  assert.ok(byApp.some((r) => r.id === VIRTUAL_STACK_PROVIDER_ID));
  const strict = queryProvidersStrict("codex");
  assert.ok(strict.some((r) => r.id === VIRTUAL_STACK_PROVIDER_ID));
  const byId = queryProviderById(VIRTUAL_STACK_PROVIDER_ID, "codex");
  assert.ok(byId && byId.is_virtual, "by-id fallback hits the virtual row");
  const byName = queryProviderMatches("Stack", "codex")[0];
  assert.ok(byName && byName.id === VIRTUAL_STACK_PROVIDER_ID);
  // claude query exits never surface the codex row
  assert.equal(queryProviderById(VIRTUAL_STACK_PROVIDER_ID, "claude"), null);
  // DB already carries a __stack__ codex row → the merge input already has
  // the id → not appended again (DB wins)
  insertCodexRow(VIRTUAL_STACK_PROVIDER_ID, "Stack", DEEPSEEK_CONFIG);
  const collided = appendVirtualStackRow([{ id: VIRTUAL_STACK_PROVIDER_ID, name: "Stack" }], "codex");
  assert.equal(collided.length, 1);
  assert.equal(collided[0].is_virtual, undefined, "DB row stands, no virtual append");
  sql(`DELETE FROM providers WHERE id = '${VIRTUAL_STACK_PROVIDER_ID}'`);
  cleanCodexState();
});

// ─── 4. buildCodexConfig aggregation branch ────────────────────────────

const HOSTILE_COMMON = `model_provider = "evil"
model_context_window = 999999
base_url = "http://top-level-evil:1/v1"
wire_api = "chat"
experimental_bearer_token = "sk-top-level"
requires_openai_auth = true
web_search = "enabled"

[model_providers.custom]
name = "hijacked"
base_url = "http://127.0.0.1:9999/v1"
env_key = "PLANTED_KEY"

[model_providers.custom.http_headers]
X-Evil = "1"

[model_providers.planted]
name = "planted"
base_url = "http://evil.example"

[tui]
terminal_title = ["common-title"]
`;

test("codex aggregation: forced common merge + identity protection via computeEffectiveSettings", () => {
  cleanCodexState();
  ensureDB();
  sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('common_config_codex', '${HOSTILE_COMMON.replace(/'/g, "''")}')`);
  const commonText = HOSTILE_COMMON;
  const dir = join(CODEX_INSTANCES, VIRTUAL_STACK_PROVIDER_ID);
  mkdirSync(dir, { recursive: true });
  const settingsConfig = { config: GLOBAL_CONFIG_FULL, auth: {} };
  const effective = codex.computeEffectiveSettings(settingsConfig, {}, "custom", commonText, VIRTUAL_STACK_PROVIDER_ID, {});
  assert.ok(effective, "derivation parses");
  // identity keys survive the hostile common config
  assert.equal(effective.model_provider, "custom");
  assert.deepEqual(effective.model_providers.custom, {
    name: "custom",
    base_url: "http://127.0.0.1:15721/v1",
    wire_api: "responses",
    experimental_bearer_token: "PROXY_MANAGED",
    requires_openai_auth: false,
  }, "whole-table restore kills env_key/http_headers plants");
  assert.equal(effective.model_providers.planted, undefined, "row-absent tables are dropped");
  assert.equal(effective.base_url, undefined, "top-level fallback keys deleted");
  assert.equal(effective.wire_api, undefined);
  assert.equal(effective.experimental_bearer_token, undefined);
  assert.equal(effective.requires_openai_auth, undefined);
  assert.equal(effective.web_search, "disabled", "row value restored over common's");
  assert.equal(effective.model_catalog_json, "cc-switch-model-catalog.json", "catalog pinned to the constant");
  // common CONTENT still merged in (the point of the forced merge)
  assert.equal(effective.model_context_window, 999999);
  assert.deepEqual(effective.tui.terminal_title, ["common-title"]);
  // model soft-protection: the row's model wins over any common value;
  // row has model → present. Remove it and a common model would stand:
  const noModelRow = { config: GLOBAL_CONFIG_FULL.replace('model = "glm-5.3-flash"\n', ""), auth: {} };
  const effective2 = codex.computeEffectiveSettings(noModelRow, {}, "custom", commonText, VIRTUAL_STACK_PROVIDER_ID, {});
  assert.equal(effective2.model, undefined, "row without model keeps no model even from common's absence");
  // explicit commonConfigEnabled:false → no merge at all, identity intact
  const effective3 = codex.computeEffectiveSettings(settingsConfig, { commonConfigEnabled: false }, "custom", commonText, VIRTUAL_STACK_PROVIDER_ID, {});
  assert.equal(effective3.model_context_window, undefined);
  assert.equal(effective3.model_provider, "custom");
  cleanCodexState();
});

test("codex aggregation: bearer token never injected even with a misconfigured OPENAI_API_KEY", () => {
  cleanCodexState();
  ensureDB();
  const settingsConfig = { config: GLOBAL_CONFIG_FULL, auth: { OPENAI_API_KEY: "sk-misconfigured" } };
  const dir = join(CODEX_INSTANCES, "bearer-test");
  mkdirSync(dir, { recursive: true });
  codex.prepare(dir, "bearer-test", settingsConfig, {}, "custom", null, {});
  const doc = parseToml(readFileSync(join(dir, "config.toml"), "utf8"));
  assert.equal(doc.model_providers.custom.experimental_bearer_token, "PROXY_MANAGED", "no key overwrite");
  assert.equal(doc.experimental_bearer_token, undefined, "no top-level fallback write either");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")), {}, "auth.json is {}");
  cleanCodexState();
});

test("codex aggregation unit: protectCodexAggregationIdentity handles row-less and empty shapes", () => {
  cleanCodexState();
  // row config unparsable → protective defaults (delete identity, pin catalog)
  const obj = { model_provider: "evil", model_providers: { evil: { base_url: "http://x" } }, web_search: "enabled" };
  protectCodexAggregationIdentity(obj, { config: "not [ valid" });
  assert.equal(obj.model_provider, undefined);
  assert.equal(obj.model_providers, undefined);
  assert.equal(obj.web_search, undefined);
  assert.equal(obj.model_catalog_json, "cc-switch-model-catalog.json");
  // row with no model_provider at all → key deleted so Codex falls back
  const obj2 = { model_provider: "evil", model_catalog_json: "wrong.json" };
  protectCodexAggregationIdentity(obj2, { config: "[tui]\nstatus_line = []\n" });
  assert.equal(obj2.model_provider, undefined);
  assert.equal(obj2.model_catalog_json, "cc-switch-model-catalog.json");
});

// ─── 5. catalog verbatim copy ──────────────────────────────────────────

test("codex aggregation: catalog is copied byte-for-byte, degraded copies warn", () => {
  cleanCodexState();
  ensureDB();
  const dir = join(CODEX_INSTANCES, VIRTUAL_STACK_PROVIDER_ID);
  mkdirSync(dir, { recursive: true });
  const settingsConfig = { config: GLOBAL_CONFIG_FULL, auth: {} };
  // global catalog present → instance copy is byte-identical
  writeGlobalCatalog(CATALOG_FIXTURE);
  let res;
  captureStderr(() => { res = copyGlobalCodexCatalogIntoInstance(dir); });
  assert.deepEqual(res, { copied: true });
  assert.equal(readFileSync(join(dir, "cc-switch-model-catalog.json"), "utf8"), CATALOG_FIXTURE, "byte-for-byte");
  assert.equal(readGlobalCodexCatalogText(), CATALOG_FIXTURE);
  // global missing + instance copy exists → kept, warning
  rmSync(GLOBAL_CATALOG, { force: true });
  captureStderr(() => { res = copyGlobalCodexCatalogIntoInstance(dir); });
  assert.deepEqual(res, { copied: false });
  assert.equal(readFileSync(join(dir, "cc-switch-model-catalog.json"), "utf8"), CATALOG_FIXTURE, "existing copy kept");
  assert.ok(stderrBuf.includes("保留现有副本"), "warns about the kept copy");
  // global missing + no copy → no file, warning
  rmSync(join(dir, "cc-switch-model-catalog.json"), { force: true });
  captureStderr(() => { res = copyGlobalCodexCatalogIntoInstance(dir); });
  assert.deepEqual(res, { copied: false });
  assert.equal(existsSync(join(dir, "cc-switch-model-catalog.json")), false);
  assert.ok(stderrBuf.includes("没有聚合模型列表"));
  // corrupt / empty models degrade the same way
  for (const bad of ["{corrupt", JSON.stringify({ models: [] }), JSON.stringify({ models: "x" })]) {
    writeGlobalCatalog(bad);
    captureStderr(() => { res = copyGlobalCodexCatalogIntoInstance(dir); });
    assert.deepEqual(res, { copied: false }, `degrades on ${bad.slice(0, 12)}`);
  }
  cleanCodexState();
});

test("codex aggregation: prepare writes catalog via copy path; plain rows keep the regenerate path", () => {
  cleanCodexState();
  ensureDB();
  // aggregation row: catalog file copied, config references the constant
  writeGlobalCatalog(CATALOG_FIXTURE);
  const stackDir = join(CODEX_INSTANCES, VIRTUAL_STACK_PROVIDER_ID);
  mkdirSync(stackDir, { recursive: true });
  codex.prepare(stackDir, VIRTUAL_STACK_PROVIDER_ID, { config: GLOBAL_CONFIG_FULL, auth: {} }, {}, null, null, {});
  assert.equal(readFileSync(join(stackDir, "cc-switch-model-catalog.json"), "utf8"), CATALOG_FIXTURE);
  const stackDoc = parseToml(readFileSync(join(stackDir, "config.toml"), "utf8"));
  assert.equal(stackDoc.model_catalog_json, "cc-switch-model-catalog.json");
  // plain row with modelCatalog → template regeneration (existing behavior)
  const plainDir = join(CODEX_INSTANCES, "plain-cat");
  mkdirSync(plainDir, { recursive: true });
  const plainConfig = `model_provider = "deepseek"

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com/v1"
wire_api = "chat"
`;
  codex.prepare(plainDir, "plain-cat", {
    config: plainConfig,
    auth: {},
    modelCatalog: { models: [{ model: "deepseek-chat", displayName: "DeepSeek Chat", contextWindow: 65536 }] },
  }, {}, "custom", null, {});
  const plainDoc = parseToml(readFileSync(join(plainDir, "config.toml"), "utf8"));
  assert.equal(plainDoc.model_catalog_json, "cc-switch-model-catalog.json");
  const regenerated = JSON.parse(readFileSync(join(plainDir, "cc-switch-model-catalog.json"), "utf8"));
  assert.equal(regenerated.models[0].slug, "deepseek-chat");
  assert.equal(regenerated.models[0].priority, 1000, "template priority, not the desktop one");
  // plain row WITHOUT modelCatalog → no file, no key (existing behavior)
  const bareDir = join(CODEX_INSTANCES, "plain-bare");
  mkdirSync(bareDir, { recursive: true });
  codex.prepare(bareDir, "plain-bare", { config: plainConfig, auth: {} }, {}, "custom", null, {});
  const bareDoc = parseToml(readFileSync(join(bareDir, "config.toml"), "utf8"));
  assert.equal(bareDoc.model_catalog_json, undefined);
  assert.equal(existsSync(join(bareDir, "cc-switch-model-catalog.json")), false);
  cleanCodexState();
});

// ─── 6. /model carry for aggregation instances ─────────────────────────

test("codex aggregation: /model pick carried across prepare; dangling key falls back; plain rows unaffected", () => {
  cleanCodexState();
  ensureDB();
  writeCodexLiveState(
    { enabled: true, members: ["m-ds"], keys: { deepseek: "m-ds" } },
    "m-ds",
  );
  insertCodexRow("m-ds", "DeepSeek", DEEPSEEK_CONFIG);
  const dir = join(CODEX_INSTANCES, VIRTUAL_STACK_PROVIDER_ID);
  mkdirSync(dir, { recursive: true });
  // first prepare: row model lands
  codex.prepare(dir, VIRTUAL_STACK_PROVIDER_ID, { config: GLOBAL_CONFIG_FULL, auth: {} }, {}, null, null, {});
  assert.equal(parseToml(readFileSync(join(dir, "config.toml"), "utf8")).model, "glm-5.3-flash");
  // user picks a member model via /model → written to the instance file
  const pickedDoc = parseToml(readFileSync(join(dir, "config.toml"), "utf8"));
  pickedDoc.model = "ccs-deepseek/deepseek-flash";
  writeFileSync(join(dir, "config.toml"), stringifyToml(pickedDoc));
  // second prepare CARRIES the pick (same derivation on the C3 side)
  captureStderr(() => {
    codex.prepare(dir, VIRTUAL_STACK_PROVIDER_ID, { config: GLOBAL_CONFIG_FULL, auth: {} }, {}, null, null, {});
  });
  assert.equal(parseToml(readFileSync(join(dir, "config.toml"), "utf8")).model, "ccs-deepseek/deepseek-flash", "pick survives relaunch");
  assert.ok(!stderrBuf.includes("已不在当前聚合栈中"));
  // C3 parity: computeEffectiveSettings sees the same carried value
  const c3 = codex.computeEffectiveSettings({ config: GLOBAL_CONFIG_FULL, auth: {} }, {}, null, null, VIRTUAL_STACK_PROVIDER_ID, {});
  assert.equal(c3.model, "ccs-deepseek/deepseek-flash", "guard derives the carry identically");
  // dangling ccs key (stack off) → carry dropped, fallback + notice
  rmSync(LIVE_STATE, { force: true });
  captureStderr(() => {
    mergeCodexRuntimeState('model = "glm-5.3-flash"\n', dir, true);
  });
  assert.ok(stderrBuf.includes("已不在当前聚合栈中"), "dangling pick warns");
  // dangling ccs key (member removed) → same
  writeCodexLiveState({ enabled: true, members: ["m-zai"], keys: { zhipu: "m-zai" } }, "m-zai");
  captureStderr(() => {
    const out = mergeCodexRuntimeState('model = "glm-5.3-flash"\n', dir, true);
    assert.equal(parseToml(out).model, "glm-5.3-flash", "generated value stands");
  });
  // live key → carried
  writeCodexLiveState({ enabled: true, members: ["m-ds"], keys: { deepseek: "m-ds" } }, "m-ds");
  const out = mergeCodexRuntimeState('model = "glm-5.3-flash"\n', dir, true);
  assert.equal(parseToml(out).model, "ccs-deepseek/deepseek-flash");
  // plain rows: no carry (third arg absent)
  const plainDir = join(CODEX_INSTANCES, "plain-carry");
  mkdirSync(plainDir, { recursive: true });
  writeFileSync(join(plainDir, "config.toml"), 'model = "ccs-deepseek/deepseek-flash"\n');
  const plainOut = mergeCodexRuntimeState('model = "glm-5.3-flash"\n', plainDir);
  assert.equal(parseToml(plainOut).model, "glm-5.3-flash", "plain row rolls back (established semantics)");
  // drift filter: model on the virtual codex instance yields; on plain rows it doesn't
  assert.equal(isCodexAggModelPath("codex", VIRTUAL_STACK_PROVIDER_ID, "model"), true);
  assert.equal(isCodexAggModelPath("codex", "plain-carry", "model"), false);
  assert.equal(isCodexAggModelPath("codex", VIRTUAL_STACK_PROVIDER_ID, "model_reasoning_effort"), false);
  assert.equal(isCodexAggModelPath("claude", VIRTUAL_STACK_PROVIDER_ID, "model"), false);
  // hand-made aggregation row yields too
  insertCodexRow("m-hand", "HandStack", GLOBAL_CONFIG_FULL);
  assert.equal(isCodexAggModelPath("codex", "m-hand", "model"), true);
  sql(`DELETE FROM providers WHERE id = 'm-hand'`);
  cleanCodexState();
});

// ─── 7. TUI group labels ───────────────────────────────────────────────

test("codex aggregation: buildAggregationGroup labels members / missing / dormant", () => {
  cleanCodexState();
  ensureDB();
  mkdirSync(join(CODEX_INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true });
  // dormant (no live-state): （未激活）
  let group = buildAggregationGroup("codex");
  assert.ok(group);
  assert.ok(group.labels.get(VIRTUAL_STACK_PROVIDER_ID).includes("未激活"));
  // live with both members
  insertCodexRow("m-ds", "DeepSeek", DEEPSEEK_CONFIG);
  insertCodexRow("m-zai", "Z.AI GLM", ZHIPU_CONFIG);
  writeCodexLiveState(
    { enabled: true, members: ["m-ds", "m-zai"], keys: { deepseek: "m-ds", zhipu: "m-zai" } },
    "m-zai",
  );
  group = buildAggregationGroup("codex");
  const label = group.labels.get(VIRTUAL_STACK_PROVIDER_ID);
  assert.ok(label.includes("◆ 聚合 · Stack"));
  assert.ok(label.includes("DeepSeek + Z.AI GLM"));
  // plain member rows are NOT in ids (real upstreams, not aggregation rows) —
  // the member names surface via the label text only
  assert.ok(!group.ids.has("m-ds") && !group.ids.has("m-zai"), "plain members stay out of ids");
  // missing member row
  sql(`DELETE FROM providers WHERE id = 'm-zai'`);
  group = buildAggregationGroup("codex");
  assert.ok(group.labels.get(VIRTUAL_STACK_PROVIDER_ID).includes("1 个成员缺失"));
  // a hand-made loopback codex row joins the group too
  insertCodexRow("m-hand", "HandStack", GLOBAL_CONFIG_FULL);
  group = buildAggregationGroup("codex");
  assert.ok(group.ids.has("m-hand"), "hand-made aggregation row labeled");
  assert.ok(group.labels.get("m-hand").includes("◆ 聚合 · HandStack"));
  cleanCodexState();
});

// ─── 8. probe dispatch ─────────────────────────────────────────────────

test("codex aggregation unit: aggregationBaseUrlFor dispatches per app", () => {
  const aggRow = { config: GLOBAL_CONFIG_FULL, auth: {} };
  assert.equal(aggregationBaseUrlFor("codex", aggRow), "http://127.0.0.1:15721/v1");
  assert.equal(aggregationBaseUrlFor("codex", { config: DEEPSEEK_CONFIG, auth: {} }), null);
  assert.equal(
    aggregationBaseUrlFor("claude", { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721", ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED" } }),
    "http://127.0.0.1:15721",
  );
  assert.equal(aggregationBaseUrlFor("claude", { env: { ANTHROPIC_BASE_URL: "https://api.z.ai", ANTHROPIC_AUTH_TOKEN: "t" } }), null);
});

// ─── 9. doctor ─────────────────────────────────────────────────────────

test("codex aggregation doctor: off → silent; live → row + proxy checks", async (t) => {
  cleanCodexState();
  // stack off → zero output
  assert.deepEqual(await codexAggregationDoctorChecks(), []);
  // live stack + listening proxy → both pass
  const srv = createServer(() => {});
  t.after(() => { srv.closeAllConnections?.(); try { srv.close(); } catch {} });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  writeGlobalConfig(GLOBAL_CONFIG_FULL.replace("http://127.0.0.1:15721/v1", `http://127.0.0.1:${port}/v1`));
  writeCodexLiveState({ enabled: true, members: ["m-ds"], keys: { deepseek: "m-ds" } }, "m-ds");
  let checks = await codexAggregationDoctorChecks();
  assert.equal(checks.length, 2);
  const byLabel = (cs) => Object.fromEntries(cs.map((c) => [c.label, c]));
  assert.equal(byLabel(checks)["codex aggregation Stack row"].pass, true);
  assert.ok(byLabel(checks)["codex aggregation Stack row"].detail.includes("virtual entry derived"));
  assert.equal(byLabel(checks)["codex aggregation proxy"].pass, true);
  await new Promise((r) => srv.close(r));
  checks = await codexAggregationDoctorChecks();
  assert.equal(byLabel(checks)["codex aggregation proxy"].pass, false, "proxy down after close");
  // live stack but global config not loopback → row derivation fails
  writeGlobalConfig(DEEPSEEK_CONFIG);
  checks = await codexAggregationDoctorChecks();
  assert.equal(byLabel(checks)["codex aggregation Stack row"].pass, false);
  assert.equal(byLabel(checks)["codex aggregation proxy"], undefined, "no row → no proxy check");
  cleanCodexState();
});

// ─── 10. C3/C2 parity + dormant settings ───────────────────────────────

test("codex aggregation: prepare output equals computeEffectiveSettings (C3 parity); dormant settings shape", () => {
  cleanCodexState();
  ensureDB();
  const dir = join(CODEX_INSTANCES, VIRTUAL_STACK_PROVIDER_ID);
  mkdirSync(dir, { recursive: true });
  // a project trust entry in the instance file — carried across regeneration
  writeFileSync(join(dir, "config.toml"), `[projects."/Users/x/proj"]
trust_level = "trusted"
`);
  const settingsConfig = { config: GLOBAL_CONFIG_FULL, auth: {} };
  codex.prepare(dir, VIRTUAL_STACK_PROVIDER_ID, settingsConfig, {}, null, null, {});
  const c2 = codex.readInstanceSettingsSnapshot(dir);
  const c3 = codex.computeEffectiveSettings(settingsConfig, {}, null, null, VIRTUAL_STACK_PROVIDER_ID, {});
  assert.deepEqual(c2, c3, "guard comparison [C3] sees what prepare writes");
  assert.equal(c2.projects["/Users/x/proj"].trust_level, "trusted", "runtime trust carried");
  // dormant settings: valid TOML with the same signature (dormant rows must
  // still read as aggregation rows so launch/probe/prepare paths engage)
  const dorm = codexStackDormantSettings("http://127.0.0.1:15721");
  assert.equal(isCodexAggregationProviderSettings(dorm), true);
  const dormDoc = parseToml(dorm.config);
  assert.equal(dormDoc.model_providers["cc-switch-stack"].base_url, "http://127.0.0.1:15721");
  assert.deepEqual(dorm.auth, {});
  cleanCodexState();
});
