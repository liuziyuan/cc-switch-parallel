import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-history-pins-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
const STATE_DIR = join(TEST_HOME, ".cc-switch");
const HISTORY_PATH = join(STATE_DIR, "launch_history.json");
mkdirSync(STATE_DIR, { recursive: true });

const { normalizeOrder, mergeTop5, insertManualOrder } = await import("../src/history.ts");

test("normalizeOrder: repeated keys are dropped, the first slot wins", () => {
  assert.deepEqual(normalizeOrder(["claude|a", "claude|a", "claude|b", null, "claude|b"]), [
    "claude|a",
    null,
    "claude|b",
    null,
    null,
  ]);
});

test("mergeTop5: the same entry key never renders twice", () => {
  const entries = [
    {
      cli: "claude",
      providerId: "a",
      provider: "A",
      hotkey: null,
      extraArgs: [],
      count: 5,
      lastUsed: 1,
    },
    {
      cli: "claude",
      providerId: "b",
      provider: "B",
      hotkey: null,
      extraArgs: [],
      count: 1,
      lastUsed: 1,
    },
  ];
  const rows = mergeTop5(entries, ["claude|a", "claude|a", "claude|b", null, null], new Map());
  assert.deepEqual(
    rows.map((e) => e.providerId),
    ["a", "b"],
  );
});

test("insertManualOrder: re-pinning moves the row instead of duplicating the slot", () => {
  const item = { cli: "claude", providerId: "a", provider: "A" };
  assert.equal(insertManualOrder(item, 1, new Map()), 1);
  // Only this row exists, so the requested slot is clamped — the point here
  // is that the re-pin must not create a second slot for the same key.
  insertManualOrder(item, 3, new Map());
  const data = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  const slots = data.order.filter(Boolean);
  assert.equal(new Set(slots).size, slots.length, "no duplicate pin slots");
  assert.deepEqual(slots, ["claude|a"]);
});
