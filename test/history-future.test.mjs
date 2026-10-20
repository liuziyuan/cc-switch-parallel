import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-history-future-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
const DIR = join(TEST_HOME, ".cc-switch");
const HISTORY_PATH = join(DIR, "launch_history.json");
mkdirSync(DIR, { recursive: true });
const FUTURE = JSON.stringify({
  version: 99,
  entries: [
    {
      cli: "claude",
      providerId: "p1",
      provider: "P1",
      hotkey: null,
      extraArgs: [],
      count: 3,
      lastUsed: 1,
    },
  ],
  order: [null, null, null, null, null],
});
writeFileSync(HISTORY_PATH, FUTURE);

const { recordLaunch, top5 } = await import("../src/history.ts");

test("future history version: readable, never migrated or rewritten", () => {
  recordLaunch("claude", "p2", "P2", null, []);
  assert.equal(
    readFileSync(HISTORY_PATH, "utf8"),
    FUTURE,
    "a newer writer's file must not be downgraded",
  );
  const rows = top5(new Map());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, "P1");
});
