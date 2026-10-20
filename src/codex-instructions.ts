// ─── codex instructions templates ──────────────────────────────────────
// Codex has no @import mechanism, so an instance AGENTS.md must EMBED the
// global content. Kept dependency-free: adapters and customize both need it,
// and adapters must not import a command module.

// Marks the boundary between the refreshable global snapshot and the
// user's instance-only section in a codex AGENTS.md template.
const CODEX_INSTRUCTIONS_INSTANCE_MARK =
  "<!-- ── instance-only instructions (below this line) ── -->";

// First run writes a marked snapshot block on top (refreshable), the user's
// instance-only section below (preserved byte-for-byte across refreshes).
function buildCodexInstructionsTemplate(globalText, globalPathDisplay) {
  const body = (globalText || "").trimEnd();
  return [
    `<!-- cc-switch: snapshot of ${globalPathDisplay} — re-run \`switch customize codex <provider>\` to refresh this block -->`,
    body ||
      "(global AGENTS.md is missing or empty — this snapshot will stay as-is until refreshed)",
    "",
    CODEX_INSTRUCTIONS_INSTANCE_MARK,
    "<!-- delete this file to fall back to the shared global AGENTS.md -->",
    "",
    "",
  ].join("\n");
}

// Rewrite ONLY the snapshot region; anything below the instance marker is
// kept byte-for-byte. Returns null when the file doesn't carry our marker
// (a hand-written file) — the caller must not touch it.
function refreshCodexInstructionsSnapshot(existingText, newGlobalText, globalPathDisplay) {
  const instanceIdx = existingText.indexOf(CODEX_INSTRUCTIONS_INSTANCE_MARK);
  if (instanceIdx < 0) return null;
  const tail = existingText.slice(instanceIdx);
  const body = (newGlobalText || "").trimEnd();
  return [
    `<!-- cc-switch: snapshot of ${globalPathDisplay} — re-run \`switch customize codex <provider>\` to refresh this block -->`,
    body ||
      "(global AGENTS.md is missing or empty — this snapshot will stay as-is until refreshed)",
    "",
    tail,
  ].join("\n");
}

export {
  CODEX_INSTRUCTIONS_INSTANCE_MARK,
  buildCodexInstructionsTemplate,
  refreshCodexInstructionsSnapshot,
};
