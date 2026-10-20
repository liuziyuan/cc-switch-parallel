// ─── commands/version ──────────────────────────────────────────────────

import { VERSION } from "../paths.js";
import { queryLatestVersion } from "./update.js";

function formatVersionLine(current: any, latest: any) {
  return `cc-switch-parallel v${current}${
    latest ? (current === latest ? " (latest)" : ` (latest: ${latest})`) : ""
  }`;
}

function runVersion() {
  console.log(formatVersionLine(VERSION, queryLatestVersion()));
  process.exit(0);
}

export { formatVersionLine, runVersion };
