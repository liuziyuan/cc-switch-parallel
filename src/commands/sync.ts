// ─── commands/sync ─────────────────────────────────────────────────────

import { detectAndPromptSync } from "../drift.js";

async function runSync() {
  const result = await detectAndPromptSync({ tui: true });
  if (result.needsTTY) {
    console.error(
      "✗ switch sync requires an interactive terminal — run it directly in a terminal.",
    );
    process.exit(1);
  }
  if (result.interrupted) process.exit(130);
  if (result.inputClosed) {
    console.error("✗ Input closed before confirmation — no changes written.");
    process.exit(1);
  }
  if (!result.drifted) console.log("No config drift detected — everything in sync.");
  else if (result.synced) {
    console.log(
      result.refreshed?.length
        ? `✓ Synced (refreshed: ${result.refreshed.join(", ")}).`
        : "✓ Synced.",
    );
  } else console.log("Skipped — no changes written.");
  process.exit(0);
}

export { runSync };
