import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Fixture home MUST be set before the dynamic import: path constants are
// evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-list-"));
process.env.CC_SWITCH_TEST_HOME = testHome;
process.env.CC_LAUNCH_SKIP_MAIN = "1";

const { listProviders, parseListArgs, renderListJson } = await import("../src/commands/list.ts");
const { DB_PATH } = await import("../src/paths.ts");

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
  const insert = (id, app, name, settings, sort, isCurrent = 0) => {
    const raw = typeof settings === "string" ? settings : JSON.stringify(settings);
    sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta, sort_index, created_at, is_current)
      VALUES ('${id}', '${app}', '${name}', '${raw.replace(/'/g, "''")}', '{}', ${sort}, 1, ${isCurrent});`);
  };
  insert("p1", "claude", "Alpha", { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }, 1);
  insert("p2", "claude", "Dup", { env: {} }, 2);
  insert("p3", "claude", "Dup", { env: {} }, 3, 1);
  insert(
    "agg",
    "claude",
    "Stacky",
    {
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721", ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED" },
    },
    4,
  );
  insert("bad", "claude", "Bad", "not-json", 5);
  insert("c1", "codex", "Codex One", { config: 'model = "gpt-5"\n' }, 1);
  insert("c2", "codex", "Codex Bad", { config: "[[[" }, 2);
}

test("listProviders: rows, aggregation, availability and ambiguity", () => {
  setupDB();
  const claude = listProviders(["claude"]);
  assert.deepEqual(
    claude.map((r) => r.id),
    ["p1", "p2", "p3", "agg", "bad"],
  );

  const alpha = claude.find((r) => r.id === "p1");
  assert.equal(alpha.name, "Alpha");
  assert.equal(alpha.kind, "provider");
  assert.equal(alpha.aggregation, false);
  assert.equal(alpha.virtual, false);
  assert.equal(alpha.available, true);
  assert.deepEqual(alpha.issues, []);
  assert.equal(alpha.members, null);

  assert.equal(claude.find((r) => r.id === "p2").nameAmbiguous, true);
  assert.equal(claude.find((r) => r.id === "p3").nameAmbiguous, true);
  assert.equal(claude.find((r) => r.id === "p3").current, true);
  assert.equal(alpha.nameAmbiguous, false);

  const agg = claude.find((r) => r.id === "agg");
  assert.equal(agg.aggregation, true);
  assert.equal(agg.virtual, false);
  assert.deepEqual(agg.members, [], "aggregation row without live stack has no members");

  const bad = claude.find((r) => r.id === "bad");
  assert.equal(bad.available, false);
  assert.equal(bad.issues.length, 1);
  assert.match(bad.issues[0], /settings_config/);

  const codex = listProviders(["codex"]);
  assert.equal(codex.find((r) => r.id === "c1").available, true);
  const c2 = codex.find((r) => r.id === "c2");
  assert.equal(c2.available, false);
  assert.match(c2.issues.join(" "), /TOML/);

  rmSync(join(testHome, ".cc-switch"), { recursive: true, force: true });
});

test("parseListArgs: flags, defaults and errors", () => {
  assert.deepEqual(parseListArgs([]), { json: false, apps: ["claude", "codex"] });
  assert.deepEqual(parseListArgs(["--json", "--app", "codex"]), { json: true, apps: ["codex"] });
  assert.deepEqual(parseListArgs(["--app=claude", "--app", "codex"]), {
    json: false,
    apps: ["claude", "codex"],
  });
  assert.deepEqual(parseListArgs(["--app", "claude", "--app", "claude"]), {
    json: false,
    apps: ["claude"],
  });
  assert.match(parseListArgs(["--app", "nope"]).error, /unknown app/);
  assert.match(parseListArgs(["--app"]).error, /missing --app value/);
  assert.match(parseListArgs(["--app="]).error, /missing --app value/);
  assert.match(parseListArgs(["--wat"]).error, /unknown argument/);
});

test("renderListJson: stable envelope", () => {
  setupDB();
  const rows = listProviders(["claude"]);
  const parsed = JSON.parse(renderListJson(rows));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.providers.length, rows.length);
  assert.deepEqual(Object.keys(parsed.providers[0]), [
    "app",
    "id",
    "name",
    "kind",
    "aggregation",
    "virtual",
    "current",
    "members",
    "available",
    "issues",
    "nameAmbiguous",
  ]);
  rmSync(join(testHome, ".cc-switch"), { recursive: true, force: true });
});
