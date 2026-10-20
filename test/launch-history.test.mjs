import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CC_LAUNCH_SKIP_MAIN = "1";

const { stripOneShotFlags, healRecordedArgs } = await import("../src/history.ts");

// Quick-launch replays the recorded extraArgs verbatim. One-shot informational
// flags (`--version` etc.) print and exit — replaying them never enters the
// CLI, and each replay re-records the flag, so a single accidental
// `switch <p> claude --version` permanently poisons the quick-launch row
// (a real history file showed such a row at count 56). recordLaunch must
// strip them at the single write point; loadHistory heals already-poisoned
// files written by older versions.

test("strips a bare one-shot flag to empty argv", () => {
  assert.deepEqual(stripOneShotFlags(["--version"]), []);
  assert.deepEqual(stripOneShotFlags(["-v"]), []);
  assert.deepEqual(stripOneShotFlags(["-V"]), []);
  assert.deepEqual(stripOneShotFlags(["--help"]), []);
  assert.deepEqual(stripOneShotFlags(["-h"]), []);
});

test("keeps session-worthy flags untouched", () => {
  assert.deepEqual(stripOneShotFlags(["--continue"]), ["--continue"]);
  assert.deepEqual(stripOneShotFlags(["--resume", "abc"]), ["--resume", "abc"]);
});

test("strips one-shot flags out of a mixed argv", () => {
  assert.deepEqual(stripOneShotFlags(["--version", "--continue", "--help"]), ["--continue"]);
});

test("prompt text is an argv element, not a flag — survives", () => {
  // `-p` print mode itself is kept: it performs a real request; only the
  // informational flags are one-shot.
  assert.deepEqual(stripOneShotFlags(["-p", "version: --help me"]), ["-p", "version: --help me"]);
});

test("non-array argv normalizes to empty", () => {
  assert.deepEqual(stripOneShotFlags(undefined), []);
  assert.deepEqual(stripOneShotFlags(null), []);
  assert.deepEqual(stripOneShotFlags("x"), []);
});

test("healRecordedArgs strips poisoned entries in place and reports dirty", () => {
  const entries = [
    { cli: "claude", providerId: "a", extraArgs: ["--version"] },
    { cli: "claude", providerId: "b", extraArgs: ["--continue"] },
    { cli: "codex", providerId: "c", extraArgs: [] },
  ];
  assert.equal(healRecordedArgs(entries), true);
  assert.deepEqual(entries[0].extraArgs, []);
  assert.deepEqual(entries[1].extraArgs, ["--continue"]); // untouched
  assert.deepEqual(entries[2].extraArgs, []);
});

test("healRecordedArgs on clean history reports clean", () => {
  const entries = [{ cli: "claude", providerId: "a", extraArgs: ["--continue"] }];
  assert.equal(healRecordedArgs(entries), false);
  assert.deepEqual(entries[0].extraArgs, ["--continue"]);
});

test("healRecordedArgs tolerates junk entries and non-array input", () => {
  assert.equal(healRecordedArgs(undefined), false);
  assert.equal(healRecordedArgs([null, {}, { extraArgs: "junk" }]), false);
});
