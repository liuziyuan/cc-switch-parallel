// ─── sessions (split from bin/cc-launch.mjs) ─────────────────────────────

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite, readdirSyncSafe } from "./fs-utils.js";
import { isPlainObject } from "./json-utils.js";
import { SYNC_STATE_PATH } from "./paths.js";

// ─── Tracked launch & session files ───────────────────────────────────

// Records of live switch-launched sessions, consumed by `switch ps` and the
// TUI live marker. One file per session (a provider can run concurrently in
// several terminals), inside the instance dir (same precedent as
// settings.json), so `clean` removes them with the directory.
const SESSIONS_SUBDIR = ".cc-switch-sessions";
const LEGACY_SESSION_FILENAME = ".cc-switch-session.json";
const sessionsDir = (instanceDir) => join(instanceDir, SESSIONS_SUBDIR);
const legacySessionFilePath = (instanceDir) => join(instanceDir, LEGACY_SESSION_FILENAME);

// One ps(1) field lookup; null on any hiccup. Used for lstart (the PID-reuse
// guard) and for the parent's tty.
function psField(pid, field) {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() || null : null;
  } catch {
    return null;
  }
}

// Writes this session's own file (named after pid+ms, so concurrent sessions
// never collide) and returns its path — null on failure. Callers only ever
// remove the path they got back, never a shared file.
function writeSessionFile(instanceDir, pid, bin, extraArgs) {
  try {
    let file = join(sessionsDir(instanceDir), `${pid}-${Date.now()}.json`);
    for (let n = 2; existsSync(file); n++) file = join(sessionsDir(instanceDir), `${pid}-${Date.now()}-${n}.json`);
    atomicWrite(file, JSON.stringify({
      pid,
      lstart: psField(pid, "lstart"),
      cli: bin,
      providerId: basename(instanceDir),
      startedAt: Date.now(),
      extraArgs,
      tty: psField(process.pid, "tty"),
      cwd: process.cwd(),
    }, null, 2));
    return file;
  } catch {
    // best-effort: a tracking failure must never block the launch
    return null;
  }
}

function removeSessionFile(sessionFilePath) {
  try { unlinkSync(sessionFilePath); } catch {}
}

// All sessions of an instance: the per-session files plus the legacy
// single-file record from older versions. A file that fails to parse (parent
// killed mid-write) yields { session: null } so the caller cleans it up.
function readSessions(instanceDir) {
  const out: { path: string; session: any }[] = [];
  const names = readdirSyncSafe(sessionsDir(instanceDir)) || [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".tmp.")) continue;
    const path = join(sessionsDir(instanceDir), name);
    try {
      const s = JSON.parse(readFileSync(path, "utf8"));
      out.push({ path, session: isPlainObject(s) ? s : null });
    } catch {
      out.push({ path, session: null });
    }
  }
  try {
    const s = JSON.parse(readFileSync(legacySessionFilePath(instanceDir), "utf8"));
    if (isPlainObject(s)) out.push({ path: legacySessionFilePath(instanceDir), session: s });
  } catch {}
  return out;
}

// Alive = pid exists AND its recorded lstart matches (kill(0) alone would
// false-positive once the OS reuses the pid).
function sessionIsAlive(session) {
  if (!session || typeof session.pid !== "number") return false;
  try {
    process.kill(session.pid, 0);
  } catch {
    return false;
  }
  if (!session.lstart) return true;
  return psField(session.pid, "lstart") === session.lstart;
}

// Env injected into every launched CLI session. The CLI's own hooks inherit
// these — that's the entire transport: the tmuxclihook status bar captures
// CC_SWITCH_PROVIDER / CC_SWITCH_PROVIDER_ID from the hook's environment into
// per-pane tmux options and renders the provider tag there (claude's wrapper
// tag and codex's native status_line both can't reach the tmux aggregate
// view). Ids are stable across renames; consumers wanting the tag color read
// statusline-preferences.json by id, exactly like the claude wrapper does.
function buildLaunchExtraEnv(providerName, providerId) {
  const env: Record<string, string> = {};
  if (providerName) env.CC_SWITCH_PROVIDER = String(providerName);
  if (providerId) env.CC_SWITCH_PROVIDER_ID = String(providerId);
  return env;
}

// Foreground replacement for the former spawnSync launch: stdio and exit-code
// semantics unchanged, but the child's pid is recorded while it runs and its
// session file is removed on a clean exit — only its own, so concurrent
// sessions of the same provider stay tracked. A crashed parent (kill -9)
// leaves the file behind — `switch ps` cleans those up as stale.
function launchTracked(bin, extraArgs, instanceDir, envKey, onExit, extraEnv) {
  // Belt-and-suspenders for the flowing-stdin hazard: any missed cleanup
  // upstream would let the parent keep consuming (and discarding) keystrokes
  // that belong to the spawned CLI. pause() is idempotent and cheap.
  try { process.stdin.pause(); } catch {}
  const child = spawn(bin, extraArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      [envKey]: instanceDir,
      ...(isPlainObject(extraEnv) ? extraEnv : {}),
    },
  });
  const sessionFile = child.pid ? writeSessionFile(instanceDir, child.pid, bin, extraArgs) : null;
  child.on("error", (e) => {
    if (sessionFile) removeSessionFile(sessionFile);
    console.error(`✗ Failed to launch ${bin}: ${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => {
    if (sessionFile) removeSessionFile(sessionFile);
    try { onExit?.(code); } catch {}
    process.exit(code || 0);
  });
}

// ─── Sync state snapshot (config drift detection) ─────────────────────

function sha256(str) {
  return createHash("sha256").update(str).digest("hex");
}

function loadSyncState() {
  try {
    return JSON.parse(readFileSync(SYNC_STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveSyncState(state) {
  atomicWrite(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

// Shallow-compare two {pluginKey: bool} maps (undefined/missing treated as
// absent on both sides via Set union of keys).
function shallowEqualPlugins(a, b) {
  const ao = isPlainObject(a) ? a : {};
  const bo = isPlainObject(b) ? b : {};
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (ao[k] !== bo[k]) return false;
  return true;
}


export { LEGACY_SESSION_FILENAME, SESSIONS_SUBDIR, buildLaunchExtraEnv, launchTracked, legacySessionFilePath, loadSyncState, psField, readSessions, removeSessionFile, saveSyncState, sessionIsAlive, sessionsDir, sha256, shallowEqualPlugins, writeSessionFile };
