// ─── commands/ps (split from bin/cc-launch.mjs) ─────────────────────────────

import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { buildRunningSet, collectInstances, pruneInstanceBaselines } from "../instances.js";
import { ccsClaudeKeyFromModel } from "../stack/aggregation.js";
import type { InstanceInfo, ProviderRow } from "../types.js";
import { queryProviderById } from "../db.js";
import { confirmSync } from "../drift.js";
import { HOME } from "../paths.js";
import { readSessions, removeSessionFile, sessionLiveness } from "../sessions.js";
import {
  displayWidth,
  padDisplay,
  parseTmuxPaneInfo,
  parseTmuxPanes,
  sanitizeText,
  type TmuxPaneInfo,
} from "../terminal-utils.js";
import { isAggregationProviderSettings, readStackState } from "../stack/state.js";

// ─── switch ps ────────────────────────────────────────────────────────

// Billable member name for an aggregation instance, decoded from the
// instance settings.json's /model pick ("ccs-claude-<key>--…" — same rule
// as the statusline wrapper). null when the pick is not attributable (no
// ccs prefix, stack off, or the key no longer live) — the plain provider
// name is shown then. Pure given (model, stack); DB lookup inside.
function stackBillingMemberName(model, stack) {
  const key = ccsClaudeKeyFromModel(model);
  if (!key) return null;
  const pid = stack?.keys?.[key];
  if (!pid) return null;
  try {
    return queryProviderById(pid, "claude")?.name || null;
  } catch {
    return null;
  }
}

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `${d}d${String(h % 24).padStart(2, "0")}h`;
}

// Live providerIds across all instances — feeds the TUI ● live marker.
// Same per-iteration-snapshot pattern as snapshotAliveByCli. Read-only: any
// session alive marks the provider; cleanup is `runPs`'s job.
// tty → tmux session name, one lookup for the whole `ps` run. Empty map when
// tmux is absent, hangs (bounded at 2s) or errors — caller then falls back to
// the raw tty. Session names are sanitized by the parser.
function tmuxSessionByTty() {
  try {
    const r = spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_tty}\t#{session_name}"], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 1 << 20,
    });
    if (r.error || r.status !== 0) return new Map();
    return parseTmuxPanes(r.stdout || "");
  } catch {
    return new Map();
  }
}

// One row per live/unknown session, shared by the table and JSON renderers
// (and later by `ps kill`/`ps attach`, so an index always means the same row).
// "unknown" (EPERM, unreadable lstart) stays visible and is never deleted.
type RunningSessionRow = {
  index: number;
  path: string;
  inst: InstanceInfo;
  session: any;
  status: "alive" | "unknown";
  pid: number | null;
  cli: string;
  providerId: string;
  name: string;
  billingMember: string | null;
  tmux: string | null;
  tty: string | null;
  cwd: string | null;
  startedAt: number | null;
  upMs: number;
  extraArgs: string[];
};

