// ─── fs-utils (split from bin/cc-launch.mjs) ─────────────────────────────

import {
  mkdirSync,
  existsSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  readdirSync,
  unlinkSync,
  renameSync,
  rmSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  chmodSync,
  readFileSync,
  linkSync,
  copyFileSync,
  cpSync,
  rmdirSync,
  utimesSync,
  constants as fsConstants,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname, basename, extname } from "node:path";
import { withFileLockSync } from "./file-lock.js";
import { HOME, INSTANCES_DIR } from "./paths.js";

// ─── Instance dir initialization ──────────────────────────────────────

function ensureSymlink(target: any, linkPath: any) {
  if (existsSync(linkPath) || isBrokenSymlink(linkPath)) {
    try {
      const stats = lstatSyncSafe(linkPath);
      if (stats?.isSymbolicLink()) {
        if (readlinkSync(linkPath) === target) return;
        unlinkSync(linkPath);
      } else {
        // Non-symlink real file/dir. Real FILES are deliberate content (a
        // customized CLAUDE.md, user-placed config) — always keep them.
        // Dirs: Claude Code auto-creates empty ones like plugins/ on first
        // launch; those are removed here and replaced by the symlink below,
        // while non-empty dirs stay (warn) to avoid deleting user data.
        if (stats!.isDirectory()) {
          const dirEntries = readdirSyncSafe(linkPath);
          if (dirEntries && dirEntries.length > 0) {
            console.error(
              `⚠ ${linkPath} already exists and is non-empty, skipping symlink (target: ${target})`,
            );
            return;
          }
          rmSync(linkPath, { recursive: true, force: true });
          // fall through: the now-absent path is linked below
        } else {
          return;
        }
      }
    } catch (e: any) {
      console.error(`⚠ Failed to replace ${linkPath} with symlink: ${e.message}`);
      return;
    }
  }
  try {
    symlinkSync(target, linkPath);
  } catch {}
}

function isBrokenSymlink(path: any) {
  try {
    return lstatSyncSafe(path)?.isSymbolicLink() === true;
  } catch {
    return false;
  }
}

function lstatSyncSafe(path: any) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function readdirSyncSafe(path: any) {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

// Paths shared from global ~/.claude/ into the instance dir.
// Both dirs and files are symlinked — these are device-level shared resources
// that should not be missing just because CLAUDE_CONFIG_DIR points to the instance dir.
const CLAUDE_SHARED_PATHS = [
  ".credentials.json",
  "projects",
  // plans are device-level, like native Claude Code (~/.claude/plans): the
  // provider used to launch a session must not decide which plans are visible.
  // Unlike the others this one needs a one-time merge before it can be linked
  // — see setupClaudePlans.
  "plans",
  "plugins",
  "skills",
  "commands",
  "cache",
  "CLAUDE.md",
  "keybindings.json",
  "settings.local.json",
  "config.json",
  ".claude.json", // contains OAuth login info (oauthAccount); missing forces re-login
];

// Instance dirs hold credentials, so they are owner-only. Existing dirs from
// older versions are tightened in place (best-effort: a read-only parent or
// exotic filesystem must not block the launch).
function ensurePrivateDir(dir: any) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {}
}

// ─── plans: one-time merge into the global directory ──────────────────
// Claude Code writes plans to $CLAUDE_CONFIG_DIR/plans. Before this path was
// shared, each provider instance accumulated its own copy, splitting one
// project's plans by the provider used to launch it. On setup we merge the
// instance's plans into the global dir and replace it with a symlink. Only the
// instance being set up is migrated (no full scan); other instances converge
// the next time they are launched or refreshed.

function isCrossDeviceError(code: string | undefined): boolean {
  return (
    code === "EXDEV" ||
    code === "EPERM" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS" ||
    code === "EMLINK"
  );
}

