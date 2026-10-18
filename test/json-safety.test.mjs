import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CC_SWITCH_TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-json-safety-"));

const { jsonDeepMerge, applyMergePatch, mergeCommonOverProvider } = await import("../src/json-utils.ts");
const { tomlDeepMerge } = await import("../src/toml-utils.ts");
const { buildNestedAssign, splitChangesByTarget } = await import("../src/upward.ts");

// JSON.parse creates "__proto__" as an OWN key. Every merge used `key in
// target`, which sees the inherited prototype and recurses into it —
// polluting Object.prototype. All writes must use own-key checks and skip
// prototype keys outright.
const EVIL = JSON.parse('{"__proto__":{"pwned":1},"constructor":{"prototype":{"x":2}},"safe":3}');

function assertClean() {
  assert.equal(({}).pwned, undefined, "Object.prototype must not gain pwned");
  assert.equal(Object.prototype.pwned, undefined);
  assert.equal(({}).x, undefined, "constructor.prototype must not gain x");
}

test("jsonDeepMerge: prototype keys are never written through", () => {
  const target = {};
  jsonDeepMerge(target, EVIL);
  assertClean();
  assert.equal(target.safe, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(target, "__proto__"), false);
});

test("applyMergePatch: prototype keys are never written through", () => {
  const target = {};
  applyMergePatch(target, EVIL);
  assertClean();
  assert.equal(target.safe, 3);
});

test("mergeCommonOverProvider: prototype keys are never written through", () => {
  const merged = mergeCommonOverProvider({}, EVIL);
  assertClean();
  assert.equal(merged.safe, 3);
});

test("tomlDeepMerge: prototype keys are never written through", () => {
  const target = {};
  tomlDeepMerge(target, EVIL);
  assertClean();
  assert.equal(target.safe, 3);
});

test("buildNestedAssign: refuses to build a patch through prototype segments", () => {
  const patch = {};
  buildNestedAssign(patch, "__proto__.polluted", 1, {}, ["__proto__", "polluted"]);
  assert.deepEqual(patch, {});
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("splitChangesByTarget: unsafe segments produce no patch", () => {
  const change = {
    path: "__proto__.polluted",
    op: "add",
    from: undefined,
    to: 1,
    segments: ["__proto__", "polluted"],
  };
  const out = splitChangesByTarget([change], "p1", {}, {}, {});
  assert.deepEqual(out.providerPatch, {});
  assert.deepEqual(out.commonPatch, {});
  assertClean();
});
