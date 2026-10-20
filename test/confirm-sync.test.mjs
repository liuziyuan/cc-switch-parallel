import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const { confirmSync } = await import("../src/drift.ts");

function fakeTTY({ isTTY = true, rawThrows = false } = {}) {
  const stdin = new EventEmitter();
  stdin.isTTY = isTTY;
  const rawModes = [];
  stdin.setRawMode = (v) => {
    rawModes.push(v);
    if (rawThrows && v === true) throw new Error("no raw mode");
  };
  let resumed = 0;
  let paused = 0;
  stdin.resume = () => {
    resumed++;
  };
  stdin.pause = () => {
    paused++;
  };
  const out = [];
  return {
    stdin,
    stdout: { isTTY, columns: 80 },
    stderr: { isTTY, columns: 80, write: (s) => out.push(s) },
    rawModes,
    out,
    counts: () => ({ resumed, paused }),
  };
}

test("confirmSync: y confirms and fully restores the terminal", async () => {
  const io = fakeTTY();
  const pending = confirmSync(["line one"], "Proceed?", io);
  io.stdin.emit("data", Buffer.from("y"));
  assert.equal(await pending, "yes");
  assert.deepEqual(io.rawModes, [true, false]);
  assert.equal(io.stdin.listenerCount("data"), 0);
  assert.equal(io.stdin.listenerCount("end"), 0);
  assert.equal(io.counts().paused, 1);
  assert.ok(io.out.join("").includes("Proceed?"));
});

test("confirmSync: any other key is no", async () => {
  const io = fakeTTY();
  const pending = confirmSync([], "?", io);
  io.stdin.emit("data", Buffer.from("n"));
  assert.equal(await pending, "no");
  assert.deepEqual(io.rawModes, [true, false]);
});

test("confirmSync: Ctrl-C is interrupt, not no", async () => {
  const io = fakeTTY();
  const pending = confirmSync([], "?", io);
  io.stdin.emit("data", Buffer.from("\x03"));
  assert.equal(await pending, "interrupt");
  assert.ok(io.out.join("").includes("^C"));
  assert.equal(io.stdin.listenerCount("data"), 0);
  assert.deepEqual(io.rawModes, [true, false]);
});

test("confirmSync: stdin EOF resolves eof instead of hanging", async () => {
  const io = fakeTTY();
  const pending = confirmSync([], "?", io);
  io.stdin.emit("end");
  assert.equal(await pending, "eof");
  assert.equal(io.stdin.listenerCount("end"), 0);
});

test("confirmSync: non-TTY returns no without touching raw mode", async () => {
  const io = fakeTTY({ isTTY: false });
  assert.equal(await confirmSync([], "?", io), "no");
  assert.deepEqual(io.rawModes, []);
});

test("confirmSync: a failing setRawMode still cleans up and returns no", async () => {
  const io = fakeTTY({ rawThrows: true });
  assert.equal(await confirmSync([], "?", io), "no");
  assert.equal(io.stdin.listenerCount("data"), 0);
  assert.equal(io.stdin.listenerCount("end"), 0);
});
