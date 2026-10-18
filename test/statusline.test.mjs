import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (CC_SWITCH_DIR, INSTANCES_DIR) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-statusline-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { __test } = await import("../bin/cc-launch.mjs");
const {
  buildClaudeEffectiveSettings,
  buildStatusLineWrapperScript,
  isStatusLineChannelPath,
  claudeProviderName,
  deepEqualJson,
  statuslineColorFor,
  saveStatuslineColor,
  loadStatuslinePreferences,
  applyCodexStatusLineInjection,
  isCodexStatusLineChannelPath,
  APP_ADAPTERS,
} = __test;

const CC = join(testHome, ".cc-switch");
const INSTANCES = join(CC, "instances", "claude");
const GLOBAL_SETTINGS = join(testHome, ".claude", "settings.json");
const claude = APP_ADAPTERS.claude;
const codex = APP_ADAPTERS.codex;

function instanceFile(providerId, name = "statusline-wrapper.mjs") {
  return join(INSTANCES, providerId, name);
}

function writeGlobalSettings(statusLine) {
  mkdirSync(join(testHome, ".claude"), { recursive: true });
  const body = statusLine === undefined ? {} : { statusLine };
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify(body, null, 2));
}

function cleanInstance(providerId) {
  rmSync(join(INSTANCES, providerId), { recursive: true, force: true });
}

// ─── statusline channel ownership ─────────────────────────────────────

test("statusline channel: owns the statusLine subtree only", () => {
  assert.equal(isStatusLineChannelPath("statusLine"), true);
  assert.equal(isStatusLineChannelPath("statusLine.command"), true);
  assert.equal(isStatusLineChannelPath("statusLine.type"), true);
  assert.equal(isStatusLineChannelPath("statusLineX"), false);
  assert.equal(isStatusLineChannelPath("enabledPlugins"), false);
  assert.equal(isStatusLineChannelPath("env.ANTHROPIC_BASE_URL"), false);
  // The claude adapter's channel filter must yield both owned subtrees.
  assert.equal(claude.channelOwnedPath("statusLine.command"), true);
  assert.equal(claude.channelOwnedPath("enabledPlugins.foo@bar"), true);
  assert.equal(claude.channelOwnedPath("env.ANTHROPIC_AUTH_TOKEN"), false);
});

// ─── injection into the effective settings ────────────────────────────