function collectRunningSessions(): RunningSessionRow[] {
  const running: { path: string; inst: InstanceInfo; session: any; status: "alive" | "unknown" }[] =
    [];
  for (const inst of collectInstances()) {
    for (const { path, session } of readSessions(inst.path)) {
      const status = sessionLiveness(session);
      if (status === "dead") {
        // A crashed parent (kill -9) leaves no exit event behind — clean up
        // here. Only the dead session's own file, never its siblings.
        try {
          unlinkSync(path);
        } catch {}
        continue;
      }
      running.push({ path, inst, session, status });
    }
  }
  if (!running.length) return [];
  const tmuxByTty = tmuxSessionByTty();
  let stackForBilling; // lazy: readStackState once, only when a claude row asks
  const now = Date.now();
  const rows = running.map(({ path, inst, session, status }) => {
    const providerId = session.providerId || inst.name;
    let name = providerId;
    let row: ProviderRow | null = null;
    try {
      row = queryProviderById(inst.name, inst.appType);
      if (row?.name) name = row.name;
    } catch {} // dead DB row → fall back to the id
    // Aggregation instance: surface the billable member next to the row name
    // ("Stack → DeepSeek") — the /model pick is instance-local, so this is
    // the only place a parallel-instance panel can show who is paying.
    // Aggregation-row gated: a plain row's instance can carry a stale ccs
    // pick (historically synced in), which would mis-bill the suffix.
    // Stack state is read lazily, once, shared across rows.
    let billingMember: string | null = null;
    if (inst.appType === "claude" && row) {
      try {
        if (isAggregationProviderSettings(JSON.parse(row.settings_config))) {
          stackForBilling ??= readStackState("claude");
          const s = JSON.parse(readFileSync(join(inst.path, "settings.json"), "utf8"));
          billingMember = stackBillingMemberName(s?.model, stackForBilling);
        }
      } catch {} // unreadable row/settings → plain name stands
    }
    const startedAt =
      typeof session.startedAt === "number" && Number.isFinite(session.startedAt)
        ? session.startedAt
        : null;
    const tmux = session.tty && tmuxByTty.get(session.tty) ? tmuxByTty.get(session.tty) : null;
    return {
      path,
      inst,
      session,
      status,
      pid: Number.isInteger(session.pid) && session.pid > 0 ? session.pid : null,
      cli: inst.appType,
      providerId: sanitizeText(providerId),
      name: sanitizeText(name),
      billingMember: billingMember === null ? null : sanitizeText(billingMember),
      tmux: tmux === null ? null : sanitizeText(tmux),
      tty: session.tty ? sanitizeText(session.tty) : null,
      cwd: session.cwd ? sanitizeText(session.cwd) : null,
      startedAt,
      upMs: startedAt === null ? 0 : Math.max(0, now - startedAt),
      extraArgs: Array.isArray(session.extraArgs)
        ? session.extraArgs.map((a) => sanitizeText(a))
        : [],
      index: 0,
    };
  });
  // Stable order so `ps` indices and `ps kill`/`ps attach` targets agree:
  // oldest first, then the deterministic identity fields.
  rows.sort((a, b) => {
    const at = a.startedAt ?? Number.POSITIVE_INFINITY;
    const bt = b.startedAt ?? Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    if (a.cli !== b.cli) return a.cli < b.cli ? -1 : 1;
    if (a.providerId !== b.providerId) return a.providerId < b.providerId ? -1 : 1;
    return (a.pid ?? 0) - (b.pid ?? 0);
  });
  rows.forEach((r, i) => {
    r.index = i + 1;
  });
  return rows;
}

