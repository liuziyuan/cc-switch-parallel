import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// are evaluated at module load. Tests run in a fixed ORDER (node:test is
// serial within a file) because the global ~/.codex/auth.json state seeded
// by the OAuth test is exactly what later tests must observe.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-auth-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { __test } = await import("../bin/cc-launch.mjs");
const { APP_ADAPTERS } = __test;
const codex = APP_ADAPTERS.codex;

const CC = join(testHome, ".cc-switch");
const GLOBAL_AUTH = join(testHome, ".codex", "auth.json");

function freshInstance(id) {
  const dir = join(CC, "instances", "codex", id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function prepareAuth(dir, auth, settings = {}) {
  codex.prepare(dir, "auth-probe", { config: 'model = "gpt-5"\n', auth }, {}, "custom", "", settings);
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

test("API-key credentials: independent real file, never a link", () => {
  rmSync(join(testHome, ".codex"), { recursive: true, force: true });
  const dir = freshInstance("probe-apikey");
  prepareAuth(dir, { OPENAI_API_KEY: "sk-123" });
  const p = join(dir, "auth.json");
  assert.equal(isSymlink(p), false, "API-key auth must stay a per-instance real file");
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { OPENAI_API_KEY: "sk-123" });
  assert.equal(existsSync(GLOBAL_AUTH), false, "API-key flow must not touch the global file");
});

test("OAuth credentials with no global file: seed it, then symlink (claude .credentials.json shape)", () => {
  rmSync(join(testHome, ".codex"), { recursive: true, force: true });
  const dir = freshInstance("probe-oauth");
  const auth = { auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } };
  prepareAuth(dir, auth);
  const p = join(dir, "auth.json");
  assert.equal(isSymlink(p), true, "OAuth auth must be a symlink to the shared global file");
  assert.deepEqual(JSON.parse(readFileSync(GLOBAL_AUTH, "utf8")), auth, "global file seeded from DB login material");
  // the instance file resolves to the SAME bytes — one live copy
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), auth);
});

test("OAuth credentials with a global file present: link, never overwrite the seed", () => {
  // The previous test seeded the global file. Rewrite it to simulate a
  // CLI-rotated token and confirm prepare does NOT resurrect the DB copy.
  writeFileSync(GLOBAL_AUTH, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "rotated", refresh_token: "r2" } }, null, 2));
  const dir = freshInstance("probe-oauth2");
  prepareAuth(dir, { auth_mode: "chatgpt", tokens: { access_token: "stale-db", refresh_token: "old" } });
  const p = join(dir, "auth.json");
  assert.equal(isSymlink(p), true);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")).tokens, { access_token: "rotated", refresh_token: "r2" }, "rotation survives prepare");
});

test("preserveCodexOfficialAuthOnSwitch: legacy per-instance behavior, no linking", () => {
  const dir = freshInstance("probe-preserve");
  const auth = { auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } };
  prepareAuth(dir, auth, { preserveCodexOfficialAuthOnSwitch: true });
  const p = join(dir, "auth.json");
  assert.equal(isSymlink(p), false, "opt-out keeps the legacy independent file");
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), auth);
});

test("no credentials at all: share the global if it exists, else an empty object", () => {
  // global exists at this point (seeded earlier) → symlink
  const dirShare = freshInstance("probe-empty-share");
  prepareAuth(dirShare, {});
  assert.equal(isSymlink(join(dirShare, "auth.json")), true);

  // global removed → plain empty file
  rmSync(GLOBAL_AUTH, { force: true });
  const dirEmpty = freshInstance("probe-empty-file");
  prepareAuth(dirEmpty, {});
  const p = join(dirEmpty, "auth.json");
  assert.equal(isSymlink(p), false);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), {});
});
