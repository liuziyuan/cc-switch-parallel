import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME before importing paths.ts consumers.
process.env.CC_SWITCH_TEST_HOME = mkdtempSync(join(tmpdir(), "cc-switch-catalog-"));

const { codexModelCatalogFromSettings, buildCodexConfig } = await import("../src/stack/catalog.ts");

test("catalog: malformed entries are skipped, valid ones survive", () => {
  const settings = {
    modelCatalog: {
      models: [
        null,
        "not-an-object",
        123,
        { model: 42 },
        { model: "" },
        { model: "good-model", displayName: 42, inputModalities: "image" },
        { model: "good-2", displayName: "Good 2", inputModalities: [null, 1, "image"] },
        { model: "good-3", inputModalities: ["text"] },
      ],
    },
  };
  const catalog = codexModelCatalogFromSettings(settings, "", "ProxyChat");
  assert.ok(catalog);
  assert.deepEqual(
    catalog.models.map((m) => m.slug),
    ["good-model", "good-2", "good-3"],
  );
  // Non-string displayName is ignored; the slug is the fallback.
  assert.equal(catalog.models[0].display_name, "good-model");
  // Non-array modalities = not declared (text+image); an array with "image"
  // wins; text-only stays text-only.
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models[1].input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models[2].input_modalities, ["text"]);
});

test("catalog: an all-malformed model list yields no catalog", () => {
  assert.equal(
    codexModelCatalogFromSettings(
      { modelCatalog: { models: [null, 1, { model: 2 }, { model: "" }] } },
      "",
      "ProxyChat",
    ),
    null,
  );
});

test("buildCodexConfig: non-object settings_config does not throw", () => {
  for (const bad of [null, [], 123, "{}", undefined]) {
    const out = buildCodexConfig(bad, {}, null, "", { id: "p" }, {});
    assert.equal(typeof out.configText, "string", `settingsConfig=${String(bad)}`);
  }
});