function renderPsTable(rows: RunningSessionRow[]): void {
  if (!rows.length) {
    console.log("✓ No running instances");
    return;
  }
  const home = process.env.HOME;
  const shorten = (p) => (home && p && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const display = rows.map((r) => ({
    index: String(r.index),
    cli: r.cli,
    name: r.billingMember ? `${r.name} → ${r.billingMember}` : r.name,
    tmux: r.tmux || r.tty || "-",
    dir: shorten(r.cwd) || "-",
    up: formatDuration(r.upMs),
    args: r.extraArgs.length ? ` ${r.extraArgs.join(" ")}` : "",
  }));
  const w = (xs) => Math.max(...xs.map((x) => displayWidth(x)), 1);
  const wIndex = w(display.map((r) => r.index));
  const wCli = w(display.map((r) => r.cli));
  const wName = w(display.map((r) => r.name));
  const wTmux = w(display.map((r) => r.tmux));
  const wDir = w(display.map((r) => r.dir));
  const wUp = w(display.map((r) => r.up));
  console.log("");
  for (const r of display) {
    console.log(
      `  ${padDisplay(r.index, wIndex)}  ${padDisplay(r.cli, wCli)}  ${padDisplay(r.name, wName)}  ` +
        `${padDisplay(r.tmux, wTmux)}  ${padDisplay(r.dir, wDir)}  up ${padDisplay(r.up, wUp)}  ${r.cli}${r.args}`,
    );
  }
  console.log("");
}

function renderPsJson(rows: RunningSessionRow[]): string {
  return JSON.stringify(
    {
      version: 1,
      sessions: rows.map((r) => ({
        index: r.index,
        pid: r.pid,
        cli: r.cli,
        providerId: r.providerId,
        name: r.name,
        tmux: r.tmux,
        tty: r.tty,
        cwd: r.cwd,
        startedAt: r.startedAt,
        upMs: r.upMs,
        extraArgs: r.extraArgs,
        billingMember: r.billingMember,
        status: r.status,
      })),
    },
    null,
    2,
  );
}

type PsArgs =
  | { mode: "table" }
  | { mode: "json" }
  | { mode: "kill"; target: string; force: boolean }
  | { mode: "attach"; target: string }
  | { error: string; usage: string };

function parsePsArgs(args: string[]): PsArgs {
  if (!args.length) return { mode: "table" };
  if (args.length === 1 && args[0] === "--json") return { mode: "json" };
  if (args[0] === "kill") {
    let force = false;
    const rest: string[] = [];
    for (const a of args.slice(1)) {
      if (a === "--force") force = true;
      else rest.push(a);
    }
    if (rest.length !== 1) {
      return {
        error: "kill requires exactly one target",
        usage: "Usage: switch ps kill <pid|index> [--force]",
      };
    }
    return { mode: "kill", target: rest[0], force };
  }
  if (args[0] === "attach") {
    if (args.length !== 2) {
      return {
        error: "attach requires exactly one index",
        usage: "Usage: switch ps attach <index>",
      };
    }
    return { mode: "attach", target: args[1] };
  }
  return {
    error: `unknown argument: ${args[0]}`,
    usage: "Usage: switch ps [--json | kill <pid|index> [--force] | attach <index>]",
  };
}

type SessionTarget = { ok: true; row: RunningSessionRow } | { ok: false; error: string };

function resolveSessionTarget(rows: RunningSessionRow[], token: string): SessionTarget {
  const raw = String(token ?? "");
  let mode: "index" | "pid" | "auto" = "auto";
  let value = raw;
  if (/^#\d+$/.test(raw)) {
    mode = "index";
    value = raw.slice(1);
  } else if (/^pid:\d+$/i.test(raw)) {
    mode = "pid";
    value = raw.slice(4);
  } else if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      error: `invalid target "${raw}" — use an index (1..${rows.length}) or pid:<pid>`,
    };
  }
  if (!rows.length) return { ok: false, error: "no running sessions" };
  const n = Number(value);
  if (mode === "index" || (mode === "auto" && n >= 1 && n <= rows.length)) {
    const row = rows.find((r) => r.index === n);
    return row
      ? { ok: true, row }
      : { ok: false, error: `index ${n} is out of range (1..${rows.length})` };
  }
  const row = rows.find((r) => r.pid === n);
  return row ? { ok: true, row } : { ok: false, error: `no session matches "${raw}"` };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code !== "ESRCH";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return true;
    await sleep(100);
  }
  return !pidExists(pid);
}

function signalPid(pid: number, signal: NodeJS.Signals): "ok" | "gone" | "eperm" | "error" {
  try {
    process.kill(pid, signal);
    return "ok";
  } catch (e: any) {
    if (e?.code === "ESRCH") return "gone";
    if (e?.code === "EPERM") return "eperm";
    return "error";
  }
}

async function confirmKill(row: RunningSessionRow): Promise<boolean> {
  const result = await confirmSync(
    [
      `  #${row.index}  ${row.cli}  ${row.name}  pid ${row.pid}`,
      `  tmux: ${row.tmux ?? "-"}  dir: ${row.cwd ?? "-"}`,
    ],
    "Kill this session?",
  );
  if (result === "interrupt") process.exit(130);
  return result === "yes";
}

