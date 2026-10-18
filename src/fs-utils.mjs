// ─── fs-utils (split from bin/cc-launch.mjs) ─────────────────────────────

import { writeFileSync, mkdirSync, existsSync, symlinkSync, readlinkSync, lstatSync, readdirSync, unlinkSync, renameSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { HOME, INSTANCES_DIR } from "./paths.mjs";

// ─── Instance dir initialization ──────────────────────────────────────

function ensureSymlink(target, linkPath) {
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
        // launch; those are replaced by symlinks, while non-empty dirs stay
        // (warn) to avoid deleting user data.
        if (stats.isDirectory()) {
          const dirEntries = readdirSyncSafe(linkPath);
          if (dirEntries && dirEntries.length > 0) {
            console.error(`⚠ ${linkPath} already exists and is non-empty, skipping symlink (target: ${target})`);
            return;
          }
          rmSync(linkPath, { recursive: true, force: true });
        }
        return;
      }
    } catch (e) {
      console.error(`⚠ Failed to replace ${linkPath} with symlink: ${e.message}`);
      return;
    }
  }
  try {
    symlinkSync(target, linkPath);
  } catch {}
}

function isBrokenSymlink(path) {
  try { return lstatSyncSafe(path)?.isSymbolicLink() === true; } catch { return false; }
}

function lstatSyncSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

function readdirSyncSafe(path) {
  try { return readdirSync(path); } catch { return null; }
}

// Paths shared from global ~/.claude/ into the instance dir.
// Both dirs and files are symlinked — these are device-level shared resources
// that should not be missing just because CLAUDE_CONFIG_DIR points to the instance dir.
const CLAUDE_SHARED_PATHS = [
  ".credentials.json",
  "projects",
  "plugins",
  "skills",
  "commands",
  "cache",
  "CLAUDE.md",
  "keybindings.json",
  "settings.local.json",
  "config.json",
  ".claude.json",  // contains OAuth login info (oauthAccount); missing forces re-login
];

function setupClaudeInstance(providerId) {
  const instanceDir = join(INSTANCES_DIR, "claude", providerId);
  mkdirSync(instanceDir, { recursive: true });
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
  "installation_id",       // device id; missing forces Codex to reinitialize
  "hooks.json",             // user hook config
  "models_cache.json",      // Codex CLI model cache; fallback source for catalog generation
  "rules",                  // user-defined rules (prefix_rule, etc.)
  "skills",                 // installed skills
  ".personality_migration", // migration marker
  ".sandbox_migration",     // migration marker
  "version.json",           // version-check cache
  "AGENTS.md",              // global instructions ($CODEX_HOME/AGENTS.md); a
                            // customize'd instance replaces this symlink with
                            // a real file — ensureSymlink never overwrites
                            // real files, and uncustomize restores the link.
];

function setupCodexInstance(providerId) {
  const instanceDir = join(INSTANCES_DIR, "codex", providerId);
  mkdirSync(instanceDir, { recursive: true });
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

function atomicWrite(path, data) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.tmp.${basename(path)}.${Date.now()}.${process.pid}`);
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}


export { CLAUDE_SHARED_PATHS, CODEX_SHARED_PATHS, atomicWrite, ensureSymlink, isBrokenSymlink, lstatSyncSafe, readdirSyncSafe, setupClaudeInstance, setupCodexInstance };
