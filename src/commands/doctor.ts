// ─── commands/doctor (split from bin/cc-launch.mjs) ─────────────────────────────

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DoctorCheck, DoctorFixResult, InstanceInfo } from "../types.js";
import { APP_ADAPTERS } from "../adapters.js";
import { instanceInstructionsPath } from "./customize.js";
import { pruneInstanceBaselines } from "./ps.js";
import {
  loadSettings,
  queryCommonConfig,
  queryDB,
  queryProviderById,
  queryProvidersByApp,
  readSchemaUserVersion,
} from "../db.js";
import { ensureSymlink, lstatSyncSafe, readdirSyncSafe } from "../fs-utils.js";
import { pruneInstanceSettingsBackups } from "../guard.js";
import { deepEqualJson, isPlainObject, parseJsonObject } from "../json-utils.js";
import { loadSyncState, readSessions, sessionLiveness } from "../sessions.js";
import { recordInstanceBaseline } from "../drift.js";
import {
  DB_PATH,
  INSTANCES_DIR,
  LIVE_STATE_PATH,
  SYNC_STATE_PATH,
  VIRTUAL_STACK_PROVIDER_ID,
} from "../paths.js";
import { detectSharedConfigMode, readSharedConfig } from "../shared-config.js";
import { codexAggregationRoute } from "../stack/catalog.js";
import {
  isAggregationProviderSettings,
  probeTcpReachable,
  readStackState,
  virtualStackProviderFor,
} from "../stack/state.js";
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
      if (lstatSyncSafe(full)?.isDirectory())
        instances.push({ name, appType: adapter.appType, path: full });
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
    console.error(
      `    ${b.inst.appType}/${b.inst.name} (pid ${b.session.pid ?? "?"}, ${b.status})`,
    );
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
  const add = (label: string, pass: boolean, detail: string) =>
    checks.push({ label, pass, detail });
  if (!existsSync(LIVE_STATE_PATH)) {
    add("aggregation live-state", true, "not present (aggregation off)");
    return checks;
  }
  let raw: any = null;
  try {
    raw = JSON.parse(readFileSync(LIVE_STATE_PATH, "utf8"));
  } catch {}
  if (!isPlainObject(raw)) {
    add("aggregation live-state", false, "exists but unparseable");
    return checks;
  }
  if (raw!.version !== undefined && raw!.version !== 1) {
    add(
      "aggregation live-state",
      false,
      `unsupported contract version ${raw!.version} (expected 1) — read as off`,
    );
    return checks;
  }
  const stack = readStackState("claude");
  if (!stack) {
    add("aggregation live-state", true, "readable (aggregation off)");
    return checks;
  }
  add("aggregation live-state", true, "readable (stack on)");
  const rowExists = (id) => {
    try {
      return !!queryProviderById(id, "claude");
    } catch {
      return false;
    }
  };
  const missing = Object.entries(stack.keys)
    .filter(([, id]) => !rowExists(id))
    .map(([key]) => key);
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
    add(
      "aggregation Stack row",
      false,
      "live stack but no virtual entry derivable — global ~/.claude/settings.json env is missing or not loopback",
    );
    return checks;
  }
  let baseUrl: string | null = null;
  try {
    baseUrl = JSON.parse(virtual.settings_config)?.env?.ANTHROPIC_BASE_URL ?? null;
  } catch {}
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
  add(
    "aggregation Stack row",
    true,
    legacy
      ? `virtual entry derived (${baseUrl}, not stored in DB); ${legacy} legacy DB row(s) pending auto-cleanup`
      : `virtual entry derived (${baseUrl}, not stored in DB)`,
  );
  const reachable = typeof baseUrl === "string" ? await probeTcpReachable(baseUrl) : false;
  add(
    "aggregation proxy",
    reachable,
    reachable
      ? `${baseUrl} reachable`
      : `${baseUrl ?? "?"} unreachable — open the cc-switch desktop app with aggregation on`,
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
  const add = (label: string, pass: boolean, detail: string) =>
    checks.push({ label, pass, detail });
  const stack = readStackState("codex");
  if (!stack) return checks;
  const virtual = virtualStackProviderFor("codex");
  if (!virtual) {
    add(
      "codex aggregation Stack row",
      false,
      "live stack but no virtual entry derivable — global ~/.codex/config.toml is missing, has no custom model_provider, or its base_url is not loopback",
    );
    return checks;
  }
  let baseUrl: string | null = null;
  try {
    const r = codexAggregationRoute(JSON.parse(virtual.settings_config)?.config || "");
    baseUrl = r?.baseUrl ?? null;
  } catch {}
  add(
    "codex aggregation Stack row",
    true,
    `virtual entry derived (${baseUrl ?? "?"}, not stored in DB)`,
  );
  const reachable = typeof baseUrl === "string" ? await probeTcpReachable(baseUrl) : false;
  add(
    "codex aggregation proxy",
    reachable,
    reachable
      ? `${baseUrl} reachable`
      : `${baseUrl ?? "?"} unreachable — open the cc-switch desktop app with aggregation on`,
  );
  return checks;
}