type KillOptions = {
  force?: boolean;
  confirm?: () => Promise<boolean>;
  isTTY?: boolean;
  termTimeoutMs?: number;
  killTimeoutMs?: number;
};

type ActionResult = { ok: boolean; detail: string; exitCode?: number };

// Only a session that was recorded by this tool AND still matches its
// recorded lstart is signalable. "unknown" means we cannot prove the pid is
// ours, so it is refused even though the process exists.
async function killSession(row: RunningSessionRow, opts: KillOptions = {}): Promise<ActionResult> {
  const pid = row.pid;
  if (pid === null || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    return {
      ok: false,
      detail: `refusing to signal pid ${row.pid ?? "?"} (not a valid session pid)`,
    };
  }
  const liveness = sessionLiveness(row.session);
  if (liveness === "dead") {
    removeSessionFile(row.path);
    return { ok: true, detail: `session #${row.index} already exited` };
  }
  if (liveness === "unknown") {
    return {
      ok: false,
      detail: `refusing to signal pid ${pid}: cannot verify process identity (lstart mismatch or unreadable)`,
    };
  }
  if (!opts.force) {
    const interactive = opts.isTTY ?? !!process.stdin.isTTY;
    if (!interactive) {
      return { ok: false, detail: "ps kill requires an interactive terminal (or use --force)" };
    }
    const confirmed = opts.confirm ? await opts.confirm() : await confirmKill(row);
    if (!confirmed) return { ok: false, detail: "cancelled" };
  }

  const termTimeoutMs = opts.termTimeoutMs ?? 5000;
  const killTimeoutMs = opts.killTimeoutMs ?? 2000;
  if (opts.force) {
    const killed = signalPid(pid, "SIGKILL");
    if (killed === "eperm") return { ok: false, detail: `permission denied signaling pid ${pid}` };
    if (killed !== "gone" && !(await waitForPidExit(pid, killTimeoutMs))) {
      return {
        ok: false,
        detail: `session #${row.index} (pid ${pid}) is still running after SIGKILL`,
      };
    }
  } else {
    const term = signalPid(pid, "SIGTERM");
    if (term === "eperm") return { ok: false, detail: `permission denied signaling pid ${pid}` };
    let exited = term === "gone" || (await waitForPidExit(pid, termTimeoutMs));
    if (!exited) {
      const killed = signalPid(pid, "SIGKILL");
      if (killed === "eperm")
        return { ok: false, detail: `permission denied signaling pid ${pid}` };
      exited = killed === "gone" || (await waitForPidExit(pid, killTimeoutMs));
    }
    if (!exited) {
      return {
        ok: false,
        detail: `session #${row.index} (pid ${pid}) is still running after SIGKILL`,
      };
    }
  }
  removeSessionFile(row.path);
  return { ok: true, detail: `killed session #${row.index} (pid ${pid}, ${row.cli}, ${row.name})` };
}

type TmuxLookup =
  | { ok: true; panes: Map<string, TmuxPaneInfo> }
  | { ok: false; reason: "notFound" | "unavailable" };

