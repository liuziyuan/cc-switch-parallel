import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseToml } from "smol-toml";

process.env.CC_LAUNCH_SKIP_MAIN = "1";
const { __test } = await import("../bin/cc-launch.mjs");
const {
  jsonDeepMerge,
  applyMergePatch,
  jsonNormalize,
  applyTomlPatchText,
  deepEqualJson,
} = __test;

// ─── applyMergePatch: true RFC 7396 ───────────────────────────────────

test("applyMergePatch: nested objects recurse, scalars overwrite", () => {
  const target = { env: { A: "1", B: "2" }, model: "gpt" };
  const out = applyMergePatch(target, { env: { B: "x" }, model: "o4" });
  assert.deepEqual(out, { env: { A: "1", B: "x" }, model: "o4" });
});

test("applyMergePatch: null deletes a key — the whole point of 7396", () => {
  const target = { env: { A: "1", B: "2" } };
  const out = applyMergePatch(target, { env: { B: null } });
  assert.deepEqual(out, { env: { A: "1" } });
  assert.equal("B" in out.env, false); // deleted, not set to null
});

test("applyMergePatch: arrays are scalars — whole-value replace, never merge", () => {
  const target = { permissions: { allow: ["a", "b"] } };
  const out = applyMergePatch(target, { permissions: { allow: ["c"] } });
  assert.deepEqual(out, { permissions: { allow: ["c"] } });
});

test("applyMergePatch: object vs scalar shape mismatch overwrites either way", () => {
  assert.deepEqual(applyMergePatch({ a: { b: 1 } }, { a: "flat" }), { a: "flat" });
  assert.deepEqual(applyMergePatch({ a: "flat" }, { a: { b: 1 } }), { a: { b: 1 } });
});

test("applyMergePatch: non-object patch replaces the whole target", () => {
  assert.equal(applyMergePatch({ a: 1 }, "flat"), "flat");
  assert.equal(applyMergePatch({ a: 1 }, null), null);
  assert.deepEqual(applyMergePatch({ a: 1 }, [1, 2]), [1, 2]);
});

// Deliberate divergence lock: jsonDeepMerge's `key in target` branch drops
// the recursive return value entirely — a null patch on an existing key is
// a silent NO-OP, and that contract is LOAD-BEARING for providerPatches
// accumulation upstream. applyMergePatch is the one that actually deletes.
// These two functions must stay separate.
test("divergence lock: jsonDeepMerge silently no-ops a null, applyMergePatch deletes", () => {
  const jm = jsonDeepMerge({ env: { A: "1", B: "2" } }, { env: { B: null } });
  assert.deepEqual(jm, { env: { A: "1", B: "2" } }); // null patch: silent no-op
  const ap = applyMergePatch({ env: { A: "1", B: "2" } }, { env: { B: null } });
  assert.deepEqual(ap, { env: { A: "1" } }); // key actually removed
});

// ─── applyTomlPatchText: TOML text round-trip ─────────────────────────

test("applyTomlPatchText: adds, changes and deletes through real TOML", () => {
  const doc = `model = "gpt-5"
approval_policy = "untrusted"

[env]
OPENAI_API_KEY = "sk-test"
`;
  const next = applyTomlPatchText(doc, {
    model: "o4",
    approval_policy: null,
    disable_response_storage: true,
    env: { OPENAI_API_KEY: null },
  });
  const parsed = parseToml(next);
  assert.equal(parsed.model, "o4");
  assert.equal("approval_policy" in parsed, false);
  assert.equal(parsed.disable_response_storage, true);
  assert.equal("OPENAI_API_KEY" in parsed.env, false);
});

test("applyTomlPatchText: empty input text is treated as an empty document", () => {
  const parsed = parseToml(applyTomlPatchText("", { model: "o4" }));
  assert.equal(parsed.model, "o4");
});

test("applyTomlPatchText: throws on unparseable TOML (no silent partial write)", () => {
  assert.throws(() => applyTomlPatchText("model = ", { model: "o4" }));
});

// ─── jsonNormalize: deterministic equality across parse calls ─────────

// Regression lock for the false-drift hazard: smol-toml yields real Date
// and NaN instances, and two parse calls of the same text produce distinct
// references. deepEqualJson's `===` leaf check calls them unequal — both
// sides of every guard/diff comparison MUST pass through jsonNormalize.
test("jsonNormalize: TOML datetime + NaN round-trip compares equal", () => {
  const text = `when = 2026-01-02T03:04:05Z
ratio = nan
name = "x"
`;
  const a = jsonNormalize(parseToml(text));
  const b = jsonNormalize(parseToml(text));
  assert.deepEqual(a, b);
  assert.equal(deepEqualJson(a, b), true);
  assert.equal(typeof a.when, "string"); // Date → ISO string
  assert.equal(a.ratio, null); // NaN → null
});

test("jsonNormalize: corrupt/circular input degrades to null, never throws", () => {
  assert.equal(jsonNormalize(undefined), null);
  const circular = {};
  circular.self = circular;
  assert.equal(jsonNormalize(circular), null);
});
