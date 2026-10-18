import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

process.env.CC_SWITCH_TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-liveness-"));

const { sessionLiveness, exitCodeFor, psField } = await import("../src/sessions.ts");

function spawnSleep() {
  return spawn("sleep", ["5"], { stdio: "ignore" });
}

function waitExit(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}

test("liveness: a live process with a matching lstart is alive", async () => {
  const child = spawnSleep();
  try {
    const lstart = psField(child.pid, "lstart");
    assert.ok(lstart, "ps lstart available");
    assert.equal(sessionLiveness({ pid: child.pid, lstart }), "alive");
  } finally {
    child.kill("SIGKILL");
    await waitExit(child);
  }
});

test("liveness: a live pid with a mismatched lstart is dead (PID reuse)", async () => {
  const child = spawnSleep();
  try {
    assert.equal(sessionLiveness({ pid: child.pid, lstart: "Mon Jan  1 00:00:00 2001" }), "dead");
  } finally {
    child.kill("SIGKILL");
    await waitExit(child);
  }
});

test("liveness: an exited process is dead", async () => {
  const child = spawnSleep();
  const pid = child.pid;
  const lstart = psField(pid, "lstart");
  child.kill("SIGKILL");
  await waitExit(child);
  assert.equal(sessionLiveness({ pid, lstart }), "dead");
});

test("liveness: unknown inputs are conservatively unknown", () => {
  assert.equal(sessionLiveness({ pid: 0 }), "unknown");
  assert.equal(sessionLiveness({ pid: -1 }), "unknown");
  assert.equal(sessionLiveness({ pid: 1.5 }), "unknown");
  assert.equal(sessionLiveness({}), "unknown");
  assert.equal(sessionLiveness(null), "unknown");
  // Live pid but no recorded start time: cannot prove anything.
  assert.equal(sessionLiveness({ pid: process.pid }), "unknown");
  // Nonexistent pid → ESRCH → provably dead.
  assert.equal(sessionLiveness({ pid: 999999, lstart: "x" }), "dead");
});

test("exitCodeFor: signal deaths map to 128 + signum", () => {
  assert.equal(exitCodeFor(0, null), 0);
  assert.equal(exitCodeFor(3, null), 3);
  assert.equal(exitCodeFor(null, "SIGINT"), 130);
  assert.equal(exitCodeFor(null, "SIGTERM"), 143);
  assert.equal(exitCodeFor(null, "SIGKILL"), 137);
  assert.equal(exitCodeFor(null, "NOT_A_SIGNAL"), 1);
  assert.equal(exitCodeFor(null, null), 1);
});
