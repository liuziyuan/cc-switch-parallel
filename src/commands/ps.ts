// ─── commands/ps (split from bin/cc-launch.mjs) ─────────────────────────────

import { spawnSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { collectInstances } from "./doctor.js";
import type { InstanceInfo, ProviderRow } from "../types.js";
import { queryProviderById } from "../db.js";
import { HOME } from "../paths.js";
import { readSessions, saveSyncState, sessionIsAlive, withSyncStateLock } from "../sessions.js";
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
// tmux is absent or errors — caller then falls back to the raw tty.
function tmuxSessionByTty() {
  const map = new Map();
  try {
    const r = spawnSync("tmux", ["list-panes", "-a", "-F", "#{pane_tty}\t#{session_name}"], { encoding: "utf8" });
    if (r.status !== 0) return map;
    for (const line of (r.stdout || "").split("\n")) {
      // #{pane_tty} reports "/dev/ttysNNN"; ps(1) reports "ttysNNN". Normalize
      // to the ps form so session.tty lookups hit.
      const [tty, session] = line.split("\t");
      if (tty && session) map.set(tty.replace(/^\/dev\//, ""), session);
    }
  } catch {}
  return map;
}

function runPs() {
  const running: { inst: InstanceInfo; session: any }[] = [];
  for (const inst of collectInstances()) {
    for (const { path, session } of readSessions(inst.path)) {
      if (sessionIsAlive(session)) {
        running.push({ inst, session });
      } else {
        // A crashed parent (kill -9) leaves no exit event behind — clean up
        // here. Only the dead session's own file, never its siblings.
        try { unlinkSync(path); } catch {}
      }
    }
  }
  if (!running.length) {
    console.log("✓ No running instances");
    return;
  }
  const tmuxByTty = tmuxSessionByTty();
  let stackForBilling; // lazy: readStackState once, only when a claude row asks
  const home = process.env.HOME;
  const shorten = (p) => (home && p && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const rows = running.map(({ inst, session }) => {
    let name = session.providerId || inst.name;
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
    if (inst.appType === "claude" && row) {
      try {
        if (isAggregationProviderSettings(JSON.parse(row.settings_config))) {
          stackForBilling ??= readStackState("claude");
          const s = JSON.parse(readFileSync(join(inst.path, "settings.json"), "utf8"));
          const member = stackBillingMemberName(s?.model, stackForBilling);
          if (member) name = `${name} → ${member}`;
        }
      } catch {} // unreadable row/settings → plain name stands
    }
    return {
      cli: inst.appType,
      name,
      tmux: (session.tty && tmuxByTty.get(session.tty)) || session.tty || "-",
      dir: shorten(session.cwd) || "-",
      up: formatDuration(Date.now() - (session.startedAt || Date.now())),
      args: Array.isArray(session.extraArgs) && session.extraArgs.length
        ? ` ${session.extraArgs.join(" ")}`
        : "",
    };
  });
  const w = (xs) => Math.max(...xs.map((x) => x.length), 1);
  const wCli = w(rows.map((r) => r.cli));
  const wName = w(rows.map((r) => r.name));
  const wTmux = w(rows.map((r) => r.tmux));
  const wDir = w(rows.map((r) => r.dir));
  const wUp = w(rows.map((r) => r.up));
  console.log("");
  for (const r of rows) {
    console.log(`  ${r.cli.padEnd(wCli)}  ${r.name.padEnd(wName)}  ${r.tmux.padEnd(wTmux)}  ${r.dir.padEnd(wDir)}  up ${r.up.padEnd(wUp)}  ${r.cli}${r.args}`);
  }
  console.log("");
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


export { buildRunningSet, formatDuration, pruneInstanceBaselines, runPs, stackBillingMemberName, tmuxSessionByTty };
