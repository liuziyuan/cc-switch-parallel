import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-clean-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
const INSTANCE_DIR = join(TEST_HOME, ".cc-switch", "instances", "claude", "live-provider");
mkdirSync(join(INSTANCE_DIR, ".cc-switch-sessions"), { recursive: true });
// A live pid (the test process) with no recorded lstart → conservative
// "unknown", which must block a clean exactly like "alive".
writeFileSync(
  join(INSTANCE_DIR, ".cc-switch-sessions", `${process.pid}-1.json`),
  JSON.stringify({
    pid: process.pid,
    lstart: null,
    cli: "claude",
    providerId: "live-provider",
    startedAt: Date.now(),
    extraArgs: [],
    cwd: "/tmp",
  }),
);

const { collectInstances, blockingSessions, assertCleanable } = await import(
  "../src/commands/doctor.ts"
);

test("clean guard: a live/unknown session blocks removal", () => {
  const instances = collectInstances();
  const blocked = blockingSessions(instances);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].status, "unknown");
  assert.equal(assertCleanable(instances, false), false);
  assert.equal(assertCleanable(instances, true), true);
});

test("clean --all refuses while a session is live; --force removes", async () => {
  const entry = new URL("../src/commands/doctor.ts", import.meta.url).href;
  const script = (args) =>
    [
      `process.env.CC_SWITCH_TEST_HOME = ${JSON.stringify(TEST_HOME)};`,
      `const { runClean } = await import(${JSON.stringify(entry)});`,
      `await runClean(${JSON.stringify(args)});`,
    ].join("\n");
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script(args)],
        {
          env: { ...process.env, CC_SWITCH_TEST_HOME: TEST_HOME },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (code) => resolve({ code, stderr }));
    });

  const refused = await run(["--all"]);
  assert.notEqual(refused.code, 0, "clean must fail while a session is live");
  assert.ok(existsSync(INSTANCE_DIR), "instance directory preserved");

  const forced = await run(["--all", "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal(existsSync(INSTANCE_DIR), false, "--force removes the instance");
});
