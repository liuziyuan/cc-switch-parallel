import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const testHome = mkdtempSync(join(tmpdir(), "cc-launch-ps-actions-"));
process.env.CC_SWITCH_TEST_HOME = testHome;
process.env.CC_LAUNCH_SKIP_MAIN = "1";

const { attachSession, killSession, parsePsArgs, resolveSessionTarget } = await import("../src/commands/ps.ts");
const { psField } = await import("../src/sessions.ts");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitExit(child) {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function makeRow(pid, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cc-launch-kill-row-"));
  const path = join(dir, `${pid}.json`);
  writeFileSync(path, "{}");
  return {
    index: 1,
    path,
    inst: { name: "p1", appType: "claude", path: dir },
    session: { pid, lstart: psField(pid, "lstart"), startedAt: Date.now() },
    status: "alive",
    pid,
    cli: "claude",
    providerId: "p1",
    name: "Provider",
    billingMember: null,
    tmux: null,
    tty: null,
    cwd: null,
    startedAt: Date.now(),
    upMs: 0,
    extraArgs: [],
    ...overrides,
  };
}

test("parsePsArgs: modes, flags and errors", () => {
  assert.deepEqual(parsePsArgs([]), { mode: "table" });
  assert.deepEqual(parsePsArgs(["--json"]), { mode: "json" });
  assert.deepEqual(parsePsArgs(["kill", "#2"]), { mode: "kill", target: "#2", force: false });
  assert.deepEqual(parsePsArgs(["kill", "--force", "1"]), { mode: "kill", target: "1", force: true });
  assert.deepEqual(parsePsArgs(["attach", "1"]), { mode: "attach", target: "1" });
  assert.match(parsePsArgs(["kill"]).error, /exactly one target/);
  assert.match(parsePsArgs(["kill", "1", "2"]).error, /exactly one target/);
  assert.match(parsePsArgs(["attach"]).error, /exactly one index/);
  assert.match(parsePsArgs(["--wat"]).error, /unknown argument/);
});

test("resolveSessionTarget: #N, pid:N, bare numbers and errors", () => {
  const rows = [
    { index: 1, pid: 100 },
    { index: 2, pid: 200 },
  ];
  assert.equal(resolveSessionTarget(rows, "#2").row, rows[1]);
  assert.equal(resolveSessionTarget(rows, "pid:100").row, rows[0]);
  assert.equal(resolveSessionTarget(rows, "1").row, rows[0]);
  assert.equal(resolveSessionTarget(rows, "100").row, rows[0], "bare out-of-range number falls back to pid");
  assert.equal(resolveSessionTarget(rows, "#9").ok, false);
  assert.equal(resolveSessionTarget(rows, "9").ok, false);
  assert.match(resolveSessionTarget(rows, "abc").error, /invalid target/);
  assert.match(resolveSessionTarget([], "1").error, /no running sessions/);
});

test("killSession --force: SIGKILL and session file removal", async (t) => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const row = makeRow(child.pid);
  const exited = waitExit(child);
  const result = await killSession(row, { force: true, killTimeoutMs: 2000 });
  assert.equal(result.ok, true, result.detail);
  const { signal } = await exited;
  assert.equal(signal, "SIGKILL");
  assert.equal(existsSync(row.path), false);
});

test("killSession: SIGTERM exits a cooperative process", async (t) => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const row = makeRow(child.pid);
  const exited = waitExit(child);
  const result = await killSession(row, {
    isTTY: true,
    confirm: async () => true,
    termTimeoutMs: 2000,
  });
  assert.equal(result.ok, true, result.detail);
  const { signal } = await exited;
  assert.equal(signal, "SIGTERM");
  assert.equal(existsSync(row.path), false);
});

