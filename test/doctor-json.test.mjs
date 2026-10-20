import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-launch-doctor-json-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
process.env.CC_LAUNCH_SKIP_MAIN = "1";

const { collectDoctorChecks, parseDoctorArgs, renderDoctorJson } = await import(
  "../src/commands/doctor.ts"
);

test("parseDoctorArgs: flags and unknown arguments", () => {
  assert.deepEqual(parseDoctorArgs([]), { json: false, fix: false, unknown: [] });
  assert.deepEqual(parseDoctorArgs(["--json"]), { json: true, fix: false, unknown: [] });
  assert.deepEqual(parseDoctorArgs(["--fix"]), { json: false, fix: true, unknown: [] });
  assert.deepEqual(parseDoctorArgs(["--json", "--fix", "x"]), {
    json: true,
    fix: true,
    unknown: ["x"],
  });
});

test("collectDoctorChecks: shape and JSON envelope", async () => {
  const checks = await collectDoctorChecks();
  assert.ok(checks.length > 0);
  for (const c of checks) {
    assert.equal(typeof c.label, "string");
    assert.equal(typeof c.pass, "boolean");
    assert.equal(typeof c.detail, "string");
  }
  const parsed = JSON.parse(renderDoctorJson(checks));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.summary.total, checks.length);
  assert.equal(parsed.summary.passed + parsed.summary.failed, checks.length);
  assert.equal(parsed.ok, parsed.summary.failed === 0);
  assert.equal(parsed.checks.length, checks.length);
});

function runDoctorProcess(args) {
  const entry = new URL("../src/commands/doctor.ts", import.meta.url).href;
  const script = [
    `process.env.CC_SWITCH_TEST_HOME = ${JSON.stringify(TEST_HOME)};`,
    `const { runDoctor } = await import(${JSON.stringify(entry)});`,
    `await runDoctor(${JSON.stringify(args)});`,
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        env: { ...process.env, CC_SWITCH_TEST_HOME: TEST_HOME },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("doctor --json: stdout is parseable, no ANSI, exit code matches ok", async () => {
  const r = await runDoctorProcess(["--json"]);
  assert.ok(!r.stdout.includes("\x1b"), "no ANSI in JSON output");
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.ok, r.code === 0, `exit code ${r.code} must match ok=${parsed.ok}`);
});

test("doctor --fix --json: accepted, parseable, fixes array, no ANSI", async () => {
  const r = await runDoctorProcess(["--fix", "--json"]);
  assert.ok(!r.stdout.includes("\x1b"), "no ANSI in JSON output");
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.fixes), "fixes is an array");
  assert.equal(parsed.ok, r.code === 0, `exit code ${r.code} must match ok=${parsed.ok}`);
});

test("doctor --fix text mode no longer reports not implemented", async () => {
  const r = await runDoctorProcess(["--fix"]);
  assert.ok(!/not implemented/.test(r.stdout + r.stderr));
  assert.match(r.stdout, /cc-switch-parallel doctor/);
});

test("doctor: unknown argument reports usage", async () => {
  const r = await runDoctorProcess(["--wat"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown argument/);
  assert.match(r.stderr, /Usage: switch doctor/);
});

test("doctor text mode keeps the existing banner", async () => {
  const r = await runDoctorProcess([]);
  assert.match(r.stdout, /cc-switch-parallel doctor/);
});
