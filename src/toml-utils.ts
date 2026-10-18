// ─── toml-utils (split from bin/cc-launch.mjs) ─────────────────────────────

import { applyMergePatch, isPlainObject, jsonDeepClone } from "./json-utils.js";
import { parseToml, stringifyToml } from "./toml.js";

// ─── TOML utils (port of Rust merge_toml_table_like) ───────────────────

function tomlDeepMerge(target, source) {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key in target && isPlainObject(target[key]) && isPlainObject(sourceValue)) {
      tomlDeepMerge(target[key], sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
  return target;
}

function tomlIsSubset(target, source) {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!(key in target)) return false;
    const targetValue = target[key];
    if (isPlainObject(sourceValue)) {
      if (!isPlainObject(targetValue)) return false;
      if (!tomlIsSubset(targetValue, sourceValue)) return false;
    } else if (Array.isArray(sourceValue)) {
      if (!Array.isArray(targetValue)) return false;
      if (!sourceValue.every((s) =>
        targetValue.some((t) => JSON.stringify(t) === JSON.stringify(s))
      )) return false;
    } else {
      if (JSON.stringify(targetValue) !== JSON.stringify(sourceValue)) return false;
    }
  }
  return true;
}

// Codex write-back core (pure): apply an RFC 7396 patch to a TOML document
// IN TEXT form — parse, patch, re-serialize. The re-serialization loses
// comments and reorders keys; that cost is accepted and documented at the
// confirmation prompt, because no format-preserving TOML editor exists in
// the JS ecosystem and this is a single-file CLI. Throws on parse failure —
// the DB write-back shells let that surface as a reported error, never a
// silent partial write.
function applyTomlPatchText(tomlText, patchObj) {
  return stringifyToml(applyMergePatch(parseToml(tomlText || ""), jsonDeepClone(patchObj)));
}


export { applyTomlPatchText, tomlDeepMerge, tomlIsSubset };
