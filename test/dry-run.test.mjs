import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const testHome = mkdtempSync(join(tmpdir(), "cc-launch-dry-run-"));
process.env.CC_SWITCH_TEST_HOME = testHome;
process.env.CC_LAUNCH_SKIP_MAIN = "1";

const { buildDryRunPlan, renderDryRunPlan } = await import("../src/commands/dry-run.ts");
const { DB_PATH, HISTORY_PATH, INSTANCES_DIR, SYNC_STATE_PATH } = await import("../src/paths.ts");
const { parseToml } = await import("../src/toml.ts");

function sql(statement) {
  return execFileSync("sqlite3", [DB_PATH, ".timeout 3000", statement], { encoding: "utf8" });
}

function setupDB() {
  mkdirSync(join(testHome, ".cc-switch"), { recursive: true });
  sql(`CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
    created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0, provider_type TEXT,
    PRIMARY KEY (id, app_type));`);
  const insert = (id, app, name, settings) => {
    const raw = JSON.stringify(settings).replace(/'/g, "''");
    sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta, sort_index, created_at)
      VALUES ('${id}', '${app}', '${name}', '${raw}', '{}', 1, 1);`);
  };
  insert("p1", "claude", "Alpha", {
    env: { ANTHROPIC_BASE_URL: "https://api.example.com", ANTHROPIC_AUTH_TOKEN: "secret-token" },
  });
  insert("c1", "codex", "Codex One", { config: 'model = "gpt-5"\n' });
}

test("dry-run claude: derives config without touching disk", async () => {
  setupDB();
  const plan = await buildDryRunPlan("claude", { name: "Alpha" }, ["--continue"], {});
  assert.ok(!("error" in plan), plan.error);
  assert.equal(plan.configFileName, "settings.json");
  assert.equal(plan.instanceDir, join(INSTANCES_DIR, "claude", "p1"));
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, plan.instanceDir);
  assert.equal(plan.env.CC_SWITCH_PROVIDER, "Alpha");
  assert.equal(plan.env.CC_SWITCH_PROVIDER_ID, "p1");
  assert.equal(plan.effective.env.ANTHROPIC_AUTH_TOKEN, "secret-token");
  assert.ok(plan.configText.includes("secret-token"));

  const rendered = renderDryRunPlan(plan, {});
  assert.ok(rendered.includes("***"));
  assert.ok(!rendered.includes("secret-token"), "token masked by default");

  const shown = renderDryRunPlan(plan, { showSecrets: true });
  assert.ok(shown.includes("secret-token"));

  assert.equal(existsSync(plan.instanceDir), false, "instance dir not created");
  assert.equal(existsSync(join(plan.instanceDir, "statusline-wrapper.mjs")), false, "wrapper not written");
  assert.equal(existsSync(HISTORY_PATH), false, "history not written");
  assert.equal(existsSync(SYNC_STATE_PATH), false, "sync state not written");
});

test("dry-run codex: config.toml is derived and parseable", async () => {
  const plan = await buildDryRunPlan("codex", { name: "Codex One" }, [], {});
  assert.ok(!("error" in plan), plan.error);
  assert.equal(plan.configFileName, "config.toml");
  assert.equal(plan.env.CODEX_HOME, plan.instanceDir);
  const parsed = parseToml(plan.configText);
  assert.equal(parsed.model, "gpt-5");
  assert.equal(existsSync(plan.instanceDir), false);
});

test("dry-run --diff: reports changes without modifying the instance file", async () => {
  const dir = join(INSTANCES_DIR, "claude", "p1");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "old-token", KEEP: "yes" } }, null, 2));
  const before = readFileSync(file, "utf8");

  const plan = await buildDryRunPlan("claude", { name: "Alpha" }, [], { diff: true });
  assert.ok(!("error" in plan), plan.error);
  assert.ok(Array.isArray(plan.changes));
  const tokenChange = plan.changes.find((c) => c.path === "env.ANTHROPIC_AUTH_TOKEN");
  assert.ok(tokenChange, "token leaf differs");

  const rendered = renderDryRunPlan(plan, { diff: true });
  assert.ok(rendered.includes("Diff vs current instance file"));
  assert.ok(rendered.includes("env.ANTHROPIC_AUTH_TOKEN"));
  assert.ok(!rendered.includes("old-token"));
  assert.ok(!rendered.includes("secret-token"));

  const shown = renderDryRunPlan(plan, { diff: true, showSecrets: true });
  assert.ok(shown.includes("old-token"));
  assert.ok(shown.includes("secret-token"));

  assert.equal(readFileSync(file, "utf8"), before, "instance file untouched");
});

test("dry-run: provider errors are reported", async () => {
  const missing = await buildDryRunPlan("claude", { name: "Nope" }, [], {});
  assert.match(missing.error, /not found/);

  const unsupported = await buildDryRunPlan("nope", { name: "Alpha" }, [], {});
  assert.match(unsupported.error, /Unsupported command/);
});
