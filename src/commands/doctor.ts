// ─── commands/doctor (split from bin/cc-launch.mjs) ─────────────────────────────

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DoctorCheck, InstanceInfo } from "../types.js";
import { APP_ADAPTERS } from "../adapters.js";
import { instanceInstructionsPath } from "./customize.js";
import { pruneInstanceBaselines } from "./ps.js";
import { queryCommonConfig, queryDB, queryProviderById, queryProvidersByApp, readSchemaUserVersion } from "../db.js";
import { lstatSyncSafe, readdirSyncSafe } from "../fs-utils.js";
import { pruneInstanceSettingsBackups } from "../guard.js";
import { isPlainObject } from "../json-utils.js";
import { readSessions, sessionLiveness } from "../sessions.js";
import { DB_PATH, INSTANCES_DIR, LIVE_STATE_PATH, SYNC_STATE_PATH } from "../paths.js";
import { detectSharedConfigMode, readSharedConfig } from "../shared-config.js";
import { codexAggregationRoute } from "../stack/catalog.js";
import { isAggregationProviderSettings, probeTcpReachable, readStackState, virtualStackProviderFor } from "../stack/state.js";
import { parseToml } from "../toml.js";
import { tuiSelect } from "../tui.js";

// ─── doctor / clean ────────────────────────────────────────────────────

function which(bin) {
  try {
    const r = spawnSync("which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function collectInstances(): InstanceInfo[] {
  const instances: InstanceInfo[] = [];
  for (const adapter of Object.values(APP_ADAPTERS)) {
    const dir = join(INSTANCES_DIR, adapter.appType);
    if (!existsSync(dir)) continue;
    for (const name of readdirSyncSafe(dir) || []) {
      const full = join(dir, name);
      if (lstatSyncSafe(full)?.isDirectory()) instances.push({ name, appType: adapter.appType, path: full });
    }
  }
  return instances;
}

// Sessions that must block a clean: alive OR unknown (conservative — never
// delete an instance whose process we cannot prove dead).
function blockingSessions(instances: InstanceInfo[]) {
  const blocked: { inst: InstanceInfo; session: any; status: string }[] = [];
  for (const inst of instances) {
    for (const { session } of readSessions(inst.path)) {
      const status = sessionLiveness(session);
      if (status === "dead") continue;
      blocked.push({ inst, session, status });
    }
  }
  return blocked;
}

function assertCleanable(instances: InstanceInfo[], force: boolean): boolean {
  if (force) return true;
  const blocked = blockingSessions(instances);
  if (!blocked.length) return true;
  console.error("✗ Refusing to remove instances with running sessions:");
  for (const b of blocked) {
    console.error(`    ${b.inst.appType}/${b.inst.name} (pid ${b.session.pid ?? "?"}, ${b.status})`);
  }
  console.error("  Exit those sessions first, or rerun with --force.");
  return false;
}

// ─── aggregation doctor checks (cc-switch 4.0 Stack) ───────────────────
// Advisory state, not launch health: a missing live-state means aggregation
// is simply off (pass). Real inconsistencies fail — members whose provider
// rows are gone, an unreachable proxy. Returns [{label, pass, detail}] for
// runDoctor's renderer, so the checks stay unit-testable without the UI.
async function aggregationDoctorChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (label: string, pass: boolean, detail: string) => checks.push({ label, pass, detail });
  if (!existsSync(LIVE_STATE_PATH)) {
    add("aggregation live-state", true, "not present (aggregation off)");
    return checks;
  }
  let raw: any = null;
  try { raw = JSON.parse(readFileSync(LIVE_STATE_PATH, "utf8")); } catch {}
  if (!isPlainObject(raw)) {
    add("aggregation live-state", false, "exists but unparseable");
    return checks;
  }
  if (raw!.version !== undefined && raw!.version !== 1) {
    add("aggregation live-state", false, `unsupported contract version ${raw!.version} (expected 1) — read as off`);
    return checks;
  }
  const stack = readStackState("claude");
  if (!stack) {
    add("aggregation live-state", true, "readable (aggregation off)");
    return checks;
  }
  add("aggregation live-state", true, "readable (stack on)");
  const rowExists = (id) => {
    try { return !!queryProviderById(id, "claude"); } catch { return false; }
  };
  const missing = Object.entries(stack.keys).filter(([, id]) => !rowExists(id)).map(([key]) => key);
  add(
    "aggregation members",
    missing.length === 0,
    missing.length === 0
      ? `${Object.keys(stack.keys).length} key(s) → provider rows all present`
      : `stack key(s) with no provider row: ${missing.join(", ")}`,
  );
  // The aggregation entry is the runtime-virtual row (not a DB row), derived
  // fresh from live-state + the global settings.json. "Present" = the derive
  // succeeds; a live stack whose global env is not loopback yields no usable
  // entry, which IS a failure (nothing to launch the stack through).
  const virtual = virtualStackProviderFor("claude");
  if (!virtual) {
    add("aggregation Stack row", false, "live stack but no virtual entry derivable — global ~/.claude/settings.json env is missing or not loopback");
    return checks;
  }
  let baseUrl: string | null = null;
  try { baseUrl = JSON.parse(virtual.settings_config)?.env?.ANTHROPIC_BASE_URL ?? null; } catch {}
  // Legacy auto-created DB rows (pre-virtualization) are cleaned up on the
  // next TUI open / launch; report them so the state is visible until then.
  let legacy = 0;
  try {
    for (const r of queryDB("SELECT settings_config FROM providers WHERE app_type = 'claude'")) {
      try {
        if (isAggregationProviderSettings(JSON.parse(r.settings_config))) legacy++;
      } catch {}
    }
  } catch {}
  add("aggregation Stack row", true, legacy
    ? `virtual entry derived (${baseUrl}, not stored in DB); ${legacy} legacy DB row(s) pending auto-cleanup`
    : `virtual entry derived (${baseUrl}, not stored in DB)`);
  const reachable = typeof baseUrl === "string" ? await probeTcpReachable(baseUrl) : false;
  add(
    "aggregation proxy",
    reachable,
    reachable ? `${baseUrl} reachable` : `${baseUrl ?? "?"} unreachable — open the cc-switch desktop app with aggregation on`,
  );
  return checks;
}

// Codex mirror — minimal set (advisory, same philosophy as the claude checks):
// no codex stack in live-state → [] (zero noise; the live-state file itself is
// already health-checked by the claude pass). Stack on → the virtual entry
// must derive from the global config.toml (a live stack whose global config
// has no loopback custom provider yields nothing to launch through — that is
// a failure) and the proxy must answer. No member-row check (codex has no
// legacy DB aggregation rows; a removed member shows in the TUI label) and no
// catalog check (prepare's copy warning already surfaces that).
async function codexAggregationDoctorChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (label: string, pass: boolean, detail: string) => checks.push({ label, pass, detail });
  const stack = readStackState("codex");
  if (!stack) return checks;
  const virtual = virtualStackProviderFor("codex");
  if (!virtual) {
    add("codex aggregation Stack row", false,
      "live stack but no virtual entry derivable — global ~/.codex/config.toml is missing, has no custom model_provider, or its base_url is not loopback");
    return checks;
  }
  let baseUrl: string | null = null;
  try {
    const r = codexAggregationRoute(JSON.parse(virtual.settings_config)?.config || "");
    baseUrl = r?.baseUrl ?? null;
  } catch {}
  add("codex aggregation Stack row", true, `virtual entry derived (${baseUrl ?? "?"}, not stored in DB)`);
  const reachable = typeof baseUrl === "string" ? await probeTcpReachable(baseUrl) : false;
  add(
    "codex aggregation proxy",
    reachable,
    reachable ? `${baseUrl} reachable` : `${baseUrl ?? "?"} unreachable — open the cc-switch desktop app with aggregation on`,
  );
  return checks;
}