// A missing baseline may only be backfilled when the instance file is exactly
// what prepare would write from the current provider row + shared config.
// Snapshot equality is the guard: user edits and unsynced shared-config drift
// both fail it, so they keep failing the check instead of being baked in.
function baselineFixSafe(adapter: any, row: any, appType: string, snapshot: any): boolean {
  try {
    const settingsConfig = parseJsonObject(row.settings_config);
    const meta = parseJsonObject(row.meta);
    if (!isPlainObject(settingsConfig) || !isPlainObject(meta)) return false;
    const shared = readSharedConfig(appType);
    if (shared.mode === "live" && shared.unavailable) return false;
    const effective = adapter.computeEffectiveSettings(
      settingsConfig,
      meta,
      row.category,
      shared,
      row.id,
      loadSettings(),
      { writeWrapper: false },
    );
    return isPlainObject(effective) && deepEqualJson(snapshot, effective);
  } catch {
    return false;
  }
}

async function collectDoctorChecks(): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (label: string, pass: boolean, detail: string) =>
    checks.push({ label, pass, detail });

  // sqlite3
  const sqliteOk = !!which("sqlite3");
  add(
    "sqlite3 CLI",
    sqliteOk,
    sqliteOk ? "available" : "not found on PATH — required to read the cc-switch DB",
  );

  // DB + providers
  let dbOk = false;
  let counts = "";
  if (!existsSync(DB_PATH)) {
    counts = "DB file not found";
  } else {
    try {
      const tables = queryDB(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`,
      );
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
    if (!snip) {
      add(`common_config_${adapter.appType}`, true, "not set");
      continue;
    }
    let pass = true;
    try {
      adapter.appType === "claude" ? JSON.parse(snip) : parseToml(snip);
    } catch {
      pass = false;
    }
    add(
      `common_config_${adapter.appType}`,
      pass,
      pass ? "parseable (legacy source)" : "unparseable",
    );
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
    const broken: string[] = [];
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
    // One fixable entry per broken link (the summary above stays for
    // backwards-compatible output); only a resolvable global target can heal.
    for (const name of broken) {
      const linkPath = instanceInstructionsPath(adapter.appType, name);
      checks.push({
        label: `${adapter.appType} instructions link "${name}"`,
        pass: false,
        detail: globalOk
          ? `broken symlink at ${linkPath} — run with --fix to relink it to ${globalPath}`
          : `broken symlink at ${linkPath}; global ${adapter.instructions.fileName} is missing`,
        ...(globalOk
          ? { fixable: true, fixId: `instructions-link:${adapter.appType}:${name}` }
          : {}),
      });
    }
  }

  // sync state
  add(
    "sync-state.json",
    existsSync(SYNC_STATE_PATH),
    existsSync(SYNC_STATE_PATH) ? "present" : "not yet created (first run)",
  );

  // Per-instance self-heal candidates (doctor --fix whitelist). A recorded
  // baseline is the evidence that switch launched the instance before; a
  // provider row that is gone is left alone (clean and the desktop app own
  // deletions). The virtual Stack entry has no DB row to anchor to.
  const syncState = loadSyncState();
  for (const adapter of Object.values(APP_ADAPTERS)) {
    const recorded = syncState?.instances?.[adapter.appType];
    if (!isPlainObject(recorded)) continue;
    for (const id of Object.keys(recorded)) {
      if (id === VIRTUAL_STACK_PROVIDER_ID) continue;
      if (!queryProviderById(id, adapter.appType)) continue;
      const dir = join(INSTANCES_DIR, adapter.appType, id);
      if (lstatSyncSafe(dir)?.isDirectory()) continue;
      checks.push({
        label: `${adapter.appType} instance dir "${id}"`,
        pass: false,
        detail: `missing at ${dir} (a baseline was recorded) — run with --fix to recreate it`,
        fixable: true,
        fixId: `instance-dir:${adapter.appType}:${id}`,
      });
    }
  }

  // Baseline missing: the instance exists and its config parses, but
  // sync-state has no v3 preparedSettings. Only record one when the file is
  // exactly what the current provider + shared config would write — anything
  // else (user edits, unsynced drift) must not become the ground truth.
  for (const inst of instances) {
    if (inst.name === VIRTUAL_STACK_PROVIDER_ID) continue;
    const adapter = (APP_ADAPTERS as any)[inst.appType];
    if (!adapter?.readInstanceSettingsSnapshot) continue;
    const row = queryProviderById(inst.name, inst.appType);
    if (!row) continue;
    const entry = syncState?.instances?.[inst.appType]?.[inst.name];
    if (isPlainObject(entry?.preparedSettings)) continue;
    const snapshot = adapter.readInstanceSettingsSnapshot(inst.path);
    if (!isPlainObject(snapshot)) continue;
    const safe = baselineFixSafe(adapter, row, inst.appType, snapshot);
    checks.push({
      label: `${inst.appType} instance baseline "${inst.name}"`,
      pass: false,
      detail: safe
        ? "no baseline recorded — run with --fix to record one"
        : "no baseline recorded; the instance content differs from the current provider/shared config (run switch sync or relaunch)",
      ...(safe ? { fixable: true, fixId: `baseline:${inst.appType}:${inst.name}` } : {}),
    });
  }

  // aggregation (cc-switch 4.0 Stack) — live-state contract, member rows,
  // Stack row, proxy reachability
  for (const c of await aggregationDoctorChecks()) add(c.label, c.pass, c.detail);
  for (const c of await codexAggregationDoctorChecks()) add(c.label, c.pass, c.detail);

  return checks;
}

function renderDoctorText(
  checks: DoctorCheck[],
  opts: { fixMode?: boolean; fixes?: DoctorFixResult[] } = {},
): void {
  console.log("\n  \x1b[1mcc-switch-parallel doctor\x1b[0m\n");
  for (const f of opts.fixes || []) {
    const ok = f.status === "fixed";
    const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${mark} ${ok ? "fixed" : "fix failed"} ${f.label} — ${f.detail}`);
  }
  if (opts.fixes?.length) console.log("");
  for (const c of checks) {
    const mark = c.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const note = opts.fixMode && !c.pass && !c.fixable ? " \x1b[2m(not auto-fixable)\x1b[0m" : "";
    console.log(`  ${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ""}${note}`);
  }
  console.log("");
  const failed = checks.filter((c) => !c.pass).length;
  if (failed) {
    console.log(`  \x1b[31m${failed} issue(s) found.\x1b[0m\n`);
    process.exit(1);
  }
  console.log("  \x1b[32mAll checks passed.\x1b[0m\n");
}

