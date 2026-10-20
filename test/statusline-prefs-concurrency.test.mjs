import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-prefs-concurrency-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
const STATE_DIR = join(TEST_HOME, ".cc-switch");
const PREFS_PATH = join(STATE_DIR, "statusline-preferences.json");
mkdirSync(STATE_DIR, { recursive: true });

const ENTRY = new URL("../src/statusline-colors.ts", import.meta.url).href;

function spawnSave(providerId, color) {
  const script = [
    `process.env.CC_SWITCH_TEST_HOME = ${JSON.stringify(TEST_HOME)};`,
    `const { saveStatuslineColor } = await import(${JSON.stringify(ENTRY)});`,
    `saveStatuslineColor("claude", ${JSON.stringify(providerId)}, ${JSON.stringify(color)});`,
  ].join("\n");
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, CC_SWITCH_TEST_HOME: TEST_HOME },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

test("concurrent color saves keep every provider's entry", async () => {
  const children = [spawnSave("p-a", "31"), spawnSave("p-b", "32")];
  const results = await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve, reject) => {
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d));
          child.on("error", reject);
          child.on("exit", (code) => resolve({ code, stderr }));
        }),
    ),
  );
  for (const r of results) assert.equal(r.code, 0, r.stderr);

  const prefs = JSON.parse(readFileSync(PREFS_PATH, "utf8"));
  assert.equal(prefs.colors.claude["p-a"], "31");
  assert.equal(prefs.colors.claude["p-b"], "32");
});
