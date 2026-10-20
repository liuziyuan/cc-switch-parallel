import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// paths.ts reads CC_SWITCH_TEST_HOME at import time, and history.ts resolves
// HISTORY_PATH from it — set the sandbox before importing anything.
const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-quick-launch-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
const STATE_DIR = join(TEST_HOME, ".cc-switch");
const HISTORY_PATH = join(STATE_DIR, "launch_history.json");
mkdirSync(STATE_DIR, { recursive: true });

const { quickItemsFor } = await import("../src/history.ts");
const { isQuickLaunchKey } = await import("../src/commands/quick.ts");

const entry = (over = {}) => ({
  cli: "claude", providerId: "p1", provider: "P1", hotkey: null,
  extraArgs: [], count: 1, lastUsed: 1, ...over,
});

// The command line's `switch a|s|d|f|g` is the twin of the TUI's quick keys:
// both project the same mergeTop5 ordering through quickItemsFor, so these
// must line up with what the picker shows in slots 1-5.

test("slots map to QUICK_KEYS in display order", () => {
  const entries = [
    entry({ providerId: "a", provider: "A", count: 30 }),
    entry({ providerId: "b", provider: "B", count: 20 }),
    entry({ providerId: "c", provider: "C", count: 10 }),
  ];
  const items = quickItemsFor(entries, [null, null, null, null, null], new Map());
  assert.deepEqual(items.map((q) => q.key), ["a", "s", "d"]);
  assert.deepEqual(items.map((q) => q.providerId), ["a", "b", "c"]);
  assert.deepEqual(items.map((q) => q.provider), ["A", "B", "C"]);
});

test("pinned slots keep their position on the command line too", () => {
  const entries = [
    entry({ providerId: "a", provider: "A", count: 30 }),
    entry({ providerId: "b", provider: "B", count: 20 }),
    entry({ providerId: "c", provider: "C", count: 10 }),
  ];
  // Pin C into slot 1: `switch a` must launch C, identical to the TUI.
  const items = quickItemsFor(entries, ["claude|c", null, null, null, null], new Map());
  assert.deepEqual(items.map((q) => q.providerId), ["c", "a", "b"]);
  assert.equal(items[0].pinned, true);
  assert.equal(items[1].pinned, false);
});

test("rename in cc-switch follows through the alive snapshot", () => {
  const entries = [entry({ providerId: "p1", provider: "Old name", count: 5 })];
  const alive = new Map([["claude", {
    idSet: new Set(["p1"]),
    nameById: new Map([["p1", "New name"]]),
  }]]);
  const [item] = quickItemsFor(entries, [null, null, null, null, null], alive);
  assert.equal(item.provider, "New name");
  assert.equal(item.dead, false);
});

test("provider deleted in cc-switch is flagged dead, not launchable by the command line", () => {
  const entries = [entry({ providerId: "gone", provider: "Gone", count: 9 })];
  const alive = new Map([["claude", { idSet: new Set(), nameById: new Map() }]]);
  const [item] = quickItemsFor(entries, [null, null, null, null, null], alive);
  assert.equal(item.dead, true);
});

test("replay argv carries the recorded extra args and the launch mode", () => {
  const entries = [entry({
    hotkey: "2",
    extraArgs: ["--permission-mode", "acceptEdits", "--continue"],
  })];
  const [item] = quickItemsFor(entries, [null, null, null, null, null], new Map());
  assert.equal(item.hotkey, "2");
  assert.deepEqual(item.extraArgs, ["--permission-mode", "acceptEdits", "--continue"]);
  assert.match(item.label, /Semi-auto/);
  assert.match(item.label, /\+args/);
});

test("bare permission flags alone are not marked +args", () => {
  const entries = [entry({ hotkey: "3", extraArgs: ["--dangerously-skip-permissions"] })];
  const [item] = quickItemsFor(entries, [null, null, null, null, null], new Map());
  assert.doesNotMatch(item.label, /\+args/);
});

test("isQuickLaunchKey accepts only the bare lowercase slot keys", () => {
  for (const key of ["a", "s", "d", "f", "g"]) assert.equal(isQuickLaunchKey(key), true);
  for (const other of ["A", "S", "sync", "claude", "1", "", " s", undefined, null, 3]) {
    assert.equal(isQuickLaunchKey(other), false, `${String(other)} must not be a quick key`);
  }
});

test("resolveQuickItem reads the same slots from history on disk", async () => {
  writeFileSync(HISTORY_PATH, JSON.stringify({
    version: 2,
    entries: [
      entry({ providerId: "p1", provider: "P1", count: 30 }),
      entry({ cli: "codex", providerId: "p2", provider: "P2", count: 20 }),
    ],
    order: [null, null, null, null, null],
  }), "utf8");
  const { resolveQuickItem } = await import("../src/commands/quick.ts");
  assert.equal(resolveQuickItem("a").providerId, "p1");
  assert.equal(resolveQuickItem("s").cli, "codex");
  assert.equal(resolveQuickItem("d"), null); // empty slot
});
