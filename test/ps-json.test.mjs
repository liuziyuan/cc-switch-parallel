import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const testHome = mkdtempSync(join(tmpdir(), "cc-launch-ps-json-"));
process.env.CC_SWITCH_TEST_HOME = testHome;
process.env.CC_LAUNCH_SKIP_MAIN = "1";

const { collectRunningSessions, renderPsJson } = await import("../src/commands/ps.ts");
const { INSTANCES_DIR } = await import("../src/paths.ts");
const { psField } = await import("../src/sessions.ts");

const instanceDir = join(INSTANCES_DIR, "claude", "p1");
const sessionsDir = join(instanceDir, ".cc-switch-sessions");

function writeSession(pid, extra = {}) {
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, `${pid}-1.json`);
  writeFileSync(
    file,
    JSON.stringify({
      pid,
      lstart: extra.lstart === undefined ? psField(pid, "lstart") : extra.lstart,
      cli: "claude",
      providerId: "p1",
      startedAt: extra.startedAt ?? Date.now(),
      extraArgs: extra.extraArgs ?? [],
      tty: "ttys999",
      cwd: "/tmp/work",
    }),
  );
  return file;
}

function sleepChild() {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  return child;
}

test("collectRunningSessions: stable index, fields and sanitization", async (t) => {
  const older = sleepChild();
  const newer = sleepChild();
  t.after(() => {
    older.kill("SIGKILL");
    newer.kill("SIGKILL");
  });
  writeSession(older.pid, { startedAt: 1000, extraArgs: ["--continue"] });
  writeSession(newer.pid, { startedAt: 2000, extraArgs: ["--flag\u001b[31m"] });

  const rows = collectRunningSessions();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.index),
    [1, 2],
  );
  assert.equal(rows[0].pid, older.pid);
  assert.equal(rows[1].pid, newer.pid);
  assert.equal(rows[0].status, "alive");
  assert.equal(rows[0].providerId, "p1");
  assert.equal(rows[0].cli, "claude");
  assert.equal(rows[0].cwd, "/tmp/work");
  assert.ok(rows[0].upMs >= 0);
  assert.ok(rows[0].startedAt > 0);
  assert.ok(!rows[1].extraArgs.join("").includes("\u001b"), "control characters stripped");

  const parsed = JSON.parse(renderPsJson(rows));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sessions.length, 2);
  assert.deepEqual(Object.keys(parsed.sessions[0]), [
    "index",
    "pid",
    "cli",
    "providerId",
    "name",
    "tmux",
    "tty",
    "cwd",
    "startedAt",
    "upMs",
    "extraArgs",
    "billingMember",
    "status",
  ]);
});

test("collectRunningSessions: unknown liveness stays visible", async (t) => {
  const child = sleepChild();
  t.after(() => child.kill("SIGKILL"));
  writeSession(child.pid, { lstart: null });
  const rows = collectRunningSessions();
  const row = rows.find((r) => r.pid === child.pid);
  assert.ok(row);
  assert.equal(row.status, "unknown");
});

test("collectRunningSessions: provably dead sessions are removed", async () => {
  const child = sleepChild();
  const file = writeSession(child.pid);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));

  const rows = collectRunningSessions();
  assert.equal(
    rows.some((r) => r.pid === child.pid),
    false,
  );
  assert.equal(existsSync(file), false, "dead session file cleaned up");
});

test("renderPsJson: empty envelope", () => {
  const parsed = JSON.parse(renderPsJson([]));
  assert.deepEqual(parsed, { version: 1, sessions: [] });
});
