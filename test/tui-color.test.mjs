import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (STATUSLINE_PREFS_PATH) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-tui-color-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { statuslineColorFor, saveStatuslineColor, loadStatuslinePreferences, STATUSLINE_COLOR_CHOICES } = await import("../src/statusline-colors.ts");

const PREFS = join(testHome, ".cc-switch", "statusline-preferences.json");

// ─── choices table ──────────────────────────────────────────────────────

test("choices: 17 entries, unique values, auto first, valid ANSI classic codes", () => {
  assert.equal(STATUSLINE_COLOR_CHOICES.length, 17);
  assert.equal(STATUSLINE_COLOR_CHOICES[0].value, "auto");
  const values = STATUSLINE_COLOR_CHOICES.map((c) => c.value);
  assert.equal(new Set(values).size, 17);
  const swatchable = STATUSLINE_COLOR_CHOICES.slice(1);
  for (const c of swatchable) {
    assert.match(c.value, /^(3[0-7]|9[0-7])$/, c.value);
    assert.ok(c.swatch.includes(`\x1b[${c.value}m`), `swatch matches value: ${c.value}`);
  }
});

test("choices: both classic ranges fully present (30-37 and 90-97)", () => {
  const values = new Set(STATUSLINE_COLOR_CHOICES.map((c) => c.value));
  for (let i = 30; i <= 37; i++) assert.ok(values.has(String(i)), `missing ${i}`);
  for (let i = 90; i <= 97; i++) assert.ok(values.has(String(i)), `missing ${i}`);
});

// ─── preference store ───────────────────────────────────────────────────

test("store: save/load round-trip; claude and codex buckets are independent", () => {
  mkdirSync(join(testHome, ".cc-switch"), { recursive: true });
  assert.equal(saveStatuslineColor("claude", "prov-a", "92"), "92");
  assert.equal(saveStatuslineColor("codex", "prov-a", "33"), "33");
  const prefs = loadStatuslinePreferences();
  assert.equal(prefs.version, 1);
  assert.equal(prefs.colors.claude["prov-a"], "92");
  assert.equal(prefs.colors.codex["prov-a"], "33");
  // cross-bucket reads stay independent
  assert.equal(statuslineColorFor("claude", "prov-a"), "92");
  assert.equal(statuslineColorFor("codex", "prov-a"), "33");
});

test("store: keyed by provider id — a rename keeps the color", () => {
  // Simulating a rename is out of scope here (the TUI maps id → name at
  // render time); what this locks in is that only ids appear in the file.
  saveStatuslineColor("claude", "prov-b", "95");
  const raw = JSON.parse(readFileSync(PREFS, "utf8"));
  assert.ok("prov-b" in raw.colors.claude);
});

test("store: consecutive saves for different providers coexist (no lost keys)", () => {
  saveStatuslineColor("claude", "prov-c1", "31");
  saveStatuslineColor("claude", "prov-c2", "94");
  assert.equal(statuslineColorFor("claude", "prov-c1"), "31");
  assert.equal(statuslineColorFor("claude", "prov-c2"), "94");
  assert.equal(statuslineColorFor("claude", "prov-a"), "92"); // earlier entry intact
});

test("store: invalid values rejected, file untouched", () => {
  const before = readFileSync(PREFS, "utf8");
  for (const bad of ["99", "40", "true", "", "autoX", null, 91]) {
    assert.equal(saveStatuslineColor("claude", "prov-bad", bad), null, String(bad));
  }
  assert.equal(readFileSync(PREFS, "utf8"), before);
  assert.equal(statuslineColorFor("claude", "prov-bad"), "auto");
});

test("store: unreadable file fails open to auto for every reader", () => {
  writeFileSync(PREFS, "{ corrupted");
  assert.equal(loadStatuslinePreferences(), null);
  assert.equal(statuslineColorFor("claude", "prov-a"), "auto");
});
