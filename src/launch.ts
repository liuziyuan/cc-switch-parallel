// ─── launch (split from bin/cc-launch.mjs) ─────────────────────────────

import { join } from "node:path";
import { APP_ADAPTERS, getAdapter } from "./adapters.js";
import { loadSettings, queryProvidersByApp } from "./db.js";
import { detectAndPromptSync, recordInstanceBaseline } from "./drift.js";
import { guardInstanceConfigBeforeOverwrite } from "./guard.js";
import { recordLaunch } from "./history.js";
import { parseJsonObject } from "./json-utils.js";
import {
  formatAmbiguousProvider,
  formatAvailableProviders,
  resolveProviderRef,
  type ProviderRef,
} from "./provider-ref.js";
import { readSharedConfig } from "./shared-config.js";
import {
  aggregationBaseUrlFor,
  cleanupLegacyStackRows,
  probeTcpReachable,
  reportLegacyStackCleanup,
} from "./stack/state.js";

// ─── Launch logic ──────────────────────────────────────────────────────

// syncFlag: null (default) = non-blocking stderr warning if drifted;
//           "on"  (--sync)    = interactive confirm before launching;
//           "off" (--no-sync) = fully silent, no warning at all.
// record: optional {hotkey} from the TUI quick/permission selection — the
//         mode the user actually picked, preferred over inferring it back
//         out of extraArgs (which quick-launch replays without flags).
// Shared error path for an unresolvable provider ref (used by the early
// command-mode resolve and the post-sync resolve).
function exitProviderRefError(ref: ProviderRef, adapter: any, resolved: any, cmd: string): never {
  if (resolved.error === "ambiguous") {
    console.error(formatAmbiguousProvider(ref?.name || "", adapter.appType, resolved.matches, cmd));
  } else {
    const label = ref?.id ? `id "${ref.id}"` : `"${ref?.name || ""}"`;
    console.error(`✗ Provider ${label} not found (${adapter.appType})`);
    console.error(formatAvailableProviders(queryProvidersByApp(adapter.appType)));
  }
  process.exit(1);
}

async function launchProvider(
  cmd: string,
  ref: ProviderRef,
  extraArgs: string[],
  syncFlag: string | null = null,
  record: { hotkey?: string } | null = null,
) {
  const adapter = getAdapter(cmd);
  if (!adapter) {
    console.error(
      `✗ Unsupported command: ${cmd}. Supported: ${Object.keys(APP_ADAPTERS).join(", ")}`,
    );
    process.exit(1);
  }

  // Command-mode launches resolve the provider BEFORE drift detection so the
  // stale list can annotate the instance this launch is about to refresh.
  // --sync keeps the old order: its interactive write-back could invalidate a
  // row resolved beforehand, and the prompt may legitimately list the
  // launched provider (confirming sync refreshes it too).
  const resolveBeforeSync = syncFlag !== "on";
  let resolved: any = null;

  if (resolveBeforeSync) {
    // One-time migration of pre-virtualization aggregation rows — command
    // mode never opens the TUI, so the claude launch path carries its own
    // pass. Runs BEFORE the lookup: a by-name launch of "Stack" must hit the
    // virtual entry, not a legacy row that is about to be deleted.
    if (adapter.appType === "claude") {
      reportLegacyStackCleanup(cleanupLegacyStackRows());
    }
    resolved = resolveProviderRef(ref, adapter.appType);
    if (!resolved.ok) exitProviderRefError(ref, adapter, resolved, cmd);
  }

  const sync = await detectAndPromptSync({
    tui: syncFlag === "on",
    quiet: syncFlag === "off",
    highlightProvider:
      resolveBeforeSync && resolved?.ok
        ? { appType: adapter.appType, id: resolved.row.id, name: resolved.row.name }
        : null,
  });
  if (sync.interrupted) process.exit(130);
  if (sync.inputClosed) {
    console.error("✗ Input closed before confirmation — launch aborted.");
    process.exit(1);
  }
  if (sync.needsTTY) {
    console.error("✗ --sync requires an interactive terminal.");
    process.exit(1);
  }

  if (!resolveBeforeSync) {
    // --sync path: migrate and resolve after the write-back, so prepare uses
    // the row as it exists once the sync has been applied.
    if (adapter.appType === "claude") {
      reportLegacyStackCleanup(cleanupLegacyStackRows());
    }
    resolved = resolveProviderRef(ref, adapter.appType);
    if (!resolved.ok) exitProviderRefError(ref, adapter, resolved, cmd);
  }
  const row = resolved.row;

  const parsedSettingsConfig = parseJsonObject(row.settings_config);
  const parsedMeta = parseJsonObject(row.meta);
  // Malformed rows must not reach prepare: it would atomically write "null",
  // "[]" or a quoted scalar as the instance's settings.json. Degrade to {}
  // with a loud warning instead of aborting the launch.
  if (!parsedSettingsConfig) {
    console.error(
      `⚠ Provider "${row.name}" has malformed settings_config JSON — launching with an empty config (repair the row in cc-switch).`,
    );
  }
  if (!parsedMeta) {
    console.error(`⚠ Provider "${row.name}" has malformed meta JSON — launching with empty meta.`);
  }
  const settingsConfig = parsedSettingsConfig ?? {};
  const meta = parsedMeta ?? {};
  const category = row.category;
  const shared = readSharedConfig(adapter.appType);
  const settings = loadSettings();

  const instanceDir = adapter.setupInstance(row.id);
  // Guard BEFORE prepare overwrites the main config file — user edits beyond
  // plugins get a warning + backup instead of vanishing silently.
  guardInstanceConfigBeforeOverwrite(adapter, row, instanceDir, shared, settings);
  adapter.prepare(instanceDir, row.id, settingsConfig, meta, category, shared, settings);
  recordInstanceBaseline(adapter, row.id, instanceDir, shared);
  // Record AFTER prepare succeeded (a failed prep is not a launch) and BEFORE
  // launch (adapter.launch execs and never returns). This is the single
  // recording point — both TUI and command mode pass through here, and the
  // extraArgs are stored so quick-launch replays the full original argv.
  const hotkey =
    record?.hotkey !== undefined ? record.hotkey : adapter.inferHotkeyFromArgs?.(extraArgs);
  recordLaunch(cmd, row.id, row.name, hotkey, extraArgs);
  // Aggregation instances route through the desktop app's loopback proxy —
  // if it is down (desktop quit/crashed/mid-upgrade) every request would die
  // with an opaque connection error inside the CLI. One quick probe turns
  // that silent failure into an actionable warning; the launch itself is
  // never gated (the proxy may come back while the instance is open).
  const aggBaseUrl = aggregationBaseUrlFor(adapter.appType, settingsConfig);
  if (aggBaseUrl) {
    const reachable = await probeTcpReachable(aggBaseUrl);
    if (!reachable) {
      console.error(
        `⚠ Aggregation proxy ${aggBaseUrl} is unreachable — make sure the cc-switch desktop app has aggregation enabled (the instance still launches; requests will fail until the proxy is back)`,
      );
    }
  }
  adapter.launch(instanceDir, extraArgs, { providerName: row.name, providerId: row.id });
}

export { launchProvider };