function tmuxPaneInfoByTty(): TmuxLookup {
  try {
    const r = spawnSync(
      "tmux",
      [
        "list-panes",
        "-a",
        "-F",
        "#{pane_tty}\t#{session_name}\t#{pane_id}\t#{window_index}\t#{pane_index}",
      ],
      { encoding: "utf8", timeout: 2000, maxBuffer: 1 << 20 },
    );
    if (r.error)
      return { ok: false, reason: (r.error as any).code === "ENOENT" ? "notFound" : "unavailable" };
    if (r.status !== 0) return { ok: false, reason: "unavailable" };
    return { ok: true, panes: parseTmuxPaneInfo(r.stdout || "") };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

type AttachOptions = {
  insideTmux?: boolean;
  isTTY?: boolean;
  runTmux?: (argv: string[], opts?: any) => any;
  lookup?: TmuxLookup;
};

function attachSession(row: RunningSessionRow, opts: AttachOptions = {}): ActionResult {
  const lookup = opts.lookup ?? tmuxPaneInfoByTty();
  if (!lookup.ok) {
    return {
      ok: false,
      detail:
        lookup.reason === "notFound"
          ? "tmux not found on PATH — attach requires tmux."
          : "tmux is not available (is a server running?)",
    };
  }
  const pane = row.tty ? lookup.panes.get(row.tty) : null;
  if (!pane) {
    return {
      ok: false,
      detail: `session #${row.index} is not running inside tmux (tty: ${row.tty ?? "-"})`,
    };
  }
  const run =
    opts.runTmux ??
    ((argv: string[], o: any = {}) => spawnSync("tmux", argv, { encoding: "utf8", ...o }));
  const failed = (what: string, r: any): ActionResult => ({
    ok: false,
    detail: `${what} failed${r?.stderr ? `: ${sanitizeText(String(r.stderr)).trim()}` : ""}`,
    exitCode: typeof r?.status === "number" ? r.status : 1,
  });
  const inside = opts.insideTmux ?? !!process.env.TMUX;
  if (inside) {
    let r = run(["switch-client", "-t", pane.session]);
    if (r.error || r.status !== 0) return failed("tmux switch-client", r);
    r = run(["select-pane", "-t", pane.paneId]);
    if (r.error || r.status !== 0) return failed("tmux select-pane", r);
    return { ok: true, detail: `selected ${pane.session} ${pane.paneId}` };
  }
  const interactive = opts.isTTY ?? !!process.stdin.isTTY;
  if (!interactive) return { ok: false, detail: "attach requires an interactive terminal." };
  let r = run(["select-window", "-t", `${pane.session}:${pane.windowIndex}`]);
  if (r.error || r.status !== 0) return failed("tmux select-window", r);
  r = run(["select-pane", "-t", pane.paneId]);
  if (r.error || r.status !== 0) return failed("tmux select-pane", r);
  r = run(["attach-session", "-t", pane.session], { stdio: "inherit" });
  if (r.error)
    return { ok: false, detail: `tmux attach-session failed: ${r.error.message || r.error}` };
  if (typeof r.status === "number" && r.status !== 0) {
    return { ok: false, detail: "tmux attach-session failed", exitCode: r.status };
  }
  return { ok: true, detail: `attached to ${pane.session} ${pane.paneId}` };
}

async function runPs(args: string[] = []): Promise<void> {
  const parsed = parsePsArgs(args);
  if ("error" in parsed) {
    console.error(`✗ ${parsed.error}`);
    console.error(parsed.usage);
    process.exit(1);
  }
  const rows = collectRunningSessions();
  if (parsed.mode === "table") {
    renderPsTable(rows);
    return;
  }
  if (parsed.mode === "json") {
    console.log(renderPsJson(rows));
    return;
  }
  const target = resolveSessionTarget(rows, parsed.target);
  if (!target.ok) {
    console.error(`✗ ${target.error}`);
    process.exit(1);
  }
  const result =
    parsed.mode === "kill"
      ? await killSession(target.row, { force: parsed.force })
      : attachSession(target.row);
  if (!result.ok) {
    console.error(`✗ ${result.detail}`);
    process.exit(result.exitCode ?? 1);
  }
  console.log(`✓ ${result.detail}`);
}

export {
  attachSession,
  buildRunningSet,
  collectRunningSessions,
  formatDuration,
  killSession,
  parsePsArgs,
  pruneInstanceBaselines,
  renderPsJson,
  renderPsTable,
  resolveSessionTarget,
  runPs,
  stackBillingMemberName,
  tmuxPaneInfoByTty,
  tmuxSessionByTty,
};