test("killSession: escalates to SIGKILL when SIGTERM is ignored", async (t) => {
  const child = spawn(process.execPath, [
    "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  ], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  await sleep(150);
  const row = makeRow(child.pid);
  const exited = waitExit(child);
  const result = await killSession(row, {
    isTTY: true,
    confirm: async () => true,
    termTimeoutMs: 300,
    killTimeoutMs: 2000,
  });
  assert.equal(result.ok, true, result.detail);
  const { signal } = await exited;
  assert.equal(signal, "SIGKILL");
});

test("killSession: refuses unverifiable identities and invalid pids", async (t) => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => {
    try { child.kill("SIGKILL"); } catch {}
  });
  // A stale lstart means PID reuse: the recorded session is provably dead,
  // so it is never signaled (the row is cleaned up instead).
  const reused = makeRow(child.pid, {
    session: { pid: child.pid, lstart: "Thu Jan  1 00:00:00 1970" },
  });
  const mismatch = await killSession(reused, { force: true });
  assert.equal(mismatch.ok, true, mismatch.detail);
  assert.match(mismatch.detail, /already exited/);
  assert.equal(child.exitCode, null, "process was not signaled");

  const unknown = makeRow(child.pid, { session: { pid: child.pid, lstart: null } });
  const unknownResult = await killSession(unknown, { force: true });
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.detail, /cannot verify process identity/);

  const self = await killSession(makeRow(process.pid), { force: true });
  assert.equal(self.ok, false);
  assert.match(self.detail, /not a valid session pid/);

  const init = await killSession(makeRow(1), { force: true });
  assert.equal(init.ok, false);
});

test("killSession: non-TTY without --force is refused", async (t) => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const row = makeRow(child.pid);
  const result = await killSession(row, { isTTY: false });
  assert.equal(result.ok, false);
  assert.match(result.detail, /interactive terminal/);
  assert.equal(child.exitCode, null);
});

test("killSession: already-exited session is acknowledged", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const row = makeRow(child.pid);
  child.kill("SIGKILL");
  await waitExit(child);
  const result = await killSession(row, { force: true });
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /already exited/);
  assert.equal(existsSync(row.path), false);
});

function paneLookup() {
  return {
    ok: true,
    panes: new Map([["ttys001", { session: "main", paneId: "%1", windowIndex: "0", paneIndex: "0" }]]),
  };
}

test("attachSession inside tmux: switch-client then select-pane", () => {
  const calls = [];
  const row = makeRow(process.pid, { tty: "ttys001" });
  const result = attachSession(row, {
    insideTmux: true,
    lookup: paneLookup(),
    runTmux: (argv) => { calls.push(argv); return { status: 0 }; },
  });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(calls, [
    ["switch-client", "-t", "main"],
    ["select-pane", "-t", "%1"],
  ]);
});

test("attachSession outside tmux: select-window, select-pane then attach-session", () => {
  const calls = [];
  const row = makeRow(process.pid, { tty: "ttys001" });
  const result = attachSession(row, {
    insideTmux: false,
    isTTY: true,
    lookup: paneLookup(),
    runTmux: (argv) => { calls.push(argv); return { status: 0 }; },
  });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(calls, [
    ["select-window", "-t", "main:0"],
    ["select-pane", "-t", "%1"],
    ["attach-session", "-t", "main"],
  ]);
});

test("attachSession: missing pane, missing tmux and non-TTY errors", () => {
  const row = makeRow(process.pid, { tty: "ttys999" });
  const missing = attachSession(row, { insideTmux: true, lookup: paneLookup(), runTmux: () => ({ status: 0 }) });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /not running inside tmux/);

  const noTmux = attachSession(row, { lookup: { ok: false, reason: "notFound" } });
  assert.equal(noTmux.ok, false);
  assert.match(noTmux.detail, /tmux not found/);

  const calls = [];
  const nonTTY = attachSession(makeRow(process.pid, { tty: "ttys001" }), {
    insideTmux: false,
    isTTY: false,
    lookup: paneLookup(),
    runTmux: (argv) => { calls.push(argv); return { status: 0 }; },
  });
  assert.equal(nonTTY.ok, false);
  assert.match(nonTTY.detail, /interactive terminal/);
  assert.deepEqual(calls, []);
});

test("attachSession: tmux command failure propagates stderr", () => {
  const row = makeRow(process.pid, { tty: "ttys001" });
  const result = attachSession(row, {
    insideTmux: true,
    lookup: paneLookup(),
    runTmux: (argv) => (argv[0] === "switch-client"
      ? { status: 1, stderr: "no client\n" }
      : { status: 0 }),
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /switch-client failed/);
  assert.match(result.detail, /no client/);
});
