import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-launch-doctor-fix-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_SHARED_SOURCE = "live";

const CC = join(TEST_HOME, ".cc-switch");
const DB = join(CC, "cc-switch.db");
const SYNC = join(CC, "sync-state.json");
const GLOBAL_DIR = join(TEST_HOME, ".claude");
const GLOBAL_MD = join(GLOBAL_DIR, "CLAUDE.md");
const GLOBAL_SETTINGS = join(GLOBAL_DIR, "settings.json");

mkdirSync(GLOBAL_DIR, { recursive: true });
mkdirSync(CC, { recursive: true });
writeFileSync(GLOBAL_SETTINGS, "{}");
execFileSync("sqlite3", [DB, `
  CREATE TABLE providers (
    id TEXT PRIMARY KEY, name TEXT, settings_config TEXT,
    category TEXT, meta TEXT, app_type TEXT
  );
  PRAGMA user_version = 20;
`]);

const { applyDoctorFixes, collectDoctorChecks } = await import("../src/commands/doctor.ts");
const { APP_ADAPTERS } = await import("../src/adapters.ts");
const { loadSettings } = await import("../src/db.ts");
const { readSharedConfig } = await import("../src/shared-config.ts");

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const instDir = (id) => join(CC, "instances", "claude", id);
const fixFor = (checks, fixId) => checks.find((c) => c.fixId === fixId);

function addProvider(id, name = id) {
  execFileSync("sqlite3", [
    DB,
    `INSERT OR REPLACE INTO providers (id,name,settings_config,category,meta,app_type)
     VALUES (${q(id)},${q(name)},'{}',NULL,'{}','claude');`,
  ]);
}

function writeSync(instances) {
  writeFileSync(SYNC, JSON.stringify({ version: 3, instances: { claude: instances } }, null, 2));
}

function providerSnapshot(id) {
  return execFileSync("sqlite3", [
    DB,
    `SELECT id||':'||name||':'||settings_config FROM providers WHERE id=${q(id)};`,
  ], { encoding: "utf8" }).trim();
}

test("fixes a broken instructions symlink, keeps user files, and is idempotent", async () => {
  const id = "p-link";
  mkdirSync(instDir(id), { recursive: true });
  writeFileSync(GLOBAL_MD, "# global\n");
  const link = join(instDir(id), "CLAUDE.md");
  symlinkSync(join(GLOBAL_DIR, "gone.md"), link);
  writeFileSync(join(instDir(id), "keep.txt"), "keep");

  const checks = await collectDoctorChecks();
  const c = fixFor(checks, `instructions-link:claude:${id}`);
  assert.ok(c, "broken link check present");
  assert.equal(c.pass, false);
  assert.equal(c.fixable, true);

  const fixes = applyDoctorFixes(checks);
  const f = fixes.find((x) => x.fixId === `instructions-link:claude:${id}`);
  assert.equal(f.status, "fixed");
  assert.equal(resolve(readlinkSync(link)), resolve(GLOBAL_MD));

  const after = await collectDoctorChecks();
  assert.equal(fixFor(after, `instructions-link:claude:${id}`), undefined);
  assert.equal(applyDoctorFixes(after).filter((x) => x.fixId.includes(id)).length, 0, "second pass is a no-op");
  assert.equal(readFileSync(join(instDir(id), "keep.txt"), "utf8"), "keep", "user file survives");
});

test("leaves a broken link unfixable while the global file is missing", async () => {
  rmSync(GLOBAL_MD, { force: true });
  const id = "p-link-missing";
  mkdirSync(instDir(id), { recursive: true });
  const link = join(instDir(id), "CLAUDE.md");
  symlinkSync(join(GLOBAL_DIR, "gone.md"), link);

  const checks = await collectDoctorChecks();
  const c = checks.find((x) => x.label === `claude instructions link "${id}"`);
  assert.ok(c && !c.pass);
  assert.notEqual(c.fixable, true, "cannot fix without a global target");
  assert.equal(applyDoctorFixes(checks).filter((x) => x.fixId.includes(id)).length, 0);
  assert.equal(existsSync(link), false, "broken link is left untouched");

  writeFileSync(GLOBAL_MD, "# global\n");
});

