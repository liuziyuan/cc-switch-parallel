import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (STATUSLINE_PREFS_PATH) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-provider-env-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { statuslineColorFor, saveStatuslineColor } = await import("../src/statusline-colors.ts");
const { buildLaunchExtraEnv } = await import("../src/sessions.ts");

// ─── buildLaunchExtraEnv ────────────────────────────────────────────────
// Transport for the tmuxclihook status bar: the launched CLI's hooks inherit
// these, and the hook captures them into per-pane tmux options.

test("buildLaunchExtraEnv: injects name and id", () => {
  assert.deepEqual(
    buildLaunchExtraEnv("Example Provider", "4e2249cb-7cec-493c-a8f0-d437cfd3aea6"),
    {
      CC_SWITCH_PROVIDER: "Example Provider",
      CC_SWITCH_PROVIDER_ID: "4e2249cb-7cec-493c-a8f0-d437cfd3aea6",
    },
  );
});

test("buildLaunchExtraEnv: empty/missing name injects nothing", () => {
  assert.deepEqual(buildLaunchExtraEnv("", "some-id"), { CC_SWITCH_PROVIDER_ID: "some-id" });
  assert.deepEqual(buildLaunchExtraEnv(undefined, undefined), {});
  assert.deepEqual(buildLaunchExtraEnv(null, null), {});
});

// ─── codex color bucket (consumed by the tmuxclihook status bar) ────────
// Same statusline-preferences.json as the claude wrapper, per-CLI buckets —
// a claude color and a codex color for the SAME provider id must not interfere.

test("codex bucket: save/read round-trips, isolated from claude", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(statuslineColorFor("codex", id), "auto"); // fail-open default

  assert.equal(saveStatuslineColor("codex", id, "95"), "95");
  assert.equal(statuslineColorFor("codex", id), "95");
  assert.equal(statuslineColorFor("claude", id), "auto"); // claude bucket untouched

  assert.equal(saveStatuslineColor("claude", id, "31"), "31");
  assert.equal(statuslineColorFor("codex", id), "95"); // codex bucket still intact
  assert.equal(statuslineColorFor("claude", id), "31");

  // invalid values are refused, read falls back to auto
  assert.equal(saveStatuslineColor("codex", id, "#ff0000"), null);
  assert.equal(statuslineColorFor("codex", id), "95");

  // storing auto deletes the key
  assert.equal(saveStatuslineColor("codex", id, "auto"), "auto");
  assert.equal(statuslineColorFor("codex", id), "auto");
  assert.equal(statuslineColorFor("claude", id), "31"); // claude survived the codex delete
});
