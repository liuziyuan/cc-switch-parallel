import process from "node:process";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (DB_PATH, GLOBAL_*_PATH) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-shared-config-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { readSharedConfig, detectSharedConfigMode, projectClaudeSharedKeys, projectCodexSharedKeys, sharedConfigHash, claudeFloorTop, claudeFloorEnv, claudeExclusiveEnv, resetSharedConfigWarnings } = await import("../src/shared-config.ts");

const CC = join(testHome, ".cc-switch");
const DB = join(CC, "cc-switch.db");
const CLAUDE_LIVE = join(testHome, ".claude", "settings.json");
const CODEX_LIVE = join(testHome, ".codex", "config.toml");

function sql(statement) {
  return execFileSync("sqlite3", [DB, ".timeout 3000", statement], { encoding: "utf8" });
}

function ensureDb() {
  mkdirSync(CC, { recursive: true });
  if (!existsSync(DB)) {
    execFileSync("sqlite3", [DB, "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);"]);
  }
  sql("PRAGMA user_version = 20;");
  sql("DELETE FROM settings;");
}

function writeClaudeLive(obj) {
  mkdirSync(join(testHome, ".claude"), { recursive: true });
  writeFileSync(CLAUDE_LIVE, JSON.stringify(obj, null, 2));
}

function writeCodexLive(text) {
  mkdirSync(join(testHome, ".codex"), { recursive: true });
  writeFileSync(CODEX_LIVE, text);
}

beforeEach(() => {
  ensureDb();
  delete process.env.CC_SWITCH_SHARED_SOURCE;
  resetSharedConfigWarnings();
});

test("floor rules mirror upstream: credentials/model/protocol are provider keys, feature switches are user keys", () => {
  for (const key of [
    "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
    "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK", "VERTEX_REGION_CLAUDE_4_5_SONNET",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SUBAGENT_MODEL", "CLOUD_ML_REGION",
    "GOOGLE_APPLICATION_CREDENTIALS", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  ]) {
    assert.equal(claudeFloorEnv(key), true, `${key} should be a key field`);
  }
  for (const key of [
    "CLAUDE_CODE_USE_POWERSHELL_TOOL", "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH",
    "CLAUDE_CODE_SKIP_PROMPT_HISTORY", "API_TIMEOUT_MS", "DISABLE_TELEMETRY",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  ]) {
    assert.equal(claudeFloorEnv(key), false, `${key} must stay a user key`);
  }
  for (const key of ["model", "apiKeyHelper", "apiBaseUrl", "modelPicker", "fallbackModel"]) {
    assert.equal(claudeFloorTop(key), true, `${key} should be a key field`);
  }
  for (const key of ["hooks", "enabledPlugins", "permissions", "statusLine", "env"]) {
    assert.equal(claudeFloorTop(key), false, `${key} must stay a user key`);
  }
  assert.equal(claudeExclusiveEnv("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"), true);
  assert.equal(claudeExclusiveEnv("CLAUDE_CODE_MAX_CONTEXT_TOKENS"), true);
});

test("claude projection: drops statusLine + provider keys, keeps hooks/plugins/user env", () => {
  const projected = projectClaudeSharedKeys({
    model: "claude-sonnet-5-5",
    apiKeyHelper: "cmd",
    modelPicker: { options: [] },
    statusLine: { type: "command", command: "node claude-hud.mjs" },
    hooks: { Stop: [{ hooks: [] }] },
    enabledPlugins: { "claude-hud@local": true },
    permissions: { allow: ["Bash"] },
    env: {
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "secret",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      API_TIMEOUT_MS: "600000",
      DISABLE_TELEMETRY: "1",
    },
  });
  assert.equal(projected.statusLine, undefined, "statusLine is channel-owned");
  assert.equal(projected.model, undefined);
  assert.equal(projected.apiKeyHelper, undefined);
  assert.equal(projected.modelPicker, undefined);
  assert.deepEqual(projected.hooks, { Stop: [{ hooks: [] }] });
  assert.deepEqual(projected.enabledPlugins, { "claude-hud@local": true });
  assert.deepEqual(projected.permissions, { allow: ["Bash"] });
  assert.deepEqual(projected.env, {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    API_TIMEOUT_MS: "600000",
    DISABLE_TELEMETRY: "1",
  });
});

test("codex projection: keeps user tables, drops routing/model/runtime state", () => {
  const projected = projectCodexSharedKeys({
    model_provider: "custom",
    model: "gpt-5",
    openai_base_url: "https://live.example",
    base_url: "https://legacy.example",
    wire_api: "responses",
    model_catalog_json: "/tmp/catalog.json",
    web_search: "disabled",
    model_context_window: 200000,
    approval_policy: "on-request",
    sandbox_mode: "workspace-write",
    model_providers: { custom: { base_url: "https://live.example" } },
    profile: "work",
    projects: { "/tmp/x": { trust_level: "trusted" } },
    mcp_servers: { fs: { command: "mcp-fs" } },
    hooks: { state: { "/tmp/x": { hash: "abc" } } },
    tui: { status_line: ["model-with-reasoning"], model_availability_nux: { "gpt-5": 2 } },
    agents: { max_threads: 4, default_subagent_model: "gpt-5-mini" },
    memories: { extract_model: "gpt-5-mini" },
  });
  assert.equal(projected.model_provider, undefined);
  assert.equal(projected.model, undefined);
  assert.equal(projected.openai_base_url, undefined);
  assert.equal(projected.base_url, undefined);
  assert.equal(projected.wire_api, undefined);
  assert.equal(projected.model_catalog_json, undefined);
  assert.equal(projected.web_search, undefined);
  assert.equal(projected.model_context_window, undefined);
  assert.equal(projected.model_providers, undefined);
  assert.equal(projected.profile, undefined);
  assert.equal(projected.projects, undefined);
  assert.equal(projected.hooks, undefined, "hook trust runtime state must not leak");
  assert.equal(projected.tui.model_availability_nux, undefined);
  assert.deepEqual(projected.tui.status_line, ["model-with-reasoning"]);
  assert.deepEqual(projected.agents, { max_threads: 4 });
  assert.equal(projected.memories, undefined);
  assert.deepEqual(projected.mcp_servers, { fs: { command: "mcp-fs" } });
  assert.equal(projected.approval_policy, "on-request");
  assert.equal(projected.sandbox_mode, "workspace-write");
});

