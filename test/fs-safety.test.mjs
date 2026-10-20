import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  chmodSync,
  statSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
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
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.startsWith(".tmp.")),
    [],
  );
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
  const wrapper = join(
    TEST_HOME,
    ".cc-switch",
    "instances",
    "claude",
    providerId,
    "statusline-wrapper.mjs",
  );
  assert.equal(statSync(wrapper).mode & 0o777, 0o600);
});

// ─── plans: device-level sharing ──────────────────────────────────────
// Claude Code writes plans to $CLAUDE_CONFIG_DIR/plans. Each test uses a
// unique provider id and unique file names: the global plans dir is shared
// across cases in this file.

function instanceDirFor(providerId) {
  return join(TEST_HOME, ".cc-switch", "instances", "claude", providerId);
}

function globalPlansDir() {
  return join(TEST_HOME, ".claude", "plans");
}

test("plans: a fresh instance links to the global plans dir", () => {
  const providerId = "plans-fresh";
  rmSync(globalPlansDir(), { recursive: true, force: true });

  setupClaudeInstance(providerId);

  const link = join(instanceDirFor(providerId), "plans");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), globalPlansDir());
  assert.equal(
    statSync(globalPlansDir()).isDirectory(),
    true,
    "the global dir is created on demand",
  );
});

test("plans: non-empty instance plans are merged into the global dir", () => {
  const providerId = "plans-merge";
  const instanceDir = instanceDirFor(providerId);
  mkdirSync(join(instanceDir, "plans"), { recursive: true });
  writeFileSync(join(instanceDir, "plans", "merge-plan.md"), "# merge\n");

  setupClaudeInstance(providerId);

  assert.equal(readFileSync(join(globalPlansDir(), "merge-plan.md"), "utf8"), "# merge\n");
  assert.equal(lstatSync(join(instanceDir, "plans")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(instanceDir, "plans", "merge-plan.md"), "utf8"), "# merge\n");
});

test("plans: identical same-name files are deduplicated", () => {
  const providerId = "plans-dedupe";
  const instanceDir = instanceDirFor(providerId);
  mkdirSync(globalPlansDir(), { recursive: true });
  mkdirSync(join(instanceDir, "plans"), { recursive: true });
  writeFileSync(join(globalPlansDir(), "dedupe-plan.md"), "# same\n");
  writeFileSync(join(instanceDir, "plans", "dedupe-plan.md"), "# same\n");

  setupClaudeInstance(providerId);

  assert.deepEqual(
    readdirSync(globalPlansDir()).filter((n) => n.startsWith("dedupe-plan")),
    ["dedupe-plan.md"],
  );
  assert.equal(lstatSync(join(instanceDir, "plans")).isSymbolicLink(), true);
});

test("plans: conflicting same-name files keep both", () => {
  const providerId = "plans-conflict";
  const instanceDir = instanceDirFor(providerId);
  mkdirSync(globalPlansDir(), { recursive: true });
  mkdirSync(join(instanceDir, "plans"), { recursive: true });
  writeFileSync(join(globalPlansDir(), "conflict-plan.md"), "# global\n");
  writeFileSync(join(instanceDir, "plans", "conflict-plan.md"), "# instance\n");

  setupClaudeInstance(providerId);

  assert.equal(
    readFileSync(join(globalPlansDir(), "conflict-plan.md"), "utf8"),
    "# global\n",
    "never overwrite",
  );
  const copies = readdirSync(globalPlansDir()).filter((n) =>
    /^conflict-plan\.plans-conflict.*\.md$/.test(n),
  );
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(globalPlansDir(), copies[0]), "utf8"), "# instance\n");
});

test("plans: nested directories and non-markdown files are migrated", () => {
  const providerId = "plans-nested";
  const instanceDir = instanceDirFor(providerId);
  mkdirSync(join(instanceDir, "plans", "sub"), { recursive: true });
  writeFileSync(join(instanceDir, "plans", "sub", "nested.txt"), "nested\n");

  setupClaudeInstance(providerId);

  assert.equal(readFileSync(join(globalPlansDir(), "sub", "nested.txt"), "utf8"), "nested\n");
  assert.equal(lstatSync(join(instanceDir, "plans")).isSymbolicLink(), true);
});

test("plans: repeated setup calls are idempotent", () => {
  const providerId = "plans-idempotent";
  const instanceDir = instanceDirFor(providerId);
  mkdirSync(join(instanceDir, "plans"), { recursive: true });
  writeFileSync(join(instanceDir, "plans", "idem-plan.md"), "# once\n");

  setupClaudeInstance(providerId);
  const before = readdirSync(globalPlansDir()).sort();
  setupClaudeInstance(providerId);

  assert.deepEqual(readdirSync(globalPlansDir()).sort(), before);
  assert.equal(lstatSync(join(instanceDir, "plans")).isSymbolicLink(), true);
  assert.equal(
    existsSync(join(TEST_HOME, ".claude", ".plans-migration.lock")),
    false,
    "the lock is released",
  );
  assert.equal(
    existsSync(join(globalPlansDir(), ".plans-migration.lock")),
    false,
    "the lock never lives in plans/",
  );
});

test("plans: an existing symlink is left in place", () => {
  const providerId = "plans-linked";
  const instanceDir = instanceDirFor(providerId);
  mkdirSync(globalPlansDir(), { recursive: true });
  mkdirSync(instanceDir, { recursive: true });
  symlinkSync(globalPlansDir(), join(instanceDir, "plans"), "dir");

  setupClaudeInstance(providerId);

  assert.equal(lstatSync(join(instanceDir, "plans")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(instanceDir, "plans")), globalPlansDir());
});

test("plans: only the instance being set up is migrated", () => {
  const ids = ["plans-current-a", "plans-current-b"];
  for (const id of ids) {
    const plans = join(instanceDirFor(id), "plans");
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, `${id}.md`), "# x\n");
  }

  setupClaudeInstance(ids[0]);

  assert.equal(lstatSync(join(instanceDirFor(ids[0]), "plans")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(instanceDirFor(ids[1]), "plans")).isSymbolicLink(), false);
  assert.equal(
    readFileSync(join(instanceDirFor(ids[1]), "plans", `${ids[1]}.md`), "utf8"),
    "# x\n",
  );
});

test("plans: an unusable global plans path does not break setup", () => {
  const providerId = "plans-unusable";
  const instanceDir = instanceDirFor(providerId);
  rmSync(globalPlansDir(), { recursive: true, force: true });
  writeFileSync(globalPlansDir(), "not a directory");
  mkdirSync(join(instanceDir, "plans"), { recursive: true });
  writeFileSync(join(instanceDir, "plans", "keep.md"), "# keep\n");

  assert.doesNotThrow(() => setupClaudeInstance(providerId));

  assert.equal(lstatSync(join(instanceDir, "plans")).isSymbolicLink(), false);
  assert.equal(readFileSync(join(instanceDir, "plans", "keep.md"), "utf8"), "# keep\n");
  rmSync(globalPlansDir(), { force: true }); // restore a clean global path
});
