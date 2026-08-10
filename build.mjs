// Build script: injects the package version into bin/cc-launch.mjs → dist/cc-launch.mjs.
// No bundler needed — this is a zero-dependency single-file CLI.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
const version = pkg.version;

const src = readFileSync(join(__dirname, "bin", "cc-launch.mjs"), "utf8");
const out = src.replace(/"__VERSION__"/g, JSON.stringify(version));

const distDir = join(__dirname, "dist");
mkdirSync(distDir, { recursive: true });
const outPath = join(distDir, "cc-launch.mjs");
writeFileSync(outPath, out, "utf8");
chmodSync(outPath, 0o755);

console.log(`✓ Built dist/cc-launch.mjs (v${version})`);
