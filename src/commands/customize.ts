// ─── commands/customize (split from bin/cc-launch.mjs) ─────────────────────────────

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { APP_ADAPTERS } from "../adapters.js";
import { queryProvider, queryProvidersByApp } from "../db.js";
import { confirmSync } from "../drift.js";
import { atomicWrite, lstatSyncSafe } from "../fs-utils.js";
import { INSTANCES_DIR } from "../paths.js";
import { buildEditorInvocation, editorExitCode } from "../terminal-utils.js";

// ─── Instance-only instructions file (customize / uncustomize) ────────

// Marks the boundary between the refreshable global snapshot and the
// user's instance-only section in a codex AGENTS.md template.
const CODEX_INSTRUCTIONS_INSTANCE_MARK =
  "<!-- ── instance-only instructions (below this line) ── -->";

// Pure arg parsing, shared by customize/uncustomize: an explicit app name is
// consumed only when it names an adapter AND a provider name follows;
// otherwise the command defaults to claude (backward compatible with the
// claude-only syntax). A bare "claude"/"codex" is ambiguous — an app name
// without a provider — so the caller must ask for
// `switch customize claude claude` explicitly in that corner case.
function parseCustomizeArgs(args) {
  const rest = args.filter((a) => a !== "--yes");
  if (rest.length === 0) return null;
  if (APP_ADAPTERS[rest[0]]) {
    if (rest.length < 2) return null; // app named but no provider
    return { cmd: rest[0], providerName: rest[1] };
  }
  return { cmd: "claude", providerName: rest[0] };
}

function instanceInstructionsPath(appType, providerId) {
  return join(INSTANCES_DIR, appType, providerId, APP_ADAPTERS[appType].instructions.fileName);
}

function findCustomizeProviderOrExit(cmd, providerName, usage) {
  if (!providerName) {
    console.error(usage);
    process.exit(1);
  }
  const adapter = APP_ADAPTERS[cmd];
  const row = queryProvider(providerName, adapter.appType);
  if (!row) {
    console.error(`✗ Provider "${providerName}" not found (${adapter.appType})`);
    console.error(`  Available providers:`);
    queryProvidersByApp(adapter.appType).forEach((p) => console.error(`    ${p.name}`));
    process.exit(1);
  }
  return row;
}

// Codex has no @import mechanism, so an instance AGENTS.md must EMBED the
// global content: a marked snapshot block on top (refreshable), the user's
// instance-only section below (preserved byte-for-byte across refreshes).
function buildCodexInstructionsTemplate(globalText, globalPathDisplay) {
  const body = (globalText || "").trimEnd();
  return [
    `<!-- cc-switch: snapshot of ${globalPathDisplay} — re-run \`switch customize codex <provider>\` to refresh this block -->`,
    body || "(global AGENTS.md is missing or empty — this snapshot will stay as-is until refreshed)",
    "",
    CODEX_INSTRUCTIONS_INSTANCE_MARK,
    "<!-- delete this file to fall back to the shared global AGENTS.md -->",
    "",
    "",
  ].join("\n");
}

// Rewrite ONLY the snapshot region; anything below the instance marker is
// kept byte-for-byte. Returns null when the file doesn't carry our marker
// (a hand-written file) — the caller must not touch it.
function refreshCodexInstructionsSnapshot(existingText, newGlobalText, globalPathDisplay) {
  const instanceIdx = existingText.indexOf(CODEX_INSTRUCTIONS_INSTANCE_MARK);
  if (instanceIdx < 0) return null;
  const tail = existingText.slice(instanceIdx);
  const body = (newGlobalText || "").trimEnd();
  return [
    `<!-- cc-switch: snapshot of ${globalPathDisplay} — re-run \`switch customize codex <provider>\` to refresh this block -->`,
    body || "(global AGENTS.md is missing or empty — this snapshot will stay as-is until refreshed)",
    "",
    tail,
  ].join("\n");
}

// First run writes the template (claude: live @import; codex: marked
// snapshot + instance section) and opens the editor; later runs open the
// existing file directly — and, for adapters with refreshSnapshot, first
// refresh the snapshot region in place. The real file survives every later
// launch because ensureSymlink preserves non-symlink files instead of
// re-linking the shared global one.
function runCustomize(args) {
  const parsed = parseCustomizeArgs(args);
  const usage = "Usage: switch customize [claude|codex] <provider>";
  if (!parsed) {
    console.error(usage);
    process.exit(1);
  }
  const adapter = APP_ADAPTERS[parsed.cmd];
  const inst = adapter.instructions;
  const row = findCustomizeProviderOrExit(parsed.cmd, parsed.providerName, usage);
  mkdirSync(join(INSTANCES_DIR, adapter.appType, row.id), { recursive: true });
  const file = instanceInstructionsPath(adapter.appType, row.id);
  const stats = lstatSyncSafe(file);
  if (stats?.isDirectory()) {
    console.error(`✗ ${file} is a directory — refusing to touch it`);
    process.exit(1);
  }
  const globalPath = inst.globalPath();
  let globalText = "";
  try { globalText = readFileSync(globalPath, "utf8"); } catch {}
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

async function runUncustomize(args) {
  const yes = args.includes("--yes");
  const parsed = parseCustomizeArgs(args);
  const usage = "Usage: switch uncustomize [claude|codex] <provider> [--yes]";
  if (!parsed) {
    console.error(usage);
    process.exit(1);
  }
  const adapter = APP_ADAPTERS[parsed.cmd];
  const inst = adapter.instructions;
  const row = findCustomizeProviderOrExit(parsed.cmd, parsed.providerName, usage);
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

function printHelp() {
  console.log(`cc-switch-parallel — launch Claude Code / Codex with per-provider isolated configs

Usage:
  switch                                 Interactive TUI (select CLI, then provider)
  switch <provider> <cmd> [args...]     Launch a provider directly
  switch --sync <provider> <cmd> [...]  Same, but confirm config drift first
  switch --no-sync <provider> <cmd> [...] Same, but suppress the drift warning
  switch sync                           Detect & sync config drift (plugins, settings fields, common config)
  switch doctor                         Diagnose the environment
  switch clean [--all] [--force]        Remove instance directories (refuses live sessions; --force overrides)
  switch ps                             List running switch-launched sessions
  switch customize [claude|codex] <provider>   Instance-only instructions file (CLAUDE.md / AGENTS.md; opens editor)
  switch uncustomize [claude|codex] <provider> [--yes]  Back to the shared global instructions file
  switch update                         Self-update to the latest npm version
  switch -v | --version                 Show version

Commands: ${Object.keys(APP_ADAPTERS).join(", ")}

Examples:
  switch "Claude Official" claude
  switch "Zhipu GLM en" claude --continue
  switch "P&G Nezha" codex`);
}


export { CODEX_INSTRUCTIONS_INSTANCE_MARK, buildCodexInstructionsTemplate, findCustomizeProviderOrExit, instanceInstructionsPath, parseCustomizeArgs, printHelp, refreshCodexInstructionsSnapshot, runCustomize, runUncustomize };