test("recreates a missing instance dir without running prepare or touching the DB", async () => {
  const id = "p-dir";
  addProvider(id, "P Dir");
  writeSync({ [id]: { preparedAt: Date.now(), sharedMode: "live", sharedHash: "x" } });
  assert.equal(existsSync(instDir(id)), false);
  const before = providerSnapshot(id);

  const checks = await collectDoctorChecks();
  const c = fixFor(checks, `instance-dir:claude:${id}`);
  assert.ok(c && !c.pass && c.fixable);

  const fixes = applyDoctorFixes(checks);
  assert.equal(fixes.find((x) => x.fixId === `instance-dir:claude:${id}`).status, "fixed");
  assert.ok(existsSync(instDir(id)), "instance dir recreated");
  assert.equal(existsSync(join(instDir(id), "settings.json")), false, "prepare was not run");
  assert.equal(providerSnapshot(id), before, "provider row unchanged");

  const after = await collectDoctorChecks();
  assert.equal(fixFor(after, `instance-dir:claude:${id}`), undefined);
});

test("backfills a baseline when the instance matches the effective config", async () => {
  const id = "p-base";
  addProvider(id, "P Base");
  writeSync({ [id]: { preparedAt: Date.now(), sharedMode: "live", sharedHash: "x" } });
  mkdirSync(instDir(id), { recursive: true });
  const effective = APP_ADAPTERS.claude.computeEffectiveSettings(
    {}, {}, null, readSharedConfig("claude"), id, loadSettings(), { writeWrapper: false },
  );
  writeFileSync(join(instDir(id), "settings.json"), JSON.stringify(effective, null, 2));

  const checks = await collectDoctorChecks();
  const c = fixFor(checks, `baseline:claude:${id}`);
  assert.ok(c && !c.pass, "baseline check present");
  assert.equal(c.fixable, true);

  const fixes = applyDoctorFixes(checks);
  assert.equal(fixes.find((x) => x.fixId === `baseline:claude:${id}`).status, "fixed");
  const state = JSON.parse(readFileSync(SYNC, "utf8"));
  assert.ok(state.instances.claude[id].preparedSettings, "preparedSettings recorded");

  const after = await collectDoctorChecks();
  assert.equal(fixFor(after, `baseline:claude:${id}`), undefined);
});

test("does not backfill a baseline over user-edited content", async () => {
  const id = "p-base-edit";
  addProvider(id, "P Edit");
  writeSync({ [id]: { preparedAt: Date.now(), sharedMode: "live", sharedHash: "x" } });
  mkdirSync(instDir(id), { recursive: true });
  const effective = APP_ADAPTERS.claude.computeEffectiveSettings(
    {}, {}, null, readSharedConfig("claude"), id, loadSettings(), { writeWrapper: false },
  );
  writeFileSync(join(instDir(id), "settings.json"), JSON.stringify({ ...effective, userEdit: "keep-me" }, null, 2));

  const checks = await collectDoctorChecks();
  const c = checks.find((x) => x.label === `claude instance baseline "${id}"`);
  assert.ok(c && !c.pass);
  assert.notEqual(c.fixable, true, "hand-edited content is not auto-fixable");
  assert.equal(applyDoctorFixes(checks).filter((x) => x.fixId === `baseline:claude:${id}`).length, 0);

  const state = JSON.parse(readFileSync(SYNC, "utf8"));
  assert.equal(state.instances.claude[id].preparedSettings, undefined, "no baseline written");
  assert.equal(JSON.parse(readFileSync(join(instDir(id), "settings.json"), "utf8")).userEdit, "keep-me");
});

test("reports a failed fix when the instance path is a regular file", async () => {
  const id = "p-blocked";
  addProvider(id, "P Blocked");
  writeSync({ [id]: { preparedAt: Date.now(), sharedMode: "live", sharedHash: "x" } });
  mkdirSync(join(CC, "instances", "claude"), { recursive: true });
  writeFileSync(instDir(id), "not a directory");

  const checks = await collectDoctorChecks();
  const c = fixFor(checks, `instance-dir:claude:${id}`);
  assert.ok(c && c.fixable);
  const fixes = applyDoctorFixes(checks);
  assert.equal(fixes.find((x) => x.fixId === `instance-dir:claude:${id}`).status, "failed");
  rmSync(instDir(id), { force: true });
});

test("does not resurrect a ghost baseline whose provider row is gone", async () => {
  writeSync({ "ghost-id": { preparedAt: 1, sharedMode: "live", sharedHash: "x" } });
  const checks = await collectDoctorChecks();
  assert.equal(fixFor(checks, "instance-dir:claude:ghost-id"), undefined);
});

test("unknown fix ids fail and non-fixable checks are left alone", () => {
  const fixes = applyDoctorFixes([
    { label: "bogus", pass: false, detail: "", fixable: true, fixId: "bogus:claude:x" },
    { label: "db", pass: false, detail: "" },
    { label: "ok", pass: true, detail: "", fixable: true, fixId: "instance-dir:claude:nope" },
  ]);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].status, "failed");
  assert.match(fixes[0].detail, /unknown fix id/);
});