test("injection: empty config gains a generated statusLine + wrapper", () => {
  cleanInstance("p-basic");
  const effective = buildClaudeEffectiveSettings({}, {}, "", "My Provider", "p-basic");

  assert.equal(effective.statusLine.type, "command");
  assert.match(effective.statusLine.command, /statusline-wrapper\.mjs/);
  assert.match(effective.statusLine.command, /node|execPath/); // quoted node binary

  const wrapperPath = instanceFile("p-basic");
  assert.ok(existsSync(wrapperPath), "wrapper script written into the instance dir");
  // The statusLine command is `node <wrapper>`, so only read access is
  // required; the file is written 0600 because it inlines usage tokens.
  const stat = spawnSync("test", ["-r", wrapperPath]);
  assert.equal(stat.status, 0, "wrapper is readable by the owner");
  const script = readFileSync(wrapperPath, "utf8");
  assert.match(script, /^#!\/usr\/bin\/env node/m);
  assert.ok(script.includes(JSON.stringify("My Provider").slice(1, -1)), "provider name inlined");
  assert.ok(script.includes(GLOBAL_SETTINGS), "global settings path inlined");
  // command points at THIS instance's wrapper
  assert.ok(effective.statusLine.command.includes(wrapperPath));
});

test("injection: carries refreshInterval/padding through an upgrade", () => {
  cleanInstance("p-upgrade");
  const effective = buildClaudeEffectiveSettings({}, {}, "", "Prov", "p-upgrade");
  const command = effective.statusLine.command;

  // Second pass: pretend the DB config holds last launch's generated entry
  // (user copied it in) — the injection must regenerate, keeping tuned
  // display fields, and stay idempotent.
  const again = buildClaudeEffectiveSettings(
    { statusLine: { type: "command", command, refreshInterval: 5 } },
    {}, "", "Prov", "p-upgrade",
  );
  assert.equal(again.statusLine.type, "command");
  assert.equal(again.statusLine.command, command);
  assert.equal(again.statusLine.refreshInterval, 5);

  // Provider renamed → the wrapper content follows, command stays put.
  const renamed = buildClaudeEffectiveSettings({}, {}, "", "Renamed", "p-upgrade");
  assert.equal(renamed.statusLine.command, command);
  assert.ok(readFileSync(instanceFile("p-upgrade"), "utf8").includes('"Renamed"'));
});

test("injection: user-authored statusLine becomes the wrapper's relay source", () => {
  cleanInstance("p-user");
  const userLine = { type: "command", command: "echo my-own-statusline", refreshInterval: 9 };
  const effective = buildClaudeEffectiveSettings(
    { statusLine: userLine }, {}, "", "Prov", "p-user",
  );
  // injected: the entry now points at the wrapper, display fields kept
  assert.equal(effective.statusLine.type, "command");
  assert.ok(effective.statusLine.command.includes("statusline-wrapper.mjs"));
  assert.equal(effective.statusLine.refreshInterval, 9);
  // ...and the user's own command is inlined as the preferred relay
  const script = readFileSync(instanceFile("p-user"), "utf8");
  assert.ok(script.includes(JSON.stringify("echo my-own-statusline")), "relay command inlined");
});

test("injection: malformed explicit statusLine (missing/blank command) still injects, no relay", () => {
  // command missing entirely
  cleanInstance("p-malformed");
  const e1 = buildClaudeEffectiveSettings(
    { statusLine: { type: "command" } }, {}, "", "Prov", "p-malformed",
  );
  assert.ok(e1.statusLine.command.includes("statusline-wrapper.mjs"));
  assert.equal(e1.statusLine.type, "command");
  assert.ok(
    readFileSync(instanceFile("p-malformed"), "utf8").includes("const RELAY_COMMAND = null"),
    "no relay inlined for a commandless entry",
  );

  // whitespace-only command — same treatment
  cleanInstance("p-blank");
  const e2 = buildClaudeEffectiveSettings(
    { statusLine: { type: "command", command: "   " } }, {}, "", "Prov", "p-blank",
  );
  assert.ok(e2.statusLine.command.includes("statusline-wrapper.mjs"));
  assert.ok(
    readFileSync(instanceFile("p-blank"), "utf8").includes("const RELAY_COMMAND = null"),
  );
});

test("injection: skipped when no provider identity is passed", () => {
  const effective = buildClaudeEffectiveSettings({}, {}, "");
  assert.equal(effective.statusLine, undefined);
});

// ─── provider name resolution ─────────────────────────────────────────

test("claudeProviderName: falls back to the id without a DB", () => {
  // The fixture home has no cc-switch.db — the lookup throws and the id
  // stands in. prepare and computeEffectiveSettings hit the same path, so
  // the two derivations stay identical.
  assert.equal(claudeProviderName("p-nonexistent"), "p-nonexistent");
});

// ─── guard consistency: prepare output == computeEffectiveSettings ────

test("guard consistency: prepare's file equals computeEffectiveSettings", () => {
  cleanInstance("p-consistent");
  const config = { env: { ANTHROPIC_BASE_URL: "https://example.com" }, model: "opus" };
  claude.prepare(
    join(INSTANCES, "p-consistent"), "p-consistent", config, {}, "", "", {},
  );
  const onDisk = claude.readInstanceSettingsSnapshot(join(INSTANCES, "p-consistent"));
  const recomputed = claude.computeEffectiveSettings(config, {}, "", "", "p-consistent", {});
  assert.ok(deepEqualJson(onDisk, recomputed));
  assert.ok(onDisk.statusLine?.command?.includes("statusline-wrapper.mjs"));
});

// ─── wrapper behaviour (end-to-end) ───────────────────────────────────

function runWrapper(providerId, stdinJson) {
  return spawnSync(
    process.execPath, [instanceFile(providerId)],
    { input: stdinJson ?? JSON.stringify({ session_id: "s1", model: { display_name: "Opus" } }), encoding: "utf8", timeout: 15000 },
  );
}

test("wrapper: tags the first line of the global statusline, relays the rest", () => {
  cleanInstance("p-e2e");
  writeGlobalSettings({ type: "command", command: "awk '{print \"HUD:\" $0}'" });
  buildClaudeEffectiveSettings({}, {}, "", "Zhipu GLM", "p-e2e");

  const r = runWrapper("p-e2e", JSON.stringify({ model: { display_name: "Opus" } }));
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.ok(out.includes("Zhipu GLM"), "provider tag present");
  assert.ok(out.includes("HUD:"), "global statusline relayed");
  // tag first (spaced fallback — the relayed line does not lead with the
  // model token), then the relayed first line, on line 1
  const firstLine = out.split("\n")[0];
  assert.ok(firstLine.startsWith("\x1b[1m\x1b["));
  assert.ok(
    firstLine.endsWith('Zhipu GLM]\x1b[0m HUD:{"model":{"display_name":"Opus"}}'),
    firstLine,
  );
});

test("wrapper: model-led line glues the tag — [provider][model]", () => {
  cleanInstance("p-glue");
  writeGlobalSettings({ type: "command", command: "echo '[Opus] │ proj'" });
  buildClaudeEffectiveSettings({}, {}, "", "Zhipu GLM en", "p-glue");

  const r = runWrapper("p-glue", JSON.stringify({ model: { display_name: "Opus" } }));
  assert.equal(r.status, 0, r.stderr);
  const firstLine = r.stdout.split("\n")[0];
  assert.ok(
    firstLine.endsWith("Zhipu GLM en]\x1b[0m[Opus] │ proj"),
    firstLine,
  );
});

test("wrapper: glue works behind the relay's own ANSI codes (claude-hud shape)", () => {
  cleanInstance("p-glue-ansi");
  writeGlobalSettings({
    type: "command",
    command: "printf '\\033[0m\\033[36m[Opus] │ proj\\n'",
  });
  buildClaudeEffectiveSettings({}, {}, "", "Zhipu GLM en", "p-glue-ansi");

  const r = runWrapper("p-glue-ansi", JSON.stringify({ model: { display_name: "Opus" } }));
  assert.equal(r.status, 0, r.stderr);
  const firstLine = r.stdout.split("\n")[0];
  // tag sits at the very front, ahead of the relay's reset/color codes
  assert.ok(firstLine.startsWith("\x1b[1m\x1b["));
  assert.ok(
    firstLine.endsWith("Zhipu GLM en]\x1b[0m\x1b[0m\x1b[36m[Opus] │ proj"),
    firstLine,
  );
});

test("wrapper: glue walks past leading indent (real claude-hud output)", () => {
  cleanInstance("p-glue-indent");
  writeGlobalSettings({
    type: "command",
    command: "printf '  [glm-5.3-flash[1m]] │ proj\\n'",
  });
  buildClaudeEffectiveSettings({}, {}, "", "Zhipu GLM en", "p-glue-indent");

  const r = runWrapper(
    "p-glue-indent",
    JSON.stringify({ model: { display_name: "glm-5.3-flash[1m]" } }),
  );
  assert.equal(r.status, 0, r.stderr);
  const firstLine = r.stdout.split("\n")[0];
  // glued tag, relay's leading indent dropped
  assert.ok(
    firstLine.endsWith("Zhipu GLM en]\x1b[0m[glm-5.3-flash[1m]] │ proj"),
    firstLine,
  );
});

test("wrapper: JSON-bearing line with model name inside does not glue", () => {
  cleanInstance("p-no-glue-json");
  writeGlobalSettings({ type: "command", command: "cat" });
  buildClaudeEffectiveSettings({}, {}, "", "Prov", "p-no-glue-json");

  const stdin = JSON.stringify({ model: { display_name: "Opus" } });
  const r = runWrapper("p-no-glue-json", stdin);
  assert.equal(r.status, 0, r.stderr);
  // `cat` relays the raw JSON — "Opus" appears mid-line behind display_name's
  // own letters, so the tag must fall back to spaced, not glue mid-token.
  const firstLine = r.stdout.split("\n")[0];
  assert.ok(firstLine.includes("[Prov]"), firstLine);
  assert.ok(firstLine.endsWith(`\x1b[0m ${stdin}`), firstLine);
});

test("wrapper: bare model at line start stays spaced, not glued", () => {
  cleanInstance("p-bare-model");
  writeGlobalSettings({ type: "command", command: "echo 'Opus | proj'" });
  buildClaudeEffectiveSettings({}, {}, "", "Prov", "p-bare-model");

  const r = runWrapper("p-bare-model", JSON.stringify({ model: { display_name: "Opus" } }));
  assert.equal(r.status, 0, r.stderr);
  const firstLine = r.stdout.split("\n")[0];
  assert.ok(firstLine.endsWith("\x1b[0m Opus | proj"), firstLine);
  assert.ok(firstLine.includes("[Prov]"), firstLine);
});

test("wrapper: per-provider colors are stable and do not collide on real names", () => {
  cleanInstance("p-col-a");
  cleanInstance("p-col-b");
  buildClaudeEffectiveSettings({}, {}, "", "Zhipu GLM en", "p-col-a");
  buildClaudeEffectiveSettings({}, {}, "", "P&G Nezha", "p-col-b");
  const colorOf = (id) => {
    const m = readFileSync(instanceFile(id), "utf8").match(/PALETTE\[hash % PALETTE\.length\]/);
    assert.ok(m, "palette expression present");
    // Evaluate the FNV-1a hash the same way the wrapper does.
    let hash = 2166136261;
    const provider = readFileSync(instanceFile(id), "utf8").match(/^const PROVIDER = "(.*)";$/m)[1];
    for (const ch of provider) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
    return [96, 92, 93, 95, 94, 91][hash % 6];
  };
  assert.notEqual(colorOf("p-col-a"), colorOf("p-col-b"));
});

test("wrapper: multi-line statusline keeps trailing lines verbatim", () => {
  cleanInstance("p-multi");
  writeGlobalSettings({ type: "command", command: "printf 'one\\ntwo\\n'" });
  buildClaudeEffectiveSettings({}, {}, "", "Prov", "p-multi");

  const r = runWrapper("p-multi", "");
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.ok(lines[0].includes("Prov"));
  assert.ok(lines[0].includes("one"));
  assert.equal(lines[1], "two");
});

test("wrapper: no global statusline → tag only", () => {
  cleanInstance("p-bare");
  writeGlobalSettings(undefined);
  buildClaudeEffectiveSettings({}, {}, "", "Solo", "p-bare");

  const r = runWrapper("p-bare", "{}");
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("Solo"));
});

