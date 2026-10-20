// ─── commands/ps (split from bin/cc-launch.mjs) ─────────────────────────────

import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { collectInstances } from "./doctor.js";
import type { InstanceInfo, ProviderRow } from "../types.js";
import { queryProviderById } from "../db.js";
import { HOME } from "../paths.js";
import { readSessions, saveSyncState, sessionIsAlive, sessionLiveness, withSyncStateLock } from "../sessions.js";
import { displayWidth, padDisplay, parseTmuxPanes, sanitizeText } from "../terminal-utils.js";
import { isAggregationProviderSettings, readStackState } from "../stack/state.js";

// ─── switch ps ────────────────────────────────────────────────────────

// Billable member name for an aggregation instance, decoded from the
// instance settings.json's /model pick ("ccs-claude-<key>--…" — same rule
// as the statusline wrapper). null when the pick is not attributable (no
// ccs prefix, stack off, or the key no longer live) — the plain provider
// name is shown then. Pure given (model, stack); DB lookup inside.
function stackBillingMemberName(model, stack) {
  if (typeof model !== "string" || !model) return null;
  const ccs = model.match(/^ccs-claude-([a-z0-9-]+?)--/i);
  if (!ccs) return null;
  const pid = stack?.keys?.[ccs[1].toLowerCase()];
  if (!pid) return null;
  try { return queryProviderById(pid, "claude")?.name || null; } catch { return null; }
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
function buildRunningSet() {
  const running = new Set();
  for (const inst of collectInstances()) {
    for (const { session } of readSessions(inst.path)) {
      if (sessionIsAlive(session)) { running.add(inst.name); break; }
    }
  }
  return running;
}

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
  const running: { path: string; inst: InstanceInfo; session: any; status: "alive" | "unknown" }[] = [];
  for (const inst of collectInstances()) {
    for (const { path, session } of readSessions(inst.path)) {
      const status = sessionLiveness(session);
      if (status === "dead") {
        // A crashed parent (kill -9) leaves no exit event behind — clean up
        // here. Only the dead session's own file, never its siblings.
        try { unlinkSync(path); } catch {}
        continue;
      }
      running.push({ path, inst, session, status });
    }
  }
  if (!running.length) return [];
  const tmuxByTty = tmuxSessionByTty();
  let stackForBilling; // lazy: readStackState once, only when a claude row asks
  const now = Date.now();
  return running.map(({ path, inst, session, status }) => {
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
    const startedAt = typeof session.startedAt === "number" && Number.isFinite(session.startedAt)
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
      extraArgs: Array.isArray(session.extraArgs) ? session.extraArgs.map((a) => sanitizeText(a)) : [],
    };
  });
}

function renderPsTable(rows: RunningSessionRow[]): void {
  if (!rows.length) {
    console.log("✓ No running instances");
    return;
  }
  const home = process.env.HOME;
  const shorten = (p) => (home && p && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const display = rows.map((r) => ({
    cli: r.cli,
    name: r.billingMember ? `${r.name} → ${r.billingMember}` : r.name,
    tmux: r.tmux || r.tty || "-",
    dir: shorten(r.cwd) || "-",
    up: formatDuration(r.upMs),
    args: r.extraArgs.length ? ` ${r.extraArgs.join(" ")}` : "",
  }));
  const w = (xs) => Math.max(...xs.map((x) => displayWidth(x)), 1);
  const wCli = w(display.map((r) => r.cli));
  const wName = w(display.map((r) => r.name));
  const wTmux = w(display.map((r) => r.tmux));
  const wDir = w(display.map((r) => r.dir));
  const wUp = w(display.map((r) => r.up));
  console.log("");
  for (const r of display) {
    console.log(
      `  ${padDisplay(r.cli, wCli)}  ${padDisplay(r.name, wName)}  ${padDisplay(r.tmux, wTmux)}  ` +
      `${padDisplay(r.dir, wDir)}  up ${padDisplay(r.up, wUp)}  ${r.cli}${r.args}`,
    );
  }
  console.log("");
}

function runPs(_args: string[] = []): void {
  renderPsTable(collectRunningSessions());
}

// Drop the drift baselines of removed instance dirs, so stale-instance
// prompts stop naming providers whose directories are gone (the dir name IS
// the providerId — see setupInstance). Best-effort: a state-file hiccup must
// not fail the clean itself.
function pruneInstanceBaselines(instances) {
  try {
    withSyncStateLock((state) => {
      let changed = false;
      for (const { name, appType } of instances) {
        if (state.instances?.[appType]?.[name] !== undefined) {
          delete state.instances[appType][name];
          changed = true;
        }
      }
      if (changed) saveSyncState(state);
    });
  } catch {
    // best-effort: unreadable state — the ghost entry stays, harmless.
  }
}


export { buildRunningSet, collectRunningSessions, formatDuration, pruneInstanceBaselines, renderPsTable, runPs, stackBillingMemberName, tmuxSessionByTty };
