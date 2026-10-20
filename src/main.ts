// ─── main entry (split from bin/cc-launch.mjs) ──────────────────────────

import { printHelp, runCustomize, runUncustomize } from "./commands/customize.js";
import { parseLaunchArgs } from "./commands/args.js";
import { runClean, runDoctor } from "./commands/doctor.js";
import { runPs } from "./commands/ps.js";
import { runList } from "./commands/list.js";
import { runDryRun } from "./commands/dry-run.js";
import { isQuickLaunchKey, runQuickLaunch } from "./commands/quick.js";
import { queryLatestVersion, runUpdate } from "./commands/update.js";
import { detectAndPromptSync } from "./drift.js";
import { launchProvider } from "./launch.js";
import { VERSION } from "./paths.js";
import { runTUI } from "./tui.js";

// ─── Main entry ────────────────────────────────────────────────────────

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
  const { syncFlag, providerId, dryRun, diff, showSecrets, rest: args } = parsed;

  if (dryRun && args.length === 0) {
    console.error("✗ --dry-run requires a provider and a command.");
    console.error("Usage: switch --dry-run [--diff] [--show-secrets] <provider> <cmd> [args...]");
    process.exit(1);
  }

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
      console.error(
        "✗ switch sync requires an interactive terminal — run it directly in a terminal.",
      );
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
    await runDoctor(args.slice(1));
    return;
  }

  if (args[0] === "clean") {
    await runClean(args.slice(1));
    return;
  }

  if (args[0] === "list") {
    runList(args.slice(1));
    return;
  }

  if (args[0] === "ps") {
    await runPs(args.slice(1));
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
    const latest = queryLatestVersion();
    console.log(
      `cc-switch-parallel v${v}${latest ? (v === latest ? " (latest)" : ` (latest: ${latest})`) : ""}`,
    );
    process.exit(0);
  }

  if (providerId !== null) {
    if (args.length < 1) {
      console.error(`Usage: switch --id <providerId> <cmd> [args...]`);
      process.exit(1);
    }
    if (dryRun) {
      await runDryRun(args[0], { id: providerId }, args.slice(1), { diff, showSecrets });
      return;
    }
    await launchProvider(args[0], { id: providerId }, args.slice(1), syncFlag);
    return;
  }

  if (dryRun) {
    if (args.length === 1 && isQuickLaunchKey(args[0])) {
      console.error("✗ --dry-run is not supported for quick slots.");
      process.exit(1);
    }
    if (args.length < 2) {
      console.error("✗ --dry-run requires a provider and a command.");
      console.error("Usage: switch --dry-run [--diff] [--show-secrets] <provider> <cmd> [args...]");
      process.exit(1);
    }
    await runDryRun(args[1], { name: args[0] }, args.slice(2), { diff, showSecrets });
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

export {
  isVoltaManagedInstall,
  queryLatestVersion,
  readInstalledVersion,
  reportUpdateOutcome,
  runUpdate,
} from "./commands/update.js";
export { main };