async function runDoctor(): Promise<void> {
  const checks: DoctorCheck[] = [];
  const add = (label: string, pass: boolean, detail: string) => checks.push({ label, pass, detail });

  // sqlite3
  const sqliteOk = !!which("sqlite3");
  add("sqlite3 CLI", sqliteOk, sqliteOk ? "available" : "not found on PATH — required to read the cc-switch DB");

  // DB + providers
  let dbOk = false;
  let counts = "";
  if (!existsSync(DB_PATH)) {
    counts = "DB file not found";
  } else {
    try {
      const tables = queryDB(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`);
      if (tables.length === 0) {
        counts = "providers table missing";
      } else {
        const parts: string[] = [];
        for (const adapter of Object.values(APP_ADAPTERS)) {
          parts.push(`${adapter.appType}: ${queryProvidersByApp(adapter.appType).length}`);
        }
        counts = parts.join(", ");
        dbOk = true;
      }
    } catch (e: any) {
      counts = e.message;
    }
  }
  add("cc-switch DB", dbOk, dbOk ? `readable (providers — ${counts})` : counts);

  // Shared settings source: cc-switch 4.0.2+ moved shared settings into the
  // clients' live config files and froze the DB snippets. Show which source
  // this run uses so "I deleted it but switch still applies it" is diagnosable.
  const sharedMode = detectSharedConfigMode();
  const schemaVersion = readSchemaUserVersion();
  add(
    "shared config source",
    schemaVersion !== null,
    `${sharedMode} mode (DB user_version ${schemaVersion === null ? "unknown" : schemaVersion}; override with CC_SWITCH_SHARED_SOURCE)`,
  );

  // CLI binaries
  for (const adapter of Object.values(APP_ADAPTERS)) {
    const p = which(adapter.bin);
    add(`${adapter.bin} binary`, !!p, p || "not found on PATH");
  }

  // Shared config: the live global file in 4.0.2+ mode (the DB snippet is a
  // frozen legacy snapshot then), the DB snippet in legacy mode.
  for (const adapter of Object.values(APP_ADAPTERS)) {
    const shared = readSharedConfig(adapter.appType);
    if (shared.mode === "live") {
      add(
        `shared config (${adapter.appType})`,
        !shared.unavailable,
        shared.unavailable
          ? `unreadable: ${shared.sourcePath}`
          : `live · ${Object.keys(shared.parsed || {}).length} user key(s) — ${shared.sourcePath}`,
      );
      const snip = queryCommonConfig(adapter.appType);
      if (snip) {
        add(
          `common_config_${adapter.appType}`,
          true,
          "legacy snapshot (frozen — ignored in live mode)",
        );
      }
      continue;
    }
    const snip = queryCommonConfig(adapter.appType);
    if (!snip) { add(`common_config_${adapter.appType}`, true, "not set"); continue; }
    let pass = true;
    try { adapter.appType === "claude" ? JSON.parse(snip) : parseToml(snip); } catch { pass = false; }
    add(`common_config_${adapter.appType}`, pass, pass ? "parseable (legacy source)" : "unparseable");
  }

  // instance dirs
  const instances = collectInstances();
  add("instance dirs", true, `${instances.length} instance(s)`);

  // instructions files (per-adapter, capability-driven): the global file's
  // readability, plus every existing instance instructions file being either
  // the shared symlink or a real file — a BROKEN symlink means the global
  // moved and the instance is silently without instructions. (Codex's global
  // AGENTS.md loading itself has a known upstream reliability issue —
  // openai/codex#8759 — so surface the file state explicitly here.)
  for (const adapter of Object.values(APP_ADAPTERS)) {
    if (!adapter.instructions) continue;
    const globalPath = adapter.instructions.globalPath();
    const globalOk = existsSync(globalPath);
    add(
      `${adapter.appType} global ${adapter.instructions.fileName}`,
      globalOk,
      globalOk ? globalPath : `${globalPath} not found (instances fall back to empty snapshots)`,
    );
    let broken: string[] = [];
    for (const inst of collectInstances().filter((i) => i.appType === adapter.appType)) {
      const p = instanceInstructionsPath(adapter.appType, inst.name);
      const st = lstatSyncSafe(p);
      if (st?.isSymbolicLink() && !existsSync(p)) broken.push(inst.name);
    }
    add(
      `${adapter.appType} instance ${adapter.instructions.fileName} links`,
      broken.length === 0,
      broken.length === 0 ? "all symlinks resolve" : `broken symlink(s): ${broken.join(", ")}`,
    );
  }

  // sync state
  add("sync-state.json", existsSync(SYNC_STATE_PATH), existsSync(SYNC_STATE_PATH) ? "present" : "not yet created (first run)");

  // aggregation (cc-switch 4.0 Stack) — live-state contract, member rows,
  // Stack row, proxy reachability
  for (const c of await aggregationDoctorChecks()) add(c.label, c.pass, c.detail);
  for (const c of await codexAggregationDoctorChecks()) add(c.label, c.pass, c.detail);

  // render
  console.log("\n  \x1b[1mcc-switch-parallel doctor\x1b[0m\n");
  for (const c of checks) {
    const mark = c.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log("");
  const failed = checks.filter((c) => !c.pass).length;
  if (failed) {
    console.log(`  \x1b[31m${failed} issue(s) found.\x1b[0m\n`);
    process.exit(1);
  }
  console.log("  \x1b[32mAll checks passed.\x1b[0m\n");
}

async function runClean(args) {
  const force = args.includes("--force");
  const instances = collectInstances();
  if (!instances.length) {
    console.log("No instance directories found.");
    return;
  }

  if (args.includes("--all") || args.includes("--yes")) {
    // --all/--yes only skip the interactive selection; they never imply
    // deleting a running instance's directory. --force is the explicit opt-in.
    if (!assertCleanable(instances, force)) process.exit(1);
    for (const inst of instances) rmSync(inst.path, { recursive: true, force: true });
    pruneInstanceBaselines(instances);
    pruneInstanceSettingsBackups(instances);
    console.log(`✓ Removed ${instances.length} instance director${instances.length === 1 ? "y" : "ies"}.`);
    return;
  }

  if (!process.stdin.isTTY) {
    console.error("✗ clean requires an interactive terminal (or use --all to remove everything).");
    process.exit(1);
  }

  const options = [
    ...instances.map((i) => ({ label: `${i.appType}/${i.name}`, value: i.path })),
    { label: "Delete ALL instances", value: "__all__" },
  ];
  const choice = await tuiSelect("Select instance directory to remove", options);
  if (choice.value === "__all__") {
    if (!assertCleanable(instances, force)) process.exit(1);
    for (const inst of instances) rmSync(inst.path, { recursive: true, force: true });
    pruneInstanceBaselines(instances);
    pruneInstanceSettingsBackups(instances);
    console.log(`✓ Removed ${instances.length} instance director${instances.length === 1 ? "y" : "ies"}.`);
  } else {
    const targets = instances.filter((i) => i.path === choice.value);
    if (!assertCleanable(targets, force)) process.exit(1);
    rmSync(choice.value, { recursive: true, force: true });
    pruneInstanceBaselines(targets);
    pruneInstanceSettingsBackups(targets);
    console.log(`✓ Removed ${choice.value}`);
  }
}


export { aggregationDoctorChecks, assertCleanable, blockingSessions, codexAggregationDoctorChecks, collectInstances, runClean, runDoctor, which };
