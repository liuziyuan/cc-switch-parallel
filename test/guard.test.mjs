import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (CC_SWITCH_DIR, SYNC_STATE_PATH, BACKUPS_DIR) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-guard-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { __test } = await import("../bin/cc-launch.mjs");
const {
  guardInstanceConfigBeforeOverwrite,
  deepEqualJson,
  APP_ADAPTERS,
} = __test;

const CC = join(testHome, ".cc-switch");
const BACKUPS = join(CC, "backups");
const syncStatePath = join(CC, "sync-state.json");

function writeState(appType, providerId, entry) {
  const state = { version: 3, instances: { [appType]: { [providerId]: entry } } };
  mkdirSync(CC, { recursive: true });
  writeFileSync(syncStatePath, JSON.stringify(state, null, 2));
}

function baselineOf(preparedSettings) {
  return { commonHash: "x", preparedAt: 1, preparedSettings };
}

// Sync capture of guard's stderr — the guard writes via process.stderr.write.
let stderrBuf = "";
function captureStderr(fn) {
  stderrBuf = "";
  const orig = process.stderr.write;
  process.stderr.write = (s) => { stderrBuf += s; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
}

function backupsFor(appType, providerId) {
  const dir = join(BACKUPS, appType, providerId);
  return existsSync(dir) ? readdirSync(dir) : [];
}

const claude = APP_ADAPTERS.claude;
const codex = APP_ADAPTERS.codex;

// ─── claude adapter (JSON config) ─────────────────────────────────────

test("guard claude: faithful mirror — silent, no backup", () => {
  const dir = join(CC, "instances", "claude", "p-mirror");
  mkdirSync(dir, { recursive: true });
  const doc = { env: { A: "1" } };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(doc));
  writeState("claude", "p-mirror", baselineOf(doc));
  captureStderr(() => guardInstanceConfigBeforeOverwrite(
    claude, { id: "p-mirror", name: "Mirror", settings_config: "{}", meta: "{}", category: "custom" },
    dir, "", {},
  ));
  assert.equal(stderrBuf.includes("⚠"), false);
  assert.deepEqual(backupsFor("claude", "p-mirror"), []);
});

test("guard claude: unsynced edit — warning + backup, max 10 kept", () => {
  const id = "p-edit";
  const dir = join(CC, "instances", "claude", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { A: "1", B: "2" } }));
  writeState("claude", id, baselineOf({ env: { A: "1" } }));
  // Pre-seed 11 old backups: the new one must push the oldest out (BACKUP_KEEP=10).
  const bdir = join(BACKUPS, "claude", id);
  mkdirSync(bdir, { recursive: true });
  for (let i = 1; i <= 11; i++) writeFileSync(join(bdir, `settings.json.2026010${i < 10 ? `0${i}` : i}-000000`), "{}");

  const row = { id, name: "Edited", settings_config: "{}", meta: "{}", category: "custom" };
  captureStderr(() => guardInstanceConfigBeforeOverwrite(claude, row, dir, "", {}));
  assert.equal(stderrBuf.includes("⚠"), true);
  assert.equal(stderrBuf.includes("env.B"), true); // path shown (the +/- mark carries ANSI color)
  const files = readdirSync(bdir).filter((n) => n.startsWith("settings.json."));
  assert.equal(files.length, 10);
});

test("guard claude: enabledPlugins edits yield to the plugin channel — silent", () => {
  const id = "p-plugin";
  const dir = join(CC, "instances", "claude", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    enabledPlugins: { "a@b": false },
    env: { A: "1" },
  }));
  writeState("claude", id, baselineOf({ enabledPlugins: { "a@b": true }, env: { A: "1" } }));
  const row = { id, name: "Plugin", settings_config: "{}", meta: "{}", category: "custom" };
  captureStderr(() => guardInstanceConfigBeforeOverwrite(claude, row, dir, "", {}));
  assert.equal(stderrBuf.includes("⚠"), false);
  assert.deepEqual(backupsFor("claude", id), []);
});

test("guard claude: in-session /model switch yields to the runtime-state filter — silent", () => {
  const id = "p-model";
  const dir = join(CC, "instances", "claude", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    model: "sonnet",
    env: { A: "1" },
  }));
  writeState("claude", id, baselineOf({ model: "opus", env: { A: "1" } }));
  const row = { id, name: "Model", settings_config: "{}", meta: "{}", category: "custom" };
  captureStderr(() => guardInstanceConfigBeforeOverwrite(claude, row, dir, "", {}));
  assert.equal(stderrBuf.includes("⚠"), false);
  assert.deepEqual(backupsFor("claude", id), []);
});

