// ─── claude-config (split from bin/cc-launch.mjs) ─────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isPlainObject,
  jsonDeepClone,
  jsonIsSubset,
  mergeCommonOverProvider,
} from "./json-utils.js";
import { INSTANCES_DIR } from "./paths.js";
import { isLiveSharedSnippet, sharedSnippetText } from "./shared-config.js";
import { ccsClaudeKeyFromModel } from "./stack/aggregation.js";
import {
  isAggregationProviderSettings,
  protectAggregationIdentityEnv,
  readGlobalModelPicker,
  readStackState,
} from "./stack/state.js";
import { applyStatusLineInjection } from "./statusline.js";
import { parseToml } from "./toml.js";
import { tomlIsSubset } from "./toml-utils.js";

// ─── Common config detection (port of Rust provider_uses_common_config) ─

function providerUsesCommonConfig(appType, settingsConfig, meta, snippet) {
  const snippetTrimmed = (snippet || "").trim();
  if (!snippetTrimmed) return false;
  const explicit = meta?.commonConfigEnabled;
  if (explicit !== undefined && explicit !== null) {
    return explicit && snippetTrimmed.length > 0;
  }
  return settingsContainCommonConfig(appType, settingsConfig, snippetTrimmed);
}

function settingsContainCommonConfig(appType, settings, snippetTrimmed) {
  if (!snippetTrimmed) return false;
  if (appType === "claude") {
    try {
      const source = JSON.parse(snippetTrimmed);
      if (isPlainObject(source)) return jsonIsSubset(settings, source);
    } catch {
      return false;
    }
  } else if (appType === "codex") {
    const configToml = settings?.config || "";
    if (!configToml.trim()) return false;
    try {
      const targetDoc = parseToml(configToml);
      const sourceDoc = parseToml(snippetTrimmed);
      return tomlIsSubset(targetDoc, sourceDoc);
    } catch {
      return false;
    }
  }
  return false;
}

// ─── Claude config generation ─────────────────────────────────────────

const CLAUDE_SANITIZE_KEYS = [
  "api_format",
  "apiFormat",
  "openrouter_compat_mode",
  "openrouterCompatMode",
];

function sanitizeClaudeSettings(settings) {
  const v = jsonDeepClone(settings);
  if (isPlainObject(v)) {
    for (const key of CLAUDE_SANITIZE_KEYS) delete v[key];
  }
  return v;
}

function applyKimiForCodingContextDefaults(effective, providerSettings) {
  const baseUrl = providerSettings?.env?.ANTHROPIC_BASE_URL;
  if (!baseUrl || baseUrl.trim().replace(/\/$/, "") !== "https://api.kimi.com/coding") return;
  effective.env = effective.env || {};
  const env = effective.env;
  const providerEnv = providerSettings?.env || {};
  const KIMI_TOKENS = "262144";
  for (const key of ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"]) {
    env[key] = providerEnv[key] || KIMI_TOKENS;
  }
}

// Instance settings.json path derivation shared by prepare, the guard's [C3]
// recompute, and the model carry inside buildClaudeEffectiveSettings — same
// expression everywhere, mirroring codexInstanceDirFor, so the three never
// see different files.
function claudeInstanceSettingsPath(providerId) {
  return join(INSTANCES_DIR, "claude", providerId, "settings.json");
}

// Runtime-state filter for the claude settings channel: `model` is the
// instance-local model choice the Claude CLI itself writes into the instance
// settings.json when the user picks a model via /model ("saved as your
// default for new sessions"). Exact match — never startsWith, or
// modelPicker.* would be swallowed too.
function isClaudeRuntimeStatePath(path) {
  return path === "model";
}

