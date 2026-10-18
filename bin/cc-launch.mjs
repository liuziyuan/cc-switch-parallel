#!/usr/bin/env node
// switch: Claude Code / Codex multi-provider parallel launcher.
// Implementation lives in src/; this shell is the package entry point.

import { main, __test } from "../src/main.mjs";

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