function parseDoctorArgs(args: string[]): { json: boolean; fix: boolean; unknown: string[] } {
  const out = { json: false, fix: false, unknown: [] as string[] };
  for (const a of args) {
    if (a === "--json") out.json = true;
    else if (a === "--fix") out.fix = true;
    else out.unknown.push(a);
  }
  return out;
}

const FIX_ORDER = ["instance-dir", "instructions-link", "baseline"];

function applyOneFix(kind: string, appType: string, providerId: string): string {
  const adapter = (APP_ADAPTERS as any)[appType];
  if (!adapter) throw new Error(`unknown app type "${appType}"`);
  if (kind === "instance-dir") {
    const dir = adapter.setupInstance(providerId);
    if (!lstatSyncSafe(dir)?.isDirectory())
      throw new Error(`instance directory was not created at ${dir}`);
    return `recreated ${dir}`;
  }
  if (kind === "instructions-link") {
    const fileName = adapter.instructions?.fileName;
    const globalPath = adapter.instructions?.globalPath?.();
    if (!globalPath || !existsSync(globalPath)) {
      throw new Error(`global ${fileName || "instructions"} file is missing — create it first`);
    }
    const linkPath = instanceInstructionsPath(appType, providerId);
    ensureSymlink(globalPath, linkPath);
    // ensureSymlink swallows creation errors; verify the result instead.
    const st = lstatSyncSafe(linkPath);
    if (!st?.isSymbolicLink() || !existsSync(linkPath))
      throw new Error(`symlink is still broken at ${linkPath}`);
    if (resolve(readlinkSync(linkPath)) !== resolve(globalPath)) {
      throw new Error(`${linkPath} does not point at ${globalPath}`);
    }
    return `relinked ${linkPath} -> ${globalPath}`;
  }
  if (kind === "baseline") {
    const dir = join(INSTANCES_DIR, appType, providerId);
    const row = queryProviderById(providerId, appType);
    if (!row) throw new Error(`provider row "${providerId}" not found (${appType})`);
    if (!adapter.readInstanceSettingsSnapshot)
      throw new Error(`adapter "${appType}" has no settings snapshot`);
    const snapshot = adapter.readInstanceSettingsSnapshot(dir);
    if (!isPlainObject(snapshot)) throw new Error(`cannot read the instance config at ${dir}`);
    if (!baselineFixSafe(adapter, row, appType, snapshot)) {
      throw new Error("instance content no longer matches the current provider/shared config");
    }
    recordInstanceBaseline(adapter, providerId, dir, readSharedConfig(appType));
    // recordInstanceBaseline is best-effort; verify the write landed.
    const entry = loadSyncState()?.instances?.[appType]?.[providerId];
    if (!isPlainObject(entry?.preparedSettings)) throw new Error("baseline was not recorded");
    return `recorded baseline for ${dir}`;
  }
  throw new Error(`unknown fix id "${kind}"`);
}