test("guard claude: no baseline + recompute equal — silent (self-healing backfill)", () => {
  const id = "p-backfill";
  const dir = join(CC, "instances", "claude", id);
  mkdirSync(dir, { recursive: true });
  const row = {
    id, name: "Backfill",
    settings_config: JSON.stringify({ env: { A: "1" } }),
    meta: "{}", category: "custom",
  };
  const effective = claude.computeEffectiveSettings(
    JSON.parse(row.settings_config), {}, row.category, "", id, {},
  );
  writeFileSync(join(dir, "settings.json"), JSON.stringify(effective));
  writeState("claude", id, { commonHash: "x", preparedAt: 1 }); // v2-shaped: no preparedSettings
  captureStderr(() => guardInstanceConfigBeforeOverwrite(claude, row, dir, "", {}));
  assert.equal(stderrBuf.includes("differs from"), false);
  assert.deepEqual(backupsFor("claude", id), []);
});

test("guard claude: no baseline + recompute differs — one silent backup + dim note", () => {
  const id = "p-ambig";
  const dir = join(CC, "instances", "claude", id);
  mkdirSync(dir, { recursive: true });
  const row = {
    id, name: "Ambiguous",
    settings_config: JSON.stringify({ env: { A: "1" } }),
    meta: "{}", category: "custom",
  };
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { A: "1", EXTRA: true } }));
  writeState("claude", id, { commonHash: "x", preparedAt: 1 });
  captureStderr(() => guardInstanceConfigBeforeOverwrite(claude, row, dir, "", {}));
  assert.equal(stderrBuf.includes("differs from the cc-switch config"), true);
  assert.equal(stderrBuf.includes("⚠"), false); // ambiguous window: never a loud warning
  assert.equal(backupsFor("claude", id).length, 1);
});

test("guard: adapter without C2/C3 capabilities is a no-op", () => {
  const dir = join(CC, "instances", "claude", "p-nocap");
  captureStderr(() => guardInstanceConfigBeforeOverwrite(
    { appType: "stub" }, { id: "p-nocap", name: "Stub", settings_config: "{}", meta: "{}" },
    dir, "", {},
  ));
  assert.equal(stderrBuf, "");
});

// ─── codex adapter (TOML config) ──────────────────────────────────────

test("guard codex: prepare-equivalent TOML round-trip compares equal (normalization contract)", () => {
  const id = "cx-roundtrip";
  const dir = join(CC, "instances", "codex", id);
  mkdirSync(dir, { recursive: true });
  const settingsConfig = { config: 'model = "gpt-5"\ndisable_response_storage = true\n' };
  const effective = codex.computeEffectiveSettings(settingsConfig, {}, "custom", "", id, {});
  assert.ok(effective, "computeEffectiveSettings must produce a semantic tree");
  // Simulate prepare: write the semantic tree back out as TOML — the file on
  // disk then differs OBJECT-wise from the baseline (fresh parse, maybe Date
  // instances) but must compare EQUAL after jsonNormalize.
  writeFileSync(join(dir, "config.toml"), stringifyToml(parseToml(stringifyToml(effective))));
  const snap = codex.readInstanceSettingsSnapshot(dir);
  assert.ok(snap);
  assert.equal(deepEqualJson(snap, effective), true);
  writeState("codex", id, baselineOf(effective));
  const row = { id, name: "RoundTrip", settings_config: JSON.stringify(settingsConfig), meta: "{}", category: "custom" };
  captureStderr(() => guardInstanceConfigBeforeOverwrite(codex, row, dir, "", {}));
  assert.equal(stderrBuf.includes("⚠"), false);
  assert.deepEqual(backupsFor("codex", id), []);
});

test("guard codex: unsynced config.toml edit — warning names the file + TOML backup", () => {
  const id = "cx-edit";
  const dir = join(CC, "instances", "codex", id);
  mkdirSync(dir, { recursive: true });
  const settingsConfig = { config: 'model = "gpt-5"\n' };
  const effective = codex.computeEffectiveSettings(settingsConfig, {}, "custom", "", id, {});
  writeFileSync(join(dir, "config.toml"), stringifyToml({ ...parseToml(stringifyToml(effective)), approval_policy: "never" }));
  writeState("codex", id, baselineOf(effective));
  const row = { id, name: "CxEdited", settings_config: JSON.stringify(settingsConfig), meta: "{}", category: "custom" };
  captureStderr(() => guardInstanceConfigBeforeOverwrite(codex, row, dir, "", {}));
  assert.equal(stderrBuf.includes("⚠ Instance config.toml"), true);
  assert.equal(stderrBuf.includes("approval_policy"), true);
  const files = backupsFor("codex", id).filter((n) => n.startsWith("config.toml."));
  assert.equal(files.length, 1);
});
