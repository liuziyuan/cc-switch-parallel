import process from "node:process";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const testHome = mkdtempSync(join(tmpdir(), "cc-launch-shared-write-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { APP_ADAPTERS } = await import("../src/adapters.ts");
const { applyClaudeLivePluginPatch, applyClaudeLiveSettingsFieldPatches, applyCodexLiveSettingsFieldPatches } = await import("../src/upward.ts");

const CC = join(testHome, ".cc-switch");
const DB = join(CC, "cc-switch.db");
const CLAUDE_LIVE = join(testHome, ".claude", "settings.json");
const CODEX_LIVE = join(testHome, ".codex", "config.toml");
const LIVE_BACKUPS = join(CC, "backups", "live");

function sql(statement) {
  return execFileSync("sqlite3", [DB, ".timeout 3000", statement], { encoding: "utf8" });
}

beforeEach(() => {
  mkdirSync(CC, { recursive: true });
  if (!existsSync(DB)) {
    execFileSync("sqlite3", [DB, "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);"]);
  }
  sql("PRAGMA user_version = 20; DELETE FROM settings;");
  rmSync(join(testHome, ".claude"), { recursive: true, force: true });
  rmSync(join(testHome, ".codex"), { recursive: true, force: true });
  rmSync(LIVE_BACKUPS, { recursive: true, force: true });
});

test("claude live write-back: patch lands in the global file, backup + mode preserved", () => {
  mkdirSync(join(testHome, ".claude"), { recursive: true });
  writeFileSync(CLAUDE_LIVE, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "old" }] }] },
    env: { ANTHROPIC_BASE_URL: "https://api.example", API_TIMEOUT_MS: "600000" },
  }, null, 2));
  chmodSync(CLAUDE_LIVE, 0o640);

  applyClaudeLiveSettingsFieldPatches({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "new" }] }] },
  }, {});

  const after = JSON.parse(readFileSync(CLAUDE_LIVE, "utf8"));
  assert.deepEqual(after.hooks.Stop, [{ hooks: [{ type: "command", command: "new" }] }]);
  assert.equal(after.env.ANTHROPIC_BASE_URL, "https://api.example", "untouched keys survive");
  assert.equal(statSync(CLAUDE_LIVE).mode & 0o777, 0o640, "file mode is preserved");
  const backups = readdirSync(join(LIVE_BACKUPS, "claude"));
  assert.ok(backups.some((n) => n.startsWith("settings.json.")), "a backup is written before the patch");
});

test("claude live plugin patch: enabledPlugins written to the global file", () => {
  mkdirSync(join(testHome, ".claude"), { recursive: true });
  writeFileSync(CLAUDE_LIVE, JSON.stringify({ enabledPlugins: { "foo@bar": true, "gone@bar": true } }));
  applyClaudeLivePluginPatch({ "foo@bar": false, "gone@bar": null });
  const after = JSON.parse(readFileSync(CLAUDE_LIVE, "utf8"));
  assert.deepEqual(after.enabledPlugins, { "foo@bar": false });
});

test("adapter dispatch: claude syncSettingsBack routes shared fields to live in live mode", () => {
  mkdirSync(join(testHome, ".claude"), { recursive: true });
  writeFileSync(CLAUDE_LIVE, JSON.stringify({ permissions: { allow: ["Bash"] } }));
  APP_ADAPTERS.claude.syncSettingsBack({
    sharedMode: "live",
    commonPatch: { permissions: { allow: ["Read"] } },
    providerPatches: {},
  });
  const after = JSON.parse(readFileSync(CLAUDE_LIVE, "utf8"));
  assert.deepEqual(after.permissions, { allow: ["Read"] });
});

test("codex live write-back: TOML patch lands in ~/.codex/config.toml", () => {
  mkdirSync(join(testHome, ".codex"), { recursive: true });
  writeFileSync(CODEX_LIVE, '# user comment\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n');
  applyCodexLiveSettingsFieldPatches({
    commonPatch: { approval_policy: "never" },
    providerPatches: {},
  });
  const after = readFileSync(CODEX_LIVE, "utf8");
  assert.match(after, /approval_policy = "never"/);
  assert.match(after, /sandbox_mode = "workspace-write"/);
  const backups = readdirSync(join(LIVE_BACKUPS, "codex"));
  assert.ok(backups.some((n) => n.startsWith("config.toml.")));
});

test("live write-back creates a missing global file instead of failing", () => {
  rmSync(join(testHome, ".claude"), { recursive: true, force: true });
  applyClaudeLiveSettingsFieldPatches({ permissions: { allow: ["Read"] } }, {});
  const after = JSON.parse(readFileSync(CLAUDE_LIVE, "utf8"));
  assert.deepEqual(after.permissions, { allow: ["Read"] });
});
