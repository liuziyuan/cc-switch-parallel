// ─── upward (split from bin/cc-launch.mjs) ─────────────────────────────

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { withFileLockSync } from "./file-lock.js";
import { DB_PROC_TIMEOUT_MS, patchCommonConfigClaude, patchProviderSettingsConfig, queryCommonConfig, queryProviderById, sqlQuote } from "./db.js";
import { atomicWrite } from "./fs-utils.js";
import { deepEqualJson, isPlainObject, isSafeObjectKey } from "./json-utils.js";
import { DB_PATH, HOME, VIRTUAL_STACK_PROVIDER_ID } from "./paths.js";
import { applyTomlPatchText } from "./toml-utils.js";

// ─── Settings-field upward channel (detect → arbitrate → split → write) ─

// Does a dotted path exist in the parsed common-config snippet? The parent
// object existing is enough — smart-split routes a field to common only when
// common already owns that key, otherwise prepare's jsonDeepMerge(effective,
// commonSource) wouldn't have sourced it from common in the first place.
// Dotted path → the tree's REAL key sequence. The path string is ambiguous
// when a key itself contains dots — codex TOML `[hooks.state."<abs path>"]`
// keys are absolute file paths ("/…/.cc-switch/…/hooks.json:pre_tool_use:0:0"),
// so a naive split("") explodes one flat key into nested levels. That is
// exactly how the 2026-10-17 sync corrupted the provider row: the write-back
// re-serialized a single TOML key as three nested tables. Resolution against
// the actual tree: prefer the exact next segment; otherwise accept a dotted
// key that swallows several segments when the remainder then resolves
// (backtracking — two sibling keys may both be dotted-prefix candidates).
// Returns the naive split when nothing fits, so dot-free paths (the
// overwhelming majority) behave byte-identically to before.
function resolvePathSegmentsDetailed(obj, path): { parts: string[]; resolved: boolean } {
  const parts = String(path).split(".");
  function walk(node, i): string[] | null {
    if (!isPlainObject(node)) return null;
    if (i === parts.length - 1) return Object.prototype.hasOwnProperty.call(node, parts[i]) ? [parts[i]] : null;
    const exact = Object.prototype.hasOwnProperty.call(node, parts[i])
      ? walk(node[parts[i]], i + 1) : null;
    if (exact) return [parts[i], ...exact];
    for (const k of Object.keys(node)) {
      if (!k.includes(".")) continue;
      let consumed = parts[i];
      // j = tail start; consumed === parts[i..j-1].join("."). j may reach
      // parts.length: a dotted key can swallow ALL remaining segments (the
      // path's leaf IS that key — an add/change reported at the key itself).
      for (let j = i + 1; j <= parts.length; j++) {
        if (consumed === k) {
          if (j === parts.length) return [k];
          const tail = walk(node[k], j);
          if (tail) return [k, ...tail];
        }
        if (j < parts.length) consumed += "." + parts[j];
      }
    }
    return null;
  }
  const found = walk(obj, 0);
  return found ? { parts: found, resolved: true } : { parts, resolved: false };
}

function resolvePathSegments(obj, path) {
  return resolvePathSegmentsDetailed(obj, path).parts;
}

// Key sequence to use when BUILDING a patch for `refObj` (the document the
// patch will be applied to). The diff's segments are the source tree's real
// keys — authoritative for a NEW path, where the target has no shape yet and
// re-splitting the dotted display path would nest `profiles."my.profile"`
// into `profiles.my.profile`. When the target DOES have a shape for the path
// (it parsed via real keys, not the naive fallback), follow the target's
// shape so the write-back stays consistent with the document it lands in.
function resolveWriteSegments(refObj, path, segments) {
  if (!Array.isArray(segments) || segments.length === 0) return resolvePathSegments(refObj, path);
  const detailed = resolvePathSegmentsDetailed(refObj, path);
  return detailed.resolved ? detailed.parts : segments;
}

function pathExistsInSnippet(snippetObj, path) {
  if (!isPlainObject(snippetObj) || !path) return false;
  const parts = resolvePathSegments(snippetObj, path);
  let cur = snippetObj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, parts[i])) return false;
    cur = cur[parts[i]];
  }
  return isPlainObject(cur) && Object.prototype.hasOwnProperty.call(cur, parts[parts.length - 1]);
}

