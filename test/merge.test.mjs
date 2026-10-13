import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CC_LAUNCH_SKIP_MAIN = "1";
const { __test } = await import("../bin/cc-launch.mjs");
const { mergeCommonOverProvider, jsonDeepMerge, deepEqualJson } = __test;

// mergeCommonOverProvider must reproduce the upstream Rust json_deep_merge
// (services/provider/live.rs@69ff69d^): objects recurse per source key;
// EVERY other shape — scalars, arrays, nulls, type mismatches — the SOURCE
// value wins outright ("common covers provider").

test("scalar overwrite: common wins on equal keys", () => {
  assert.deepEqual(mergeCommonOverProvider({ a: 1 }, { a: 2 }), { a: 2 });
});

test("array overwrite: arrays are atomic leaves, provider extras are lost", () => {
  assert.deepEqual(mergeCommonOverProvider({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
});

test("object vs null: null overwrites", () => {
  assert.deepEqual(mergeCommonOverProvider({ a: { x: 1 } }, { a: null }), { a: null });
});

test("object vs scalar: scalar overwrites", () => {
  assert.deepEqual(mergeCommonOverProvider({ a: { x: 1 } }, { a: 5 }), { a: 5 });
});

test("scalar vs object: object overwrites", () => {
  assert.deepEqual(mergeCommonOverProvider({ a: 5 }, { a: { x: 1 } }), { a: { x: 1 } });
});

test("provider-only keys survive", () => {
  assert.deepEqual(mergeCommonOverProvider({ a: 1, b: 2 }, { a: 9 }), { a: 9, b: 2 });
});

test("common-only keys are inserted", () => {
  assert.deepEqual(mergeCommonOverProvider({ a: 1 }, { c: 3 }), { a: 1, c: 3 });
});

test("deep nesting mixes recursion and insertion", () => {
  assert.deepEqual(
    mergeCommonOverProvider({ a: { b: { c: 1, d: 2 } } }, { a: { b: { c: 9 }, e: 8 } }),
    { a: { b: { c: 9, d: 2 }, e: 8 } },
  );
});

test("deep type mismatch overwrites at depth", () => {
  assert.deepEqual(mergeCommonOverProvider({ a: { b: { c: 1 } } }, { a: { b: "s" } }), {
    a: { b: "s" },
  });
});

test("non-object source: returns source (assign-back contract)", () => {
  assert.deepEqual(mergeCommonOverProvider({ a: 1 }, 42), 42);
});

test("non-object target: returns source", () => {
  assert.deepEqual(mergeCommonOverProvider(7, { a: 1 }), { a: 1 });
});

test("inserted values are cloned, not shared with source", () => {
  const source = { n: { x: 1 } };
  const out = mergeCommonOverProvider({}, source);
  out.n.x = 2;
  const out2 = mergeCommonOverProvider({}, source);
  assert.equal(out2.n.x, 1);
});

// Freeze the deliberate divergence: this function and jsonDeepMerge MUST
// disagree on conflict shapes. If someone "unifies" them, this test fails
// before the providerPatches accumulation (which relies on target-wins)
// silently inverts.
test("divergence from jsonDeepMerge is intentional and locked", () => {
  const t1 = { a: { x: 1 } };
  assert.deepEqual(mergeCommonOverProvider(t1, { a: "s" }), { a: "s" });
  const t2 = { a: { x: 1 } };
  assert.deepEqual(jsonDeepMerge(t2, { a: "s" }), { a: { x: 1 } });
});

// Baseline and runtime settings come from two separate JSON.parse calls, so
// equal arrays are never the same reference. deepEqualJson must compare them
// by content or every sync sees a phantom permissions.allow diff.
test("deepEqualJson: identical arrays from different parses are equal", () => {
  const a = JSON.parse('{"allow":["Bash(ls:*)","Read"]}');
  const b = JSON.parse('{"allow":["Bash(ls:*)","Read"]}');
  assert.equal(deepEqualJson(a.allow, b.allow), true);
  assert.equal(deepEqualJson(a, b), true);
});

test("deepEqualJson: arrays differ on length, order, or element content", () => {
  assert.equal(deepEqualJson([1, 2], [1, 2, 3]), false);
  assert.equal(deepEqualJson([1, 2], [2, 1]), false); // order-sensitive
  assert.equal(deepEqualJson([{ k: 1 }], [{ k: 2 }]), false); // nested objects compared
  assert.equal(deepEqualJson([{ k: 1 }], [{ k: 1 }]), true);
});
