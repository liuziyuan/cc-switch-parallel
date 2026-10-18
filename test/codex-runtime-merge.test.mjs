import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

process.env.CC_SWITCH_TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-codex-merge-"));
const { mergeCodexRuntimeState } = await import("../src/stack/catalog.ts");

function instanceWith(configText) {
  const dir = mkdtempSync(join(tmpdir(), "cc-switch-codex-inst-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), configText);
  return dir;
}

const GENERATED = [
  '[projects."/a"]',
  'trust_level = "generated"',
  '[projects."/b"]',
  'trust_level = "generated-only"',
  '[hooks.state."/a:hooks.json:pre_tool_use:0:0"]',
  'trusted_hash = "sha256:STALE"',
  '[tui]',
  'model_availability_nux = { "gpt-5" = "old", "gpt-6" = "keep" }',
].join("\n");

const CURRENT = [
  '[projects."/a"]',
  'trust_level = "live"',
  '[hooks.state."/a:hooks.json:pre_tool_use:0:0"]',
  'trusted_hash = "sha256:LIVE"',
  '[tui]',
  'model_availability_nux = { "gpt-5" = "new" }',
].join("\n");

test("runtime state: live values win over the DB echo", () => {
  const merged = mergeCodexRuntimeState(GENERATED, instanceWith(CURRENT));
  const doc = parse(merged);
  assert.equal(doc.projects["/a"].trust_level, "live");
  assert.equal(
    doc.hooks.state["/a:hooks.json:pre_tool_use:0:0"].trusted_hash,
    "sha256:LIVE",
    "a stale hooks trust hash must not roll the live one back",
  );
  assert.equal(doc.tui.model_availability_nux["gpt-5"], "new");
});

test("runtime state: generated-only keys survive the live merge", () => {
  const merged = mergeCodexRuntimeState(GENERATED, instanceWith(CURRENT));
  const doc = parse(merged);
  assert.equal(doc.projects["/b"].trust_level, "generated-only");
  assert.equal(doc.tui.model_availability_nux["gpt-6"], "keep");
});
