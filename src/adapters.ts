// ─── adapters (split from bin/cc-launch.mjs) ─────────────────────────────

import { readFileSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildClaudeEffectiveSettings, isClaudeRuntimeStatePath } from "./claude-config.js";
import { CLI_META } from "./cli-meta.js";
import type { AppAdapter, AppKey } from "./types.js";
import {
  buildCodexInstructionsTemplate,
  refreshCodexInstructionsSnapshot,
} from "./codex-instructions.js";
import { patchCommonConfigClaude, queryProviderById, queryProvidersByApp } from "./db.js";
import {
  atomicWrite,
  ensureSymlink,
  readdirSyncSafe,
  setupClaudeInstance,
  setupCodexInstance,
} from "./fs-utils.js";
import { isPluginChannelPath } from "./guard.js";
import {
  deepEqualJson,
  diffSettingsLeaves,
  isPlainObject,
  jsonDeepMerge,
  jsonNormalize,
  parseJsonObject,
} from "./json-utils.js";
import { HOME, INSTANCES_DIR } from "./paths.js";
import { buildLaunchExtraEnv, launchTracked, shallowEqualPlugins } from "./sessions.js";
import { detectSharedConfigMode, readSharedConfig, sharedSnippetText } from "./shared-config.js";
import {
  CC_SWITCH_CATALOG_FILENAME,
  buildCodexConfig,
  codexAuthHasLoginMaterial,
  codexInstanceDirFor,
  copyGlobalCodexCatalogIntoInstance,
  isCodexRuntimeStateChange,
  isCodexStatusLineChannelPath,
  mergeCodexRuntimeState,
} from "./stack/catalog.js";
import { isCodexAggModelPath } from "./stack/state.js";
import {
  claudeProviderName,
  collectEnabledPluginsPatch,
  isStatusLineChannelPath,
} from "./statusline.js";
import { parseToml } from "./toml.js";
import {
  applyClaudeLivePluginPatch,
  applyClaudeLiveSettingsFieldPatches,
  applyClaudeSettingsFieldPatches,
  applyCodexLiveSettingsFieldPatches,
  applyCodexSettingsFieldPatches,
  normalizeInstalledPluginPaths,
  pathExistsInSnippet,
  splitChangesByTarget,
} from "./upward.js";

