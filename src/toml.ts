// ─── toml (split from bin/cc-launch.mjs) ─────────────────────────────

// smol-toml is resolved at BUILD time and inlined into the single-file dist
// artifact by esbuild — no runtime module resolution, no install-layout
// fallbacks. It stays in `dependencies` because the test suite imports it
// directly as a reference implementation.
import { parse, stringify } from "smol-toml";

function parseToml(text: string): any {
  return toPlainObjects(parse(text));
}

// smol-toml 1.9 returns null-prototype objects (a key-safety hardening).
// Downstream code assumes plain objects (deepStrictEqual, Object.assign,
// hasOwnProperty), so rebuild them with defineProperty — which also keeps a
// literal "__proto__" key as an own property instead of hitting the setter.
function toPlainObjects(value: any): any {
  if (Array.isArray(value)) return value.map(toPlainObjects);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: any = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: toPlainObjects(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

function stringifyToml(obj: any): string {
  return stringify(obj);
}

export { parseToml, stringifyToml };
