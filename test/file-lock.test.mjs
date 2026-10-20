import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const { withFileLockSync } = await import("../src/file-lock.ts");

function tmpTarget() {
  const dir = mkdtempSync(join(tmpdir(), "cc-switch-lock-"));
  return join(dir, "state.json");
}

test("acquire: runs the callback, holds the lock, releases afterwards", () => {
  const target = tmpTarget();
  const lock = `${target}.lock`;
  const r = withFileLockSync(target, () => {
    assert.ok(existsSync(lock), "lock exists inside the critical section");
    return 42;
  });
  assert.deepEqual(r, { acquired: true, value: 42 });
  assert.equal(existsSync(lock), false);
});

test("reentrant: an inner call must not release the outer lock", () => {
  const target = tmpTarget();
  const lock = `${target}.lock`;
  const r = withFileLockSync(target, () => {
    const inner = withFileLockSync(target, () => 7);
    assert.deepEqual(inner, { acquired: true, value: 7 });
    assert.ok(existsSync(lock), "inner release keeps the outer lock");
    return 9;
  });
  assert.deepEqual(r, { acquired: true, value: 9 });
  assert.equal(existsSync(lock), false);
});

test("stale: a lock whose owner pid is gone is reclaimed", () => {
  const target = tmpTarget();
  writeFileSync(
    `${target}.lock`,
    JSON.stringify({
      pid: 999999,
      host: hostname(),
      createdAt: Date.now(),
      nonce: "dead",
    }),
  );
  const r = withFileLockSync(target, () => "ok");
  assert.deepEqual(r, { acquired: true, value: "ok" });
  assert.equal(existsSync(`${target}.lock`), false);
});

test("stale: an mtime-expired lock is reclaimed even if the pid is alive", () => {
  const target = tmpTarget();
  const lock = `${target}.lock`;
  writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      createdAt: 0,
      nonce: "old",
    }),
  );
  const past = new Date(Date.now() - 31_000);
  utimesSync(lock, past, past);
  const r = withFileLockSync(target, () => "ok", { staleMs: 30_000 });
  assert.deepEqual(r, { acquired: true, value: "ok" });
  assert.equal(existsSync(lock), false);
});

test("timeout: another process holding the lock makes the call skip", async () => {
  const target = tmpTarget();
  const entry = new URL("../src/file-lock.ts", import.meta.url).href;
  const script = [
    `const { withFileLockSync } = await import(${JSON.stringify(entry)});`,
    `withFileLockSync(${JSON.stringify(target)}, () => {`,
    `  process.stdout.write("locked\\n");`,
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);`,
    `});`,
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
    });
    const r = withFileLockSync(target, () => "should not run", { timeoutMs: 100 });
    assert.deepEqual(r, { acquired: false, reason: "timeout" });
  } finally {
    await new Promise((resolve) => child.once("exit", resolve));
  }
  assert.equal(existsSync(`${target}.lock`), false, "the holder removed its lock");
});

test("release: a lock replaced by another owner is not deleted", () => {
  const target = tmpTarget();
  const lock = `${target}.lock`;
  withFileLockSync(target, () => {
    unlinkSync(lock);
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        createdAt: Date.now(),
        nonce: "other-owner",
      }),
    );
  });
  assert.equal(existsSync(lock), true, "nonce mismatch preserves the new owner's lock");
  unlinkSync(lock);
});
