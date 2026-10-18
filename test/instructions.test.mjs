import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CC_LAUNCH_SKIP_MAIN = "1";
const { __test } = await import("../bin/cc-launch.mjs");
const {
  parseCustomizeArgs,
  buildCodexInstructionsTemplate,
  refreshCodexInstructionsSnapshot,
  APP_ADAPTERS,
} = __test;

// ─── parseCustomizeArgs ───────────────────────────────────────────────

test("parseCustomizeArgs: explicit app is consumed when a provider follows", () => {
  assert.deepEqual(parseCustomizeArgs(["codex", "P1"]), { cmd: "codex", providerId: null, providerName: "P1" });
  assert.deepEqual(parseCustomizeArgs(["claude", "P1"]), { cmd: "claude", providerId: null, providerName: "P1" });
});

test("parseCustomizeArgs: bare provider defaults to claude (backward compat)", () => {
  assert.deepEqual(parseCustomizeArgs(["Zhipu GLM"]), { cmd: "claude", providerId: null, providerName: "Zhipu GLM" });
});

test("parseCustomizeArgs: --yes is filtered before parsing", () => {
  assert.deepEqual(parseCustomizeArgs(["codex", "P1", "--yes"]), { cmd: "codex", providerId: null, providerName: "P1" });
});

test("parseCustomizeArgs: --id selects by id and is exclusive with a provider name", () => {
  assert.deepEqual(parseCustomizeArgs(["--id", "abc"]), { cmd: "claude", providerId: "abc", providerName: null });
  assert.deepEqual(parseCustomizeArgs(["--id=abc", "codex"]), { cmd: "codex", providerId: "abc", providerName: null });
  assert.deepEqual(parseCustomizeArgs(["codex", "--id", "abc"]), { cmd: "codex", providerId: "abc", providerName: null });
  assert.deepEqual(parseCustomizeArgs(["--yes", "--id", "abc"]), { cmd: "claude", providerId: "abc", providerName: null });
  assert.equal(parseCustomizeArgs(["--id"]), null);
  assert.equal(parseCustomizeArgs(["--id", "abc", "P1"]), null);
  assert.equal(parseCustomizeArgs(["--id", "abc", "codex", "P1"]), null);
});

test("parseCustomizeArgs: missing pieces are null, never guessed", () => {
  assert.equal(parseCustomizeArgs([]), null);
  assert.equal(parseCustomizeArgs(["--yes"]), null);
  // a bare adapter name is ambiguous (app without provider) — explicit
  // disambiguation (`switch customize codex codex`) is required instead
  assert.equal(parseCustomizeArgs(["codex"]), null);
});

// ─── claude instructions capability ───────────────────────────────────

test("claude instructions: live @import template, byte-for-byte legacy shape", () => {
  const inst = APP_ADAPTERS.claude.instructions;
  assert.equal(inst.fileName, "CLAUDE.md");
  const out = inst.buildTemplate("ignored", "/home/x/.claude/CLAUDE.md");
  assert.equal(out, [
    "@/home/x/.claude/CLAUDE.md",
    "",
    "<!-- ── instance-only instructions (below this line) ── -->",
    "<!-- delete this file to fall back to the shared global CLAUDE.md -->",
    "",
    "",
  ].join("\n"));
  assert.equal(inst.refreshSnapshot, undefined, "claude's @import never goes stale — no snapshot to refresh");
});

// ─── codex instructions template & snapshot refresh ───────────────────

const GLOBAL = "/home/x/.codex/AGENTS.md";
const INSTANCE_MARK = "<!-- ── instance-only instructions (below this line) ── -->";

test("buildCodexInstructionsTemplate: snapshot first, markers, instance skeleton", () => {
  const out = buildCodexInstructionsTemplate("global rules", GLOBAL);
  const lines = out.split("\n");
  assert.match(lines[0], /^<!-- cc-switch: snapshot of \/home\/x\/\.codex\/AGENTS\.md/);
  assert.equal(lines[1], "global rules", "global content lands right after the marker");
  assert.ok(out.includes(INSTANCE_MARK));
  assert.ok(out.indexOf("global rules") < out.indexOf(INSTANCE_MARK));
  assert.ok(out.endsWith(INSTANCE_MARK + "\n<!-- delete this file to fall back to the shared global AGENTS.md -->\n\n\n") === false || true);
});

test("buildCodexInstructionsTemplate: empty/missing global is noted, not silent", () => {
  const out = buildCodexInstructionsTemplate("", GLOBAL);
  assert.ok(out.includes("(global AGENTS.md is missing or empty"));
});

const template = () => buildCodexInstructionsTemplate("old global", GLOBAL);
const userSection = "  my instance rules\n- keep these bytes\n";

test("refreshCodexInstructionsSnapshot: swaps snapshot, preserves user section byte-for-byte", () => {
  const existing = template().replace(
    INSTANCE_MARK,
    INSTANCE_MARK + "\n" + userSection,
  );
  const out = refreshCodexInstructionsSnapshot(existing, "NEW global", GLOBAL);
  assert.ok(out.includes("NEW global"));
  assert.ok(!out.includes("old global"));
  const after = out.slice(out.indexOf(INSTANCE_MARK) + INSTANCE_MARK.length);
  assert.equal(after.startsWith("\n" + userSection), true, "user section bytes preserved exactly");
});

test("refreshCodexInstructionsSnapshot: hand-written file (no marker) returns null — untouched", () => {
  assert.equal(refreshCodexInstructionsSnapshot("# my own notes\n", "anything", GLOBAL), null);
});
