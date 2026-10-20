import { test } from "node:test";
import assert from "node:assert/strict";

const { redactArgv, redactAtPath, redactSecrets } = await import("../src/redact.ts");

test("redactSecrets: masks credentials, keeps routing values", () => {
  const input = {
    env: {
      ANTHROPIC_AUTH_TOKEN: "secret-token",
      ANTHROPIC_API_KEY: "secret-key",
      ANTHROPIC_BASE_URL: "https://api.example.com",
    },
    headers: { Authorization: "Bearer xyz", "X-Trace": "keep" },
    nested: [{ MY_PASSWORD: "pw" }, { value: 1 }],
  };
  const out = redactSecrets(input);
  assert.equal(out.env.ANTHROPIC_AUTH_TOKEN, "***");
  assert.equal(out.env.ANTHROPIC_API_KEY, "***");
  assert.equal(out.env.ANTHROPIC_BASE_URL, "https://api.example.com");
  assert.equal(out.headers, "***", "a headers map is masked as a whole");
  assert.equal(out.nested[0].MY_PASSWORD, "***");
  assert.equal(out.nested[1].value, 1);
  assert.equal(input.env.ANTHROPIC_AUTH_TOKEN, "secret-token", "input untouched");
});

test("redactSecrets: showSecrets returns values unchanged", () => {
  const input = { env: { ANTHROPIC_AUTH_TOKEN: "secret-token" } };
  assert.deepEqual(redactSecrets(input, { showSecrets: true }), input);
});

test("redactAtPath: masks whole leaves on sensitive key segments", () => {
  assert.equal(redactAtPath("value", ["env", "ANTHROPIC_AUTH_TOKEN"]), "***");
  assert.equal(redactAtPath("value", ["env", "ANTHROPIC_BASE_URL"]), "value");
  assert.equal(redactAtPath("value", null), "value");
  assert.equal(redactAtPath("value", ["env", "ANTHROPIC_AUTH_TOKEN"], { showSecrets: true }), "value");
});

test("redactArgv: masks flag values and --flag=value forms", () => {
  assert.deepEqual(redactArgv(["--api-key", "secret", "--continue"]), ["--api-key", "***", "--continue"]);
  assert.deepEqual(redactArgv(["--token=abc", "--verbose"]), ["--token=***", "--verbose"]);
  assert.deepEqual(redactArgv(["--api-key=abc"]), ["--api-key=***"]);
  assert.deepEqual(redactArgv(["--continue"]), ["--continue"]);
  assert.deepEqual(redactArgv(["--api-key", "secret"], { showSecrets: true }), ["--api-key", "secret"]);
});
