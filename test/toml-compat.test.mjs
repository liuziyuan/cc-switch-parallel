import { test } from "node:test";
import assert from "node:assert/strict";

const { parseToml, stringifyToml } = await import("../src/toml.ts");

test("parseToml keeps plain-object semantics after the smol-toml upgrade", () => {
  const empty = parseToml("");
  assert.deepEqual(empty, {});
  assert.equal(Object.getPrototypeOf(empty), Object.prototype, "empty document is a plain object");

  const doc = parseToml(`[a]\nb = 1\n[[items]]\nname = "x"\n`);
  assert.equal(Object.getPrototypeOf(doc), Object.prototype);
  assert.equal(Object.getPrototypeOf(doc.a), Object.prototype, "nested table is a plain object");
  assert.equal(Object.getPrototypeOf(doc.items[0]), Object.prototype, "array element is a plain object");
  assert.deepEqual(doc, { a: { b: 1 }, items: [{ name: "x" }] });
});

test("parseToml preserves Date and NaN values through the wrapper", () => {
  const doc = parseToml(`d = 2024-01-02T03:04:05Z\nn = nan\n`);
  assert.ok(doc.d instanceof Date, "datetime stays a Date");
  assert.ok(Number.isNaN(doc.n), "nan stays NaN");
});

test("parseToml keeps __proto__ as an own key without polluting Object.prototype", () => {
  const doc = parseToml(`[__proto__]\npolluted = "yes"\n`);
  assert.ok(Object.prototype.hasOwnProperty.call(doc, "__proto__"), "__proto__ is an own property");
  assert.equal({}.polluted, undefined, "Object.prototype is not polluted");
  assert.deepEqual(doc.__proto__, { polluted: "yes" });
});

test("stringify(parseToml(text)) round-trips", () => {
  const text = `[mcp_servers.fs]\ncommand = "npx"\nargs = ["-y", "server-fs"]\n`;
  const again = parseToml(stringifyToml(parseToml(text)));
  assert.equal(again.mcp_servers.fs.command, "npx");
  assert.deepEqual(again.mcp_servers.fs.args, ["-y", "server-fs"]);
});
