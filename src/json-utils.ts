// ─── json-utils (split from bin/cc-launch.mjs) ─────────────────────────────


// ─── JSON utils (port of Rust json_deep_merge / json_is_subset) ────────

import type { SettingsChange } from "./types.js";

function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Keys that must never be written through a merge: assigning them walks /
// replaces the prototype instead of creating a config entry. JSON.parse can
// produce "__proto__" as an OWN key, which is exactly the prototype-pollution
// vector (`key in target` then recurses into Object.prototype).
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isSafeObjectKey(key: any): boolean {
  return !UNSAFE_OBJECT_KEYS.has(String(key));
}
function hasOwn(obj: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// Parse a DB column that is supposed to hold a JSON object. Missing/empty
// values are the legitimate "no config" case → {}. Invalid JSON, arrays and
// scalars → null: callers must warn and degrade to {} instead of handing the
// value to prepare, which would atomically write a corrupt instance file
// ("null", "[]", "\"{}\"").
function parseJsonObject(value: any): Record<string, any> | null {
  if (value === undefined || value === null) return {};
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") return null;
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonDeepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function jsonDeepMerge(target, source) {
  if (isPlainObject(target) && isPlainObject(source)) {
    for (const [key, sourceValue] of Object.entries(source)) {
      if (!isSafeObjectKey(key)) continue;
      if (hasOwn(target, key)) {
        jsonDeepMerge(target[key], sourceValue);
      } else {
        target[key] = sourceValue;
      }
    }
  }
  return target;
}

// JSON round-trip normalizer for cross-parse comparisons. smol-toml can
// produce Date/NaN instances; two parse calls of the SAME text yield
// structurally equal but reference-distinct values, and deepEqualJson's
// `===` leaf check would call them unequal — a full false-drift. Round-
// tripping BOTH sides (snapshot and recomputed baseline) through this
// makes equality deterministic: Date → ISO string, NaN/Infinity → null,
// top-level undefined → null. Circular structures throw → null (a corrupt
// document is "no snapshot", never a drift report).
function jsonNormalize(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

// True RFC 7396 merge-patch application — the thing jsonDeepMerge above
// deliberately is NOT (it drops the recursive return value in the `key in
// target` branch, so a null never deletes). Contract: non-object patch →
// whole-value replace; object patch → null deletes the key, plain objects
// recurse, everything else (arrays included — they are scalars under
// 7396) overwrites. Mutates target and returns it, like jsonDeepMerge.
// Used by the TOML write-back path; jsonDeepMerge keeps its own
// target-wins contract for providerPatches accumulation — two functions,
// two contracts, kept separate on purpose.
function applyMergePatch(target, patch) {
  if (!isPlainObject(patch)) return jsonDeepClone(patch ?? null);
  if (!isPlainObject(target)) target = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!isSafeObjectKey(key)) continue;
    if (value === null) {
      delete target[key];
    } else if (isPlainObject(value)) {
      target[key] = applyMergePatch(isPlainObject(target[key]) ? target[key] : {}, value);
    } else {
      target[key] = jsonDeepClone(value);
    }
  }
  return target;
}

// 1:1 port of the upstream Rust json_deep_merge (services/provider/live.rs,
// 69ff69d^): two plain objects recurse per key of source (missing keys are
// inserted, existing keys recurse); EVERY other shape — scalar vs object,
// object vs scalar, arrays, type mismatches — falls through to a full source
// overwrite. The old jsonDeepMerge above got that fallthrough wrong (the
// target kept its value), which inverted the common-over-provider semantics
// of buildClaudeEffectiveSettings. Do NOT "fix" jsonDeepMerge in place:
// detectSettingsDrift's providerPatches accumulation still calls it and
// relies on target-wins for merging nested patches. Two functions, two
// contracts, kept separate on purpose.
// Contract: returns the merged value; the caller must assign it back
// (`x = mergeCommonOverProvider(x, src)`) because the scalar-overwrite
// branch cannot mutate the caller's binding. source is always a JSON.parse
// result, so jsonDeepClone (JSON round-trip) is safe on every branch.
function mergeCommonOverProvider(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return jsonDeepClone(source);
  }
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!isSafeObjectKey(key)) continue;
    if (hasOwn(target, key)) {
      target[key] = mergeCommonOverProvider(target[key], sourceValue);
    } else {
      target[key] = jsonDeepClone(sourceValue);
    }
  }
  return target;
}