// Sensitive-key gate for the smart split's common direction — 1:1 port of
// Rust ProviderService::is_sensitive_config_key. Deliberately over-broad:
// blocking one shareable key only costs that key not being shared (small,
// recoverable), while leaking one credential into common_config reaches
// EVERY provider that consumes the snippet (unrecoverable). Pattern classes,
// not name enumeration — enumerating `*_API_KEY` would miss the next one.
function isSensitiveConfigKey(name) {
  const upper = String(name).toUpperCase();
  const SENSITIVE_SUFFIXES = [
    "_KEY", "_API_KEY", "_ACCESS_KEY", "_ACCESS_KEY_ID", "_KEY_ID",
    "_PRIVATE_KEY", "_APIKEY", "_ACCESSKEY", "_SECRETKEY", "_APITOKEN",
    "_AUTH_TOKEN", "_TOKEN", "_PAT", "_PWD", "_PASS", "_PASSPHRASE",
    "_CREDS", "_CUSTOM_HEADERS",
  ];
  const SENSITIVE_EXACT = ["APIKEY", "API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIALS", "HEADERS"];
  const SENSITIVE_CONTAINS = ["SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE_KEY", "BEARER_TOKEN", "COOKIE", "AUTHORIZATION"];
  return SENSITIVE_EXACT.includes(upper)
    || SENSITIVE_SUFFIXES.some((s) => upper.endsWith(s))
    || SENSITIVE_CONTAINS.some((c) => upper.includes(c));
}

// Dotted-path variant for the smart split: every segment of a change path is
// a map key at some nesting level, and Rust strips sensitive keys at EVERY
// level — so a hit on any segment routes the change out of common's direction.
function isSensitiveConfigPath(path, segments: string[] | null = null) {
  // Segments are the real key sequence when the caller has them (a key may
  // contain dots); the string split is the backward-compatible fallback.
  const parts = Array.isArray(segments) && segments.length
    ? segments
    : String(path || "").split(".");
  return parts.some((seg) => isSensitiveConfigKey(seg));
}

