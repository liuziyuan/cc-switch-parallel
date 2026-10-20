// ─── commands/customize (split from bin/cc-launch.mjs) ─────────────────────────────

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { APP_ADAPTERS, getAdapter } from "../adapters.js";
import { queryProviderById, queryProviderMatches, queryProvidersByApp } from "../db.js";
import { formatAmbiguousProvider, formatAvailableProviders } from "../provider-ref.js";
import { confirmSync } from "../drift.js";
import { atomicWrite, lstatSyncSafe } from "../fs-utils.js";
import { INSTANCES_DIR } from "../paths.js";
import { buildEditorInvocation, editorExitCode } from "../terminal-utils.js";

// The codex instruction template helpers live in a leaf module so adapters do
// not have to import this command module; keep the historical export surface.
export {
  CODEX_INSTRUCTIONS_INSTANCE_MARK,
  buildCodexInstructionsTemplate,
  refreshCodexInstructionsSnapshot,
} from "../codex-instructions.js";

// ─── Instance-only instructions file (customize / uncustomize) ────────

// Pure arg parsing, shared by customize/uncustomize. An explicit app name is
// consumed only when it names an adapter AND a provider follows; otherwise the
// command defaults to claude. `--id <id>` selects the provider by id and is
// mutually exclusive with the positional provider name.
function parseCustomizeArgs(args: string[]) {
  const rest = args.filter((a) => a !== "--yes");
  let providerId: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--id") {
      const value = rest[i + 1];
      if (!value) return null; // missing value
      providerId = value;
      i++;
      continue;
    }
    if (a.startsWith("--id=")) {
      const value = a.slice("--id=".length);
      if (!value) return null;
      providerId = value;
      continue;
    }
    positional.push(a);
  }
  if (providerId !== null) {
    // With --id the only allowed positional token is an optional app name.
    if (positional.length === 0) return { cmd: "claude", providerId, providerName: null };
    if (positional.length === 1 && getAdapter(positional[0])) {
      return { cmd: positional[0], providerId, providerName: null };
    }
    return null; // id + provider name are mutually exclusive
  }
  if (positional.length === 0) return null;
  if (getAdapter(positional[0])) {
    if (positional.length < 2) return null; // app named but no provider
    return { cmd: positional[0], providerId: null, providerName: positional[1] };
  }
  return { cmd: "claude", providerId: null, providerName: positional[0] };
}

function instanceInstructionsPath(appType: string, providerId: string) {
  return join(INSTANCES_DIR, appType, providerId, getAdapter(appType)!.instructions!.fileName);
}

function findCustomizeProviderOrExit(
  cmd: string,
  providerId: string | null,
  providerName: string | null,
  usage: string,
) {
  const adapter = getAdapter(cmd)!;
  if (providerId) {
    const row = queryProviderById(providerId, adapter.appType);
    if (!row) {
      console.error(`✗ Provider id "${providerId}" not found (${adapter.appType})`);
      console.error(formatAvailableProviders(queryProvidersByApp(adapter.appType)));
      process.exit(1);
    }
    return row;
  }
  if (!providerName) {
    console.error(usage);
    process.exit(1);
  }
  const matches = queryProviderMatches(providerName, adapter.appType);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    console.error(`✗ Provider "${providerName}" not found (${adapter.appType})`);
    console.error(formatAvailableProviders(queryProvidersByApp(adapter.appType)));
    process.exit(1);
  }
  console.error(
    formatAmbiguousProvider(
      providerName,
      adapter.appType,
      matches,
      cmd,
      `switch customize ${cmd} --id <providerId>`,
    ),
  );
  process.exit(1);
}

// First run writes the template (claude: live @import; codex: marked
// snapshot + instance section) and opens the editor; later runs open the
// existing file directly — and, for adapters with refreshSnapshot, first
// refresh the snapshot region in place. The real file survives every later
// launch because ensureSymlink preserves non-symlink files instead of
// re-linking the shared global one.
function runCustomize(args: string[]) {
  const parsed = parseCustomizeArgs(args);
  const usage =
    "Usage: switch customize [claude|codex] <provider>\n       switch customize [claude|codex] --id <providerId>";
  if (!parsed) {
    console.error(usage);
    process.exit(1);
  }
  const adapter = getAdapter(parsed.cmd)!;
  const inst = adapter.instructions!;
  const row = findCustomizeProviderOrExit(
    parsed.cmd,
    parsed.providerId,
    parsed.providerName,
    usage,
  );
  mkdirSync(join(INSTANCES_DIR, adapter.appType, row.id), { recursive: true });
  const file = instanceInstructionsPath(adapter.appType, row.id);
  const stats = lstatSyncSafe(file);
  if (stats?.isDirectory()) {
    console.error(`✗ ${file} is a directory — refusing to touch it`);
    process.exit(1);
  }
  const globalPath = inst.globalPath();
  let globalText = "";
  try {
    globalText = readFileSync(globalPath, "utf8");
  } catch {}
  if (!stats || stats.isSymbolicLink()) {
    if (!existsSync(globalPath)) {
      console.error(inst.missingGlobalWarn(globalPath));
    }
    atomicWrite(file, inst.buildTemplate(globalText, globalPath));
  } else if (inst.refreshSnapshot) {
    // The file existed at lstat time but may vanish (or become unreadable)
    // before this read — handle that instead of crashing with a stack trace.
    let existing: string | null = null;
    try {
      existing = readFileSync(file, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        atomicWrite(file, inst.buildTemplate(globalText, globalPath));
      } else {
        console.error(`✗ Failed to read ${file}: ${e.message}`);
        process.exit(1);
      }
    }
    if (existing !== null) {
      const refreshed = inst.refreshSnapshot(existing, globalText, globalPath);
      if (refreshed !== null) atomicWrite(file, refreshed);
    }
  }
  // Shell-parsed editor: supports `VISUAL="code -w"`. The file is passed as
  // a positional argument, so its path is never interpreted by the shell.
  const editor = (process.env.VISUAL || process.env.EDITOR || "vi").trim() || "vi";
  const invocation = buildEditorInvocation(editor, file);
  const r = spawnSync(invocation.command, invocation.args, { stdio: "inherit" });
  const code = editorExitCode(r);
  if (code !== 0) {
    if (r.error) console.error(`✗ Failed to open editor "${editor}": ${r.error.message}`);
    else if (r.signal) console.error(`✗ Editor terminated by ${r.signal}.`);
    else console.error(`✗ Editor exited with status ${r.status}.`);
    console.error(`  Edit the file manually: ${file}`);
    process.exit(code);
  }
  console.log(`✓ customized — applies to new sessions`);
  process.exit(0);
}

