import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CC_LAUNCH_SKIP_MAIN = "1";
const { __test } = await import("../bin/cc-launch.mjs");
const { isSensitiveConfigKey, isSensitiveConfigPath, splitChangesByTarget } = __test;

// ─── isSensitiveConfigKey ──────────────────────────────────────────────
// 1:1 port of Rust is_sensitive_config_key — deliberately over-broad.

test("sensitive keys: credential-shaped names match", () => {
  const hits = [
    "ANTHROPIC_AUTH_TOKEN", // _AUTH_TOKEN suffix
    "OPENAI_API_KEY", // _API_KEY suffix
    "AWS_SESSION_TOKEN", // singular _TOKEN suffix
    "AWS_SECRET_ACCESS_KEY", // SECRET contained
    "GITHUB_PAT", // _PAT suffix
    "ANTHROPIC_CUSTOM_HEADERS", // _CUSTOM_HEADERS suffix
    "Authorization", // AUTHORIZATION contained, case-insensitive
    "db_password", // PASSWORD contained, case-insensitive
    "VOLC_ACCESSKEY", // _ACCESSKEY suffix
    "Secret-Key", // SECRET contained
  ];
  for (const name of hits) {
    assert.equal(isSensitiveConfigKey(name), true, `expected hit: ${name}`);
  }
});

test("benign keys: token-count knobs and headers must NOT match", () => {
  const misses = [
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS", // plural _TOKENS does not satisfy the _TOKEN suffix
    "MAX_THINKING_TOKENS", // same
    "apiKeyHelper", // not exactly APIKEY, no suffix/containment hit
    "OTEL_EXPORTER_OTLP_HEADERS", // HEADERS is exact-match only
    "CLAUDE_CODE_ATTRIBUTION_HEADER", // singular HEADER, not the _CUSTOM_HEADERS suffix
    "permissions",
    "allow",
    "PWD", // bare PWD is fine; the _PWD suffix is what's sensitive
    "enabledPlugins",
  ];
  for (const name of misses) {
    assert.equal(isSensitiveConfigKey(name), false, `expected miss: ${name}`);
  }
});

// ─── isSensitiveConfigPath ─────────────────────────────────────────────

test("path hits when ANY segment is sensitive", () => {
  assert.equal(isSensitiveConfigPath("env.ANTHROPIC_AUTH_TOKEN"), true);
  assert.equal(isSensitiveConfigPath("env.Amazon_S3_Credentials"), true);
});

test("path misses on non-sensitive segments", () => {
  assert.equal(isSensitiveConfigPath("permissions.allow"), false);
});

// ─── splitChangesByTarget: the gate is common-direction-only ───────────

const PROVIDER_ID = "p1";

test("sensitive add/change into common is rejected and goes NOWHERE", () => {
  const changes = [{ path: "env.ANTHROPIC_AUTH_TOKEN", op: "change", from: "old", to: "new" }];
  const commonObj = { env: { ANTHROPIC_AUTH_TOKEN: "old" } };
  const out = splitChangesByTarget(changes, PROVIDER_ID, commonObj, {});
  assert.deepEqual(out.commonPatch, {});
  assert.deepEqual(out.providerPatch, {});
  assert.deepEqual(out.rejected, changes);
});

test("non-sensitive change into common flows normally", () => {
  const changes = [
    { path: "env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", op: "change", from: "0", to: "1" },
  ];
  const commonObj = { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" } };
  const out = splitChangesByTarget(changes, PROVIDER_ID, commonObj, {});
  assert.deepEqual(out.commonPatch, { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
  assert.deepEqual(out.providerPatch, {});
  assert.deepEqual(out.rejected, []);
});

test("removing a sensitive key FROM common stays allowed (leak cleanup)", () => {
  const changes = [{ path: "env.ANTHROPIC_AUTH_TOKEN", op: "remove", from: "old", to: undefined }];
  const commonObj = { env: { ANTHROPIC_AUTH_TOKEN: "old" } };
  const out = splitChangesByTarget(changes, PROVIDER_ID, commonObj, {});
  // env holds ONLY the deleted key, so the patch folds to a whole-subtree
  // remove — no {"env":{}} husk left behind.
  assert.deepEqual(out.commonPatch, { env: null }); // RFC 7396 remove
  assert.deepEqual(out.providerPatch, {});
  assert.deepEqual(out.rejected, []);
});

test("sensitive path NOT in common takes the provider direction, ungated", () => {
  const changes = [{ path: "env.MY_SERVICE_TOKEN", op: "add", from: undefined, to: "t" }];
  const commonObj = {};
  const providerSettings = { env: {} };
  const out = splitChangesByTarget(changes, PROVIDER_ID, commonObj, providerSettings);
  assert.deepEqual(out.commonPatch, {});
  assert.deepEqual(out.providerPatch, { env: { MY_SERVICE_TOKEN: "t" } });
  assert.deepEqual(out.rejected, []);
});

test("case variants of sensitive paths are refused", () => {
  for (const path of ["env.ApiKey", "env.aws_secret_access_key"]) {
    const changes = [{ path, op: "change", from: "old", to: "new" }];
    const leaf = path.split(".")[1];
    const commonObj = { env: { [leaf]: "old" } };
    const out = splitChangesByTarget(changes, PROVIDER_ID, commonObj, {});
    assert.deepEqual(out.commonPatch, {}, path);
    assert.deepEqual(out.rejected, changes, path);
  }
});

test("entries already equal to the DB value produce no patch and no rejection", () => {
  const changes = [
    { path: "env.SHARED", op: "change", from: "same", to: "same" },
    { path: "env.TOKEN_X", op: "change", from: "same", to: "same" },
  ];
  const commonObj = { env: { SHARED: "same", TOKEN_X: "same" } };
  const out = splitChangesByTarget(changes, PROVIDER_ID, commonObj, {});
  assert.deepEqual(out.commonPatch, {});
  assert.deepEqual(out.providerPatch, {});
  // equal-value sensitive entries never reach the gate, so nothing is rejected
  assert.deepEqual(out.rejected, []);
});

test("removing one env key leaves its siblings in the patch (no collateral delete)", () => {
  // The old folded whole-subtree remove produced {env:null} and wiped
  // KEEP_ME from common_config; the patch must stay per-leaf here.
  const changes = [{ path: "env.ANTHROPIC_AUTH_TOKEN", op: "remove", from: "old", to: undefined }];
  const commonObj = { env: { ANTHROPIC_AUTH_TOKEN: "old", KEEP_ME: "v" } };
  const out = splitChangesByTarget(changes, PROVIDER_ID, commonObj, {});
  assert.deepEqual(out.commonPatch, { env: { ANTHROPIC_AUTH_TOKEN: null } });
  assert.deepEqual(out.rejected, []);
});

test("deleting EVERY key of a subtree folds the patch to a whole-tree null", () => {
  // Husk prevention: per-leaf nulls alone would leave {"hooks":{}} behind.
  const changes = [
    { path: "hooks.Stop", op: "remove", from: { a: 1 }, to: undefined },
    { path: "hooks.PreToolUse", op: "remove", from: { b: 2 }, to: undefined },
  ];
  const commonObj = { hooks: { Stop: { a: 1 }, PreToolUse: { b: 2 } } };
  const out = splitChangesByTarget(changes, PROVIDER_ID, commonObj, {});
  assert.deepEqual(out.commonPatch, { hooks: null });
});
