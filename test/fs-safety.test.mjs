import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, readlinkSync, readFileSync, readdirSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the home directory BEFORE paths.ts is imported: it derives
// HOME/CC_SWITCH_DIR/INSTANCES_DIR at module load time.
const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-fs-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;

const { setupClaudeInstance, atomicWrite } = await import("../src/fs-utils.ts");
const { buildClaudeEffectiveSettings } = await import("../src/claude-config.ts");

function tempDir() {
  return mkdtempSync(join(TEST_HOME, "case-"));
}

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

// ─── private permissions ──────────────────────────────────────────────
// Instance files carry provider tokens; a default umask made them 0644.

test("atomicWrite: new files are 0600 and leave no temp file behind", () => {
  const dir = tempDir();
  const file = join(dir, "secret.json");
  atomicWrite(file, '{"token":"x"}');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readFileSync(file, "utf8"), '{"token":"x"}');
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(".tmp.")), []);
});

test("atomicWrite: an existing permissive file is tightened to 0600", () => {
  const dir = tempDir();
  const file = join(dir, "old.json");
  writeFileSync(file, "old");
  chmodSync(file, 0o640);
  atomicWrite(file, "new");
  assert.equal(statSync(file).mode & 0o777, 0o600, "credentials must shrink, not inherit");
  assert.equal(readFileSync(file, "utf8"), "new");
});

test("atomicWrite: repeated writes keep the full content", () => {
  const dir = tempDir();
  const file = join(dir, "repeat.json");
  atomicWrite(file, "first");
  atomicWrite(file, JSON.stringify({ v: 2 }));
  assert.equal(readFileSync(file, "utf8"), '{"v":2}');
});

test("setupClaudeInstance: the instance directory is 0700", () => {
  const dir = setupClaudeInstance("private-dir-provider");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("statusline wrapper: generated script is 0600 (it inlines usage tokens)", () => {
  const providerId = "wrapper-perm-provider";
  buildClaudeEffectiveSettings(
    { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "tok" } },
    { usage_script: { codingPlanProvider: "zhipu" } },
    "",
    "Z.AI GLM",
    providerId,
  );
  const wrapper = join(TEST_HOME, ".cc-switch", "instances", "claude", providerId, "statusline-wrapper.mjs");
  assert.equal(statSync(wrapper).mode & 0o777, 0o600);
});
