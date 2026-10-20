// ─── main entry (split from bin/cc-launch.mjs) ──────────────────────────

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { APP_ADAPTERS } from "./adapters.js";
import { buildClaudeEffectiveSettings, claudeInstanceSettingsPath, isClaudeRuntimeStatePath } from "./claude-config.js";
import { buildCodexInstructionsTemplate, parseCustomizeArgs, printHelp, refreshCodexInstructionsSnapshot, runCustomize, runUncustomize } from "./commands/customize.js";
import { aggregationDoctorChecks, codexAggregationDoctorChecks, runClean, runDoctor } from "./commands/doctor.js";
import { runPs, stackBillingMemberName } from "./commands/ps.js";
import { isQuickLaunchKey, runQuickLaunch } from "./commands/quick.js";
import { queryProvider, queryProviderById, queryProviderMatches, queryProvidersByApp, queryProvidersStrict, readSchemaUserVersion } from "./db.js";
import { detectAndPromptSync } from "./drift.js";
import { formatSettingsChangeLine, guardInstanceConfigBeforeOverwrite } from "./guard.js";
import { healRecordedArgs, isDeadEntry, snapshotAliveByCli, stripOneShotFlags } from "./history.js";
import { applyMergePatch, deepEqualJson, diffSettingsLeaves, jsonDeepMerge, jsonNormalize, mergeCommonOverProvider, parseJsonObject } from "./json-utils.js";
import { launchProvider } from "./launch.js";
import { formatAmbiguousProvider, resolveProviderRef } from "./provider-ref.js";
import { HOME, NPM_PACKAGE_NAME, VERSION, VIRTUAL_STACK_PROVIDER_ID } from "./paths.js";
import { buildLaunchExtraEnv } from "./sessions.js";
import { claudeExclusiveEnv, claudeFloorEnv, claudeFloorTop, detectSharedConfigMode, isLiveSharedSnippet, projectClaudeSharedKeys, projectCodexSharedKeys, readSharedConfig, resetSharedConfigWarnings, sharedConfigHash, sharedSnippetText } from "./shared-config.js";
import { applyCodexStatusLineInjection, codexAggregationRoute, codexInstanceDirFor, copyGlobalCodexCatalogIntoInstance, isCodexRuntimeStateChange, isCodexRuntimeStatePath, isCodexStatusLineChannelPath, mergeCodexRuntimeState, protectCodexAggregationIdentity, readGlobalCodexCatalogText } from "./stack/catalog.js";
import { aggregationBaseUrlFor, appendVirtualStackRow, buildAggregationGroup, buildCodexStackSettingsFromGlobal, buildStackSettingsFromGlobal, buildStackUsageConfig, cleanupLegacyStackRows, codexStackDormantSettings, isAggregationProviderSettings, isCodexAggModelPath, isCodexAggregationProviderSettings, isLoopbackBaseUrl, probeTcpReachable, protectAggregationIdentityEnv, providerIsAggregation, readGlobalModelPicker, readStackState, virtualStackProviderFor } from "./stack/state.js";
import { USAGE_CACHE_FILENAME, buildUsageQueryConfig, extractClaudeUsageSource, resolveUsageIdentity, usageEndpointFor } from "./stack/usage.js";
import { applyStatusLineInjection, buildStackUsageWrapperLines, buildStatusLineWrapperScript, buildUsageWrapperLines, claudeProviderName, isStatusLineChannelPath } from "./statusline.js";
import { STATUSLINE_COLOR_CHOICES, STATUSLINE_DISPLAY_ITEMS, detectStatuslineRelay, loadStatuslineDisplay, loadStatuslinePreferences, normalizeDisplayPreferences, saveStatuslineColor, saveStatuslineDisplay, statuslineColorFor } from "./statusline-colors.js";
import { applyTomlPatchText } from "./toml-utils.js";
import { buildStatuslinePanelLines, launchRefForQuick, launchRefForRow, runTUI } from "./tui.js";
import { applyClaudeLivePluginPatch, applyClaudeLiveSettingsFieldPatches, applyCodexLiveSettingsFieldPatches, buildNestedAssign, foldRemovalPatch, getPathValue, isSensitiveConfigKey, isSensitiveConfigPath, pathExistsInSnippet, resolvePathSegments, splitChangesByTarget } from "./upward.js";

