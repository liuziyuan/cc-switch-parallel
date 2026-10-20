import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CC_SWITCH_TEST_HOME = mkdtempSync(join(tmpdir(), "cc-launch-help-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";

const { buildHelpText } = await import("../src/commands/customize.ts");

const README_EN = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const README_ZH = readFileSync(new URL("../README_ZH.md", import.meta.url), "utf8");

test("help lists every command, flag and alias", () => {
  const help = buildHelpText();
  const tokens = [
    "switch <provider> <cmd>",
    "--sync", "--no-sync", "--id", "--dry-run", "--diff", "--show-secrets",
    "a|s|d|f|g",
    "switch list", "--json", "--app",
    "switch ps", "switch ps kill", "switch ps attach", "--force",
    "switch sync",
    "switch doctor",
    "switch clean", "--all", "--yes",
    "switch customize", "switch uncustomize",
    "switch update", "self-update", "--update",
    "switch version", "-v", "--version",
    "switch help", "-h", "--help",
  ];
  for (const token of tokens) assert.ok(help.includes(token), `help is missing ${token}`);
});

const COMMAND_HEADINGS = [
  "`switch list",
  "`switch ps [",
  "`switch ps kill",
  "`switch ps attach",
  "`switch sync`",
  "`switch doctor",
  "`switch clean",
  "`switch customize",
  "`switch uncustomize",
  "`switch update",
  "`switch version",
  "`switch help",
];

function commandPositions(text) {
  return COMMAND_HEADINGS.map((token) => text.indexOf(token));
}

test("both READMEs document every command", () => {
  for (const [name, text] of [["README.md", README_EN], ["README_ZH.md", README_ZH]]) {
    for (const token of COMMAND_HEADINGS) {
      assert.ok(text.includes(token), `${name} is missing ${token}`);
    }
    for (const flag of ["--json", "--app", "--dry-run", "--diff", "--show-secrets", "--force", "--all", "--yes", "--id", "--sync", "--no-sync"]) {
      assert.ok(text.includes(flag), `${name} is missing ${flag}`);
    }
  }
});

test("README command order stays aligned across languages", () => {
  for (const [name, positions] of [["README.md", commandPositions(README_EN)], ["README_ZH.md", commandPositions(README_ZH)]]) {
    assert.ok(positions.every((p) => p >= 0), `${name} is missing a command section`);
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] > positions[i - 1], `${name} command sections out of order at ${COMMAND_HEADINGS[i]}`);
    }
  }
});
