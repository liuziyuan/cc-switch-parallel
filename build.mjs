// Build script: bundles src/main.mjs into a single-file CLI at
// dist/cc-launch.mjs, injects the package version, and makes it executable.
//
// The published artifact stays one self-contained file (the npm package
// ships dist/ + resources/ only), so `switch update`, volta installs, and
// `npm link` keep working exactly as before. esbuild is a dev dependency;
// the CLI itself still has no build-time or runtime bundler requirement.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));

// The entry is the bin shell, not src/main.mjs: the shell owns the shebang
// and the CC_LAUNCH_SKIP_MAIN guard that starts main(). Bundling src/main.mjs
// directly would produce a library with no CLI entry point.
// esbuild preserves the entry file's hashbang at the top of the output, so
// no banner is used here (a banner would risk a second `#!` line).
const result = await build({
  entryPoints: [join(__dirname, "bin", "cc-launch.mjs")],
  outfile: join(__dirname, "dist", "cc-launch.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  write: false,
  logLevel: "warning",
});

// `VERSION` is a string literal ("__VERSION__") in src/paths.mjs; esbuild's
// define only rewrites bare identifiers, so keep the text substitution.
const outfile = join(__dirname, "dist", "cc-launch.mjs");
const out = result.outputFiles[0].text.replace(/"__VERSION__"/g, JSON.stringify(pkg.version));

mkdirSync(join(__dirname, "dist"), { recursive: true });
writeFileSync(outfile, out, "utf8");
chmodSync(outfile, 0o755);

console.log(`✓ Built dist/cc-launch.mjs (v${pkg.version})`);
