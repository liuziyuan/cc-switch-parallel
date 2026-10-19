#!/usr/bin/env node
// switch: Claude Code / Codex multi-provider parallel launcher.
// Implementation lives in src/; this shell is the package entry point.

import { isNodeVersionSupported, unsupportedNodeVersionMessage } from "../src/node-version.js";

// Runtime floor, checked before src/main.js is evaluated. Older runtimes lack
// the global fetch() the statusline usage segment depends on; there the query
// fails silently and the balance segment just never appears, so users end up
// debugging providers instead of their Node version. Exit here with a clear
// message instead. (Top-level await keeps the main module unloaded until the
// version has been accepted.)
if (!isNodeVersionSupported(process.versions.node)) {
  console.error(unsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

const { main, __test } = await import("../src/main.js");

export { __test };

// Guarded so test/*.test.mjs can import this file as a plain ESM module:
// `node --test` imports it with CC_LAUNCH_SKIP_MAIN set, and the top level
// is side-effect-free apart from main() itself.
if (!process.env.CC_LAUNCH_SKIP_MAIN) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
