import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Throwaway HOME + real sqlite DB: detectCommonConfigDrift resolves provider
// names through queryProvidersByApp, and readSharedConfig reads the legacy
// common_config_claude row / schema version through the same DB.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-drift-ann-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;
process.env.CC_SWITCH_SHARED_SOURCE = "legacy";

const { collectStaleInstanceIds, detectAndPromptSync, detectCommonConfigDrift } = await import(
  "../src/drift.ts"
);
const { readSharedConfig, sharedConfigHash } = await import("../src/shared-config.ts");

const CC = join(testHome, ".cc-switch");
const DB = join(CC, "cc-switch.db");
mkdirSync(CC, { recursive: true });

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
  ["p3", "Other"],
]) {
  sql(`INSERT INTO providers (id, app_type, name, settings_config, category, meta)
    VALUES ('${id}', 'claude', '${name}', '{}', 'custom', '{}');`);
}

function seedState(staleIds) {
  const instances = {};
  for (const id of staleIds) {
    instances[id] = {
      sharedMode: "legacy",
      sharedHash: "stale",
      commonHash: "stale",
      preparedAt: 1,
      preparedSettings: { env: {} },
    };
  }
  const state = {
    version: 3,
    instances: { claude: instances },
    claude: { installedPluginKeys: [], enabledPlugins: {} },
  };
  writeFileSync(join(CC, "sync-state.json"), JSON.stringify(state, null, 2));
  return state;
}

async function captureStderrAsync(fn) {
  let buf = "";
  const orig = process.stderr.write;
  process.stderr.write = (s) => {
    buf += s;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return buf;
}

test("detectCommonConfigDrift maps stale ids to provider names", () => {
  const state = seedState(["p1", "p2"]);
  assert.deepEqual(detectCommonConfigDrift(state), { claude: ["Keep Me", "Launched"] });
});

test("command-mode warning keeps the launching provider and annotates it", async () => {
  seedState(["p1", "p2"]);
  const out = await captureStderrAsync(() =>
    detectAndPromptSync({
      tui: false,
      highlightProvider: { appType: "claude", id: "p2", name: "Launched" },
    }),
  );
  assert.equal(out.includes("restart to apply: Keep Me, Launched"), true);
  assert.equal(
    out.includes(
      '(this launch will refresh "Launched"; other running sessions still need a restart)',
    ),
    true,
  );
  assert.equal(out.includes("switch --sync <slot>"), true);
});

test("no annotation when the highlighted provider is not stale", async () => {
  seedState(["p1"]);
  const out = await captureStderrAsync(() =>
    detectAndPromptSync({
      tui: false,
      highlightProvider: { appType: "claude", id: "p3", name: "Other" },
    }),
  );
  assert.equal(out.includes("restart to apply: Keep Me"), true);
  assert.equal(out.includes("this launch will refresh"), false);
});

test("the only stale provider still gets its app line plus the annotation", async () => {
  seedState(["p2"]);
  const out = await captureStderrAsync(() =>
    detectAndPromptSync({
      tui: false,
      highlightProvider: { appType: "claude", id: "p2", name: "Launched" },
    }),
  );
  assert.equal(out.includes("common config (claude)"), true);
  assert.equal(out.includes("restart to apply: Launched"), true);
  assert.equal(out.includes('this launch will refresh "Launched"'), true);
});

test("quiet mode stays silent and reports drift", async () => {
  seedState(["p1", "p2"]);
  let result;
  const out = await captureStderrAsync(async () => {
    result = await detectAndPromptSync({
      tui: false,
      quiet: true,
      highlightProvider: { appType: "claude", id: "p2", name: "Launched" },
    });
  });
  assert.equal(out, "");
  assert.deepEqual(result, { synced: false, drifted: true });
});

test("no drift: highlighting does not invent a stale entry", async () => {
  const shared = readSharedConfig("claude");
  const hash = sharedConfigHash(shared);
  writeFileSync(
    join(CC, "sync-state.json"),
    JSON.stringify({
      version: 3,
      instances: {
        claude: {
          p2: { sharedMode: shared.mode, sharedHash: hash, preparedAt: 1, preparedSettings: {} },
        },
      },
      claude: { installedPluginKeys: [], enabledPlugins: {} },
    }),
  );
  let result;
  const out = await captureStderrAsync(async () => {
    result = await detectAndPromptSync({
      tui: false,
      highlightProvider: { appType: "claude", id: "p2", name: "Launched" },
    });
  });
  assert.equal(out, "");
  assert.deepEqual(result, { synced: false, drifted: false });
});

test("the annotation never shrinks the refresh set", () => {
  const state = seedState(["p1", "p2"]);
  assert.deepEqual(collectStaleInstanceIds(state), { claude: ["p1", "p2"] });
});
