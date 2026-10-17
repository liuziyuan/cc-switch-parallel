import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-runtime-state-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { __test } = await import("../bin/cc-launch.mjs");
const {
  resolvePathSegments,
  getPathValue,
  pathExistsInSnippet,
  buildNestedAssign,
  splitChangesByTarget,
  isCodexRuntimeStatePath,
  mergeCodexRuntimeState,
  codexInstanceDirFor,
} = __test;

// ─── dotted-key path resolution (2026-10-17 provider-row corruption) ────
// Codex TOML keys like [hooks.state."<abs path>"] contain dots; the dotted
// path string "hooks.state./Users/x/.cc-switch/…/hooks.json:pre_tool_use:0:0"
// used to be split naively, re-nesting one flat key into three levels and
// corrupting the provider row on write-back.

const FLAT_KEY = "/Users/u/.cc-switch/instances/codex/i1/hooks.json:pre_tool_use:0:0";
const HOOKS_TREE = {
  hooks: { state: { [FLAT_KEY]: { trusted_hash: "sha256:abc" } } },
};

test("resolvePathSegments: flat dotted key resolves as ONE segment", () => {
  assert.deepEqual(
    resolvePathSegments(HOOKS_TREE, `hooks.state.${FLAT_KEY}`),
    ["hooks", "state", FLAT_KEY],
  );
});

test("resolvePathSegments: dot-free paths unchanged", () => {
  assert.deepEqual(resolvePathSegments({ a: { b: 1 } }, "a.b"), ["a", "b"]);
  // unknown path → naive split (callers treat as absent)
  assert.deepEqual(resolvePathSegments({ a: 1 }, "x.y"), ["x", "y"]);
});

test("resolvePathSegments: backtracks when a dotted key is a longer match", () => {
  // sibling keys "a" and "a.b" — path "a.b.c" must land in the "a.b" key
  const tree = { a: { x: 1 }, "a.b": { c: 2 } };
  assert.deepEqual(resolvePathSegments(tree, "a.b.c"), ["a.b", "c"]);
});

test("getPathValue / pathExistsInSnippet: dotted key round-trips", () => {
  const p = `hooks.state.${FLAT_KEY}`;
  assert.equal(pathExistsInSnippet(HOOKS_TREE, p), true);
  assert.deepEqual(getPathValue(HOOKS_TREE, p), { trusted_hash: "sha256:abc" });
  assert.equal(pathExistsInSnippet(HOOKS_TREE, "hooks.state.nope"), false);
  assert.equal(getPathValue(HOOKS_TREE, "hooks.state.nope.deep"), undefined);
});

test("buildNestedAssign with refObj keeps the flat key FLAT", () => {
  const patch = {};
  buildNestedAssign(patch, `hooks.state.${FLAT_KEY}`, { trusted_hash: "sha256:new" }, HOOKS_TREE);
  assert.deepEqual(patch, { hooks: { state: { [FLAT_KEY]: { trusted_hash: "sha256:new" } } } });
  // and the patched tree reads back equal
  const merged = { ...HOOKS_TREE.hooks.state, ...patch.hooks.state };
  assert.deepEqual(getPathValue({ hooks: { state: merged } }, `hooks.state.${FLAT_KEY}`), {
    trusted_hash: "sha256:new",
  });
});

test("splitChangesByTarget: provider patch for a dotted key stays single-keyed", () => {
  const providerSettings = {
    model_provider: "custom",
    hooks: { state: { [FLAT_KEY]: { trusted_hash: "sha256:old" } } },
  };
  const { providerPatch } = splitChangesByTarget(
    [{ path: `hooks.state.${FLAT_KEY}`, op: "change", from: { trusted_hash: "sha256:old" }, to: { trusted_hash: "sha256:new" } }],
    "pid", {}, providerSettings,
  );
  assert.deepEqual(providerPatch, { hooks: { state: { [FLAT_KEY]: { trusted_hash: "sha256:new" } } } });
});

// ─── runtime-state filter (2026-10-17 sync prompt noise) ────────────────

test("isCodexRuntimeStatePath: exact runtime keys, user config untouched", () => {
  for (const p of [
    "projects./Users/x/somerepo",
    "hooks.state./Users/u/.codex/hooks.json:stop:0:0",
    "tui.screen_reader_detection_done",
    "tui.model_availability_nux.gpt-5.6-sol",
  ]) assert.equal(isCodexRuntimeStatePath(p), true, p);

  for (const p of [
    "projects", // bare table — only leaves are runtime state
    "model", "model_providers.custom.base_url",
    "tui.terminal_title", // user-configured [tui] keys keep syncing
    "tui.notifications",
    "hooks", // the [hooks] table itself is config, only .state is runtime
  ]) assert.equal(isCodexRuntimeStatePath(p), false, p);
});

// ─── runtime state survives prepare regeneration ────────────────────────

test("mergeCodexRuntimeState: carries projects/hooks.state/tui markers across regeneration", () => {
  const dir = join(testHome, "codex-merge-test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), [
    'model = "gpt-5"',
    '',
    '[projects."/Users/x/repo"]',
    'trust_level = "trusted"',
    '',
    '[hooks.state]',
    '',
    `[hooks.state."${FLAT_KEY}"]`,
    'trusted_hash = "sha256:live"',
    '',
    "[tui]",
    'status_line = [ "model-with-reasoning" ]',
    "screen_reader_detection_done = true",
    "",
    "[tui.model_availability_nux]",
    '"gpt-5.6-sol" = 2',
    "",
  ].join("\n"));

  const regenerated = mergeCodexRuntimeState('model = "gpt-5"\n', dir);
  assert.ok(regenerated.includes('trust_level = "trusted"'), "projects carried");
  assert.ok(regenerated.includes('trusted_hash = "sha256:live"'), "hooks.state carried");
  assert.ok(regenerated.includes("screen_reader_detection_done = true"), "tui marker carried");
  assert.ok(regenerated.includes('"gpt-5.6-sol" = 2'), "nux carried");
  // DB-side config value survives as the base (live value wins on conflict)
  assert.ok(regenerated.includes('model = "gpt-5"'));
});

test("mergeCodexRuntimeState: no state on disk → input unchanged; corrupt file → input unchanged", () => {
  const empty = join(testHome, "codex-merge-empty");
  mkdirSync(empty, { recursive: true });
  const text = 'model = "gpt-5"\n';
  assert.equal(mergeCodexRuntimeState(text, empty), text);

  const corrupt = join(testHome, "codex-merge-corrupt");
  mkdirSync(corrupt, { recursive: true });
  writeFileSync(join(corrupt, "config.toml"), "not [ valid toml");
  assert.equal(mergeCodexRuntimeState(text, corrupt), text);

  // missing dir entirely
  assert.equal(mergeCodexRuntimeState(text, join(testHome, "no-such-dir")), text);
});

test("codexInstanceDirFor: same derivation as setupCodexInstance", () => {
  assert.equal(codexInstanceDirFor("abc"), join(testHome, ".cc-switch", "instances", "codex", "abc"));
});
