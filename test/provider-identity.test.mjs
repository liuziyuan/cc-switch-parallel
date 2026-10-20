import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-provider-identity-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
const CC = join(TEST_HOME, ".cc-switch");

function sql(statement) {
  return execFileSync("sqlite3", [join(CC, "cc-switch.db"), ".timeout 3000", statement], {
    encoding: "utf8",
  });
}
function ensureDB() {
  mkdirSync(CC, { recursive: true });
  sql(`CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
    created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0, provider_type TEXT,
    PRIMARY KEY (id, app_type));`);
  sql(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
}
function insertRow(id, appType, name) {
  ensureDB();
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta)
    VALUES ('${id}', '${appType}', '${name}', '{}', '{}');`);
}

// Two same-name claude rows (id order: a-dup < z-dup), one unique row, and a
// same-name row under another app.
insertRow("a-dup", "claude", "Dup");
insertRow("z-dup", "claude", "Dup");
insertRow("solo", "claude", "Solo");
insertRow("codex-dup", "codex", "Dup");

const { queryProviderById, queryProviderMatches, queryProvidersByApp } = await import(
  "../src/db.ts"
);
const { parseLaunchArgs } = await import("../src/commands/args.ts");
const { resolveProviderRef, formatAmbiguousProvider } = await import("../src/provider-ref.ts");
const { launchRefForRow, launchRefForQuick } = await import("../src/tui.ts");
const { formatAvailableProviders } = await import("../src/provider-ref.ts");

test("queryProviderMatches: returns every same-name row in id order", () => {
  const rows = queryProviderMatches("Dup", "claude");
  assert.deepEqual(
    rows.map((r) => r.id),
    ["a-dup", "z-dup"],
  );
  assert.deepEqual(
    queryProviderMatches("Solo", "claude").map((r) => r.id),
    ["solo"],
  );
  assert.deepEqual(queryProviderMatches("Nope", "claude"), []);
});

test("formatAvailableProviders: includes ids so duplicate names disambiguate", () => {
  const text = formatAvailableProviders(queryProvidersByApp("claude"));
  assert.match(text, /a-dup\s+Dup/);
  assert.match(text, /z-dup\s+Dup/);
  assert.match(text, /solo\s+Solo/);
});

test("resolveProviderRef: name ambiguity is reported, id is exact", () => {
  const ambiguous = resolveProviderRef({ name: "Dup" }, "claude");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error, "ambiguous");
  assert.deepEqual(
    ambiguous.matches.map((r) => r.id),
    ["a-dup", "z-dup"],
  );

  const byId = resolveProviderRef({ id: "z-dup" }, "claude");
  assert.equal(byId.ok, true);
  assert.equal(byId.row.id, "z-dup");

  const solo = resolveProviderRef({ name: "Solo" }, "claude");
  assert.equal(solo.ok, true);
  assert.equal(solo.row.id, "solo");

  assert.equal(resolveProviderRef({ name: "Nope" }, "claude").error, "notFound");
  // An id from another app must not resolve.
  assert.equal(resolveProviderRef({ id: "a-dup" }, "codex").error, "notFound");
});

test("formatAmbiguousProvider: lists every id and the --id hint", () => {
  const matches = queryProviderMatches("Dup", "claude");
  const text = formatAmbiguousProvider("Dup", "claude", matches, "claude");
  assert.ok(text.includes("a-dup"));
  assert.ok(text.includes("z-dup"));
  assert.ok(text.includes("switch --id"));
  assert.ok(text.includes("ambiguous"));
});

test("parseLaunchArgs: --id selects by id and leaves the CLI args untouched", () => {
  assert.deepEqual(parseLaunchArgs(["--sync", "--id", "z-dup", "claude", "--continue"]), {
    syncFlag: "on",
    providerId: "z-dup",
    dryRun: false,
    diff: false,
    showSecrets: false,
    rest: ["claude", "--continue"],
  });
  assert.deepEqual(parseLaunchArgs(["--id=z-dup", "claude"]), {
    syncFlag: null,
    providerId: "z-dup",
    dryRun: false,
    diff: false,
    showSecrets: false,
    rest: ["claude"],
  });
  assert.deepEqual(parseLaunchArgs(["--no-sync", "P", "claude", "--continue"]), {
    syncFlag: "off",
    providerId: null,
    dryRun: false,
    diff: false,
    showSecrets: false,
    rest: ["P", "claude", "--continue"],
  });
  // Flags are only consumed at the front; everything after the first
  // positional token is forwarded to the CLI verbatim.
  assert.deepEqual(parseLaunchArgs(["P", "claude", "--sync"]), {
    syncFlag: null,
    providerId: null,
    dryRun: false,
    diff: false,
    showSecrets: false,
    rest: ["P", "claude", "--sync"],
  });
  assert.deepEqual(parseLaunchArgs(["--dry-run", "--diff", "--show-secrets", "P", "claude"]), {
    syncFlag: null,
    providerId: null,
    dryRun: true,
    diff: true,
    showSecrets: true,
    rest: ["P", "claude"],
  });
  assert.equal(parseLaunchArgs(["--id"]).error, "missing --id value");
  assert.equal(
    parseLaunchArgs(["--diff", "P", "claude"]).error,
    "--diff and --show-secrets require --dry-run",
  );
  assert.equal(
    parseLaunchArgs(["--show-secrets", "P", "claude"]).error,
    "--diff and --show-secrets require --dry-run",
  );
});

test("launch refs: id wins when present, name is the legacy fallback", () => {
  assert.deepEqual(launchRefForRow({ id: "z-dup", name: "Dup" }), { id: "z-dup", name: "Dup" });
  assert.deepEqual(launchRefForQuick({ providerId: "z-dup", provider: "Dup" }), {
    id: "z-dup",
    name: "Dup",
  });
  assert.deepEqual(launchRefForQuick({ providerId: null, provider: "Dup" }), { name: "Dup" });
  assert.deepEqual(launchRefForRow(null), { name: undefined });
});
