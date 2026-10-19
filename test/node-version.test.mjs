import { test } from "node:test";
import assert from "node:assert/strict";

// Direct source import: the version floor is enforced inside bin/cc-launch.mjs,
// but the predicate itself is a pure function worth testing on its own.
const { MIN_NODE_MAJOR, isNodeVersionSupported, nodeMajorVersion, unsupportedNodeVersionMessage } =
  await import("../src/node-version.ts");

test("accepts Node 18 and newer", () => {
  assert.equal(MIN_NODE_MAJOR, 18);
  for (const version of ["18.0.0", "18.20.8", "20.11.1", "22.22.3", "24.1.0"]) {
    assert.equal(isNodeVersionSupported(version), true, version);
  }
});

test("rejects Node older than 18", () => {
  for (const version of ["16.14.0", "16.20.2", "17.9.1", "14.21.3", "v16.14.0"]) {
    assert.equal(isNodeVersionSupported(version), false, version);
  }
});

test("unparseable versions count as unsupported", () => {
  for (const version of ["", "not-a-version", "v", "vx18.0.0"]) {
    assert.equal(nodeMajorVersion(version), 0, version);
    assert.equal(isNodeVersionSupported(version), false, version);
  }
});

test("message reports both current and required versions", () => {
  const message = unsupportedNodeVersionMessage("16.14.0");
  assert.match(message, />= 18/);
  assert.match(message, /v16\.14\.0/);
  assert.match(message, /fetch/);
});