// ─── Main entry ────────────────────────────────────────────────────────

// A volta-managed install (`volta install <pkg>`) execs this script from
// ~/.volta/tools/image/packages/...; the copy `npm install -g` updates lives
// under image/node/<ver>/lib/ instead, which the volta shim never reads — so
// updating that copy silently does nothing for the shim. Detect it here so
// `switch update` goes through volta itself.
function isVoltaManagedInstall() {
  try {
    return realpathSync(process.argv[1] || "").includes("/.volta/tools/image/packages/");
  } catch {
    return false;
  }
}

// Version actually on disk at the location this install mode executes from.
// The update confirmation reads this — not what npm claimed — so a silent
// partial install can't pass as a success.
function readInstalledVersion() {
  let pkgJsonPath: string | null = null;
  if (isVoltaManagedInstall()) {
    pkgJsonPath = join(HOME, ".volta", "tools", "image", "packages", NPM_PACKAGE_NAME,
      "lib", "node_modules", NPM_PACKAGE_NAME, "package.json");
  } else {
    try {
      pkgJsonPath = join(execSync("npm root -g", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(), NPM_PACKAGE_NAME, "package.json");
    } catch {}
  }
  try {
    const v = JSON.parse(readFileSync(pkgJsonPath!, "utf8")).version;
    if (typeof v === "string" && v) return v;
  } catch {}
  return null;
}

// Shared tail for both update paths: confirm against what is really on disk,
// and fail loudly (non-zero) when the disk still disagrees.
function reportUpdateOutcome(latestVersion) {
  const installed = readInstalledVersion();
  if (installed === latestVersion) {
    console.log(`✓ Updated to v${latestVersion}`);
    process.exit(0);
  }
  console.error(`⚠ Update command finished, but the install on disk reads v${installed ?? "unknown"} — restart your terminal and run \`switch update\` again if it still shows the old version.`);
  process.exit(1);
}

async function runUpdate() {
  const currentVersion = VERSION;
  console.log(`Current version: v${currentVersion}`);

  let latestVersion;
  try {
    latestVersion = execSync(`npm view ${NPM_PACKAGE_NAME} version`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    console.error("✗ Failed to query latest version. Please check your network connection.");
    process.exit(1);
  }

  if (currentVersion === latestVersion) {
    console.log("Already up to date.");
    process.exit(0);
  }

  console.log(`Updating to v${latestVersion}...`);

  if (isVoltaManagedInstall()) {
    const r = spawnSync("volta", ["install", `${NPM_PACKAGE_NAME}@latest`], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`✗ Update failed — try running \`volta install ${NPM_PACKAGE_NAME}@latest\` manually.`);
      process.exit(r.status || 1);
    }
    reportUpdateOutcome(latestVersion);
  }

  try {
    execSync(`npm install -g ${NPM_PACKAGE_NAME}@latest`, { stdio: "inherit" });
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || "");
    if (/EACCES|EPERM|EISDIR/.test(msg)) {
      console.error(`✗ Permission denied. Try: sudo npm install -g ${NPM_PACKAGE_NAME}@latest`);
    } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|network|fetch failed/.test(msg)) {
      console.error("✗ Network error during install. Please check your connection and retry.");
    } else {
      console.error(`✗ Update failed: ${msg.trim() || "unknown error"}`);
    }
    process.exit(1);
  }
  reportUpdateOutcome(latestVersion);
}

// Parse leading launch flags. `--id` selects a provider by id and is
// mutually exclusive with the positional provider name (with --id the first
// positional token is the command); everything after that is forwarded
// verbatim to the launched CLI.
function parseLaunchArgs(argv: string[]) {
  const rest = [...argv];
  let syncFlag: string | null = null;
  let providerId: string | null = null;
  while (rest.length) {
    const a = rest[0];
    if (a === "--sync") { syncFlag = "on"; rest.shift(); continue; }
    if (a === "--no-sync") { syncFlag = "off"; rest.shift(); continue; }
    if (a === "--id") {
      rest.shift();
      const value = rest.shift();
      if (!value) return { error: "missing --id value" as const };
      providerId = value;
      continue;
    }
    if (a.startsWith("--id=")) {
      const value = a.slice("--id=".length);
      if (!value) return { error: "missing --id value" as const };
      providerId = value;
      rest.shift();
      continue;
    }
    break;
  }
  return { syncFlag, providerId, rest };
}

