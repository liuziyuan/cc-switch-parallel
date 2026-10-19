import process from "node:process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (STATUSLINE_PREFS_PATH) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-switch-statusline-display-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { __test } = await import("../bin/cc-launch.mjs");
const {
  buildStatusLineWrapperScript,
  loadStatuslineDisplay,
  saveStatuslineDisplay,
  detectStatuslineRelay,
  STATUSLINE_DISPLAY_ITEMS,
} = __test;

const CC = join(testHome, ".cc-switch");
const PREFS = join(CC, "statusline-preferences.json");
const GLOBAL_SETTINGS = join(testHome, ".claude", "settings.json");
const WRAPPER_DIR = join(testHome, "wrappers");
mkdirSync(WRAPPER_DIR, { recursive: true });

function writeGlobalSettings(statusLine) {
  mkdirSync(join(testHome, ".claude"), { recursive: true });
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify(statusLine === undefined ? {} : { statusLine }, null, 2));
}

function writePrefs(body) {
  mkdirSync(CC, { recursive: true });
  writeFileSync(PREFS, JSON.stringify(body, null, 2));
}

function resetPrefs() {
  rmSync(PREFS, { force: true });
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

let wrapperSeq = 0;
function makeWrapper(extra = {}) {
  const path = join(WRAPPER_DIR, `wrapper-${wrapperSeq++}.mjs`);
  writeFileSync(
    path,
    buildStatusLineWrapperScript("Prov", GLOBAL_SETTINGS, extra.relay ?? null, "auto", extra.usage ?? null, extra.stack ?? null),
  );
  return path;
}

function runWrapper(path, input) {
  const r = spawnSync(process.execPath, [path], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  return {
    raw: r.stdout,
    lines: stripAnsi(r.stdout).replace(/\n+$/, "").split("\n"),
  };
}

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "cc-switch-git-"));
  const run = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  const init = run(["init", "-q"]);
  assert.equal(init.status, 0, init.stderr);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "x");
  run(["add", "a.txt"]);
  const commit = run(["commit", "-qm", "init"]);
  assert.equal(commit.status, 0, commit.stderr);
  writeFileSync(join(dir, "a.txt"), "y");
  return dir;
}

// ─── preference store ───────────────────────────────────────────────────

test("display: defaults mirror claude-hud and are all on", () => {
  resetPrefs();
  const d = loadStatuslineDisplay();
  assert.equal(d.display.showModel, true);
  assert.equal(d.display.showProject, true);
  assert.equal(d.display.showContext, true);
  assert.equal(d.display.showContextBar, true);
  assert.equal(d.display.showUsage, true);
  assert.equal(d.display.usageBarEnabled, true);
  assert.equal(d.display.contextValue, "percent");
  assert.equal(d.display.modelFormat, "full");
  assert.equal(d.gitStatus.enabled, true);
  assert.equal(d.gitStatus.showDirty, true);
  assert.equal(d.gitStatus.showAheadBehind, false);
  assert.equal(d.pathLevels, 1);
});

test("display: one switch saves without touching colors; invalid writes rejected", () => {
  writePrefs({ version: 1, colors: { claude: { p1: "91" } } });
  assert.equal(saveStatuslineDisplay("display.showModel", false), false);
  assert.equal(loadStatuslineDisplay().display.showModel, false);

  const raw = JSON.parse(readFileSync(PREFS, "utf8"));
  assert.equal(raw.colors.claude.p1, "91", "color bucket survives a display save");

  const before = readFileSync(PREFS, "utf8");
  assert.equal(saveStatuslineDisplay("display.showModel", "no"), null);
  assert.equal(saveStatuslineDisplay("display.nope", false), null);
  assert.equal(readFileSync(PREFS, "utf8"), before, "rejected writes leave the file untouched");
});

test("display: a display-only file is valid; a corrupt file fails open", () => {
  writePrefs({ version: 1, display: { showUsage: false }, gitStatus: { enabled: false }, pathLevels: 2 });
  const d = loadStatuslineDisplay();
  assert.equal(d.display.showUsage, false);
  assert.equal(d.gitStatus.enabled, false);
  assert.equal(d.pathLevels, 2);

  writeFileSync(PREFS, "{ not json");
  const fallback = loadStatuslineDisplay();
  assert.equal(fallback.display.showUsage, true);
  assert.equal(fallback.gitStatus.enabled, true);
  assert.equal(fallback.pathLevels, 1);
});

test("display items: five switches, stable dotted keys", () => {
  assert.deepEqual(
    STATUSLINE_DISPLAY_ITEMS.map((i) => i.key),
    ["display.showModel", "display.showProject", "gitStatus.enabled", "display.showContext", "display.showUsage"],
  );
});

// ─── relay detection (TUI notice) ───────────────────────────────────────

