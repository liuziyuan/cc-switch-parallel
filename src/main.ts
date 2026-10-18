// ─── main entry (split from bin/cc-launch.mjs) ──────────────────────────

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { APP_ADAPTERS } from "./adapters.js";
import { buildClaudeEffectiveSettings, claudeInstanceSettingsPath, isClaudeRuntimeStatePath } from "./claude-config.js";
import { buildCodexInstructionsTemplate, parseCustomizeArgs, printHelp, refreshCodexInstructionsSnapshot, runCustomize, runUncustomize } from "./commands/customize.js";
import { aggregationDoctorChecks, codexAggregationDoctorChecks, runClean, runDoctor } from "./commands/doctor.js";
import { runPs, stackBillingMemberName } from "./commands/ps.js";
import { queryProvider, queryProviderById, queryProvidersByApp, queryProvidersStrict } from "./db.js";
import { detectAndPromptSync } from "./drift.js";
import { formatSettingsChangeLine, guardInstanceConfigBeforeOverwrite } from "./guard.js";
import { healRecordedArgs, isDeadEntry, snapshotAliveByCli, stripOneShotFlags } from "./history.js";
import { applyMergePatch, deepEqualJson, diffSettingsLeaves, jsonDeepMerge, jsonNormalize, mergeCommonOverProvider, parseJsonObject } from "./json-utils.js";
import { launchProvider } from "./launch.js";
import { HOME, NPM_PACKAGE_NAME, VERSION, VIRTUAL_STACK_PROVIDER_ID } from "./paths.js";
import { buildLaunchExtraEnv } from "./sessions.js";
import { applyCodexStatusLineInjection, codexAggregationRoute, codexInstanceDirFor, copyGlobalCodexCatalogIntoInstance, isCodexRuntimeStateChange, isCodexRuntimeStatePath, isCodexStatusLineChannelPath, mergeCodexRuntimeState, protectCodexAggregationIdentity, readGlobalCodexCatalogText } from "./stack/catalog.js";
import { aggregationBaseUrlFor, appendVirtualStackRow, buildAggregationGroup, buildCodexStackSettingsFromGlobal, buildStackSettingsFromGlobal, buildStackUsageConfig, cleanupLegacyStackRows, codexStackDormantSettings, isAggregationProviderSettings, isCodexAggModelPath, isCodexAggregationProviderSettings, isLoopbackBaseUrl, probeTcpReachable, protectAggregationIdentityEnv, providerIsAggregation, readGlobalModelPicker, readStackState, virtualStackProviderFor } from "./stack/state.js";
import { USAGE_CACHE_FILENAME, buildUsageQueryConfig, extractClaudeUsageSource, resolveUsageIdentity, usageEndpointFor } from "./stack/usage.js";
import { applyStatusLineInjection, buildStackUsageWrapperLines, buildStatusLineWrapperScript, buildUsageWrapperLines, claudeProviderName, isStatusLineChannelPath } from "./statusline.js";
import { STATUSLINE_COLOR_CHOICES, loadStatuslinePreferences, saveStatuslineColor, statuslineColorFor } from "./statusline-colors.js";
import { applyTomlPatchText } from "./toml-utils.js";
import { runTUI } from "./tui.js";
import { buildNestedAssign, foldRemovalPatch, getPathValue, isSensitiveConfigKey, isSensitiveConfigPath, pathExistsInSnippet, resolvePathSegments, splitChangesByTarget } from "./upward.js";

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

async function main() {
  const args = process.argv.slice(2);

  // Leading --sync / --no-sync flag (command mode only). Must be stripped
  // before any other parsing since the remainder of argv is forwarded
  // verbatim to the launched CLI (e.g. `claude --continue`) — a flag parsed
  // anywhere but the front could be mistaken for a CLI argument.
  let syncFlag: string | null = null;
  while (args.length && (args[0] === "--sync" || args[0] === "--no-sync")) {
    syncFlag = args.shift() === "--sync" ? "on" : "off";
  }

  if (args.length === 0) {
    try {
      await runTUI();
    } catch (e: any) {
      if (e.message !== "Cancelled") console.error(`✗ ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (args[0] === "update" || args[0] === "self-update" || args[0] === "--update") {
    await runUpdate();
    return;
  }

  if (args[0] === "sync") {
    const result = await detectAndPromptSync({ tui: true });
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

  if (args.length < 2) {
    console.error(`Usage: switch <provider> <cmd> [args...]`);
    console.error(`  Run \`switch --help\` for all commands.`);
    console.error(`Examples: switch "Claude Official" claude`);
    console.error(`          switch "Zhipu GLM en" claude --continue`);
    console.error(`          switch "P&G Nezha" codex`);
    process.exit(1);
  }

  const providerName = args[0];
  const cmd = args[1];
  const extraArgs = args.slice(2);
  await launchProvider(cmd, providerName, extraArgs, syncFlag);
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
  queryProvidersByApp,
  queryProvidersStrict,
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
});

export { isVoltaManagedInstall, main, readInstalledVersion, reportUpdateOutcome, runUpdate };
