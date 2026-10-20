import { test } from "node:test";
import assert from "node:assert/strict";

const { parseLaunchArgs } = await import("../src/commands/args.ts");

test("parseLaunchArgs: empty argv", () => {
  assert.deepEqual(parseLaunchArgs([]), {
    syncFlag: null,
    providerId: null,
    dryRun: false,
    diff: false,
    showSecrets: false,
    rest: [],
  });
});

test("parseLaunchArgs: sync flags", () => {
  assert.equal(parseLaunchArgs(["--sync", "P", "claude"]).syncFlag, "on");
  assert.equal(parseLaunchArgs(["--no-sync", "P", "claude"]).syncFlag, "off");
});

test("parseLaunchArgs: dry-run flags stay at the front", () => {
  assert.deepEqual(
    parseLaunchArgs(["--dry-run", "--diff", "--show-secrets", "P", "claude", "--continue"]),
    {
      syncFlag: null,
      providerId: null,
      dryRun: true,
      diff: true,
      showSecrets: true,
      rest: ["P", "claude", "--continue"],
    },
  );
});

test("parseLaunchArgs: --id forms", () => {
  assert.deepEqual(parseLaunchArgs(["--id", "p1", "claude", "--continue"]), {
    syncFlag: null,
    providerId: "p1",
    dryRun: false,
    diff: false,
    showSecrets: false,
    rest: ["claude", "--continue"],
  });
  assert.equal(parseLaunchArgs(["--id=p1", "claude"]).providerId, "p1");
});

test("parseLaunchArgs: errors and trailing flags", () => {
  assert.equal(parseLaunchArgs(["--id"]).error, "missing --id value");
  assert.equal(parseLaunchArgs(["--id=", "claude"]).error, "missing --id value");
  assert.equal(
    parseLaunchArgs(["--diff", "P", "claude"]).error,
    "--diff and --show-secrets require --dry-run",
  );
  assert.equal(
    parseLaunchArgs(["--show-secrets", "P", "claude"]).error,
    "--diff and --show-secrets require --dry-run",
  );
  // Only leading flags are switch flags; the rest is forwarded verbatim.
  assert.deepEqual(parseLaunchArgs(["P", "claude", "--sync"]).rest, ["P", "claude", "--sync"]);
});
