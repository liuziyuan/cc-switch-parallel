// ─── commands/update ───────────────────────────────────────────────────

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { HOME, NPM_PACKAGE_NAME, VERSION } from "../paths.js";

// A volta-managed install (`volta install <pkg>`) execs this script from
// ~/.volta/tools/image/packages/...; the copy `npm install -g` updates lives
// under image/node/<ver>/lib/ instead, which the volta shim never reads — so
// updating that copy silently does nothing for the shim. Detect it here so
// `switch update` goes through volta itself.
function isVoltaManagedInstall() {
  try {
    return realpathSync(process.argv[1] || "").includes("/.volta/tools/image/packages/");
  } catch {
    return false;
  }
}

// Version actually on disk at the location this install mode executes from.
// The update confirmation reads this — not what npm claimed — so a silent
// partial install can't pass as a success.
function readInstalledVersion() {
  let pkgJsonPath: string | null = null;
  if (isVoltaManagedInstall()) {
    pkgJsonPath = join(HOME, ".volta", "tools", "image", "packages", NPM_PACKAGE_NAME,
      "lib", "node_modules", NPM_PACKAGE_NAME, "package.json");
  } else {
    try {
      pkgJsonPath = join(execSync("npm root -g", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(), NPM_PACKAGE_NAME, "package.json");
    } catch {}
  }
  try {
    const v = JSON.parse(readFileSync(pkgJsonPath!, "utf8")).version;
    if (typeof v === "string" && v) return v;
  } catch {}
  return null;
}

// Shared tail for both update paths: confirm against what is really on disk,
// and fail loudly (non-zero) when the disk still disagrees.
function reportUpdateOutcome(latestVersion) {
  const installed = readInstalledVersion();
  if (installed === latestVersion) {
    console.log(`✓ Updated to v${latestVersion}`);
    process.exit(0);
  }
  console.error(`⚠ Update command finished, but the install on disk reads v${installed ?? "unknown"} — restart your terminal and run \`switch update\` again if it still shows the old version.`);
  process.exit(1);
}

// Latest version on npm, or null when the registry is unreachable. Shared by
// `switch update` and `switch version`.
function queryLatestVersion(): string | null {
  try {
    const v = execSync(`npm view ${NPM_PACKAGE_NAME} version`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return v || null;
  } catch {
    return null;
  }
}

async function runUpdate() {
  const currentVersion = VERSION;
  console.log(`Current version: v${currentVersion}`);

  const latestVersion = queryLatestVersion();
  if (!latestVersion) {
    console.error("✗ Failed to query latest version. Please check your network connection.");
    process.exit(1);
  }

  if (currentVersion === latestVersion) {
    console.log("Already up to date.");
    process.exit(0);
  }

  console.log(`Updating to v${latestVersion}...`);

  if (isVoltaManagedInstall()) {
    const r = spawnSync("volta", ["install", `${NPM_PACKAGE_NAME}@latest`], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`✗ Update failed — try running \`volta install ${NPM_PACKAGE_NAME}@latest\` manually.`);
      process.exit(r.status || 1);
    }
    reportUpdateOutcome(latestVersion);
  }

  try {
    execSync(`npm install -g ${NPM_PACKAGE_NAME}@latest`, { stdio: "inherit" });
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || "");
    if (/EACCES|EPERM|EISDIR/.test(msg)) {
      console.error(`✗ Permission denied. Try: sudo npm install -g ${NPM_PACKAGE_NAME}@latest`);
    } else if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|network|fetch failed/.test(msg)) {
      console.error("✗ Network error during install. Please check your connection and retry.");
    } else {
      console.error(`✗ Update failed: ${msg.trim() || "unknown error"}`);
    }
    process.exit(1);
  }
  reportUpdateOutcome(latestVersion);
}


export { isVoltaManagedInstall, queryLatestVersion, readInstalledVersion, reportUpdateOutcome, runUpdate };
