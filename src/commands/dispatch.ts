// ─── commands/dispatch ─────────────────────────────────────────────────
// Top-level command routing. Only main.ts imports this module; command
// modules must never import it back (that would invert the layer).

import { runTUI } from "../tui.js";
import { parseLaunchArgs } from "./args.js";
import { printHelp, runCustomize, runUncustomize } from "./customize.js";
import { runClean, runDoctor } from "./doctor.js";
import { routeLaunch } from "./launch-route.js";
import { runList } from "./list.js";
import { runPs } from "./ps.js";
import { runSync } from "./sync.js";
import { runUpdate } from "./update.js";
import { runVersion } from "./version.js";

async function dispatch(argv: string[]): Promise<void> {
  // Leading flags (command mode only). They must be stripped before any other
  // parsing since the remainder of argv is forwarded verbatim to the launched
  // CLI (e.g. `claude --continue`) — a flag parsed anywhere but the front
  // could be mistaken for a CLI argument.
  const parsed = parseLaunchArgs(argv);
  if ("error" in parsed) {
    console.error(`✗ ${parsed.error}`);
    console.error(`Usage: switch [--sync|--no-sync] [--id <providerId>] <cmd> [args...]`);
    process.exit(1);
  }
  const { dryRun, rest: args } = parsed;

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
    await runSync();
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
    runVersion();
    return;
  }

  await routeLaunch(args, parsed);
}

export { dispatch };
