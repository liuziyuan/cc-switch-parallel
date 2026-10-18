import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-claude-model-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { __test } = await import("../bin/cc-launch.mjs");
const {
  buildClaudeEffectiveSettings,
  claudeInstanceSettingsPath,
  isClaudeRuntimeStatePath,
  APP_ADAPTERS,
} = __test;

const CC = join(testHome, ".cc-switch");
const claude = APP_ADAPTERS.claude;

// Seed an instance settings.json the way the Claude CLI would have left it
// after an in-session /model pick.
function seedInstance(id, doc, raw) {
  const dir = join(CC, "instances", "claude", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), raw ?? JSON.stringify(doc));
  return dir;
}

// providerName stays undefined in these unit tests so the statusline
// injection (global-settings read + wrapper write) stays out of the way; the
// carry only needs providerId, matching its production guard.
function buildFor(id, settingsConfig, commonSnippet) {
  return buildClaudeEffectiveSettings(
    settingsConfig, { commonConfigEnabled: true }, commonSnippet, undefined, id,
  );
}

// ─── carry: the instance's /model pick survives regeneration ────────────

test("claude model carry: instance file wins over provider base AND common", () => {
  seedInstance("p-carry", { env: { A: "1" }, model: "from-instance" });
  const effective = buildFor(
    "p-carry",
    { model: "from-provider", env: { A: "1" } },
    JSON.stringify({ model: "from-common", env: { A: "1" } }),
  );
  assert.equal(effective.model, "from-instance");
});

test("claude model carry: aggregation siblings keep independent models", () => {
  seedInstance("p-sib-a", { model: "model-a" });
  seedInstance("p-sib-b", { model: "model-b" });
  const common = JSON.stringify({ model: "from-common" });
  const base = { model: "base" };
  assert.equal(buildFor("p-sib-a", base, common).model, "model-a");
  assert.equal(buildFor("p-sib-b", base, common).model, "model-b");
});

test("claude model carry: fresh instance (no file yet) uses the generated initial value", () => {
  // no seedInstance — the common/provider value stands on first prepare
  const effective = buildFor(
    "p-fresh",
    { model: "base" },
    JSON.stringify({ model: "from-common" }),
  );
  assert.equal(effective.model, "from-common");
});

// ─── carry fail-safety: a broken disk must never break prepare ──────────

test("claude model carry: fail-safe when file missing / corrupt / model non-string", () => {
  // corrupt JSON on disk
  seedInstance("p-corrupt", null, "{not json");
  assert.equal(buildFor("p-corrupt", { model: "base" }, "").model, "base");
  // non-string model on disk must not clobber the generated value
  seedInstance("p-num", { model: 42 });
  assert.equal(buildFor("p-num", { model: "base" }, "").model, "base");
  // empty-string model on disk likewise
  seedInstance("p-empty", { model: "" });
  assert.equal(buildFor("p-empty", { model: "base" }, "").model, "base");
});

test("claude model carry: providerId undefined skips the carry entirely", () => {
  const effective = buildClaudeEffectiveSettings(
    { model: "base" }, {}, "", undefined, undefined,
  );
  assert.equal(effective.model, "base");
});

// ─── runtime-state filter predicate ─────────────────────────────────────

test("isClaudeRuntimeStatePath: exact model only, modelPicker untouched", () => {
  assert.equal(isClaudeRuntimeStatePath("model"), true);
  for (const p of [
    "modelPicker",
    "modelPicker.options",
    "modelPicker.replaceBuiltInOptions",
    "env",
    "models",
    "model_x",
  ]) assert.equal(isClaudeRuntimeStatePath(p), false, p);
});

// ─── upward drift: model is filtered, real config edits still surface ───
// Real sqlite DB (same sqlite3 CLI the tool uses): queryCommonConfig throws
// on a fixture home with no DB (sqlite3 creates an empty file → "no such
// table" → exit 1 → throw), and that call sits OUTSIDE the per-instance try
// in detectConfigDriftGeneric — so this schema fixture is load-bearing.

test("claude drift: model-only diff yields NO drift; env diff still surfaces (control)", () => {
  mkdirSync(CC, { recursive: true });
  const DB = join(CC, "cc-switch.db");
  const sql = (s) => execFileSync("sqlite3", [DB, ".timeout 3000", s], { encoding: "utf8" });
  sql(`CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
    created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0, provider_type TEXT,
    PRIMARY KEY (id, app_type));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
  sql(`INSERT OR REPLACE INTO settings (key, value) VALUES ('common_config_claude', '{}');`);
  // The provider row must exist for the split to route the control edit.
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, category, meta)
    VALUES ('p-drift', 'claude', 'Drift', '${JSON.stringify({ env: { A: "1" } }).replace(/'/g, "''")}',
    'custom', '{}');`);

  const id = "p-drift";
  const dir = join(CC, "instances", "claude", id);
  mkdirSync(dir, { recursive: true });
  const baseline = { model: "old", env: { A: "1" } };
  const state = {
    instances: { claude: { [id]: { commonHash: "x", preparedAt: 1, preparedSettings: baseline } } },
  };

  // In-session /model switch: the ONLY diff is model → filtered → null drift.
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "new", env: { A: "1" } }));
  assert.equal(claude.detectSettingsDrift(state), null, "model-only diff must not drift");

  // Control: same harness, env.A changed → drift fires, patches carry env
  // only. Proves the null above is the runtime-state filter doing its job,
  // not the pipeline being broken.
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "new", env: { A: "2" } }));
  const drift = claude.detectSettingsDrift(state);
  assert.ok(drift, "env edit must still drift (control)");
  assert.deepEqual(drift.commonPatch, {});
  assert.equal(drift.providerPatches[id].env.A, "2");
  assert.equal(drift.providerPatches[id].model, undefined, "model must never ride along");
});

// ─── guard: model edits yield to the runtime-state filter — silent ──────

test("claudeInstanceSettingsPath: same derivation as prepare/launch instance dirs", () => {
  assert.equal(
    claudeInstanceSettingsPath("p-x"),
    join(CC, "instances", "claude", "p-x", "settings.json"),
  );
});
