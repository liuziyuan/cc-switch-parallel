// ─── commands/launch-route ─────────────────────────────────────────────
// Provider launch routing: --id, positional --dry-run, quick slots and the
// generic usage text. Kept out of the dispatcher so the command table stays
// readable.

import { launchProvider } from "../launch.js";
import type { ParsedLaunchOptions } from "./args.js";
import { runDryRun } from "./dry-run.js";
import { isQuickLaunchKey, runQuickLaunch } from "./quick.js";

async function routeLaunch(args: string[], flags: ParsedLaunchOptions): Promise<void> {
  const { syncFlag, providerId, dryRun, diff, showSecrets } = flags;

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

export { routeLaunch };