test("wrapper: failing global statusline degrades to tag only", () => {
  cleanInstance("p-fail");
  writeGlobalSettings({ type: "command", command: "exit 3" });
  buildClaudeEffectiveSettings({}, {}, "", "Fallback", "p-fail");

  const r = runWrapper("p-fail", "{}");
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("Fallback"));
  assert.equal(r.stdout.trimEnd().split("\n").length, 1, "single line out");
});

test("wrapper: loop guard — a global command pointing back at the wrapper is not run", () => {
  cleanInstance("p-loop");
  writeGlobalSettings({
    type: "command",
    command: `echo 'should not appear'; ${process.execPath} ${instanceFile("p-loop")}`,
  });
  buildClaudeEffectiveSettings({}, {}, "", "NoLoop", "p-loop");

  const r = runWrapper("p-loop", "{}");
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("NoLoop"));
  assert.ok(!r.stdout.includes("should not appear"));
});

test("wrapper: inlined RELAY_COMMAND (from cc-switch config) beats the global statusline", () => {
  cleanInstance("p-relay");
  writeGlobalSettings({ type: "command", command: "echo GLOBAL-SOURCE" });
  buildClaudeEffectiveSettings(
    { statusLine: { type: "command", command: "echo RELAY-SOURCE" } },
    {}, "", "Prov", "p-relay",
  );

  const r = runWrapper("p-relay", "{}");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("RELAY-SOURCE"), r.stdout);
  assert.ok(!r.stdout.includes("GLOBAL-SOURCE"), r.stdout);
});

