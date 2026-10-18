// ─── launch (split from bin/cc-launch.mjs) ─────────────────────────────

import { join } from "node:path";
import { APP_ADAPTERS } from "./adapters.mjs";
import { loadSettings, queryCommonConfig, queryProvider, queryProvidersByApp } from "./db.mjs";
import { detectAndPromptSync, recordInstanceBaseline } from "./drift.mjs";
import { guardInstanceConfigBeforeOverwrite } from "./guard.mjs";
import { recordLaunch } from "./history.mjs";
import { aggregationBaseUrlFor, cleanupLegacyStackRows, probeTcpReachable, reportLegacyStackCleanup } from "./stack/state.mjs";

// ─── Launch logic ──────────────────────────────────────────────────────

// syncFlag: null (default) = non-blocking stderr warning if drifted;
//           "on"  (--sync)    = interactive confirm before launching;
//           "off" (--no-sync) = fully silent, no warning at all.
// record: optional {hotkey} from the TUI quick/permission selection — the
//         mode the user actually picked, preferred over inferring it back
//         out of extraArgs (which quick-launch replays without flags).
async function launchProvider(cmd, providerName, extraArgs, syncFlag = null, record = null) {
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

  const settingsConfig = JSON.parse(row.settings_config || "{}");
  const meta = JSON.parse(row.meta || "{}");
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
