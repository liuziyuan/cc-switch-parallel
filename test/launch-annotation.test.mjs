import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

// End-to-end command-mode launch: real sqlite DB + sync-state + a `claude`
// stub on PATH. Verifies the launching provider stays in the stale list with
// its annotation AND that a bad provider ref now fails before the drift
// warning (command mode resolves before detecting).
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-ann-"));
const binDir = mkdtempSync(join(tmpdir(), "cc-launch-bin-"));
const CC = join(testHome, ".cc-switch");
const DB = join(CC, "cc-switch.db");
mkdirSync(CC, { recursive: true });
writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");
chmodSync(join(binDir, "claude"), 0o755);

function sql(statement) {
  return execFileSync("sqlite3", [DB, ".timeout 3000", statement], { encoding: "utf8" });
}

sql(`CREATE TABLE providers (
  id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
  settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
  created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
  meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
  in_failover_queue BOOLEAN NOT NULL DEFAULT 0, provider_type TEXT,
  PRIMARY KEY (id, app_type));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
sql(`INSERT INTO settings (key, value) VALUES ('common_config_claude', '{"env":{"SHARED":"1"}}');`);
for (const [id, name] of [
  ["p1", "Keep Me"],
  ["p2", "Launched"],
]) {
  sql(`INSERT INTO providers (id, app_type, name, settings_config, category, meta)
    VALUES ('${id}', 'claude', '${name}', '{}', 'custom', '{}');`);
}

const staleEntry = {
  sharedMode: "legacy",
  sharedHash: "stale",
  commonHash: "stale",
  preparedAt: 1,
  preparedSettings: { env: {} },
};
writeFileSync(
  join(CC, "sync-state.json"),
  JSON.stringify({
    version: 3,
    instances: { claude: { p1: staleEntry, p2: staleEntry } },
    claude: { installedPluginKeys: [], enabledPlugins: {} },
  }),
);

const launchEntry = new URL("../src/launch.ts", import.meta.url).href;

function runLaunch(refLiteral) {
  const script = [
    `process.env.CC_SWITCH_TEST_HOME = ${JSON.stringify(testHome)};`,
    `process.env.CC_SWITCH_SHARED_SOURCE = "legacy";`,
    `process.env.CC_LAUNCH_SKIP_MAIN = "1";`,
    `const { launchProvider } = await import(${JSON.stringify(launchEntry)});`,
    `await launchProvider("claude", ${refLiteral}, [], null);`,
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          CC_SWITCH_TEST_HOME: testHome,
          CC_SWITCH_SHARED_SOURCE: "legacy",
          CC_LAUNCH_SKIP_MAIN: "1",
          PATH: `${binDir}:${process.env.PATH}`,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

test("launch warns with the stale list annotated, then prepares and launches", async () => {
  const { code, stderr } = await runLaunch(`{ id: "p2" }`);
  assert.equal(code, 0, stderr);
  assert.equal(stderr.includes("restart to apply: Keep Me, Launched"), true);
  assert.equal(stderr.includes('this launch will refresh "Launched"'), true);
  assert.equal(stderr.includes("CLAUDE_CONFIG_DIR="), true);
  assert.equal(
    existsSync(join(CC, "instances", "claude", "p2", "settings.json")),
    true,
    "prepare must still run",
  );
});

test("an unknown provider fails before the drift warning", async () => {
  const { code, stderr } = await runLaunch(`{ name: "Nope" }`);
  assert.notEqual(code, 0);
  assert.equal(stderr.includes("not found"), true);
  assert.equal(stderr.includes("Config drift detected"), false);
});