// ─── App adapters (per-CLI strategy) ──────────────────────────────────
// Each CLI implements a small adapter so adding a new CLI (e.g. gemini) means
// adding one object here — runTUI / launchProvider / main stay generic. Fields:
//   appType          DB app_type value
//   label            CLI-layer display name
//   bin              executable name
//   envVar           env var that points the CLI at the instance dir
//   commonConfigKey  settings-table key for the shared config snippet
//   setupInstance()  create instance dir + symlink shared resources
//   prepare()        generate & write the instance's config files
//   launch()         spawnSync the CLI and exit
//   permissionArgs() map permission hotkey → CLI argv
// Optional capability interfaces — the guard and sync flows NEVER branch on
// appType; they capability-probe these. An adapter lacking an interface is
// "v2-shaped" for that layer and simply skips it:
//   instanceSettingsFileName   name of the instance's main config file
//                              (guard backups, drift mtime). [C1]
//   readInstanceSettingsSnapshot(dir) → parsed semantic tree of the main
//                              config as it sits on disk NOW; null = missing
//                              or corrupt. MUST be jsonNormalize()-ed so two
//                              parses compare equal under deepEqualJson.
//                              Contract: right after prepare, the file IS
//                              the ground truth of what was handed down.
//                              Without it an adapter skips the overwrite
//                              guard and the settings-field sync. [C2]
//   computeEffectiveSettings(settingsConfig, meta, category, commonSnippet,
//                              providerId, settings) → the semantic tree
//                              prepare WOULD write, normalized identically
//                              to C2 — lets the guard's backfill branch
//                              recompute without a snapshot. [C3]
//   parseCommonSnippet(text) → parsed common-config snippet, or null. [C4]
//   providerDocFromSettingsConfig(settingsConfigObj) → the diffable provider
//                              config document extracted from the DB row's
//                              parsed settings_config. [C5]
//   channelOwnedPath(path) → paths owned by a dedicated channel (claude:
//                              the plugin channel); the field channel must
//                              yield them to avoid double reporting. [C6]
//   runtimeStatePath(path, change?) → runtime state the CLI itself writes into
//                              the instance's main config file (codex: project
//                              trust / hook hashes / TUI markers; claude:
//                              the /model pick). Filtered out of the guard
//                              AND the upward settings sync — it's machine/
//                              session-local fact, not config to sync — and
//                              carried across prepare's full regeneration
//                              instead (codex: mergeCodexRuntimeState at the
//                              write site; claude: the carry inside
//                              buildClaudeEffectiveSettings). `change` lets a
//                              filter recognize a whole-subtree add/remove,
//                              where the leaf diff only reports the parent
//                              path (see isCodexRuntimeStateChange).
//   syncSettingsBack(drift) → write confirmed {commonPatch, providerPatches}
//                              back into the DB. [C7]
//   instructions         instance-level instruction-file capability for
//                              customize/uncustomize: { fileName,
//                              globalPath(), missingGlobalWarn(p),
//                              buildTemplate(globalText, globalPathDisplay),
//                              refreshSnapshot?(existing, globalText,
//                              globalPathDisplay) — null = don't touch }. [C8]
//   fullAutoFlag         the CLI's full-auto permission flag, used verbatim
//                              in TUI confirmation copy. [C9]
// Claude-only channel (no codex counterpart — Codex has no plugin concept):
//   detectPluginDrift() / syncPluginsBack() / readInstancePluginState().
// Statusline channels per app (both owned via C6, both generated by prepare):
//   claude → the statusLine entry + wrapper (isStatusLineChannelPath),
//   codex  → the [tui] status_line subtree (isCodexStatusLineChannelPath).
const APP_ADAPTERS = {
  claude: {
    appType: "claude",
    label: "claude",
    displayName: "Claude Code",
    bin: "claude",
    envVar: "CLAUDE_CONFIG_DIR",
    commonConfigKey: "common_config_claude",

    // Capability interfaces [C1][C9] — see the comment block above the table.
    instanceSettingsFileName: "settings.json",
    fullAutoFlag: CLI_META.claude.fullAutoFlag,

    setupInstance: setupClaudeInstance,

    prepare(instanceDir, providerId, settingsConfig, meta, category, shared, settings) {
      normalizeInstalledPluginPaths();
      const effective = buildClaudeEffectiveSettings(
        settingsConfig,
        meta,
        shared,
        claudeProviderName(providerId),
        providerId,
      );
      atomicWrite(join(instanceDir, "settings.json"), JSON.stringify(effective, null, 2));
    },

    launch(instanceDir, extraArgs, ctx) {
      process.stderr.write(
        `\x1b[2mCLAUDE_CONFIG_DIR=${instanceDir} claude ${extraArgs.join(" ")}\x1b[0m\n`,
      );
      launchTracked(
        "claude",
        extraArgs,
        instanceDir,
        "CLAUDE_CONFIG_DIR",
        () => normalizeInstalledPluginPaths(),
        buildLaunchExtraEnv(ctx?.providerName, ctx?.providerId),
      );
    },

    permissionArgs(hotkey) {
      return CLI_META.claude.permissionArgs(hotkey);
    },

    // Reverse of permissionArgs for history recording: which permission mode
    // (if any) the forwarded argv carries. Contract: returns undefined when no
    // permission flag is present — never "1"/default, or the same launch would
    // fork two history entries.
    inferHotkeyFromArgs(args) {
      return CLI_META.claude.inferHotkeyFromArgs(args);
    },

    // Read the enabledPlugins this instance's settings.json currently holds
    // (used by recordInstanceBaseline() to snapshot per-instance provenance).
    readInstancePluginState(instanceDir) {
      const snap = this.readInstanceSettingsSnapshot?.(instanceDir);
      if (!snap) return null;
      return isPlainObject(snap.enabledPlugins) ? snap.enabledPlugins : {};
    },

    // Read the full parsed settings.json this instance currently holds. Used
    // by buildInstanceBaselineEntry() right after prepare — the file on disk
    // at that moment IS what we handed down, so the recorded snapshot is the
    // ground truth the overwrite guard and the settings-field sync diff
    // against. Returns null on missing/corrupt file (treated as "no v3
    // baseline" by every consumer — never a drift report).
    readInstanceSettingsSnapshot(instanceDir) {
      try {
        return JSON.parse(readFileSync(join(instanceDir, "settings.json"), "utf8"));
      } catch {
        return null;
      }
    },

    // Semantic tree prepare WOULD write (guard backfill branch) — the JSON
    // source is naturally normalized, so no jsonNormalize needed here. [C3]
    // providerName/providerId must match prepare's pair exactly, or the
    // statusline injection makes the two derivations fork.
    computeEffectiveSettings(
      settingsConfig,
      meta,
      _category,
      shared,
      providerId,
      _settings,
      opts = {},
    ) {
      return jsonNormalize(
        buildClaudeEffectiveSettings(
          settingsConfig,
          meta,
          shared,
          claudeProviderName(providerId),
          providerId,
          opts,
        ),
      );
    },

    // [C6] — claude's settings_config IS the diffable document.
    parseCommonSnippet(text) {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    providerDocFromSettingsConfig(settingsConfigObj) {
      return isPlainObject(settingsConfigObj) ? settingsConfigObj : null;
    },
    channelOwnedPath: (path) => isPluginChannelPath(path) || isStatusLineChannelPath(path),
    // Runtime state the Claude CLI writes itself (the /model pick) — filtered
    // from the guard and the upward settings sync, and carried across
    // prepare's full regeneration instead of synced as config (mirrors the
    // codex runtimeStatePath contract).
    runtimeStatePath: isClaudeRuntimeStatePath,

    // [C8] Instance instruction file. The @import line is LIVE — global
    // edits flow through without touching the instance file, so there is
    // no snapshot region and no refreshSnapshot.
    instructions: {
      fileName: "CLAUDE.md",
      globalPath() {
        return join(HOME, ".claude", "CLAUDE.md");
      },
      missingGlobalWarn(p) {
        return `⚠ ${p} not found — the @import line will resolve once it exists`;
      },
      buildTemplate(_globalText, globalPath) {
        return [
          `@${globalPath}`,
          "",
          "<!-- ── instance-only instructions (below this line) ── -->",
          "<!-- delete this file to fall back to the shared global CLAUDE.md -->",
          "",
          "",
        ].join("\n");
      },
    },

    // Upward drift: plugin installs/removals/toggles since the last sync.
    // Returns { added, removed, toggled, patch, installedKeys } or null.
    detectPluginDrift(state) {
      const { patch, installedKeys } = computeEnabledPluginsPatch(state);
      const prev = state?.claude || {};
      const prevEnabled = prev.enabledPlugins || {};
      const prevKeys = new Set(prev.installedPluginKeys || []);
      const curKeys = new Set(installedKeys);

      const added = installedKeys.filter((k) => !prevKeys.has(k));
      const removed = [...prevKeys].filter((k) => !curKeys.has(k));
      const toggled: any[] = [];
      for (const [k, v] of Object.entries(patch || {})) {
        if (v !== null && v !== prevEnabled[k])
          toggled.push({ key: k, from: prevEnabled[k], to: v });
      }

      if (!added.length && !removed.length && !toggled.length) return null;
      return {
        added,
        removed,
        toggled,
        patch,
        installedKeys,
        sharedMode: detectSharedConfigMode(),
      };
    },

    // Write-back: apply the plugin patch into the shared document — the live
    // ~/.claude/settings.json in 4.0.2+ mode, common_config_claude in legacy.
    syncPluginsBack(drift) {
      applyEnabledPluginsPatch(drift.patch, drift.sharedMode);
    },

    // Upward drift, channel 2: non-plugin settings fields edited inside a
    // session. Leaf-level diff of every instance's runtime settings.json
    // against its v3 baseline (instances without one are skipped — pre-v3
    // edits can't be told apart from mirrors), arbitrated across instances,
    // then smart-split between common config and provider settings_config.
    // Mirrors computeEnabledPluginsPatch's arbitration: a faithful mirror
    // gets no vote; among voting instances the most recent edit (mtime) wins
    // per path; the plugin channel's subtree is excluded so the two channels
    // never double-report or double-vote; runtime-state paths (the /model
    // pick) are excluded via runtimeStatePath — carried across prepare
    // instead of synced.
    // Returns { instances: [{providerId, name, changes, mtimeMs}],
    //           commonPatch, providerPatches, conflicts: {path: count} } or null.
    // Upward drift of non-plugin fields — thin delegation to the shared
    // generic pipeline below (extracted verbatim from this adapter when
    // codex joined the capability set; the leaf diff, per-path mtime
    // arbitration, and the smart split are CLI-agnostic). Call shape
    // matters: `this` relies on method invocation (the APP_ADAPTERS loop),
    // so don't destructure the adapter out of the table.
    detectSettingsDrift(state) {
      return detectConfigDriftGeneric(this, state);
    },

    // Write-back: apply the split patches. Runs in detectAndPromptSync's
    // confirmed branch AFTER the plugin channel and BEFORE
    // refreshStaleInstances — the write-back makes other instances stale,
    // and refresh rebuilds their baselines so this prompt doesn't re-fire.
    syncSettingsBack(drift) {
      if (drift.sharedMode === "live") {
        applyClaudeLiveSettingsFieldPatches(drift.commonPatch, drift.providerPatches);
      } else {
        applyClaudeSettingsFieldPatches(drift.commonPatch, drift.providerPatches);
      }
    },
  },

  codex: {
    appType: "codex",
    label: "codex",
    displayName: "Codex",
    bin: "codex",
    envVar: "CODEX_HOME",
    commonConfigKey: "common_config_codex",

    // Capability interfaces [C1][C2][C3][C4][C5][C6][C7][C9] — see the
    // comment block above the table. Codex has no plugin concept (that
    // channel never engages), but C6 now owns the injected [tui] status_line
    // subtree (isCodexStatusLineChannelPath): the guard ignores it and the
    // upward settings sync yields it, mirroring claude's statusLine channel.
    instanceSettingsFileName: "config.toml",
    fullAutoFlag: CLI_META.codex.fullAutoFlag,
    // common_config_codex is a TOML text: write-back re-serializes the whole
    // document (parse → patch → stringify), so comments/formatting are lost.
    // Surfaced at the sync prompt; no format-preserving TOML editor exists.
    rewritesCommonOnSync: true,
    channelOwnedPath: isCodexStatusLineChannelPath,
    // Runtime state the Codex CLI writes itself (project trust, hook trust
    // hashes, TUI markers) — filtered from the guard and the upward sync, and
    // carried across prepare's full regeneration instead of synced as config.
    // Change-aware so a subtree appearing whole (baseline lacked it → leaf
    // diff reports "hooks"/"projects", not leaves) is still recognized.
    runtimeStatePath: isCodexRuntimeStateChange,

    parseCommonSnippet(text) {
      try {
        return jsonNormalize(parseToml(text || ""));
      } catch {
        return null;
      }
    },
    // The diffable document is the `config` TOML inside the settings_config
    // JSON envelope ({config, auth, modelCatalog}) — auth and modelCatalog
    // are out of the field channel's scope.
    providerDocFromSettingsConfig(settingsConfigObj) {
      try {
        return jsonNormalize(parseToml(settingsConfigObj?.config || ""));
      } catch {
        return null;
      }
    },

    setupInstance: setupCodexInstance,

    prepare(instanceDir, providerId, settingsConfig, meta, category, commonSnippet, settings) {
      const { configText, auth, catalog, apiKey, stackCatalog } = buildCodexConfig(
        settingsConfig,
        meta,
        category,
        commonSnippet,
        { id: providerId },
        settings,
      );
      atomicWrite(
        join(instanceDir, "config.toml"),
        mergeCodexRuntimeState(configText, instanceDir, stackCatalog),
      );

      const authPath = join(instanceDir, "auth.json");
      const globalAuthPath = join(HOME, ".codex", "auth.json");
      const hasLoginMaterial = codexAuthHasLoginMaterial(auth);
      if (!apiKey && !hasLoginMaterial) {
        // No credentials in the DB: share whatever the global auth holds.
        if (existsSync(globalAuthPath)) {
          ensureSymlink(globalAuthPath, authPath);
        } else {
          atomicWrite(authPath, JSON.stringify({}, null, 2));
        }
      } else if (!apiKey && hasLoginMaterial && !settings.preserveCodexOfficialAuthOnSwitch) {
        // PURE OAuth credentials (no OPENAI_API_KEY — note that the login-
        // material check is true for ANY non-empty auth, so the apiKey guard
        // must come first or API-key auth would get linked too): link the
        // GLOBAL auth file — the same shape as claude's .credentials.json. The CLI rotates tokens
        // by rewriting auth.json mid-session; a per-instance copy dies on
        // the next prepare, which resurrects the DB's stale refresh token
        // and forces a re-login. One shared live file makes the rotation
        // permanent. First run seeds the global file from the DB's stored
        // login material; from then on the DB copy is never handed down
        // again. Trade-off (documented in the README): providers with
        // DIFFERENT ChatGPT accounts can no longer hold independent logins;
        // `preserveCodexOfficialAuthOnSwitch` keeps the legacy per-instance
        // behavior for those who need it.
        if (!existsSync(globalAuthPath)) {
          atomicWrite(globalAuthPath, JSON.stringify(auth, null, 2));
        }
        ensureSymlink(globalAuthPath, authPath);
      } else {
        // API-key credentials (or the preserve opt-out): a deterministic DB
        // artifact the CLI never rewrites — an independent file is correct.
        const authContent = apiKey ? { OPENAI_API_KEY: apiKey } : hasLoginMaterial ? auth : {};
        atomicWrite(authPath, JSON.stringify(authContent, null, 2));
      }

      if (catalog) {
        atomicWrite(
          join(instanceDir, CC_SWITCH_CATALOG_FILENAME),
          JSON.stringify(catalog, null, 2),
        );
      } else if (stackCatalog) {
        // Aggregation row: the catalog is NOT regenerated — the global one is
        // copied verbatim (see readGlobalCodexCatalogText). A failed copy
        // keeps the instance's previous file and warns; the config's
        // model_catalog_json stays pinned to the constant either way.
        copyGlobalCodexCatalogIntoInstance(instanceDir);
      }
    },

    launch(instanceDir, extraArgs, ctx) {
      process.stderr.write(
        `\x1b[2mCODEX_HOME=${instanceDir} codex ${extraArgs.join(" ")}\x1b[0m\n`,
      );
      launchTracked(
        "codex",
        extraArgs,
        instanceDir,
        "CODEX_HOME",
        null,
        buildLaunchExtraEnv(ctx?.providerName, ctx?.providerId),
      );
    },

    // Semantic tree prepare WOULD write: run buildCodexConfig, carry the
    // instance's runtime state across (same merge prepare does), and parse
    // the TOML, normalized identically to the C2 snapshot so the guard's
    // backfill comparison is deterministic. [C3]
    computeEffectiveSettings(
      settingsConfig,
      meta,
      category,
      commonSnippet,
      providerId,
      settings,
      _opts = {},
    ) {
      try {
        const { configText, stackCatalog } = buildCodexConfig(
          settingsConfig,
          meta,
          category,
          commonSnippet,
          { id: providerId },
          settings,
        );
        return jsonNormalize(
          parseToml(
            mergeCodexRuntimeState(configText, codexInstanceDirFor(providerId), stackCatalog),
          ),
        );
      } catch {
        return null;
      }
    },

    // Parsed semantic tree of the instance's config.toml as it sits on disk
    // NOW. TOML comments/whitespace are not semantic — smol-toml may also
    // yield Date/NaN instances, hence the jsonNormalize round-trip (same
    // normalization on the C3 side). Returns null on missing/corrupt file
    // (treated as "no v3 baseline" by every consumer — never a drift
    // report). [C2]
    readInstanceSettingsSnapshot(instanceDir) {
      try {
        return jsonNormalize(parseToml(readFileSync(join(instanceDir, "config.toml"), "utf8")));
      } catch {
        return null;
      }
    },

    permissionArgs(hotkey) {
      return CLI_META.codex.permissionArgs(hotkey);
    },

    // See the claude adapter for the contract (undefined = no permission flag).
    inferHotkeyFromArgs(args) {
      return CLI_META.codex.inferHotkeyFromArgs(args);
    },

    // Same shared pipeline as claude's — method-invocation `this` binding.
    detectSettingsDrift(state) {
      return detectConfigDriftGeneric(this, state);
    },

    // [C7] Write-back goes through the TOML shells below: sqlite's
    // json_patch cannot touch TOML, so common_config_codex and each
    // provider's settings_config.config are read-patched-written with a
    // compare-and-swap on the original text.
    syncSettingsBack(drift) {
      if (drift.sharedMode === "live") applyCodexLiveSettingsFieldPatches(drift);
      else applyCodexSettingsFieldPatches(drift);
    },

    // [C8] Instance instruction file. Codex has no @import mechanism — the
    // template embeds a MARKED snapshot of the global file (refreshable by
    // re-running customize) above the instance-only section.
    instructions: {
      fileName: "AGENTS.md",
      globalPath() {
        return join(HOME, ".codex", "AGENTS.md");
      },
      missingGlobalWarn(p) {
        return `⚠ ${p} not found — the snapshot block will note it until it exists`;
      },
      buildTemplate(globalText, globalPath) {
        return buildCodexInstructionsTemplate(globalText, globalPath);
      },
      refreshSnapshot(existingText, newGlobalText, globalPath) {
        return refreshCodexInstructionsSnapshot(existingText, newGlobalText, globalPath);
      },
    },
  },
} satisfies Record<AppKey, AppAdapter>;

// Typed lookup for dynamic app keys. Callers keep their existing
// "unknown app → skip/error" behavior.
function getAdapter(appType: string): AppAdapter | undefined {
  return (APP_ADAPTERS as unknown as Record<string, AppAdapter>)[appType];
}

// Settings-field upward drift, CLI-agnostic — extracted verbatim from the
// claude adapter when codex joined the C1-C5 capability set. The leaf diff,
// per-path mtime arbitration, and the smart split are shared unchanged; the
// adapter supplies only instance dir, baseline map, common-snippet parsing
// [C4], provider-document extraction [C5], the channel filter [C6], and the
// runtime-state filter (paths that never sync — they're carried across
// prepare instead).
// Reads instance files + DB; writes nothing.
function detectConfigDriftGeneric(adapter: any, state: any) {
  const dir = join(INSTANCES_DIR, adapter.appType);
  const baselines = state?.instances?.[adapter.appType] || {};
  if (!existsSync(dir)) return null;

  // Parse the current shared document once; used both for split decisions
  // and for "already equal in the target" filtering. In 4.0.2+ live mode an
  // unreadable global file means we cannot tell which paths the shared
  // document owns — guessing would write user keys into provider rows, so
  // skip the field channel for this run (the launch guard still protects the
  // instance files).
  const shared = readSharedConfig(adapter.appType);
  if (shared.mode === "live" && shared.unavailable) return null;
  const commonObj = adapter.parseCommonSnippet(sharedSnippetText(shared)) ?? {};

  const candidates: any[] = [];
  for (const name of readdirSyncSafe(dir) || []) {
    try {
      const instDir = join(dir, name);
      const current = adapter.readInstanceSettingsSnapshot(instDir);
      const baseline = baselines[name]?.preparedSettings;
      if (!isPlainObject(baseline)) continue; // no v3 baseline — no vote
      if (current === null || deepEqualJson(current, baseline)) continue; // unchanged/corrupt mirror
      const changes = diffSettingsLeaves(baseline, current).filter(
        (ch) =>
          !adapter.channelOwnedPath?.(ch.path) &&
          !adapter.runtimeStatePath?.(ch.path, ch) &&
          !isCodexAggModelPath(adapter.appType, name, ch.path),
      );
      if (changes.length === 0) continue; // only channel-owned edits
      let mtimeMs = 0;
      try {
        mtimeMs = lstatSync(join(instDir, adapter.instanceSettingsFileName)).mtimeMs;
      } catch {}
      candidates.push({ providerId: name, changes, mtimeMs });
    } catch {
      // missing/corrupt instance config — skip
    }
  }
  if (candidates.length === 0) return null;

  // Per-path vote: a candidate that never changed a path relative to ITS
  // OWN baseline has no say on that path (it only diverges from the
  // group, not from what it was given). Winner = newest mtime.
  const votes = new Map<string, any[]>(); // path → [{candidate, change}]
  for (const cand of candidates) {
    for (const ch of cand.changes) {
      if (!votes.has(ch.path)) votes.set(ch.path, []);
      votes.get(ch.path)!.push({ cand, ch });
    }
  }
  const commonPatch = {};
  const providerPatches: Record<string, any> = {};
  const conflicts: Record<string, number> = {};
  const rejectedPaths: string[] = [];
  const rejectedReasons: Record<string, string> = {}; // path → "sensitive" | "virtual" (prompt wording)
  let virtualBlocked = false; // provider-target changes refused for the virtual Stack entry
  const warnedMalformedRows = new Set<string>();
  for (const [path, voters] of votes.entries()) {
    voters.sort((a, b) => a.cand.mtimeMs - b.cand.mtimeMs);
    const winner = voters[voters.length - 1];
    if (voters.length > 1) conflicts[path] = voters.length;

    const row = queryProviderById(winner.cand.providerId, adapter.appType);
    const parsedRowSettings = row ? parseJsonObject(row.settings_config) : null;
    // One malformed row used to throw out of this loop and abort the whole
    // drift pass (every launch failed). Skip that row's write-back and keep
    // the other providers syncing; warn once per provider.
    if (row && !parsedRowSettings) {
      if (!warnedMalformedRows.has(row.id)) {
        warnedMalformedRows.add(row.id);
        console.error(
          `⚠ Provider "${row.name || row.id}" has malformed settings_config JSON — skipping its drift write-back.`,
        );
      }
      continue;
    }
    const providerSettings = parsedRowSettings
      ? adapter.providerDocFromSettingsConfig(parsedRowSettings)
      : null;
    if (!providerSettings || !row) continue; // provider row gone — provider-target path is dropped

    const {
      commonPatch: cp,
      providerPatch: pp,
      rejected: rj,
    } = splitChangesByTarget(
      [winner.ch],
      winner.cand.providerId,
      commonObj,
      providerSettings,
      // The virtual Stack entry has no DB row: provider-target edits cannot be
      // written back (they'd be silently rebuilt by the next prepare anyway) —
      // route them to rejected so the prompt says so instead of dropping them.
      row.is_virtual ? { virtualProvider: true } : {},
    );
    if (row.is_virtual && rj.length) virtualBlocked = true;
    Object.assign(commonPatch, cp);
    for (const ch of rj) {
      rejectedPaths.push(ch.path);
      // Mirror splitChangesByTarget's branches: the sensitive gate only
      // fires on paths common owns; virtual-row refusal only on the rest.
      rejectedReasons[ch.path] =
        row.is_virtual && !pathExistsInSnippet(commonObj, ch.path) ? "virtual" : "sensitive";
    }
    // pp is ONE change's nested patch object (path-keyed), not {pid: patch} —
    // merge it under the WINNING provider's id.
    if (Object.keys(pp).length) {
      providerPatches[winner.cand.providerId] = jsonDeepMerge(
        providerPatches[winner.cand.providerId] || {},
        pp,
      );
    }
  }
  // All-rejected drift must still surface: every change was refused, but
  // the prompt has to say so instead of going silent.
  if (
    !Object.keys(commonPatch).length &&
    !Object.keys(providerPatches).length &&
    !rejectedPaths.length
  )
    return null;

  // Display-facing: one entry per candidate instance with its (filtered)
  // changes, plus the name resolution for the prompt lines.
  const nameById = new Map(queryProvidersByApp(adapter.appType).map((p) => [p.id, p.name]));
  const instances = candidates.map((c) => ({
    providerId: c.providerId,
    name: nameById.get(c.providerId) || c.providerId,
    changes: c.changes,
    mtimeMs: c.mtimeMs,
  }));
  return {
    instances,
    commonPatch,
    providerPatches,
    conflicts,
    rejected: rejectedPaths,
    rejectedReasons,
    virtualBlocked,
    sharedMode: shared.mode,
  };
}

// Set of plugin keys ("name@source") with a user-scope install record — the
// source of truth for "what's installed at user level".
function readUserInstalledPluginSet() {
  try {
    const file = join(HOME, ".claude", "plugins", "installed_plugins.json");
    if (!existsSync(file)) return new Set();
    const data = JSON.parse(readFileSync(file, "utf8"));
    const set = new Set();
    for (const [k, recs] of Object.entries(data.plugins || {})) {
      if (Array.isArray(recs) && recs.some((r) => r && r.scope === "user")) set.add(k);
    }
    return set;
  } catch {
    return new Set();
  }
}

// The shared document's enabledPlugins map: the live global file in 4.0.2+
// mode (projected user keys), common_config_claude otherwise.
function readSharedEnabledPlugins() {
  try {
    const shared = readSharedConfig("claude");
    if (shared.mode === "live" && shared.unavailable) return {};
    const ep = shared.parsed?.enabledPlugins;
    return isPlainObject(ep) ? ep : {};
  } catch {
    return {};
  }
}

function readSharedEnabledPluginKeys() {
  return Object.keys(readSharedEnabledPlugins());
}

// Backward-compatible alias (legacy naming, same behavior).
const readCommonEnabledPluginKeys = readSharedEnabledPluginKeys;

// Compute the enabledPlugins patch to write back into common_config_claude,
// based on all claude instances' runtime settings + the user-scope install
// set. Pure — does not touch the DB. installed_plugins.json's user-scope
// records are the source of truth for "what's installed", so all three
// operations are captured:
//  - enable/disable: explicit true/false from any instance → merged into common.
//  - uninstall: a plugin dropped from user-scope is removed from common (null),
//    even if a stale instance still lists it as enabled.
//
// Arbitration: an instance's enabledPlugins that still matches the baseline
// recorded the last time cc-switch generated its settings.json (state.instances)
// carries no user intent — it's just a mirror of whatever common config looked
// like at prepare time — so it does not get a vote. Among instances that were
// actually edited by the user (e.g. via /plugin), the most recently modified
// settings.json wins per key. Instances with no recorded baseline (e.g. a
// sync-state.json predating this tracking) are treated as lowest priority so
// they don't clobber instances we do have provenance for.
// Returns { patch, installedKeys } — patch is a json_patch object or null.
function computeEnabledPluginsPatch(state: any) {
  try {
    const dir = join(INSTANCES_DIR, "claude");
    const installedUser = readUserInstalledPluginSet();
    const baselines = state?.instances?.claude || {};
    const candidates: any[] = [];
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        try {
          const settingsPath = join(dir, name, "settings.json");
          const s = JSON.parse(readFileSync(settingsPath, "utf8"));
          const cur = isPlainObject(s.enabledPlugins) ? s.enabledPlugins : {};
          const baseline = baselines[name]?.enabledPlugins;
          const known = baseline !== undefined;
          if (known && shallowEqualPlugins(cur, baseline)) continue; // unchanged mirror — no vote
          const ep = collectEnabledPluginsPatch(cur);
          if (!ep) continue;
          let mtimeMs = 0;
          try {
            mtimeMs = lstatSync(settingsPath).mtimeMs;
          } catch {}
          candidates.push({ ep, known, mtimeMs });
        } catch {
          // missing/corrupt instance settings — skip
        }
      }
    }
    // Unknown-baseline candidates apply first (lowest priority); among the
    // rest, oldest-first so the most recently modified instance wins last.
    candidates.sort((a, b) => (a.known !== b.known ? (a.known ? 1 : -1) : a.mtimeMs - b.mtimeMs));

    const epPatch: Record<string, any> = {};
    let has = false;
    for (const { ep } of candidates) {
      for (const [k, v] of Object.entries(ep)) {
        // Only honor states for plugins still installed at user scope;
        // stale entries for uninstalled plugins are ignored.
        if (installedUser.has(k)) {
          epPatch[k] = v;
          has = true;
        }
      }
    }
    // Remove from the shared document any plugin no longer installed at user
    // scope.
    for (const k of readSharedEnabledPluginKeys()) {
      if (!installedUser.has(k) && !(k in epPatch)) {
        epPatch[k] = null;
        has = true;
      }
    }
    return { patch: has ? epPatch : null, installedKeys: [...installedUser] };
  } catch {
    // best-effort: unreadable instances dir or DB lock — return empty.
    return { patch: null, installedKeys: [] };
  }
}

// Write an enabledPlugins patch into the shared document (used by the sync
// flow after user confirmation): the live global file in 4.0.2+ mode,
// common_config_claude in legacy. No-op on an empty patch.
function applyEnabledPluginsPatch(patch: any, sharedMode = detectSharedConfigMode()) {
  if (!patch || Object.keys(patch).length === 0) return;
  try {
    if (sharedMode === "live") applyClaudeLivePluginPatch(patch);
    else patchCommonConfigClaude({ enabledPlugins: patch });
  } catch {
    // best-effort: DB lock or unreadable — skip write-back silently.
  }
}

export {
  APP_ADAPTERS,
  applyEnabledPluginsPatch,
  computeEnabledPluginsPatch,
  detectConfigDriftGeneric,
  getAdapter,
  readCommonEnabledPluginKeys,
  readSharedEnabledPluginKeys,
  readSharedEnabledPlugins,
  readUserInstalledPluginSet,
};
