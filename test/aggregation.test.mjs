import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  ccsClaudeKeyFromModel,
  ccsCodexKeyFromModel,
  codexAggregationRoute,
  isCustomCodexModelProviderId,
} = await import("../src/stack/aggregation.ts");

test("codexAggregationRoute: active provider table wins", () => {
  const route = codexAggregationRoute(`
model_provider = "custom"
base_url = "https://top-level.example"
experimental_bearer_token = "top-level-token"

[model_providers.custom]
base_url = "http://127.0.0.1:15721"
experimental_bearer_token = "PROXY_MANAGED"
`);
  assert.equal(route.providerId, "custom");
  assert.equal(route.baseUrl, "http://127.0.0.1:15721");
  assert.equal(route.bearer, "PROXY_MANAGED");
});

test("codexAggregationRoute: falls back to top-level keys", () => {
  const route = codexAggregationRoute(`
base_url = "http://127.0.0.1:15721"
experimental_bearer_token = "PROXY_MANAGED"
`);
  assert.equal(route.providerId, null);
  assert.equal(route.baseUrl, "http://127.0.0.1:15721");
  assert.equal(route.bearer, "PROXY_MANAGED");
});

test("codexAggregationRoute: unparsable input returns null", () => {
  assert.equal(codexAggregationRoute("[[["), null);
  assert.deepEqual(codexAggregationRoute(""), {
    providerId: null,
    table: null,
    baseUrl: null,
    bearer: null,
  });
});

test("isCustomCodexModelProviderId: reserved ids are case-insensitive", () => {
  assert.equal(isCustomCodexModelProviderId("custom"), true);
  assert.equal(isCustomCodexModelProviderId("my-gateway"), true);
  assert.equal(isCustomCodexModelProviderId("OpenAI"), false);
  assert.equal(isCustomCodexModelProviderId("ollama"), false);
  assert.equal(isCustomCodexModelProviderId("  "), false);
});

test("ccs model id parsing: shared key extraction for both apps", () => {
  assert.equal(ccsClaudeKeyFromModel("ccs-claude-deepseek--deepseek-flash[1m]"), "deepseek");
  assert.equal(ccsClaudeKeyFromModel("ccs-claude-ZAI--glm"), "zai");
  assert.equal(ccsClaudeKeyFromModel("claude-sonnet-4"), null);
  assert.equal(ccsClaudeKeyFromModel(undefined), null);
  assert.equal(ccsCodexKeyFromModel("ccs-deepseek/deepseek-chat"), "deepseek");
  assert.equal(ccsCodexKeyFromModel("openai/gpt-5"), null);
  assert.equal(ccsCodexKeyFromModel(""), null);
});

test("stack/state no longer imports stack/catalog (cycle guard)", () => {
  const source = readFileSync(new URL("../src/stack/state.ts", import.meta.url), "utf8");
  assert.equal(source.includes('from "./catalog.js"'), false);
});
