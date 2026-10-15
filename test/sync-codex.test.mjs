import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

// End-to-end fixture: a throwaway HOME with a REAL sqlite DB (via the same
// sqlite3 CLI the tool uses) + instance dir + sync-state. Exercises the full
// codex field-channel loop — prepare → baseline → in-session edit → detect →
// smart split → CAS write-back — against a database, then the whole fixture
// is discarded. Nothing outside the temp dir is touched.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-sync-codex-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { __test } = await import("../bin/cc-launch.mjs");
const { APP_ADAPTERS } = __test;

const CC = join(testHome, ".cc-switch");
const DB = join(CC, "cc-switch.db");
const codex = APP_ADAPTERS.codex;
const claude = APP_ADAPTERS.claude;

function sql(statement) {
  return execFileSync("sqlite3", [DB, ".timeout 3000", statement], { encoding: "utf8" });
}

function rowJson(id) {
  return JSON.parse(sql(`SELECT settings_config FROM providers WHERE id='${id}' AND app_type='codex';`).trim());
}

function commonText() {
  return sql(`SELECT value FROM settings WHERE key='common_config_codex';`).trim();
}

function stateWith(id, preparedSettings) {
  return { instances: { codex: { [id]: { commonHash: "x", preparedAt: 1, preparedSettings } } } };
}

// Insert a codex provider row + run prepare into its instance dir. Each test
// gets its own provider id so DB state from an earlier test's write-back can
// never feed into a later test's split decisions.
function makeProvider(id, configToml) {
  mkdirSync(CC, { recursive: true });
  sql(`INSERT INTO providers (id, app_type, name, settings_config, category, meta)
    VALUES ('${id}', 'codex', '${id.toUpperCase()}',
    '${JSON.stringify({ config: configToml, auth: {} }).replace(/'/g, "''")}',
    'custom', '{"commonConfigEnabled": true}');`);
  const dir = join(CC, "instances", "codex", id);
  mkdirSync(dir, { recursive: true });
  codex.prepare(dir, id, { config: configToml, auth: {} }, { commonConfigEnabled: true }, "custom", commonText(), {});
  const baselineTree = codex.readInstanceSettingsSnapshot(dir);
  assert.ok(baselineTree, "snapshot after prepare must parse");
  return { dir, baselineTree };
}

let stderrBuf = "";
function captureStderr(fn) {
  stderrBuf = "";
  const orig = process.stderr.write;
  process.stderr.write = (s) => { stderrBuf += s; return true; };
  try { fn(); } finally { process.stderr.write = orig; }
}

test("codex field channel end-to-end: provider-direction write-back", () => {
  mkdirSync(CC, { recursive: true });
  sql(`CREATE TABLE providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
    created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0, provider_type TEXT,
    PRIMARY KEY (id, app_type));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  sql(`INSERT INTO settings (key, value) VALUES ('common_config_codex', 'model_context_window = 128000\n');`);

  const id = "p1";
  const { dir, baselineTree } = makeProvider(id, 'model = "gpt-5"\n');
  // prepare merged common over provider: both fields visible in the file
  assert.equal(baselineTree.model, "gpt-5");
  assert.equal(baselineTree.model_context_window, 128000);

  writeFileSync(join(CC, "sync-state.json"), JSON.stringify({
    version: 3, instances: { codex: stateWith(id, baselineTree).instances.codex },
  }));

  // In-session edit: the user changed the model.
  writeFileSync(join(dir, "config.toml"), stringifyToml({ ...baselineTree, model: "o4" }));

  const drift = codex.detectSettingsDrift(stateWith(id, baselineTree));
  assert.ok(drift, "drift must be detected");
  assert.equal(drift.instances.length, 1);
  assert.ok(drift.providerPatches[id], "model is not in common → provider direction");
  assert.equal(drift.providerPatches[id].model, "o4");

  captureStderr(() => codex.syncSettingsBack(drift));
  assert.equal(stderrBuf.includes("✗"), false, `write-back should succeed, got: ${stderrBuf}`);

  const updated = rowJson(id);
  const parsed = parseToml(updated.config);
  assert.equal(parsed.model, "o4");
  // the write-back patches ONLY the provider's own config document; the
  // common-owned field never leaks INTO the provider row…
  assert.equal(parsed.model_context_window, undefined);
  // …and the JSON envelope (auth) passes through untouched.
  assert.ok("auth" in updated);
});

test("codex field channel end-to-end: common-direction write-back", () => {
  const id = "p2";
  const { dir, baselineTree } = makeProvider(id, 'model = "gpt-5"\n');

  // In-session edit: change a COMMON-owned field and the provider-side model.
  writeFileSync(join(dir, "config.toml"), stringifyToml({
    ...baselineTree,
    model: "o4",
    model_context_window: 98000,
  }));

  const drift = codex.detectSettingsDrift(stateWith(id, baselineTree));
  assert.ok(drift);
  assert.deepEqual(drift.commonPatch, { model_context_window: 98000 });
  assert.equal(drift.providerPatches[id].model, "o4");

  captureStderr(() => codex.syncSettingsBack(drift));
  assert.equal(stderrBuf.includes("✗"), false);

  // common TOML in the settings table got the change via the real SQL CAS path
  assert.equal(parseToml(commonText()).model_context_window, 98000);
  // provider row holds its own change too
  assert.equal(parseToml(rowJson(id).config).model, "o4");
});

test("codex field channel: sensitive change in common-held subtree is rejected, DB untouched", () => {
  const id = "p3";
  const dir = join(CC, "instances", "codex", id);
  mkdirSync(dir, { recursive: true });
  // The provider row must exist for the vote winner to be considered at all.
  sql(`INSERT INTO providers (id, app_type, name, settings_config, category, meta)
    VALUES ('p3', 'codex', 'P3', '{}', 'custom', '{}');`);

  // The sensitive gate's jurisdiction: a path COMMON already holds. A
  // brand-new key routes provider-ward (pathExists is false), so the fixture
  // CHANGES an existing sensitive value — the exact "user retypes a rotated
  // token in-session" scenario the gate exists for.
  const baselineTree = { model: "gpt-5", model_context_window: 98000, env: { A: "1", MY_API_TOKEN: "old-secret" } };
  writeFileSync(join(dir, "config.toml"), stringifyToml({
    ...baselineTree,
    env: { A: "1", MY_API_TOKEN: "new-secret" },
  }));

  // Give common the same subtree so the sensitive path exists there; the
  // provider row needs no aligned state — nothing gets written at all.
  sql(`UPDATE settings SET value = 'model_context_window = 98000\n[env]\nA = "1"\nMY_API_TOKEN = "old-secret"\n' WHERE key='common_config_codex';`);
  const before = commonText();

  const drift = codex.detectSettingsDrift(stateWith(id, baselineTree));
  assert.ok(drift, "all-rejected drift must still surface");
  assert.deepEqual(drift.rejected, ["env.MY_API_TOKEN"], "sensitive change must be blocked from common");
  assert.deepEqual(drift.commonPatch, {}, "no common write for the blocked path");
  assert.equal(drift.providerPatches[id], undefined, "blocked path does not leak to provider either");

  assert.equal(commonText(), before, "settings table untouched by the blocked path");
  assert.ok(!rowJson(id).config, "provider row untouched too (p3 never had a config to begin with)");

  // claude regression: same generic pipeline still runs for claude (no
  // claude instances in this fixture → null drift proves the scan works).
  assert.equal(claude.detectSettingsDrift(stateWith(id, baselineTree)), null);
});
