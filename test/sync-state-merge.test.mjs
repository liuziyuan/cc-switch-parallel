import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-sync-merge-"));
process.env.CC_SWITCH_TEST_HOME = TEST_HOME;
const STATE_DIR = join(TEST_HOME, ".cc-switch");
const SYNC_PATH = join(STATE_DIR, "sync-state.json");
mkdirSync(STATE_DIR, { recursive: true });

const { mergeAndSaveSyncState } = await import("../src/drift.ts");

function seed(state) {
  writeFileSync(SYNC_PATH, JSON.stringify(state));
}
function read() {
  return JSON.parse(readFileSync(SYNC_PATH, "utf8"));
}

test("merge: touched instances are written, untouched disk entries survive", () => {
  seed({
    version: 3,
    instances: {
      claude: {
        a: { preparedAt: 1, commonHash: "disk-a" },
        keep: { preparedAt: 1, commonHash: "disk-keep" },
      },
    },
    claude: { installedPluginKeys: ["old"] },
  });
  const local = {
    version: 3,
    instances: { claude: { a: { preparedAt: 2, commonHash: "local-a" } } },
    claude: { installedPluginKeys: ["new"] },
  };
  assert.equal(mergeAndSaveSyncState(local, { claude: ["a"] }, {}, false), true);
  const out = read();
  assert.equal(out.instances.claude.a.commonHash, "local-a");
  assert.equal(out.instances.claude.keep.commonHash, "disk-keep", "concurrent entry preserved");
  assert.deepEqual(
    out.claude.installedPluginKeys,
    ["old"],
    "plugin baseline untouched without plugin sync",
  );
});

test("merge: removed ids drop the baseline, other disk entries survive", () => {
  seed({
    version: 3,
    instances: { claude: { dead: { preparedAt: 1 }, keep: { preparedAt: 1 } } },
  });
  const local = { version: 3, instances: { claude: {} } };
  assert.equal(mergeAndSaveSyncState(local, {}, { claude: ["dead"] }, false), true);
  const out = read();
  assert.equal(out.instances.claude.dead, undefined);
  assert.ok(out.instances.claude.keep);
});

test("merge: the plugin baseline is written only when the plugin channel ran", () => {
  seed({ version: 3, instances: {}, claude: { installedPluginKeys: ["old"] } });
  const local = { version: 3, instances: {}, claude: { installedPluginKeys: ["new"] } };
  assert.equal(mergeAndSaveSyncState(local, {}, {}, true), true);
  assert.deepEqual(read().claude.installedPluginKeys, ["new"]);
});

test("merge: a newer concurrent baseline is not overwritten by an older local one", () => {
  seed({ version: 3, instances: { claude: { a: { preparedAt: 5, commonHash: "newer-disk" } } } });
  const local = {
    version: 3,
    instances: { claude: { a: { preparedAt: 2, commonHash: "older-local" } } },
  };
  assert.equal(mergeAndSaveSyncState(local, { claude: ["a"] }, {}, false), true);
  assert.equal(read().instances.claude.a.commonHash, "newer-disk");

  // And the local value wins when it is newer.
  seed({ version: 3, instances: { claude: { a: { preparedAt: 1, commonHash: "older-disk" } } } });
  assert.equal(mergeAndSaveSyncState(local, { claude: ["a"] }, {}, false), true);
  assert.equal(read().instances.claude.a.commonHash, "older-local");
});
