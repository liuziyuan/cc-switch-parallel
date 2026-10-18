import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CC_LAUNCH_SKIP_MAIN = "1";
const { __test } = await import("../bin/cc-launch.mjs");
const { mergeCommonOverProvider, jsonDeepMerge, deepEqualJson, foldRemovalPatch, diffSettingsLeaves, parseJsonObject, buildClaudeEffectiveSettings } = __test;

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

// ─── diffSettingsLeaves: no removal folding ────────────────────────────
// Deleting ONE key of a subtree must diff as that leaf only — folding used
// to collapse it into a whole-subtree remove, and the {parent:null} patch
// then wiped untouched siblings from common_config (unrecoverable: the DB
// row has no backup).

test("diffSettingsLeaves: deleting one key of a subtree stays a leaf remove", () => {
  const baseline = { env: { TOKEN: "t", KEEP_ME: "v" } };
  const current = { env: { KEEP_ME: "v" } };
  assert.deepEqual(diffSettingsLeaves(baseline, current), [
    { path: "env.TOKEN", op: "remove", from: "t", to: undefined, segments: ["env", "TOKEN"] },
  ]);
});

test("diffSettingsLeaves: mixed add/remove inside one subtree stays per-leaf", () => {
  const baseline = { env: { A: 1 } };
  const current = { env: { B: 2 } };
  assert.deepEqual(diffSettingsLeaves(baseline, current), [
    { path: "env.A", op: "remove", from: 1, to: undefined, segments: ["env", "A"] },
    { path: "env.B", op: "add", from: undefined, to: 2, segments: ["env", "B"] },
  ]);
});

// ─── malformed DB values: degrade, never write a corrupt instance ──────
// A settings_config column that parses to null/[]/a scalar used to flow
// through prepare into settings.json ("null", "[]", a quoted JSON string).

test("parseJsonObject: empty is legitimately {}, malformed/non-object is null", () => {
  assert.deepEqual(parseJsonObject(undefined), {});
  assert.deepEqual(parseJsonObject(null), {});
  assert.deepEqual(parseJsonObject(""), {});
  assert.deepEqual(parseJsonObject("   "), {});
  assert.deepEqual(parseJsonObject("{}"), {});
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.equal(parseJsonObject("null"), null);
  assert.equal(parseJsonObject("[]"), null);
  assert.equal(parseJsonObject("123"), null);
  assert.equal(parseJsonObject('"{}"'), null); // a JSON string, not an object
  assert.equal(parseJsonObject("{bad"), null);
  assert.equal(parseJsonObject([1, 2]), null);
});

test("buildClaudeEffectiveSettings: non-object settings_config degrades to {}", () => {
  for (const bad of [null, [], 123, "{}", undefined]) {
    const eff = buildClaudeEffectiveSettings(bad, {}, "", undefined, undefined);
    assert.equal(eff !== null && typeof eff === "object" && !Array.isArray(eff), true, String(bad));
  }
});

// ─── foldRemovalPatch: husk prevention, target-aware ───────────────────
// A subtree folds to one whole-remove null ONLY when the patch deletes
// every key the target holds there — patch-internal all-null is NOT
// enough, because the patch doesn't carry untouched siblings.

test("subtree fully removed in target folds to one null (no empty husks)", () => {
  const p = { hooks: { a: null, b: null } };
  foldRemovalPatch(p, { hooks: { a: 1, b: 2 } });
  assert.deepEqual(p, { hooks: null });
});

test("subtree with surviving target siblings stays per-leaf", () => {
  const p = { env: { TOKEN: null } };
  foldRemovalPatch(p, { env: { TOKEN: "t", KEEP_ME: "v" } });
  assert.deepEqual(p, { env: { TOKEN: null } });
});

test("top level never folds (RFC 7396 patches are objects)", () => {
  const p = { a: null, b: null };
  foldRemovalPatch(p, { a: 1, b: 2 });
  assert.deepEqual(p, { a: null, b: null });
});

test("fold is idempotent-safe on non-object patch or missing target", () => {
  const p = { env: { X: null } };
  foldRemovalPatch(p, undefined); // target row gone: stays per-leaf
  assert.deepEqual(p, { env: { X: null } });
});