test("mode: user_version >= 20 is live, <= 19 is legacy, env override wins", () => {
  sql("PRAGMA user_version = 19;");
  assert.equal(detectSharedConfigMode(), "legacy");
  process.env.CC_SWITCH_SHARED_SOURCE = "live";
  assert.equal(detectSharedConfigMode(), "live");
  delete process.env.CC_SWITCH_SHARED_SOURCE;
  sql("PRAGMA user_version = 20;");
  assert.equal(detectSharedConfigMode(), "live");
  sql("PRAGMA user_version = 21;");
  assert.equal(detectSharedConfigMode(), "live");
  process.env.CC_SWITCH_SHARED_SOURCE = "legacy";
  assert.equal(detectSharedConfigMode(), "legacy");
  delete process.env.CC_SWITCH_SHARED_SOURCE;
});

test("live read: shared text comes from the global file, never the frozen DB snippet", () => {
  sql(`INSERT INTO settings (key, value) VALUES ('common_config_claude',
    '{"statusLine":{"type":"command","command":"node claude-hud.mjs"},"hooks":{"Frozen":[1]}}');`);
  writeClaudeLive({
    statusLine: { type: "command", command: "node another-statusline.mjs" },
    hooks: { Live: [2] },
    env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", API_TIMEOUT_MS: "600000" },
  });
  const shared = readSharedConfig("claude");
  assert.equal(shared.mode, "live");
  assert.equal(shared.unavailable, false);
  assert.equal(shared.sourcePath, CLAUDE_LIVE);
  assert.deepEqual(shared.parsed.hooks, { Live: [2] });
  assert.equal(shared.parsed.statusLine, undefined);
  assert.deepEqual(shared.parsed.env, { API_TIMEOUT_MS: "600000" });
  assert.ok(!shared.text.includes("claude-hud"), "frozen statusLine must not be resurrected");
  assert.ok(!shared.text.includes("Frozen"));
});

test("legacy read: the DB snippet is used unchanged", () => {
  sql("PRAGMA user_version = 19;");
  sql(`INSERT INTO settings (key, value) VALUES ('common_config_claude',
    '{"statusLine":{"type":"command","command":"node claude-hud.mjs"},"hooks":{"Frozen":[1]}}');`);
  writeClaudeLive({ hooks: { Live: [2] } });
  const shared = readSharedConfig("claude");
  assert.equal(shared.mode, "legacy");
  assert.equal(shared.sourcePath, null);
  assert.deepEqual(shared.parsed.hooks, { Frozen: [1] });
  assert.ok(shared.text.includes("claude-hud"));
});

test("live read: missing global file is unavailable — no fallback to the frozen snippet", () => {
  sql(`INSERT INTO settings (key, value) VALUES ('common_config_claude', '{"hooks":{"Frozen":[1]}}');`);
  rmSync(CLAUDE_LIVE, { force: true });
  const shared = readSharedConfig("claude");
  assert.equal(shared.mode, "live");
  assert.equal(shared.unavailable, true);
  assert.equal(shared.text, "");
  assert.deepEqual(shared.parsed, {});
});

test("codex live read: TOML projection excludes routing and runtime state", () => {
  writeCodexLive([
    'model_provider = "custom"',
    'model = "gpt-5"',
    'approval_policy = "on-request"',
    'projects = { "/tmp/x" = { trust_level = "trusted" } }',
    '[model_providers.custom]',
    'base_url = "https://live.example"',
    '[mcp_servers.fs]',
    'command = "mcp-fs"',
    '',
  ].join("\n"));
  const shared = readSharedConfig("codex");
  assert.equal(shared.mode, "live");
  assert.equal(shared.parsed.model_provider, undefined);
  assert.equal(shared.parsed.model, undefined);
  assert.equal(shared.parsed.projects, undefined);
  assert.equal(shared.parsed.model_providers, undefined);
  assert.equal(shared.parsed.approval_policy, "on-request");
  assert.equal(shared.parsed.mcp_servers.fs.command, "mcp-fs");
});

test("hash: stable across key order, ignores provider key fields and statusLine, reacts to user keys", () => {
  const base = { hooks: { A: [1] }, permissions: { allow: ["Bash"] }, model: "m", statusLine: { command: "a" } };
  const hash = (obj) => sharedConfigHash({ mode: "live", parsed: projectClaudeSharedKeys(obj), text: "" });
  assert.equal(hash(base), hash({ permissions: { allow: ["Bash"] }, model: "other", statusLine: { command: "b" }, hooks: { A: [1] } }),
    "key order, model and statusLine are not part of the shared document");
  assert.notEqual(hash(base), hash({ ...base, hooks: { A: [2] } }));
});