async function runUncustomize(args: string[]) {
  const yes = args.includes("--yes");
  const parsed = parseCustomizeArgs(args);
  const usage =
    "Usage: switch uncustomize [claude|codex] <provider> [--yes]\n       switch uncustomize [claude|codex] --id <providerId> [--yes]";
  if (!parsed) {
    console.error(usage);
    process.exit(1);
  }
  const adapter = getAdapter(parsed.cmd)!;
  const inst = adapter.instructions!;
  const row = findCustomizeProviderOrExit(
    parsed.cmd,
    parsed.providerId,
    parsed.providerName,
    usage,
  );
  const file = instanceInstructionsPath(adapter.appType, row.id);
  const stats = lstatSyncSafe(file);
  if (!stats) {
    console.log(`not customized (no instance ${inst.fileName})`);
    return;
  }
  if (stats.isSymbolicLink()) {
    console.log(`not customized (${inst.fileName} is the shared global symlink)`);
    return;
  }
  if (stats.isDirectory()) {
    console.error(`✗ ${file} is a directory — refusing to touch it`);
    process.exit(1);
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("✗ uncustomize requires an interactive terminal (or use --yes).");
      process.exit(1);
    }
    const outcome = await confirmSync(
      [`Remove instance ${inst.fileName} for "${row.name}"?`, `  ${file}`],
      "Remove it?",
    );
    if (outcome === "interrupt") process.exit(130);
    if (outcome !== "yes") {
      console.error("aborted");
      process.exit(1);
    }
  }
  try {
    unlinkSync(file);
  } catch (e: any) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
  adapter.setupInstance(row.id); // restore the shared symlink immediately
  console.log(`✓ restored to shared global ${inst.fileName}`);
  process.exit(0);
}

function buildHelpText(): string {
  return `cc-switch-parallel — launch Claude Code / Codex with per-provider isolated configs

Usage:
  switch [global flags] [<provider> <cmd> [args...]]
  switch [global flags] a|s|d|f|g
  switch <command> [args...]

Global flags (must precede <provider>/<cmd>):
  --sync | --no-sync                 Confirm / suppress the config-drift prompt before launch
  --id <providerId> | --id=<id>      Select a provider by id (disambiguates duplicate names)
  --dry-run                          Print what a launch would write and run; no side effects
  --diff                             With --dry-run: show a diff against the current instance file
  --show-secrets                     With --dry-run: reveal unredacted values

Launch:
  switch                              Interactive TUI (select CLI, then provider)
  switch <provider> <cmd> [args...]   Launch directly; args are forwarded verbatim to the CLI
  switch --id <providerId> <cmd> ...  Launch by provider id
  switch --dry-run [--diff] [--show-secrets] <provider> <cmd> [args...]
                                      Preview config, instance dir, command and env
  switch a|s|d|f|g                    Launch a Recent top-5 slot directly

Sessions:
  switch ps [--json]                  List running switch-launched sessions
  switch ps kill <pid|index> [--force]
                                      Stop a recorded session; --force = SIGKILL, no prompt
  switch ps attach <index>            Focus the session's tmux pane

Providers:
  switch list [--json] [--app claude|codex]
                                      List providers, aggregation state and availability
  switch customize [claude|codex] <provider>
  switch customize [claude|codex] --id <providerId>
                                      Instance-only instructions file (CLAUDE.md / AGENTS.md)
  switch uncustomize [claude|codex] <provider> [--yes]
  switch uncustomize [claude|codex] --id <providerId> [--yes]
                                      Restore the shared global instructions file

Maintenance:
  switch sync                         Detect & sync config drift
  switch doctor [--json] [--fix]      Diagnose the environment; --fix rehomes broken links, missing instance dirs and baselines
  switch clean [--all|--yes] [--force] Remove instance directories
  switch update | self-update | --update
                                      Self-update to the latest npm version
  switch version | -v | --version     Show version
  switch help | -h | --help           Show this help

Commands: ${Object.keys(APP_ADAPTERS).join(", ")}

Examples:
  switch "Claude Official" claude
  switch --id <providerId> claude --continue
  switch --dry-run --diff "Zhipu GLM en" claude
  switch list --app claude
  switch ps --json
  switch s                              # Recent slot 2 — same as pressing s in the TUI`;
}

function printHelp() {
  console.log(buildHelpText());
}

export {
  buildHelpText,
  findCustomizeProviderOrExit,
  instanceInstructionsPath,
  parseCustomizeArgs,
  printHelp,
  runCustomize,
  runUncustomize,
};