test("wrapper: RELAY_COMMAND works even without a global settings file", () => {
  cleanInstance("p-relay-noglobal");
  rmSync(GLOBAL_SETTINGS, { force: true });
  buildClaudeEffectiveSettings(
    { statusLine: { type: "command", command: "echo ONLY-RELAY" } },
    {}, "", "Prov", "p-relay-noglobal",
  );

  const r = runWrapper("p-relay-noglobal", "{}");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("ONLY-RELAY"), r.stdout);
});

test("wrapper: corrupted global settings file → tag only", () => {
  cleanInstance("p-corrupt");
  mkdirSync(join(testHome, ".claude"), { recursive: true });
  writeFileSync(GLOBAL_SETTINGS, "{ not json");
  buildClaudeEffectiveSettings({}, {}, "", "Tough", "p-corrupt");

  const r = runWrapper("p-corrupt", "{}");
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes("Tough"));
});

// ─── wrapper script source (no execution) ─────────────────────────────

test("wrapper script: quoted strings survive shell round-trip", () => {
  const script = buildStatusLineWrapperScript("P&G Nezha 'quoted'", GLOBAL_SETTINGS);
  assert.ok(script.includes(JSON.stringify("P&G Nezha 'quoted'")));
  assert.ok(script.includes(JSON.stringify(GLOBAL_SETTINGS)));
});

