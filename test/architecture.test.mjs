import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

// HOME-derived constants are evaluated at import time (paths.ts).
process.env.CC_SWITCH_TEST_HOME = mkdtempSync(join(tmpdir(), "cc-launch-architecture-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Static relative imports only: src/ has no dynamic import, and type-only
// imports are still real module edges for our purposes (they cannot form a
// runtime cycle, but keeping them in the graph is the stricter check).
function relativeEdges(file) {
  const source = readFileSync(file, "utf8");
  const edges = new Set();
  const re = /^\s*(?:import|export)\s+(?:[^;]*?from\s+)?["'](\.{1,2}\/[^"']+)["']/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const target = resolve(dirname(file), m[1].replace(/\.js$/, ".ts"));
    if (tsFilesCache.has(target)) edges.add(target);
  }
  return [...edges];
}

const files = tsFiles(SRC);
const tsFilesCache = new Set(files);
const graph = new Map(files.map((f) => [f, relativeEdges(f)]));

function stronglyConnectedComponents() {
  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  function strongconnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v)) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }
    if (lowlink.get(v) === indices.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) sccs.push(component);
    }
  }
  for (const file of files) if (!indices.has(file)) strongconnect(file);
  return sccs;
}

test("src import graph has no cycles", () => {
  const sccs = stronglyConnectedComponents();
  const rendered = sccs.map((c) => c.map((f) => relative(SRC, f)).join(" -> ")).join("\n");
  assert.equal(sccs.length, 0, `import cycles found:\n${rendered}`);
});

test("known cycle edges stay removed", () => {
  const forbidden = [
    ["db.ts", "./stack/state.js"],
    ["stack/state.ts", "./history.js"],
    ["history.ts", "./adapters.js"],
    ["adapters.ts", "./commands/customize.js"],
    ["commands/doctor.ts", "./ps.js"],
    ["commands/ps.ts", "./doctor.js"],
    ["tui.ts", "./commands/ps.js"],
  ];
  for (const [file, target] of forbidden) {
    const source = readFileSync(join(SRC, file), "utf8");
    assert.equal(
      source.includes(`from "${target}"`),
      false,
      `${file} must not import ${target} (cycle edge)`,
    );
  }
});

test("leaf modules stay below their consumers", () => {
  const forbidden = [
    ["stack/aggregation.ts", ["./state.js", "./catalog.js", "./usage.js", "../db.js"]],
    ["cli-meta.ts", ["./adapters.js"]],
    ["codex-instructions.ts", ["./adapters.js"]],
    ["stack/live-state.ts", ["./state.js", "../db.js", "./virtual-row.js"]],
    ["stack/virtual-row.ts", ["../db.js", "./state.js"]],
  ];
  for (const [file, targets] of forbidden) {
    const source = readFileSync(join(SRC, file), "utf8");
    for (const target of targets) {
      assert.equal(source.includes(`from "${target}"`), false, `${file} must not import ${target}`);
    }
  }
});

test("stack/state keeps its public surface", async () => {
  const state = await import("../src/stack/state.ts");
  for (const name of [
    "readStackState",
    "readGlobalModelPicker",
    "virtualStackProviderFor",
    "appendVirtualStackRow",
    "buildStackSettingsFromGlobal",
    "buildCodexStackSettingsFromGlobal",
    "cleanupLegacyStackRows",
    "reportLegacyStackCleanup",
    "isLoopbackBaseUrl",
    "isAggregationProviderSettings",
    "protectAggregationIdentityEnv",
  ]) {
    assert.equal(typeof state[name], "function", `stack/state must still export ${name}`);
  }
  assert.equal(typeof state.STACK_SETTINGS_DERIVERS, "object");
  assert.ok(state.AGGREGATION_IDENTITY_ENV_KEYS.length > 0);
});