test("relay detection: none, claude-hud, other, and the wrapper itself", () => {
  writeGlobalSettings(undefined);
  assert.equal(detectStatuslineRelay().kind, "none");

  writeGlobalSettings({ type: "command", command: "node /x/plugins/claude-hud/statusline.mjs" });
  assert.equal(detectStatuslineRelay().kind, "claude-hud");

  writeGlobalSettings({ type: "command", command: "node /x/ccstatusline" });
  assert.equal(detectStatuslineRelay().kind, "other");

  writeGlobalSettings({ type: "command", command: "node /x/statusline-wrapper.mjs" });
  assert.equal(detectStatuslineRelay().kind, "none", "loop guard");
});

// ─── self-drawn wrapper ─────────────────────────────────────────────────

test("self-draw: model, project, git on row 1; context on row 2", () => {
  resetPrefs();
  writeGlobalSettings(undefined);
  const repo = gitRepo();
  const { lines, raw } = runWrapper(makeWrapper(), {
    model: { display_name: "Opus 5.5" },
    cwd: repo,
    context_window: { context_window_size: 200000, used_percentage: 45 },
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[Prov\]\[Opus 5\.5\] \S+ git:\(\S+\*\)$/);
  assert.match(lines[1], /^Context [█░]+ 45%$/);
  assert.ok(raw.includes("\x1b[36m[Opus 5.5]\x1b[0m"), "model badge is cyan");
  assert.ok(raw.includes("\x1b[33m"), "project is yellow");
  assert.ok(raw.includes("\x1b[35mgit:(\x1b[0m"), "git label is magenta");
});

test("self-draw: no git repo and no context data leave those segments out", () => {
  resetPrefs();
  writeGlobalSettings(undefined);
  const dir = mkdtempSync(join(tmpdir(), "cc-switch-nogit-"));
  const { lines } = runWrapper(makeWrapper(), { model: { display_name: "Opus" }, cwd: dir });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `[Prov][Opus] ${dir.split("/").pop()}`);
});

test("self-draw: switches hide model/project/git/context; the tag remains", () => {
  writePrefs({
    version: 1,
    display: { showModel: false, showProject: false, showContext: false, showUsage: false },
    gitStatus: { enabled: false },
  });
  writeGlobalSettings(undefined);
  const { lines } = runWrapper(makeWrapper(), {
    model: { display_name: "Opus" },
    cwd: gitRepo(),
    context_window: { used_percentage: 45 },
  });
  assert.deepEqual(lines, ["[Prov]"]);
});

test("self-draw: showContextBar=false keeps the percentage without a bar", () => {
  writePrefs({ version: 1, display: { showModel: false, showProject: false, showContextBar: false }, gitStatus: { enabled: false } });
  writeGlobalSettings(undefined);
  const { lines } = runWrapper(makeWrapper(), {
    model: { display_name: "Opus" },
    cwd: "/tmp",
    context_window: { context_window_size: 200000, current_usage: { input_tokens: 50000, cache_read_input_tokens: 40000 } },
  });
  assert.deepEqual(lines, ["[Prov]", "Context 45%"]);
});

test("self-draw: context falls back to current_usage when used_percentage is absent", () => {
  resetPrefs();
  writeGlobalSettings(undefined);
  const { lines } = runWrapper(makeWrapper(), {
    model: { display_name: "Opus" },
    cwd: "/tmp",
    context_window: { context_window_size: 100000, current_usage: { input_tokens: 30000, cache_read_input_tokens: 20000 } },
  });
  assert.equal(lines[1], "Context █████░░░░░ 50%");
});

// ─── relay ownership ────────────────────────────────────────────────────

test("relay present: self-draw is skipped, tag glues to the model-led relay", () => {
  resetPrefs();
  writeGlobalSettings({
    type: "command",
    command: `node -e "console.log('[Opus] │ project git:(main*)')"`,
  });
  const { lines } = runWrapper(makeWrapper(), {
    model: { display_name: "Opus" },
    cwd: gitRepo(),
    context_window: { used_percentage: 45 },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "[Prov][Opus] │ project git:(main*)");
});

test("relay present but failing still suppresses self-draw", () => {
  resetPrefs();
  writeGlobalSettings({ type: "command", command: "exit 1" });
  const { lines } = runWrapper(makeWrapper(), {
    model: { display_name: "Opus" },
    cwd: gitRepo(),
    context_window: { used_percentage: 45 },
  });
  assert.deepEqual(lines, ["[Prov]"]);
});

// ─── aggregation ────────────────────────────────────────────────────────

test("self-draw: aggregation model id drops the ccs key prefix", () => {
  resetPrefs();
  writeGlobalSettings(undefined);
  const stack = { selfPath: join(WRAPPER_DIR, "self.mjs"), map: {}, names: {}, defaultKey: null };
  const { lines } = runWrapper(makeWrapper({ stack }), {
    model: { display_name: "ccs-claude-zhipu--glm-5.3[1M]" },
    cwd: "/tmp",
  });
  assert.equal(lines[0], "[Prov][glm-5.3[1M]] tmp");
});
