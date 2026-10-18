// ─── toml (split from bin/cc-launch.mjs) ─────────────────────────────

// smol-toml is resolved at BUILD time and inlined into the single-file dist
// artifact by esbuild — no runtime module resolution, no install-layout
// fallbacks. It stays in `dependencies` because the test suite imports it
// directly as a reference implementation.
import { parse, stringify } from "smol-toml";

function parseToml(text: string): any {
  return parse(text);
}

function stringifyToml(obj: any): string {
  return stringify(obj);
}

export { parseToml, stringifyToml };
