// ─── file-lock (batch C) ───────────────────────────────────────────────
// Synchronous, reentrant, cross-process lock for the shared state files.
// The lock is a sibling "<target>.lock" created with O_EXCL and removed by
// its owner. Locks are held for milliseconds (a load → mutate → atomicWrite
// window); a timeout means another process is stuck, so callers skip the
// write and keep going — state files are rebuildable, launches are not.

import { openSync, writeSync, fsyncSync, closeSync, unlinkSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_MS = 30_000;
const HOST = hostname();

type LockContent = { pid?: number; host?: string; createdAt?: number; nonce?: string };

export type LockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; reason: "timeout" | "io" };

// lockPath → nesting depth. Reentrancy matters because low-level writers
// (saveHistory, saveSyncState) are called from functions that already hold
// the same lock (e.g. a write path triggering the heal/migration write).
const held = new Map<string, number>();
const warned = new Set<string>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(lockPath: string): LockContent | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// A lock is stale when its owner is provably gone (same host, ESRCH), when
// it is unreadable/corrupt, or when it simply outlived any plausible critical
// section. EPERM means the process exists but we cannot signal it — keep it.
// A lock from another host is only judged by mtime (shared/NFS home).
function lockIsStale(lockPath: string, staleMs: number): boolean {
  let st;
  try {
    st = statSync(lockPath);
  } catch {
    return true; // vanished — nothing to reclaim, the caller retries
  }
  if (Date.now() - st.mtimeMs > staleMs) return true;
  const c = readLock(lockPath);
  if (!c || !Number.isInteger(c.pid) || (c.pid as number) <= 0) {
    // A lock file exists but its content is empty/partial: the owner is very
    // likely between open(create) and write (milliseconds). Reclaiming it
    // immediately would let two processes into the critical section, so give
    // a genuinely corrupt lock a short grace period instead.
    return Date.now() - st.mtimeMs > 5_000;
  }
  if (typeof c.host === "string" && c.host && c.host !== HOST) return false;
  try {
    process.kill(c.pid as number, 0);
    return false;
  } catch (e: any) {
    return e?.code === "ESRCH";
  }
}

// Reclaim only if the file did not change between the staleness check and
// the unlink: another process may have reclaimed and re-created it in the
// meantime. Best-effort (the remaining window is tiny and guarded by nonce
// on release), but it avoids deleting a fresh lock in the common race.
function tryReclaim(lockPath: string, staleMs: number): boolean {
  let before: { mtimeMs: number; raw: string };
  try {
    before = { mtimeMs: statSync(lockPath).mtimeMs, raw: readFileSync(lockPath, "utf8") };
  } catch {
    return true;
  }
  if (!lockIsStale(lockPath, staleMs)) return false;
  let after: { mtimeMs: number; raw: string };
  try {
    after = { mtimeMs: statSync(lockPath).mtimeMs, raw: readFileSync(lockPath, "utf8") };
  } catch {
    return true;
  }
  if (before.mtimeMs !== after.mtimeMs || before.raw !== after.raw) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function warnOnce(lockPath: string): void {
  if (warned.has(lockPath)) return;
  warned.add(lockPath);
  process.stderr.write(`⚠ The state file is being written by another process (${lockPath}); this save was skipped (the launch is unaffected).\n`);
}

/**
 * Run `fn` while holding `<targetPath>.lock`. Reentrant within this process.
 * On timeout returns { acquired: false } and `fn` is NOT run — callers must
 * skip their write; the surrounding launch/sync continues.
 */
export function withFileLockSync<T>(
  targetPath: string,
  fn: () => T,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): LockResult<T> {
  const lockPath = `${targetPath}.lock`;
  const depth = held.get(lockPath);
  if (depth !== undefined) {
    held.set(lockPath, depth + 1);
    try {
      return { acquired: true, value: fn() };
    } finally {
      held.set(lockPath, depth);
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const nonce = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    return { acquired: false, reason: "io" };
  }

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: HOST, createdAt: Date.now(), nonce }), null, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") return { acquired: false, reason: "io" };
      if (tryReclaim(lockPath, staleMs)) continue;
      if (Date.now() >= deadline) {
        warnOnce(lockPath);
        return { acquired: false, reason: "timeout" };
      }
      // Jitter avoids a thundering herd of processes polling in lockstep.
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }

  held.set(lockPath, 1);
  try {
    return { acquired: true, value: fn() };
  } finally {
    held.delete(lockPath);
    // Only remove OUR lock: if the file was reclaimed/replaced meanwhile its
    // nonce differs, and deleting it would let a second process in.
    const current = readLock(lockPath);
    if (current && current.nonce === nonce) {
      try { unlinkSync(lockPath); } catch {}
    }
  }
}

export { lockIsStale };