async function main() {
  // Leading flags (command mode only). They must be stripped before any other
  // parsing since the remainder of argv is forwarded verbatim to the launched
  // CLI (e.g. `claude --continue`) — a flag parsed anywhere but the front
  // could be mistaken for a CLI argument.
  const parsed = parseLaunchArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`✗ ${parsed.error}`);
    console.error(`Usage: switch [--sync|--no-sync] [--id <providerId>] <cmd> [args...]`);
    process.exit(1);
  }
  const { syncFlag, providerId, rest: args } = parsed;

  if (args.length === 0) {
    try {
      await runTUI();
    } catch (e: any) {
      // Ctrl-C during the pre-TUI sync prompt carries exitCode 130 and is
      // intentionally quiet; everything else is reported.
      if (e.message !== "Cancelled" && e.exitCode !== 130) console.error(`✗ ${e.message}`);
      process.exit(e.exitCode ?? 1);
    }
    return;
  }

  if (args[0] === "update" || args[0] === "self-update" || args[0] === "--update") {
    await runUpdate();
    return;
  }

  if (args[0] === "sync") {
    const result = await detectAndPromptSync({ tui: true });
    if (result.needsTTY) {
      console.error("✗ switch sync requires an interactive terminal — run it directly in a terminal.");
      process.exit(1);
    }
    if (result.interrupted) process.exit(130);
    if (result.inputClosed) {
      console.error("✗ Input closed before confirmation — no changes written.");
      process.exit(1);
    }
    if (!result.drifted) console.log("No config drift detected — everything in sync.");
    else if (result.synced) {
      console.log(
        result.refreshed?.length
          ? `✓ Synced (refreshed: ${result.refreshed.join(", ")}).`
          : "✓ Synced.",
      );
    } else console.log("Skipped — no changes written.");
    process.exit(0);
    return;
  }

  if (args[0] === "doctor") {
    await runDoctor();
    return;
  }

  if (args[0] === "clean") {
    await runClean(args.slice(1));
    return;
  }

  if (args[0] === "ps") {
    runPs();
    return;
  }

  if (args[0] === "customize") {
    runCustomize(args.slice(1));
    return;
  }

  if (args[0] === "uncustomize") {
    await runUncustomize(args.slice(1));
    return;
  }

  if (args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    printHelp();
    process.exit(0);
    return;
  }

  if (args[0] === "-v" || args[0] === "--version" || args[0] === "version") {
    const v = VERSION;
    const latest = (() => {
      try {
        return execSync(`npm view ${NPM_PACKAGE_NAME} version`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch {
        return null;
      }
    })();
    console.log(`cc-switch-parallel v${v}${latest ? (v === latest ? " (latest)" : ` (latest: ${latest})`) : ""}`);
    process.exit(0);
  }

  if (providerId !== null) {
    if (args.length < 1) {
      console.error(`Usage: switch --id <providerId> <cmd> [args...]`);
      process.exit(1);
    }
    await launchProvider(args[0], { id: providerId }, args.slice(1), syncFlag);
    return;
  }

  if (args.length < 2) {
    // Recent top5 shortcut: a bare `a`/`s`/`d`/`f`/`g` launches that slot
    // exactly as the TUI's quick key would, without opening the picker. Only
    // the single-token form qualifies — with a second token this is the
    // provider-name path below.
    if (args.length === 1 && isQuickLaunchKey(args[0])) {
      await runQuickLaunch(args[0], syncFlag);
      return;
    }
    console.error(`Usage: switch <provider> <cmd> [args...]`);
    console.error(`       switch --id <providerId> <cmd> [args...]`);
    console.error(`       switch a|s|d|f|g                     (launch a Recent top5 slot)`);
    console.error(`  Run \`switch --help\` for all commands.`);
    console.error(`Examples: switch "Claude Official" claude`);
    console.error(`          switch "Zhipu GLM en" claude --continue`);
    console.error(`          switch --id <providerId> claude`);
    console.error(`          switch s                      (Recent slot 2, same as the TUI)`);
    process.exit(1);
  }

  const providerName = args[0];
  const cmd = args[1];
  const extraArgs = args.slice(2);
  await launchProvider(cmd, { name: providerName }, extraArgs, syncFlag);
}


// Test-only export surface. Frozen so callers can't reach module internals.
export const __test = Object.freeze({
  mergeCommonOverProvider,
  protectAggregationIdentityEnv,
  jsonDeepMerge,
  applyMergePatch,
  jsonNormalize,
  parseJsonObject,
  applyTomlPatchText,
  deepEqualJson,
  isSensitiveConfigKey,
  isSensitiveConfigPath,
  stripOneShotFlags,
  healRecordedArgs,
  queryProvider,
  queryProviderById,
  queryProviderMatches,
  queryProvidersByApp,
  queryProvidersStrict,
  parseLaunchArgs,
  resolveProviderRef,
  formatAmbiguousProvider,
  launchRefForQuick,
  launchRefForRow,
  snapshotAliveByCli,
  isDeadEntry,
  splitChangesByTarget,
  buildNestedAssign,
  pathExistsInSnippet,
  getPathValue,
  foldRemovalPatch,
  diffSettingsLeaves,
  guardInstanceConfigBeforeOverwrite,
  parseCustomizeArgs,
  buildCodexInstructionsTemplate,
  refreshCodexInstructionsSnapshot,
  buildClaudeEffectiveSettings,
  claudeInstanceSettingsPath,
  isClaudeRuntimeStatePath,
  applyStatusLineInjection,
  buildStatusLineWrapperScript,
  isStatusLineChannelPath,
  claudeProviderName,
  statuslineColorFor,
  saveStatuslineColor,
  loadStatuslinePreferences,
  STATUSLINE_DISPLAY_ITEMS,
  loadStatuslineDisplay,
  saveStatuslineDisplay,
  normalizeDisplayPreferences,
  detectStatuslineRelay,
  buildStatuslinePanelLines,
  buildLaunchExtraEnv,
  STATUSLINE_COLOR_CHOICES,
  applyCodexStatusLineInjection,
  isCodexStatusLineChannelPath,
  isCodexRuntimeStatePath,
  isCodexRuntimeStateChange,
  formatSettingsChangeLine,
  mergeCodexRuntimeState,
  codexInstanceDirFor,
  resolvePathSegments,
  extractClaudeUsageSource,
  resolveUsageIdentity,
  usageEndpointFor,
  buildUsageQueryConfig,
  buildUsageWrapperLines,
  isLoopbackBaseUrl,
  isAggregationProviderSettings,
  isCodexAggregationProviderSettings,
  codexAggregationRoute,
  providerIsAggregation,
  aggregationBaseUrlFor,
  buildCodexStackSettingsFromGlobal,
  codexStackDormantSettings,
  protectCodexAggregationIdentity,
  copyGlobalCodexCatalogIntoInstance,
  readGlobalCodexCatalogText,
  isCodexAggModelPath,
  readStackState,
  readGlobalModelPicker,
  buildStackSettingsFromGlobal,
  virtualStackProviderFor,
  appendVirtualStackRow,
  VIRTUAL_STACK_PROVIDER_ID,
  buildStackUsageConfig,
  buildStackUsageWrapperLines,
  buildAggregationGroup,
  cleanupLegacyStackRows,
  probeTcpReachable,
  aggregationDoctorChecks,
  codexAggregationDoctorChecks,
  stackBillingMemberName,
  USAGE_CACHE_FILENAME,
  APP_ADAPTERS,
  readSchemaUserVersion,
  readSharedConfig,
  detectSharedConfigMode,
  projectClaudeSharedKeys,
  projectCodexSharedKeys,
  sharedConfigHash,
  sharedSnippetText,
  isLiveSharedSnippet,
  claudeFloorTop,
  claudeFloorEnv,
  claudeExclusiveEnv,
  resetSharedConfigWarnings,
  applyClaudeLiveSettingsFieldPatches,
  applyClaudeLivePluginPatch,
  applyCodexLiveSettingsFieldPatches,
});

export { isVoltaManagedInstall, main, readInstalledVersion, reportUpdateOutcome, runUpdate };
