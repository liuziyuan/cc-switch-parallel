// ─── launch (split from bin/cc-launch.mjs) ─────────────────────────────

import { join } from "node:path";
import { APP_ADAPTERS } from "./adapters.js";
import { loadSettings, queryCommonConfig, queryProvider, queryProvidersByApp } from "./db.js";
import { detectAndPromptSync, recordInstanceBaseline } from "./drift.js";
import { guardInstanceConfigBeforeOverwrite } from "./guard.js";
import { recordLaunch } from "./history.js";
import { parseJsonObject } from "./json-utils.js";
import { aggregationBaseUrlFor, cleanupLegacyStackRows, probeTcpReachable, reportLegacyStackCleanup } from "./stack/state.js";

// ─── Launch logic ──────────────────────────────────────────────────────

// syncFlag: null (default) = non-blocking stderr warning if drifted;
//           "on"  (--sync)    = interactive confirm before launching;
//           "off" (--no-sync) = fully silent, no warning at all.
// record: optional {hotkey} from the TUI quick/permission selection — the
//         mode the user actually picked, preferred over inferring it back
//         out of extraArgs (which quick-launch replays without flags).
async function launchProvider(cmd: string, providerName: string, extraArgs: string[], syncFlag: string | null = null, record: { hotkey?: string } | null = null) {
  const adapter = APP_ADAPTERS[cmd];
  if (!adapter) {
    console.error(`✗ Unsupported command: ${cmd}. Supported: ${Object.keys(APP_ADAPTERS).join(", ")}`);
    process.exit(1);
  }

  await detectAndPromptSync({ tui: syncFlag === "on", quiet: syncFlag === "off" });

  // One-time migration of pre-virtualization aggregation rows — command mode
  // never opens the TUI, so the claude launch path carries its own pass.
  // Runs BEFORE the lookup: a by-name launch of "Stack" must hit the virtual
  // entry, not a legacy row that is about to be deleted.
  if (adapter.appType === "claude") {
    reportLegacyStackCleanup(cleanupLegacyStackRows());
  }

  const row = queryProvider(providerName, adapter.appType);
  if (!row) {
    console.error(`✗ Provider "${providerName}" not found (${adapter.appType})`);
    console.error(`  Available providers:`);
    queryProvidersByApp(adapter.appType).forEach((p) => console.error(`    ${p.name}`));
    process.exit(1);
  }

  const parsedSettingsConfig = parseJsonObject(row.settings_config);
  const parsedMeta = parseJsonObject(row.meta);
  // Malformed rows must not reach prepare: it would atomically write "null",
  // "[]" or a quoted scalar as the instance's settings.json. Degrade to {}
  // with a loud warning instead of aborting the launch.
  if (!parsedSettingsConfig) {
    console.error(`⚠ Provider "${row.name}" has malformed settings_config JSON — launching with an empty config (repair the row in cc-switch).`);
  }
  if (!parsedMeta) {
    console.error(`⚠ Provider "${row.name}" has malformed meta JSON — launching with empty meta.`);
  }
  const settingsConfig = parsedSettingsConfig ?? {};
  const meta = parsedMeta ?? {};
  const category = row.category;
  const commonSnippet = queryCommonConfig(adapter.appType);
  const settings = loadSettings();

  const instanceDir = adapter.setupInstance(row.id);
  // Guard BEFORE prepare overwrites the main config file — user edits beyond
  // plugins get a warning + backup instead of vanishing silently.
  guardInstanceConfigBeforeOverwrite(adapter, row, instanceDir, commonSnippet, settings);
  adapter.prepare(instanceDir, row.id, settingsConfig, meta, category, commonSnippet, settings);
  recordInstanceBaseline(adapter, row.id, instanceDir, commonSnippet);
  // Record AFTER prepare succeeded (a failed prep is not a launch) and BEFORE
  // launch (adapter.launch execs and never returns). This is the single
  // recording point — both TUI and command mode pass through here, and the
  // extraArgs are stored so quick-launch replays the full original argv.
  const hotkey = record?.hotkey !== undefined ? record.hotkey : adapter.inferHotkeyFromArgs?.(extraArgs);
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
      console.error(`⚠ 聚合代理 ${aggBaseUrl} 不可达 — 请确认 cc-switch 桌面端已开启聚合（实例照常启动，请求会失败直至代理恢复）`);
    }
  }
  adapter.launch(instanceDir, extraArgs, { providerName: row.name, providerId: row.id });
}


export { launchProvider };