// providerName/providerId: when both are given, the effective settings get
// the instance statusline injected (see applyStatusLineInjection) AND the
// instance-local model carried over from the file currently on disk (see the
// carry block at the end of this function). prepare() and the guard's
// computeEffectiveSettings [C3] MUST pass the same pair — C3 exists to
// recompute exactly what prepare would write, and a fork between the two
// derivations makes the overwrite guard misfire.
function buildClaudeEffectiveSettings(
  settingsConfig,
  meta,
  shared,
  providerName,
  providerId,
  opts: { writeWrapper?: boolean } = {},
) {
  // Defensive: callers pass parsed DB columns. A non-object (null, array,
  // scalar) would be cloned and handed to prepare, which writes it back as
  // the instance settings.json — degrade to {} instead.
  if (!isPlainObject(settingsConfig)) settingsConfig = {};
  if (!isPlainObject(meta)) meta = {};
  let effective = jsonDeepClone(settingsConfig);
  const sharedText = sharedSnippetText(shared);
  const sharedTrimmed = sharedText.trim();
  const liveShared = isLiveSharedSnippet(shared);
  // Aggregation rows (loopback + PROXY_MANAGED signature) always merge the
  // shared config: the row carries only routing env + modelPicker, so the
  // subset fallback in providerUsesCommonConfig can never see the shared
  // content (hooks!) and the row would launch without every shared setting.
  // An explicit commonConfigEnabled:false still wins — the desktop app can
  // turn shared settings off on the Stack row itself. Not gated on
  // readStackState: the row launches with the stack off too, and a merge
  // decision that flips with desktop state would break prepare determinism.
  //
  // live mode (cc-switch 4.0.2+): the projection already contains only user
  // keys, so every row merges it (the snippet's `commonConfigEnabled` flag
  // is only kept upstream for old-version compatibility). legacy mode keeps
  // the historical subset/forced-aggregation rules byte-identically.
  const isAgg = isAggregationProviderSettings(settingsConfig);
  const useShared =
    !!sharedTrimmed &&
    (meta?.commonConfigEnabled === false
      ? false
      : liveShared
        ? true
        : (isAgg && meta?.commonConfigEnabled !== false) ||
          providerUsesCommonConfig("claude", settingsConfig, meta, sharedText));
  if (useShared) {
    try {
      const source = JSON.parse(sharedText);
      // Object guard: mergeCommonOverProvider full-overwrites on shape
      // mismatch, so a non-object snippet ("[1]") would replace the whole
      // effective settings — skip it instead.
      if (isPlainObject(source)) {
        effective = mergeCommonOverProvider(effective, source);
        // The aggregation row IS the routing identity (loopback address +
        // proxy placeholder token + ccs model aliases); the shared config
        // must never re-point or re-auth it. See protectAggregationIdentityEnv.
        if (isAgg) protectAggregationIdentityEnv(effective, settingsConfig);
      }
    } catch (e: any) {
      console.error(`⚠ Common config merge failed: ${e.message}`);
    }
  }
  applyKimiForCodingContextDefaults(effective, settingsConfig);
  effective = sanitizeClaudeSettings(effective);
  // Aggregation instance (loopback + PROXY_MANAGED): sync the desktop app's
  // modelPicker (the aggregation /model list) from the GLOBAL settings.json
  // so member changes surface on every prepare without touching the provider
  // row's snapshot. Three states: a populated picker syncs in; an EMPTY
  // options array (the desktop app clearing back to built-in models) drops
  // the picker too — an empty replaceBuiltInOptions list must not linger as
  // a stale row snapshot; no modelPicker key at all leaves the row's value.
  // With the stack OFF, a stackManaged row's snapshot would keep offering
  // dead-proxy ccs ids in /model — drop it (hand-made rows keep theirs:
  // user config is user config). Runs inside buildClaudeEffectiveSettings so
  // prepare and the guard's computeEffectiveSettings [C3] derive identically.
  if (providerId !== undefined && isAggregationProviderSettings(settingsConfig)) {
    const stack = readStackState("claude");
    if (stack) {
      const picker = readGlobalModelPicker();
      if (picker && picker.options.length) effective.modelPicker = picker;
      else if (picker) delete effective.modelPicker;
    } else if (meta?.stackManaged === true) {
      delete effective.modelPicker;
    }
  }
  if (providerName !== undefined && providerId !== undefined) {
    applyStatusLineInjection(effective, providerName, providerId, settingsConfig, meta, opts);
  }
  // Carry the instance-local model choice (isClaudeRuntimeStatePath) across a
  // full settings.json regeneration — the claude mirror of
  // mergeCodexRuntimeState, for the one field the Claude CLI owns: /model
  // writes `model` into the instance file, and without the carry prepare
  // would roll it back to the common/provider value on every launch, then
  // drift-prompt the rollback as an edit to sync. The file's live value wins
  // over everything merged above: common's `model` and the provider row's
  // `model` are INITIAL values for a freshly created instance only — they no
  // longer propagate to existing instances (per-instance choice; aggregation
  // siblings never see each other's pick). Lives inside
  // buildClaudeEffectiveSettings — not at the write site like codex — so
  // prepare AND the guard's computeEffectiveSettings [C3] derive identically
  // from this single point; an upgrade-window instance that only ever
  // switched models therefore backfills silently instead of eating a
  // spurious backup note. providerId undefined (some test call sites) or a
  // missing/corrupt instance file → skip, the generated value stands.
  if (providerId !== undefined) {
    try {
      const current = JSON.parse(readFileSync(claudeInstanceSettingsPath(providerId), "utf8"));
      if (typeof current?.model === "string" && current.model) {
        let model = current.model;
        // Dangling ccs model fallback: a carried /model pick still pointing at
        // a Stack key that is no longer live (stack off in the desktop app, or
        // the member since removed) would fail at the proxy on every launch —
        // drop the carry and let the merged value stand. Key liveness mirrors
        // the wrapper's decode (ccs-claude-<key>--…; key never contains "--").
        // Runs in buildClaudeEffectiveSettings (not the write site) so the
        // guard's computeEffectiveSettings [C3] drops it identically — the
        // one-time overwrite note the guard shows for the rollback is the
        // desired signal, not a false positive.
        const key = ccsClaudeKeyFromModel(model);
        if (key) {
          const stack = readStackState("claude");
          if (!stack || !(key in stack.keys)) {
            console.error(
              `\x1b[2mℹ Aggregation model "${model}" is no longer in the current aggregation stack (stack off or member removed) — falling back to the default model for this launch; reselect it in /model after it returns\x1b[0m`,
            );
            model = null;
          }
        }
        if (model) effective.model = model;
      }
    } catch {
      // no instance file yet (first prepare) or unreadable — generated value stands
    }
  }
  return effective;
}

export {
  CLAUDE_SANITIZE_KEYS,
  applyKimiForCodingContextDefaults,
  buildClaudeEffectiveSettings,
  claudeInstanceSettingsPath,
  isClaudeRuntimeStatePath,
  providerUsesCommonConfig,
  sanitizeClaudeSettings,
  settingsContainCommonConfig,
};