function filesAreIdentical(a: string, b: string): boolean {
  try {
    const sa = lstatSync(a);
    const sb = lstatSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

// link+unlink moves without copying and never clobbers: linkSync is atomic and
// fails with EEXIST when the target exists. Filesystems without hard links (or
// across devices) fall back to COPYFILE_EXCL, which is equally no-clobber.
function moveFileNoClobber(src: string, dst: string): "moved" | "exists" {
  try {
    linkSync(src, dst);
  } catch (e: any) {
    if (e?.code === "EEXIST") return "exists";
    if (!isCrossDeviceError(e?.code)) throw e;
    try {
      copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
      try {
        const st = lstatSync(src);
        utimesSync(dst, st.atime, st.mtime);
      } catch {}
    } catch (e2: any) {
      if (e2?.code === "EEXIST") return "exists";
      try {
        unlinkSync(dst);
      } catch {} // never leave a half-written plan
      throw e2;
    }
  }
  unlinkSync(src);
  return "moved";
}

function plansConflictName(name: string, providerId: string, n: number): string {
  const safeId = providerId.replace(/[^A-Za-z0-9._-]/g, "_");
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return `${stem}.${safeId}${n > 1 ? `-${n}` : ""}${ext}`;
}

function moveFileWithConflicts(src: string, dst: string, providerId: string): void {
  if (moveFileNoClobber(src, dst) === "moved") return;
  if (filesAreIdentical(src, dst)) {
    unlinkSync(src); // same plan already global — drop the duplicate
    return;
  }
  for (let n = 1; n <= 100; n++) {
    const alt = join(dirname(dst), plansConflictName(basename(dst), providerId, n));
    if (moveFileNoClobber(src, alt) === "moved") return;
    if (filesAreIdentical(src, alt)) {
      unlinkSync(src);
      return;
    }
  }
  throw new Error("too many plan name conflicts");
}

function moveDirNoClobber(src: string, dst: string): void {
  if (existsSync(dst)) {
    const e: any = new Error(`${dst} already exists`);
    e.code = "EEXIST";
    throw e;
  }
  try {
    renameSync(src, dst);
  } catch (e: any) {
    if (!isCrossDeviceError(e?.code)) throw e;
    cpSync(src, dst, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    rmSync(src, { recursive: true, force: true });
  }
}

function movePlanEntry(src: string, dst: string, providerId: string): void {
  const st = lstatSyncSafe(src);
  if (!st) return; // vanished underneath us
  if (st.isSymbolicLink()) {
    // Never follow or move a link: it may point anywhere. Report failure so the
    // instance keeps its real plans dir instead of losing the link.
    throw new Error("symbolic link inside plans is not migrated");
  }
  if (st.isDirectory()) {
    if (!existsSync(dst)) {
      moveDirNoClobber(src, dst);
      return;
    }
    // Same-named directory already global: move this one aside rather than
    // merging its contents, so nothing is overwritten.
    for (let n = 1; n <= 100; n++) {
      const alt = join(dirname(dst), plansConflictName(basename(dst), providerId, n));
      if (!existsSync(alt)) {
        moveDirNoClobber(src, alt);
        return;
      }
    }
    throw new Error("too many plan name conflicts");
  }
  moveFileWithConflicts(src, dst, providerId);
}

function migratePlans(
  instancePlansDir: string,
  globalPlansDir: string,
  providerId: string,
): { ok: boolean; failed: number } {
  const st = lstatSyncSafe(instancePlansDir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return { ok: true, failed: 0 };

  let entries: string[];
  try {
    entries = readdirSync(instancePlansDir);
  } catch (e: any) {
    console.error(
      `⚠ Cannot read ${instancePlansDir}: ${e.message} — plans stay local for this launch.`,
    );
    return { ok: false, failed: 1 };
  }
  if (entries.length === 0) return { ok: true, failed: 0 }; // ensureSymlink removes the empty dir

  let failed = 0;
  for (const name of entries) {
    try {
      movePlanEntry(join(instancePlansDir, name), join(globalPlansDir, name), providerId);
    } catch (e: any) {
      failed++;
      console.error(
        `⚠ Failed to merge plan "${name}": ${e.message} — it stays in ${instancePlansDir}.`,
      );
    }
  }
  if (failed === 0) {
    try {
      rmdirSync(instancePlansDir);
    } catch {}
  }
  return { ok: failed === 0, failed };
}

function setupClaudePlans(instanceDir: string, globalPlansDir: string, providerId: string): void {
  // The lock covers migration AND ensureSymlink: without it, two concurrent
  // launches of the same instance could have one process readdir() through the
  // other's fresh symlink, treat global files as sources, and unlink them.
  withFileLockSync(join(dirname(globalPlansDir), ".plans-migration"), () => {
    try {
      // Default mode (native ~/.claude/plans is 0755 / umask); an existing dir
      // keeps its permissions.
      mkdirSync(globalPlansDir, { recursive: true });
    } catch (e: any) {
      console.error(
        `⚠ Failed to create ${globalPlansDir}: ${e.message} — plans stay local for this launch.`,
      );
      return;
    }
    const migrated = migratePlans(join(instanceDir, "plans"), globalPlansDir, providerId);
    if (!migrated.ok) {
      // Do NOT call ensureSymlink on a partially migrated dir: readdirSyncSafe
      // returning null would make ensureSymlink treat it as empty and delete it.
      console.error(
        `⚠ Plans migration incomplete (${migrated.failed} left) — plans stay local for this launch.`,
      );
      return;
    }
    ensureSymlink(globalPlansDir, join(instanceDir, "plans"));
  });
}

function setupClaudeInstance(providerId: any) {
  const instanceDir = join(INSTANCES_DIR, "claude", providerId);
  ensurePrivateDir(instanceDir);
  const globalClaudeDir = join(HOME, ".claude");

  // .claude.json lives in two places:
  //   - Without CLAUDE_CONFIG_DIR: ~/.claude.json (HOME root)
  //   - With CLAUDE_CONFIG_DIR set: $CLAUDE_CONFIG_DIR/.claude.json
  // The global ~/.claude.json holds OAuth login info (oauthAccount);
  // missing it in the instance dir forces Claude Code to re-login.
  const globalDotClaudeJson = join(HOME, ".claude.json");
  if (existsSync(globalDotClaudeJson)) {
    ensureSymlink(globalDotClaudeJson, join(instanceDir, ".claude.json"));
  }

  for (const name of CLAUDE_SHARED_PATHS) {
    const globalPath = join(globalClaudeDir, name);
    if (name === "plans") {
      // Must run even when the global dir does not exist yet: it creates the
      // dir and migrates, otherwise the existsSync guard below would skip the
      // link and plans would land in the instance dir again.
      setupClaudePlans(instanceDir, globalPath, providerId);
      continue;
    }
    if (existsSync(globalPath)) {
      ensureSymlink(globalPath, join(instanceDir, name));
    }
  }
  return instanceDir;
}

// Paths shared from global ~/.codex/ into the instance dir.
// These are device-level shared resources / user config that should not be
// missing just because CODEX_HOME points to the instance dir.
// auth.json is NOT included here — it is handled per-provider by the codex adapter
// (third-party providers get a standalone auth.json; official/OAuth providers symlink to global).
const CODEX_SHARED_PATHS = [
  "installation_id", // device id; missing forces Codex to reinitialize
  "hooks.json", // user hook config
  "models_cache.json", // Codex CLI model cache; fallback source for catalog generation
  "rules", // user-defined rules (prefix_rule, etc.)
  "skills", // installed skills
  ".personality_migration", // migration marker
  ".sandbox_migration", // migration marker
  "version.json", // version-check cache
  "AGENTS.md", // global instructions ($CODEX_HOME/AGENTS.md); a
  // customize'd instance replaces this symlink with
  // a real file — ensureSymlink never overwrites
  // real files, and uncustomize restores the link.
];

function setupCodexInstance(providerId: any) {
  const instanceDir = join(INSTANCES_DIR, "codex", providerId);
  ensurePrivateDir(instanceDir);
  const globalCodexDir = join(HOME, ".codex");
  for (const name of CODEX_SHARED_PATHS) {
    const globalPath = join(globalCodexDir, name);
    if (existsSync(globalPath)) {
      ensureSymlink(globalPath, join(instanceDir, name));
    }
  }
  return instanceDir;
}

// ─── Atomic write ──────────────────────────────────────────────────────

// Atomic write with a private mode. The temp file is created 0600 under an
// exclusive, unique name (pid + time + random), fsynced, and renamed into
// place. The final chmod ENFORCES `mode` even when the previous file was more
// permissive: credentials must shrink, not inherit a stale 0644. On failure
// the temp file is removed so no half-written secret is left behind.
function atomicWrite(path: any, data: any, mode = 0o600) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const tmp = join(
    parent,
    `.tmp.${basename(path)}.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", mode);
    if (Buffer.isBuffer(data)) writeSync(fd, data);
    else writeSync(fd, String(data), null, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    try {
      chmodSync(path, mode);
    } catch {}
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

export {
  CLAUDE_SHARED_PATHS,
  CODEX_SHARED_PATHS,
  atomicWrite,
  ensurePrivateDir,
  ensureSymlink,
  isBrokenSymlink,
  lstatSyncSafe,
  readdirSyncSafe,
  setupClaudeInstance,
  setupCodexInstance,
};
