import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-history-concurrency-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
const STATE_DIR = join(TEST_HOME, ".cc-switch");
const HISTORY_PATH = join(STATE_DIR, "launch_history.json");
mkdirSync(STATE_DIR, { recursive: true });

const HISTORY_ENTRY = new URL("../src/history.ts", import.meta.url).href;

// Each child imports the TS module under tsx and runs recordLaunch N times.
// The import happens AFTER CC_SWITCH_TEST_HOME is set (paths.ts reads it at
// module load), so all processes share one history file.
function spawnRecorder(providerId, times) {
  const script = [
    `process.env.CC_SWITCH_TEST_HOME = ${JSON.stringify(TEST_HOME)};`,
    `const { recordLaunch } = await import(${JSON.stringify(HISTORY_ENTRY)});`,
    `for (let i = 0; i < ${times}; i++) recordLaunch("claude", ${JSON.stringify(providerId)}, "P", null, []);`,
  ].join("\n");
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, CC_SWITCH_TEST_HOME: TEST_HOME },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function runAll(children) {
  return Promise.all(children.map((child) => new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  })));
}

test("concurrent recordLaunch: every increment survives", async () => {
  // 6 writers x 15 launches: enough contention to lose updates without the
  // lock, small enough that the 2s per-acquisition budget is never tight.
  const results = await runAll(Array.from({ length: 6 }, () => spawnRecorder("p1", 15)));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  const hit = data.entries.find((e) => e.providerId === "p1" && e.cli === "claude");
  assert.ok(hit, "entry exists");
  assert.equal(hit.count, 90, "every launch must be counted");
});

test("concurrent recordLaunch: different providers all survive", async () => {
  const results = await runAll(Array.from({ length: 8 }, (_, i) => spawnRecorder(`provider-${i}`, 1)));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  for (let i = 0; i < 8; i++) {
    assert.ok(
      data.entries.some((e) => e.providerId === `provider-${i}`),
      `provider-${i} must be recorded`,
    );
  }
});