// ─── codex native [tui] status_line injection ──────────────────────────

test("codex injection: empty config gains default status_line + colors", () => {
  const tree = codex.computeEffectiveSettings({ config: "", auth: {} }, {}, "", "", "p-cx", {});
  assert.deepEqual(tree.tui.status_line, ["model-with-reasoning", "current-dir"]);
  assert.equal(tree.tui.status_line_use_colors, true);
});

test("codex injection: sibling [tui] keys survive the merge", () => {
  const obj = { tui: { notifications: true, status_line: undefined } };
  delete obj.tui.status_line;
  const out = applyCodexStatusLineInjection(obj);
  assert.equal(out.tui.notifications, true);
  assert.deepEqual(out.tui.status_line, ["model-with-reasoning", "current-dir"]);
});

test("codex injection: explicit user values win (fill-if-absent)", () => {
  const cfg = { config: '[tui]\nstatus_line = ["model"]\nstatus_line_use_colors = false\n' };
  const tree = codex.computeEffectiveSettings(cfg, {}, "", "", "p-cx", {});
  assert.deepEqual(tree.tui.status_line, ["model"]);
  assert.equal(tree.tui.status_line_use_colors, false);
});

test("codex injection: status_line = [] opts out entirely", () => {
  const cfg = { config: '[tui]\nstatus_line = []\n' };
  const tree = codex.computeEffectiveSettings(cfg, {}, "", "", "p-cx", {});
  assert.deepEqual(tree.tui.status_line, []);
});

