import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const testHome = mkdtempSync(join(tmpdir(), "cc-launch-history-migrate-"));
process.env.CC_SWITCH_TEST_HOME = testHome;
process.env.CC_LAUNCH_SKIP_MAIN = "1";

const { loadHistory, entryKey } = await import("../src/history.ts");
const { DB_PATH, HISTORY_PATH } = await import("../src/paths.ts");

function sql(statement) {
  return execFileSync("sqlite3", [DB_PATH, ".timeout 3000", statement], { encoding: "utf8" });
}

function setup() {
  mkdirSync(join(testHome, ".cc-switch"), { recursive: true });
  sql(`CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
    is_current BOOLEAN NOT NULL DEFAULT 0, created_at INTEGER, sort_index INTEGER,
    PRIMARY KEY (id, app_type));`);
  for (const [id, name] of [
    ["a-dup", "Dup"],
    ["z-dup", "Dup"],
    ["solo", "Solo"],
  ]) {
    sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, created_at)
      VALUES ('${id}', 'claude', '${name}', '{}', 1);`);
  }
  writeFileSync(
    HISTORY_PATH,
    JSON.stringify(
      {
        version: 1,
        entries: [
          { cli: "claude", provider: "Dup", extraArgs: [], count: 3, lastUsed: 1 },
          { cli: "claude", provider: "Solo", extraArgs: [], count: 2, lastUsed: 2 },
        ],
        order: ["claude|Dup", null, null, null, null],
      },
      null,
      2,
    ),
  );
}

test("v1 migration: unique names bind, duplicate names stay unbound + warn once", () => {
  setup();
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let migrated;
  try {
    migrated = loadHistory();
  } finally {
    console.error = original;
  }

  const dup = migrated.entries.find((e) => e.provider === "Dup");
  const solo = migrated.entries.find((e) => e.provider === "Solo");
  assert.equal(dup.providerId, null, "duplicate name must not silently pick a row");
  assert.equal(solo.providerId, "solo");
  assert.equal(migrated.order[0], entryKey(dup), "order slot survives the migration");

  assert.equal(errors.length, 1, "exactly one warning per ambiguous name");
  assert.match(errors[0], /a-dup/);
  assert.match(errors[0], /z-dup/);
  assert.match(errors[0], /Dup/);

  const onDisk = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.entries.find((e) => e.provider === "Dup").providerId, null);
  assert.equal(onDisk.entries.find((e) => e.provider === "Solo").providerId, "solo");

  // A second load reads v2 — no migration, no warning.
  const again = [];
  console.error = (...args) => again.push(args.join(" "));
  try {
    loadHistory();
  } finally {
    console.error = original;
  }
  assert.deepEqual(again, []);
});
