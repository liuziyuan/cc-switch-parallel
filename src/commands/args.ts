// ─── commands/args ─────────────────────────────────────────────────────

type ParsedLaunchArgs =
  | { error: string }
  | {
      syncFlag: string | null;
      providerId: string | null;
      dryRun: boolean;
      diff: boolean;
      showSecrets: boolean;
      rest: string[];
    };

// Parse leading launch flags. `--id` selects a provider by id and is
// mutually exclusive with the positional provider name (with --id the first
// positional token is the command); everything after that is forwarded
// verbatim to the launched CLI.
function parseLaunchArgs(argv: string[]): ParsedLaunchArgs {
  const rest = [...argv];
  let syncFlag: string | null = null;
  let providerId: string | null = null;
  let dryRun = false;
  let diff = false;
  let showSecrets = false;
  while (rest.length) {
    const a = rest[0];
    if (a === "--sync") { syncFlag = "on"; rest.shift(); continue; }
    if (a === "--no-sync") { syncFlag = "off"; rest.shift(); continue; }
    if (a === "--dry-run") { dryRun = true; rest.shift(); continue; }
    if (a === "--diff") { diff = true; rest.shift(); continue; }
    if (a === "--show-secrets") { showSecrets = true; rest.shift(); continue; }
    if (a === "--id") {
      rest.shift();
      const value = rest.shift();
      if (!value) return { error: "missing --id value" };
      providerId = value;
      continue;
    }
    if (a.startsWith("--id=")) {
      const value = a.slice("--id=".length);
      if (!value) return { error: "missing --id value" };
      providerId = value;
      rest.shift();
      continue;
    }
    break;
  }
  if ((diff || showSecrets) && !dryRun) {
    return { error: "--diff and --show-secrets require --dry-run" };
  }
  return { syncFlag, providerId, dryRun, diff, showSecrets, rest };
}


export { parseLaunchArgs, type ParsedLaunchArgs };
