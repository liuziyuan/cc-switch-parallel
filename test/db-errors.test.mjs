import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CC_SWITCH_TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-db-errors-"));

// Put a fake sqlite3 first in PATH; its behaviour is selected by FAKE_SQLITE.
const binDir = mkdtempSync(join(tmpdir(), "cc-switch-fake-sqlite-"));
const fake = join(binDir, "sqlite3");
writeFileSync(
  fake,
  [
    "#!/bin/sh",
    'case "$FAKE_SQLITE" in',
    "  ok) echo 1 ;;",
    '  busy) echo "Error: database is locked" >&2; exit 1 ;;',
    '  syntax) echo "Error: near x: syntax error" >&2; exit 1 ;;',
    "  timeout) sleep 2 ;;",
    "  *) echo unknown; exit 1 ;;",
    "esac",
    "",
  ].join("\n"),
);
chmodSync(fake, 0o755);
const oldPath = process.env.PATH;
process.env.PATH = `${binDir}:${oldPath}`;
after(() => {
  process.env.PATH = oldPath;
});

const { execDBWithChanges } = await import("../src/upward.ts");

test("execDBWithChanges: success returns the changes count", () => {
  process.env.FAKE_SQLITE = "ok";
  assert.equal(execDBWithChanges("UPDATE t SET x=1"), 1);
});

test("execDBWithChanges: a busy database is DB_BUSY (retryable CAS race)", () => {
  process.env.FAKE_SQLITE = "busy";
  assert.throws(
    () => execDBWithChanges("UPDATE t SET x=1"),
    (e) => e.code === "DB_BUSY",
  );
});

test("execDBWithChanges: a syntax error is DB_ERROR (reported, never retried)", () => {
  process.env.FAKE_SQLITE = "syntax";
  assert.throws(
    () => execDBWithChanges("UPDATE t SET x=1"),
    (e) => e.code === "DB_ERROR",
  );
});

test("execDBWithChanges: a timeout is DB_TIMEOUT (reported, never retried)", () => {
  process.env.FAKE_SQLITE = "timeout";
  assert.throws(
    () => execDBWithChanges("UPDATE t SET x=1", 100),
    (e) => e.code === "DB_TIMEOUT",
  );
});
