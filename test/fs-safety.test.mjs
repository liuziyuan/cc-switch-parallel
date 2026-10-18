import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the home directory BEFORE paths.ts is imported: it derives
// HOME/CC_SWITCH_DIR/INSTANCES_DIR at module load time.
const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-fs-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;

const { setupClaudeInstance } = await import("../src/fs-utils.ts");

function globalPluginsDir() {
  const dir = join(TEST_HOME, ".claude", "plugins");
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("ensureSymlink: an empty instance dir is replaced by the shared symlink", () => {
  const target = globalPluginsDir();
  const instanceDir = join(TEST_HOME, ".cc-switch", "instances", "claude", "empty-dir-provider");
  mkdirSync(join(instanceDir, "plugins"), { recursive: true });

  setupClaudeInstance("empty-dir-provider");

  const link = join(instanceDir, "plugins");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "empty dir should have become a symlink");
  assert.equal(readlinkSync(link), target);
});

test("ensureSymlink: a non-empty instance dir is left untouched", () => {
  globalPluginsDir();
  const instanceDir = join(TEST_HOME, ".cc-switch", "instances", "claude", "nonempty-dir-provider");
  mkdirSync(join(instanceDir, "plugins"), { recursive: true });
  writeFileSync(join(instanceDir, "plugins", "keep.txt"), "user data");

  setupClaudeInstance("nonempty-dir-provider");

  const link = join(instanceDir, "plugins");
  assert.equal(lstatSync(link).isDirectory(), true);
  assert.equal(lstatSync(link).isSymbolicLink(), false);
});

test("ensureSymlink: a real file is preserved (never replaced)", () => {
  globalPluginsDir();
  // A global CLAUDE.md must exist, or setupClaudeInstance never reaches the
  // keep-real-files branch for this path.
  writeFileSync(join(TEST_HOME, ".claude", "CLAUDE.md"), "# shared global\n");
  const instanceDir = join(TEST_HOME, ".cc-switch", "instances", "claude", "real-file-provider");
  mkdirSync(instanceDir, { recursive: true });
  const file = join(instanceDir, "CLAUDE.md");
  writeFileSync(file, "# my instance instructions\n");

  setupClaudeInstance("real-file-provider");

  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(lstatSync(file).isFile(), true);
});