test("codex channel: owns the tui.status_line subtree only", () => {
  assert.equal(isCodexStatusLineChannelPath("tui.status_line"), true);
  assert.equal(isCodexStatusLineChannelPath("tui.status_line_use_colors"), true);
  assert.equal(isCodexStatusLineChannelPath("tui.status_lineX"), false);
  assert.equal(isCodexStatusLineChannelPath("tui"), false);
  assert.equal(isCodexStatusLineChannelPath("tui.notifications"), false);
  assert.equal(isCodexStatusLineChannelPath("model"), false);
  assert.equal(codex.channelOwnedPath("tui.status_line"), true);
  assert.equal(codex.channelOwnedPath("tui.notifications"), false);
});

test("codex guard consistency: prepare's file equals computeEffectiveSettings", () => {
  const dir = join(CC, "instances", "codex", "p-cx-consistent");
  mkdirSync(dir, { recursive: true });
  const cfg = { config: '[tui]\nnotifications = true\n', auth: {} };
  codex.prepare(dir, "p-cx-consistent", cfg, {}, "", "", {});
  const onDisk = codex.readInstanceSettingsSnapshot(dir);
  const recomputed = codex.computeEffectiveSettings(cfg, {}, "", "", "p-cx-consistent", {});
  assert.ok(deepEqualJson(onDisk, recomputed));
  // injected, and the user's own sibling key survived
  assert.deepEqual(onDisk.tui.status_line, ["model-with-reasoning", "current-dir"]);
  assert.equal(onDisk.tui.notifications, true);
});

test("codex purity: two computations of the same input are identical", () => {
  const cfg = { config: "model = \"x\"\n", auth: {} };
  const a = codex.computeEffectiveSettings(cfg, {}, "", "", "p-cx", {});
  const b = codex.computeEffectiveSettings(cfg, {}, "", "", "p-cx", {});
  assert.ok(deepEqualJson(a, b));
});

// ─── tag color preference ───────────────────────────────────────────────

test("tag color: default is auto and unknown codes fall back to auto", () => {
  assert.equal(statuslineColorFor("claude", "p-never-set"), "auto");
  // corrupt file → fail-open
  mkdirSync(CC, { recursive: true });
  writeFileSync(join(CC, "statusline-preferences.json"), "{ not json");
  assert.equal(statuslineColorFor("claude", "p-x"), "auto");
  assert.equal(buildStatusLineWrapperScript("Prov", GLOBAL_SETTINGS).includes('const COLOR = "auto"'), true);
});

test("tag color: save/load round-trip drives the wrapper's COLOR constant", () => {
  cleanInstance("p-color");
  assert.equal(saveStatuslineColor("claude", "p-color", "91"), "91");
  assert.equal(statuslineColorFor("claude", "p-color"), "91");
  buildClaudeEffectiveSettings({}, {}, "", "Prov", "p-color");
  assert.ok(
    readFileSync(instanceFile("p-color"), "utf8").includes('const COLOR = "91"'),
    "wrapper inlines the chosen color",
  );
  // e2e: fixed color reaches the tag, no hashing
  const r = spawnSync(
    process.execPath, [instanceFile("p-color")],
    { input: "{}", encoding: "utf8", timeout: 15000 },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith("\x1b[1m\x1b[91m[Prov]"), r.stdout);
});

test("tag color: setting back to auto removes the stored key", () => {
  assert.equal(saveStatuslineColor("claude", "p-color", "auto"), "auto");
  assert.equal(statuslineColorFor("claude", "p-color"), "auto");
  const prefs = loadStatuslinePreferences();
  assert.equal(prefs.colors.claude["p-color"], undefined);
});

test("tag color: invalid values are rejected without corrupting the file", () => {
  const before = readFileSync(join(CC, "statusline-preferences.json"), "utf8");
  assert.equal(saveStatuslineColor("claude", "p-color", "99"), null);
  assert.equal(saveStatuslineColor("claude", "p-color", "true"), null);
  assert.equal(readFileSync(join(CC, "statusline-preferences.json"), "utf8"), before);
});