function jsonIsSubset(target, source) {
  if (isPlainObject(source)) {
    if (!isPlainObject(target)) return false;
    for (const [key, sourceValue] of Object.entries(source)) {
      if (!isSafeObjectKey(key)) continue;
      if (!hasOwn(target, key)) return false;
      if (!jsonIsSubset(target[key], sourceValue)) return false;
    }
    return true;
  }
  if (Array.isArray(source)) {
    if (!Array.isArray(target)) return false;
    return source.every((srcItem) =>
      target.some((tgtItem) => jsonIsSubset(tgtItem, srcItem)),
    );
  }
  return target === source;
}

// Strict structural equality for the instance-settings guard & diff: objects
// recurse per key; arrays are atomic, order-sensitive leaves. The array
// semantics are deliberate — settings arrays like permissions.allow or hooks
// have no reliable element-level merge under RFC 7396 (json_patch has no
// array patch primitive), so "did the user change this array" is answered
// whole-block. jsonIsSubset is the WRONG tool here: its fuzzy array matching
// (every source item matches SOME target item) would call different arrays
// equal, which is exactly the false negative the overwrite guard must never
// produce.
function deepEqualJson(a, b) {
  if (a === b) return true;
  // Arrays: still atomic leaves for DIFF purposes (a changed array is one
  // whole-block change), but equality is CONTENT equality, element-wise —
  // baseline and runtime settings come from two separate JSON.parse calls,
  // so `a === b` would call two identical arrays unequal and turn every
  // unchanged permissions.allow/hooks block into a phantom diff (false
  // overwrite-guard warnings, idempotent-but-noisy sync writes).
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJson(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqualJson(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// Leaf-level diff of two parsed settings objects, from a baseline to the
// current state: [{path, op: "add"|"change"|"remove", from, to}] where path
// is a dotted key path ("env.ANTHROPIC_AUTH_TOKEN"). Objects recurse per
// key; arrays are atomic — the path stops at the array's key and from/to
// carry the whole array (same semantics as deepEqualJson, so "what changed"
// and "is it equal" can never disagree).
// NO removal folding here: folded subtree removes once made "delete one key"
// read as "delete the whole parent" — a folded {env:null} patch wiped every
// SIBLING the user never touched from common_config (unrecoverable: the
// overwrite-guard backup only covers instance files, not the DB row), and
// the folded parent path also bypassed the sensitive-key gate. Diffing stays
// per-leaf; empty-husk prevention moved to foldAllNullSubtrees at patch
// build time.
// Callers filter the enabledPlugins subtree themselves — the plugin channel
// owns that path, and this function must not know about channels.
function diffSettingsLeaves(baseline: any, current: any, prefix = "", segments: string[] = []): SettingsChange[] {
  const changes: SettingsChange[] = [];
  const b = isPlainObject(baseline) ? baseline : {};
  const c = isPlainObject(current) ? current : {};

  const keys = new Set([...Object.keys(b), ...Object.keys(c)]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    // Real key sequence (k may itself contain dots). Carried through add,
    // remove and change so write-back never has to re-split the display path.
    const childSegments = [...segments, k];
    const inB = Object.prototype.hasOwnProperty.call(b, k);
    const inC = Object.prototype.hasOwnProperty.call(c, k);
    if (inB && inC) {
      const bv = b[k];
      const cv = c[k];
      if (isPlainObject(bv) && isPlainObject(cv)) {
        changes.push(...diffSettingsLeaves(bv, cv, path, childSegments));
      } else if (!deepEqualJson(bv, cv)) {
        // Arrays & scalars are leaves; deepEqualJson's non-object branch is
        // strict ===, which is the right comparison for both.
        changes.push({ path, op: "change", from: bv, to: cv, segments: childSegments });
      }
    } else if (inC) {
      changes.push({ path, op: "add", from: undefined, to: c[k], segments: childSegments });
    } else {
      changes.push({ path, op: "remove", from: b[k], to: undefined, segments: childSegments });
    }
  }
  return changes;
}


export { applyMergePatch, deepEqualJson, diffSettingsLeaves, isPlainObject, isSafeObjectKey, jsonDeepClone, jsonDeepMerge, jsonIsSubset, jsonNormalize, mergeCommonOverProvider, parseJsonObject };