function applyDoctorFixes(checks: DoctorCheck[]): DoctorFixResult[] {
  const results: DoctorFixResult[] = [];
  const seen = new Set<string>();
  const fixable = checks
    .filter((c) => !c.pass && c.fixable === true && typeof c.fixId === "string")
    .sort(
      (a, b) =>
        FIX_ORDER.indexOf(a.fixId!.split(":")[0]) - FIX_ORDER.indexOf(b.fixId!.split(":")[0]),
    );
  for (const check of fixable) {
    const fixId = check.fixId!;
    if (seen.has(fixId)) continue;
    seen.add(fixId);
    const [kind, appType, providerId] = fixId.split(":");
    try {
      results.push({
        fixId,
        label: check.label,
        status: "fixed",
        detail: applyOneFix(kind, appType, providerId),
      });
    } catch (e: any) {
      results.push({
        fixId,
        label: check.label,
        status: "failed",
        detail: e?.message || String(e),
      });
    }
  }
  return results;
}

function renderDoctorJson(checks: DoctorCheck[], fixes?: DoctorFixResult[]): string {
  const failed = checks.filter((c) => !c.pass).length;
  return JSON.stringify(
    {
      version: 1,
      ok: failed === 0,
      summary: { total: checks.length, passed: checks.length - failed, failed },
      ...(fixes ? { fixes } : {}),
      checks,
    },
    null,
    2,
  );
}

async function runDoctor(args: string[] = []): Promise<void> {
  const parsed = parseDoctorArgs(args);
  if (parsed.unknown.length) {
    console.error(`✗ unknown argument: ${parsed.unknown[0]}`);
    console.error("Usage: switch doctor [--json] [--fix]");
    process.exit(1);
  }
  if (parsed.fix) {
    // collect → whitelisted fixes → re-collect: the final state decides the
    // exit code, and a failed fix simply leaves its check failing.
    const before = await collectDoctorChecks();
    const fixes = applyDoctorFixes(before);
    const checks = await collectDoctorChecks();
    if (parsed.json) {
      console.log(renderDoctorJson(checks, fixes));
      if (checks.some((c) => !c.pass)) process.exitCode = 1;
      return;
    }
    renderDoctorText(checks, { fixMode: true, fixes });
    return;
  }
  const checks = await collectDoctorChecks();
  if (parsed.json) {
    console.log(renderDoctorJson(checks));
    // exitCode instead of exit(): let stdout drain before the process ends.
    if (checks.some((c) => !c.pass)) process.exitCode = 1;
    return;
  }
  renderDoctorText(checks);
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
    console.log(
      `✓ Removed ${instances.length} instance director${instances.length === 1 ? "y" : "ies"}.`,
    );
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
    console.log(
      `✓ Removed ${instances.length} instance director${instances.length === 1 ? "y" : "ies"}.`,
    );
  } else {
    const targets = instances.filter((i) => i.path === choice.value);
    if (!assertCleanable(targets, force)) process.exit(1);
    rmSync(choice.value, { recursive: true, force: true });
    pruneInstanceBaselines(targets);
    pruneInstanceSettingsBackups(targets);
    console.log(`✓ Removed ${choice.value}`);
  }
}

export {
  aggregationDoctorChecks,
  applyDoctorFixes,
  assertCleanable,
  blockingSessions,
  codexAggregationDoctorChecks,
  collectDoctorChecks,
  collectInstances,
  parseDoctorArgs,
  renderDoctorJson,
  renderDoctorText,
  runClean,
  runDoctor,
  which,
};
