import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-history-corrupt-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
const DIR = join(TEST_HOME, ".cc-switch");
const HISTORY_PATH = join(DIR, "launch_history.json");
mkdirSync(DIR, { recursive: true });
writeFileSync(HISTORY_PATH, "{ not json");

const { recordLaunch } = await import("../src/history.ts");

test("corrupt history: bytes preserved under .corrupt-* and writes frozen", () => {
  recordLaunch("claude", "p1", "P1", null, []);
  const corrupt = readdirSync(DIR).filter((n) => n.startsWith("launch_history.json.corrupt-"));
  assert.equal(corrupt.length, 1, "the corrupt file is renamed, not deleted");
  assert.equal(readFileSync(join(DIR, corrupt[0]), "utf8"), "{ not json");
  assert.equal(existsSync(HISTORY_PATH), false, "no empty history was written over it");

  // Every later write in this process stays frozen too.
  recordLaunch("claude", "p1", "P1", null, []);
  assert.equal(
    readdirSync(DIR).filter((n) => n.startsWith("launch_history.json.corrupt-")).length,
    1,
  );
  assert.equal(existsSync(HISTORY_PATH), false);
});
