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

const {
  resolvePathSegments,
  getPathValue,
  pathExistsInSnippet,
  buildNestedAssign,
  splitChangesByTarget,
} = await import("../src/upward.ts");
const {
  isCodexRuntimeStatePath,
  isCodexRuntimeStateChange,
  mergeCodexRuntimeState,
  codexInstanceDirFor,
} = await import("../src/stack/catalog.ts");

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
  assert.deepEqual(resolvePathSegments(HOOKS_TREE, `hooks.state.${FLAT_KEY}`), [
    "hooks",
    "state",
    FLAT_KEY,
  ]);
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
    [
      {
        path: `hooks.state.${FLAT_KEY}`,
        op: "change",
        from: { trusted_hash: "sha256:old" },
        to: { trusted_hash: "sha256:new" },
      },
    ],
    "pid",
    {},
    providerSettings,
  );
  assert.deepEqual(providerPatch, {
    hooks: { state: { [FLAT_KEY]: { trusted_hash: "sha256:new" } } },
  });
});

// ─── runtime-state filter (2026-10-17 sync prompt noise) ────────────────

test("isCodexRuntimeStatePath: exact runtime keys, user config untouched", () => {
  for (const p of [
    "projects./Users/x/somerepo",
    "hooks.state./Users/u/.codex/hooks.json:stop:0:0",
    "tui.screen_reader_detection_done",
    "tui.model_availability_nux.gpt-5.6-sol",
  ])
    assert.equal(isCodexRuntimeStatePath(p), true, p);

  for (const p of [
    "projects", // bare table — only leaves are runtime state
    "model",
    "model_providers.custom.base_url",
    "tui.terminal_title", // user-configured [tui] keys keep syncing
    "tui.notifications",
    "hooks", // the [hooks] table itself is config, only .state is runtime
  ])
    assert.equal(isCodexRuntimeStatePath(p), false, p);
});

// Regressions behind the 2026-10-18 "every launch asks to sync hooks" bug:
// diffSettingsLeaves reports the PARENT path when the whole subtree appears
// (baseline had no hooks → {path:"hooks", op:"add"}), which the path-only
// filter above cannot recognize. The change-aware variant closes that gap
// without widening the path contract ("hooks" alone stays config).
test("isCodexRuntimeStateChange: whole-subtree runtime adds filtered, user hooks kept", () => {
  // runtime: the first session materializes the whole table
  const hooksState = {
    op: "add",
    to: { state: { "/abs/hooks.json:stop:0:0": { trusted_hash: "sha256:a" } } },
  };
  assert.equal(isCodexRuntimeStateChange("hooks", hooksState), true);
  assert.equal(
    isCodexRuntimeStateChange("projects", { op: "add", to: { "/x": { trust_level: "trusted" } } }),
    true,
  );
  assert.equal(
    isCodexRuntimeStateChange("tui.model_availability_nux", { op: "add", to: { "gpt-6": 1 } }),
    true,
  );
  assert.equal(isCodexRuntimeStateChange("hooks", { op: "remove", from: { state: {} } }), true);

  // genuine user config must still surface
  assert.equal(
    isCodexRuntimeStateChange("hooks", { op: "add", to: { custom: { command: "x" } } }),
    false,
  );
  assert.equal(
    isCodexRuntimeStateChange("hooks", { op: "add", to: { state: {}, custom: {} } }),
    false,
  );
  // leaf paths keep their existing contract
  assert.equal(isCodexRuntimeStateChange("hooks.state./abs/hooks.json:stop:0:0"), true);
  assert.equal(
    isCodexRuntimeStateChange("tui.terminal_title", { op: "change", to: ["thread"] }),
    false,
  );
});

// ─── runtime state survives prepare regeneration ────────────────────────

test("mergeCodexRuntimeState: carries projects/hooks.state/tui markers across regeneration", () => {
  const dir = join(testHome, "codex-merge-test");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.toml"),
    [
      'model = "gpt-5"',
      "",
      '[projects."/Users/x/repo"]',
      'trust_level = "trusted"',
      "",
      "[hooks.state]",
      "",
      `[hooks.state."${FLAT_KEY}"]`,
      'trusted_hash = "sha256:live"',
      "",
      "[tui]",
      'status_line = [ "model-with-reasoning" ]',
      "screen_reader_detection_done = true",
      "",
      "[tui.model_availability_nux]",
      '"gpt-5.6-sol" = 2',
      "",
    ].join("\n"),
  );

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
  assert.equal(
    codexInstanceDirFor("abc"),
    join(testHome, ".cc-switch", "instances", "codex", "abc"),
  );
});

// ─── write-back segments: NEW dotted keys must stay flat ────────────────
// The display path joins keys with dots, so "profiles.my.profile" is
// ambiguous when the target document has no shape for it yet (a newly added
// [profiles."my.profile"]). Re-splitting it nested three tables and
// corrupted the provider row — same class as the 2026-10-17 incident.

test("splitChangesByTarget: a NEW dotted key stays flat (no nested-table corruption)", () => {
  const change = {
    path: "profiles.my.profile",
    op: "add",
    from: undefined,
    to: { model: "x" },
    segments: ["profiles", "my.profile"],
  };
  const out = splitChangesByTarget([change], "p1", {}, {}, {});
  assert.deepEqual(out.providerPatch, { profiles: { "my.profile": { model: "x" } } });
});

test("splitChangesByTarget: an existing nested target shape is followed", () => {
  const target = { profiles: { "my.profile": { model: "old" } } };
  const change = {
    path: "profiles.my.profile.model",
    op: "change",
    from: "old",
    to: "new",
    segments: ["profiles", "my.profile", "model"],
  };
  const out = splitChangesByTarget([change], "p1", {}, target, {});
  assert.deepEqual(out.providerPatch, { profiles: { "my.profile": { model: "new" } } });
});

test("splitChangesByTarget: a dotted key owned by common goes to commonPatch", () => {
  const common = { profiles: { "my.profile": { model: "old" } } };
  const change = {
    path: "profiles.my.profile.model",
    op: "change",
    from: "old",
    to: "new",
    segments: ["profiles", "my.profile", "model"],
  };
  const out = splitChangesByTarget([change], "p1", common, {}, {});
  assert.deepEqual(out.commonPatch, { profiles: { "my.profile": { model: "new" } } });
  assert.deepEqual(out.providerPatch, {});
});