// Read the value at a dotted path inside a parsed object (undefined if absent).
// Resolution is tree-aware — see resolvePathSegments for why the naive split
// misreads keys that themselves contain dots.
function getPathValue(obj, path) {
  let cur = obj;
  for (const part of resolvePathSegments(obj, path)) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Write-back orchestration for the settings-field channel, CLAUDE flavor:
// common_config via json_patch (single-statement atomic) and each provider's
// settings_config likewise. (Codex has its own shell — applyCodexSettings-
// FieldPatches — because TOML cannot go through sqlite's json_patch.)
// Common and each provider patch go through SEPARATE try blocks: one DB
// hiccup must not abort the rest, and — unlike the plugin channel's silent
// best-effort — failures are REPORTED, because the user just explicitly
// confirmed these writes; losing one silently is worse than an error line.
function applyClaudeSettingsFieldPatches(commonPatch, providerPatches) {
  if (commonPatch && Object.keys(commonPatch).length) {
    try {
      patchCommonConfigClaude(commonPatch);
    } catch (e: any) {
      process.stderr.write(`\x1b[31m✗ Failed to write common config: ${e.message}\x1b[0m\n`);
    }
  }
  for (const [providerId, patchObj] of Object.entries(providerPatches || {})) {
    if (!patchObj || !Object.keys(patchObj).length) continue;
    // Virtual Stack entry: no DB row — an UPDATE here would silently match 0
    // rows. The drift split already refuses provider-target edits for it; this
    // guard keeps any future caller from losing an edit the same silent way.
    if (providerId === VIRTUAL_STACK_PROVIDER_ID) continue;
    try {
      patchProviderSettingsConfig(providerId, "claude", patchObj);
    } catch (e: any) {
      process.stderr.write(`\x1b[31m✗ Failed to write provider ${providerId} settings: ${e.message}\x1b[0m\n`);
    }
  }
}

// ─── Codex write-back (TOML) ───────────────────────────────────────────
// sqlite's json_patch only speaks JSON; common_config_codex is a TOML text
// and each codex provider's settings_config carries the config as a TOML
// string inside a JSON envelope. The equivalent of claude's single-statement
// atomic json_patch is therefore a read-modify-write anchored by a
// COMPARE-AND-SWAP: the UPDATE's WHERE clause requires the column to still
// hold the exact text we read, and `SELECT changes()` confirms the row was
// actually replaced. A concurrent writer (the desktop app) between our read
// and write yields 0 rows → re-read, re-patch, retry. No partial writes, no
// lost updates; two failed retries surface as a reported error (same
// report-don't-swallow contract as applyClaudeSettingsFieldPatches above).

function dbError(code, message) {
  const err: any = new Error(message);
  err.code = code;
  return err;
}

function execDBWithChanges(sql, timeoutMs = DB_PROC_TIMEOUT_MS) {
  try {
    // Trailing semicolon is REQUIRED: without it the appended SELECT would
    // parse as one (invalid) statement and the whole batch would error out.
    const out = execFileSync("sqlite3", [DB_PATH, ".timeout 3000", `${sql};\nSELECT changes();`], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const n = parseInt(String(out).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e: any) {
    const stderr = String(e?.stderr || "");
    // Classify instead of collapsing every failure to "0 rows": a timeout or
    // a syntax error is NOT "another writer won the CAS".
    if (e?.code === "ETIMEDOUT" || e?.signal) {
      throw dbError("DB_TIMEOUT", "sqlite3 timed out (database busy?)");
    }
    if (/database is locked|database is busy|SQLITE_BUSY/i.test(stderr)) {
      throw dbError("DB_BUSY", stderr.trim() || "database is busy");
    }
    throw dbError("DB_ERROR", stderr.trim() || e?.message || "sqlite3 failed");
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function patchCodexCommonConfig(patchObj) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = queryCommonConfig("codex");
    if (cur === null || cur === undefined) {
      throw new Error("common_config_codex row does not exist in the settings table");
    }
    const next = applyTomlPatchText(cur, patchObj);
    try {
      const n = execDBWithChanges(
        `UPDATE settings SET value = ${sqlQuote(next)} WHERE key = 'common_config_codex' AND value = ${sqlQuote(cur)}`,
      );
      if (n === 1) return;
    } catch (e: any) {
      if (e?.code !== "DB_BUSY") throw e; // timeout/SQL errors are not CAS races
    }
    if (attempt < 2) sleepSync(50);
  }
  throw new Error("common_config_codex kept changing under us (desktop app writing concurrently?) — run switch sync again");
}

function patchCodexProviderConfig(providerId, patchObj) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = queryProviderById(providerId, "codex");
    if (!row) return; // provider gone — nothing to write (mirrors the generic drift drop)
    const original = row.settings_config;
    let sc;
    try {
      sc = JSON.parse(original || "{}");
    } catch {
      throw new Error(`provider "${providerId}" settings_config is not valid JSON`);
    }
    // Patch ONLY the config document; auth and modelCatalog pass through
    // untouched — the field channel never owns them.
    sc.config = applyTomlPatchText(sc.config || "", patchObj);
    const casClause = original == null ? "settings_config IS NULL" : `settings_config = ${sqlQuote(original)}`;
    try {
      const n = execDBWithChanges(
        `UPDATE providers SET settings_config = ${sqlQuote(JSON.stringify(sc))} WHERE id = ${sqlQuote(providerId)} AND app_type = 'codex' AND ${casClause}`,
      );
      if (n === 1) return;
    } catch (e: any) {
      if (e?.code !== "DB_BUSY") throw e;
    }
    if (attempt < 2) sleepSync(50);
  }
  throw new Error(`provider "${providerId}" config kept changing under us — run switch sync again`);
}

// Thin shell mirroring applyClaudeSettingsFieldPatches: same separate
// try-blocks, same report-don't-swallow error style.
function applyCodexSettingsFieldPatches(drift) {
  if (drift.commonPatch && Object.keys(drift.commonPatch).length) {
    try {
      patchCodexCommonConfig(drift.commonPatch);
    } catch (e: any) {
      process.stderr.write(`\x1b[31m✗ Failed to write common config: ${e.message}\x1b[0m\n`);
    }
  }
  for (const [providerId, patchObj] of Object.entries(drift.providerPatches || {})) {
    if (!patchObj || !Object.keys(patchObj).length) continue;
    try {
      patchCodexProviderConfig(providerId, patchObj);
    } catch (e: any) {
      process.stderr.write(`\x1b[31m✗ Failed to write provider ${providerId} config: ${e.message}\x1b[0m\n`);
    }
  }
}

// Collapse a patch subtree into one null (RFC 7396 whole-subtree remove)
// ONLY when the patch deletes every key the target object actually holds at
// that level. Per-leaf nulls alone would leave empty husks ({"hooks": {}}
// after deleting every hook), but an unconditional all-null-in-patch fold
// would delete siblings the user never touched — the patch does not carry
// them, so "all-null inside the patch" is NOT "all gone in the target";
// the fold must consult the object the patch will be applied to. The TOP
// level never folds: an RFC 7396 patch IS an object, a top-level null is
// an invalid patch.
function foldRemovalPatch(patch, target) {
  if (!isPlainObject(patch)) return;
  for (const k of Object.keys(patch)) {
    if (!isSafeObjectKey(k)) continue;
    const pv = patch[k];
    if (!isPlainObject(pv)) continue; // leaves (values and nulls) stay as-is
    const targetChild = isPlainObject(target) ? target[k] : undefined;
    foldRemovalPatch(pv, targetChild);
    const pvKeys = Object.keys(pv);
    if (
      pvKeys.length > 0 &&
      pvKeys.every((key) => pv[key] === null) &&
      isPlainObject(targetChild) &&
      Object.keys(targetChild).length === pvKeys.length &&
      pvKeys.every((key) => isSafeObjectKey(key) && Object.prototype.hasOwnProperty.call(targetChild, key))
    ) {
      patch[k] = null;
    }
  }
}

// Apply the smart split to one instance's winning changes: a path that
// exists in the parsed common snippet goes to commonPatch (else next prepare
// would overwrite the provider row with common's stale value — the change
// would be lost); everything else goes to this provider's patch. Entries
// already equal to the current DB value are dropped (avoids pointless writes
// and phantom "refreshed" reports).
// Sensitive gate (common direction ONLY): an add/change to a path whose name
// matches isSensitiveConfigPath is refused into commonPatch — it goes
// NOWHERE (not the provider row either: common already owns the key, so the
// next prepare would clobber the provider copy anyway and the "saved" edit
// would silently revert). The edit stays in the instance file; the launch
// guard warns before it is ever overwritten. remove stays allowed: deleting
// a sensitive key FROM common clears a historical leak. providerPatch is
// never gated — provider rows are per-provider secrets by construction.
// Returns { commonPatch, providerPatch, rejected } — rejected carries the
// refused changes so the prompt can say so BEFORE the user confirms. opts:
// virtualProvider — the winning provider row is the runtime-virtual Stack
// entry (no DB row to write back to): provider-target changes land in
// rejected too (surfaced as "blocked"), common-target changes still flow.
function splitChangesByTarget(changes: any[], providerId: string, commonObj: any, providerSettings: any, opts: any = {}) {
  const commonPatch = {};
  const providerPatch = {};
  const rejected: any[] = [];
  for (const ch of changes) {
    if (pathExistsInSnippet(commonObj, ch.path)) {
      if (ch.op !== "remove" && isSensitiveConfigPath(ch.path, ch.segments)) {
        rejected.push(ch);
        continue;
      }
      if (!deepEqualJson(getPathValue(commonObj, ch.path), ch.op === "remove" ? undefined : ch.to)) {
        buildNestedAssign(commonPatch, ch.path, ch.op === "remove" ? null : ch.to, commonObj, ch.segments);
      }
    } else if (opts.virtualProvider) {
      rejected.push(ch);
    } else {
      const cur = getPathValue(providerSettings, ch.path);
      if (!deepEqualJson(cur, ch.op === "remove" ? undefined : ch.to)) {
        buildNestedAssign(providerPatch, ch.path, ch.op === "remove" ? null : ch.to, providerSettings, ch.segments);
      }
    }
  }
  // Husk prevention + precise removals: a subtree the patch empties
  // COMPLETELY (all of the target's keys are being removed) folds to one
  // null so json_patch deletes it whole with no {} husk; partially-emptied
  // subtrees stay per-leaf so untouched siblings in the target survive.
  foldRemovalPatch(commonPatch, commonObj);
  foldRemovalPatch(providerPatch, providerSettings);
  return { commonPatch, providerPatch, rejected };
}

// Assign a value at a dotted path inside a patch object, creating
// intermediate objects as needed (inverse of getPathValue for patch
// construction; works on a shared, partially-populated patch across
// changes — unlike a fresh-patch builder). refObj (the tree the path was
// diffed against) anchors tree-aware segment resolution: without it a key
// containing dots would be re-nested into levels that don't exist in the
// target document, corrupting it on write-back.
function buildNestedAssign(patch, path, value, refObj, segments: string[] | null = null) {
  const parts = resolveWriteSegments(refObj, path, segments);
  // Never build a patch through prototype keys: assigning them mutates the
  // prototype instead of creating a config entry.
  if (!parts.every((p) => isSafeObjectKey(p))) return;
  let cur = patch;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

// List every path of a patch object, INCLUDING intermediate ones: a change's
// path may stop at an object (e.g. an added statusLine), which materializes
// as a nested object in the patch — listing only leaves would yield
// statusLine.type and never match the change's statusLine. Nulls are leaves
// (RFC 7396 removals). Used to tag sync-prompt lines with their write target.
function collectPatchPaths(patch: any, prefix = ""): string[] {
  const out: string[] = [];
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    if (v !== null && isPlainObject(v)) out.push(...collectPatchPaths(v, path));
  }
  return out;
}

// Rewrite any per-instance-prefixed installPath in the shared
// installed_plugins.json back to the global ~/.claude/plugins path. cc-switch
// points CLAUDE_CONFIG_DIR at a per-instance dir, so Claude Code records newly
// installed user plugins under that instance and other instances can't resolve
// them. Any dir name matches ([^/]+) — UUID rows AND the virtual `__stack__`
// instance. Idempotent (already-global paths are untouched) and best-effort.
const INSTANCE_PLUGIN_PATH_RE = /^.*?\/instances\/claude\/[^/]+\/plugins\//;
function normalizeInstalledPluginPaths() {
  try {
    const globalPluginsDir = join(HOME, ".claude", "plugins");
    const file = join(globalPluginsDir, "installed_plugins.json");
    if (!existsSync(file)) return;
    withFileLockSync(file, () => {
      try {
        // Re-read inside the lock: another switch instance may have rewritten
        // install paths between the caller's check and this write.
        if (!existsSync(file)) return;
        const data = JSON.parse(readFileSync(file, "utf8"));
        let changed = false;
        for (const recs of Object.values(data.plugins || {})) {
          if (!Array.isArray(recs)) continue;
          for (const rec of recs) {
            const ip = rec.installPath;
            if (typeof ip === "string" && INSTANCE_PLUGIN_PATH_RE.test(ip)) {
              rec.installPath = ip.replace(INSTANCE_PLUGIN_PATH_RE, `${globalPluginsDir}/`);
              changed = true;
            }
          }
        }
        if (changed) atomicWrite(file, JSON.stringify(data, null, 2));
      } catch {
        // corrupt file — leave it alone
      }
    });
  } catch {
    // best-effort: missing/corrupt file — silently skip.
  }
}


export { INSTANCE_PLUGIN_PATH_RE, applyClaudeSettingsFieldPatches, applyCodexSettingsFieldPatches, buildNestedAssign, collectPatchPaths, execDBWithChanges, foldRemovalPatch, getPathValue, isSensitiveConfigKey, isSensitiveConfigPath, normalizeInstalledPluginPaths, patchCodexCommonConfig, patchCodexProviderConfig, pathExistsInSnippet, resolvePathSegments, splitChangesByTarget };
