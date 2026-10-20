import process from "node:process";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (DB_PATH, INSTANCES_DIR, GLOBAL_*_PATH) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-shared-prepare-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { APP_ADAPTERS } = await import("../src/adapters.ts");
const { readSharedConfig, resetSharedConfigWarnings } = await import("../src/shared-config.ts");

const CC = join(testHome, ".cc-switch");
const DB = join(CC, "cc-switch.db");
const CLAUDE_LIVE = join(testHome, ".claude", "settings.json");
const CODEX_LIVE = join(testHome, ".codex", "config.toml");
const claude = APP_ADAPTERS.claude;
const codex = APP_ADAPTERS.codex;

const FROZEN_COMMON = {
  statusLine: { type: "command", command: "node /tmp/claude-hud/dist/index.js" },
  hooks: { Frozen: [{ hooks: [] }] },
};

function sql(statement) {
  return execFileSync("sqlite3", [DB, ".timeout 3000", statement], { encoding: "utf8" });
}

function ensureDb() {
  mkdirSync(CC, { recursive: true });
  if (!existsSync(DB)) {
    execFileSync("sqlite3", [DB, `CREATE TABLE providers (
      id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
      settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
      created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
      meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
      in_failover_queue BOOLEAN NOT NULL DEFAULT 0, provider_type TEXT,
      PRIMARY KEY (id, app_type));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`]);
  }
  sql("DELETE FROM providers; DELETE FROM settings; PRAGMA user_version = 20;");
  writeClaudeLive({ hooks: { Live: [{ hooks: [] }] }, permissions: { allow: ["Bash"] } });
  resetSharedConfigWarnings();
}

function writeClaudeLive(obj) {
  mkdirSync(join(testHome, ".claude"), { recursive: true });
  writeFileSync(CLAUDE_LIVE, JSON.stringify(obj, null, 2));
}

function writeCodexLive(text) {
  mkdirSync(join(testHome, ".codex"), { recursive: true });
  writeFileSync(CODEX_LIVE, text);
}

function addProvider(id, appType, settingsConfig, meta = {}) {
  sql(`INSERT INTO providers (id, app_type, name, settings_config, category, meta)
    VALUES ('${id}', '${appType}', '${id.toUpperCase()}',
    '${JSON.stringify(settingsConfig).replace(/'/g, "''")}', 'custom',
    '${JSON.stringify(meta).replace(/'/g, "''")}');`);
}

function prepareClaude(id, settingsConfig, meta = {}) {
  const dir = join(CC, "instances", "claude", id);
  mkdirSync(dir, { recursive: true });
  claude.prepare(dir, id, settingsConfig, meta, "custom", readSharedConfig("claude"), {});
  return {
    dir,
    settings: JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")),
    wrapper: readFileSync(join(dir, "statusline-wrapper.mjs"), "utf8"),
  };
}

function resetInstances() {
  rmSync(join(CC, "instances"), { recursive: true, force: true });
}

beforeEach(() => {
  ensureDb();
  resetInstances();
});

test("live mode: frozen claude-hud statusLine is ignored even when the provider row has none", () => {
  sql(`INSERT INTO settings (key, value) VALUES ('common_config_claude',
    '${JSON.stringify(FROZEN_COMMON).replace(/'/g, "''")}');`);
  const settingsConfig = {
    env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "tok" },
  };
  addProvider("glm-live", "claude", settingsConfig, {});

  const { settings, wrapper } = prepareClaude("glm-live", settingsConfig, {});
  // live hooks/permissions land; the frozen statusLine/hooks do not.
  assert.deepEqual(settings.hooks, { Live: [{ hooks: [] }] });
  assert.deepEqual(settings.permissions, { allow: ["Bash"] });
  assert.ok(settings.statusLine.command.includes("statusline-wrapper.mjs"));
  assert.doesNotMatch(wrapper, /dist\/index\.js/, "wrapper must not inline the frozen statusLine");
  assert.match(wrapper, /const RELAY_COMMAND = null;/);
});

test("legacy mode: the DB snippet keeps its historical statusLine relay behavior", () => {
  sql("PRAGMA user_version = 19;");
  sql(`INSERT INTO settings (key, value) VALUES ('common_config_claude',
    '${JSON.stringify(FROZEN_COMMON).replace(/'/g, "''")}');`);
  const settingsConfig = {
    env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "tok" },
  };
  addProvider("glm-legacy", "claude", settingsConfig, { commonConfigEnabled: true });

  const { settings, wrapper } = prepareClaude("glm-legacy", settingsConfig, { commonConfigEnabled: true });
  assert.deepEqual(settings.hooks, { Frozen: [{ hooks: [] }] });
  assert.ok(wrapper.includes("/tmp/claude-hud/dist/index.js"), "legacy mode still inlines the explicit statusLine");
});

test("live mode: unreadable global file means no shared settings — no frozen fallback", () => {
  sql(`INSERT INTO settings (key, value) VALUES ('common_config_claude',
    '${JSON.stringify(FROZEN_COMMON).replace(/'/g, "''")}');`);
  rmSync(CLAUDE_LIVE, { force: true });
  const settingsConfig = { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "tok" } };
  addProvider("glm-missing", "claude", settingsConfig, {});

  const { settings, wrapper } = prepareClaude("glm-missing", settingsConfig, {});
  assert.equal(settings.hooks, undefined);
  assert.doesNotMatch(wrapper, /dist\/index\.js/);
  assert.match(wrapper, /const RELAY_COMMAND = null;/);
});

test("live mode: codex shared keys merge, routing/model stay with the provider row", () => {
  writeCodexLive([
    'model_provider = "live-provider"',
    'model = "live-model"',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    '[model_providers.live-provider]',
    'base_url = "https://live.example"',
    '[mcp_servers.fs]',
    'command = "mcp-fs"',
    '',
  ].join("\n"));
  const settingsConfig = {
    config: [
      'model_provider = "row-provider"',
      'model = "row-model"',
      '[model_providers.row-provider]',
      'base_url = "https://row.example"',
      'wire_api = "responses"',
      '',
    ].join("\n"),
    auth: {},
  };
  addProvider("codex-live", "codex", settingsConfig, {});

  const dir = join(CC, "instances", "codex", "codex-live");
  mkdirSync(dir, { recursive: true });
  codex.prepare(dir, "codex-live", settingsConfig, {}, "custom", readSharedConfig("codex"), {});
  const config = readFileSync(join(dir, "config.toml"), "utf8");
  assert.match(config, /approval_policy = "on-request"/);
  assert.match(config, /\[mcp_servers\.fs\]/);
  assert.match(config, /model_provider = "row-provider"/);
  assert.match(config, /model = "row-model"/);
  assert.doesNotMatch(config, /live-model/);
  assert.doesNotMatch(config, /live\.example/);
});

test("live mode: aggregation row keeps loopback identity and still receives shared user keys", () => {
  const settingsConfig = {
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
    },
  };
  addProvider("stack-live", "claude", settingsConfig, {});
  const { settings } = prepareClaude("stack-live", settingsConfig, {});
  assert.deepEqual(settings.hooks, { Live: [{ hooks: [] }] });
  assert.deepEqual(settings.permissions, { allow: ["Bash"] });
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15721");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "PROXY_MANAGED");
});
