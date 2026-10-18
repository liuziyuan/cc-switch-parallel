// ─── toml (split from bin/cc-launch.mjs) ─────────────────────────────

import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { SCRIPT_DIR } from "./paths.mjs";

// ─── smol-toml loader ─────────────────────────────────────────────────

let _tomlModule = null;

function getToml() {
  if (_tomlModule) return _tomlModule;
  // Try resolving from this package's node_modules
  const candidates = [
    join(SCRIPT_DIR, "..", "node_modules", "smol-toml"),
    join(SCRIPT_DIR, "..", "..", "node_modules", "smol-toml"),
  ];
  for (const p of candidates) {
    try {
      const mod = require(p);
      if (mod.parse && mod.stringify) {
        _tomlModule = mod;
        return mod;
      }
    } catch {}
  }
  try {
    const mod = require("smol-toml");
    if (mod.parse && mod.stringify) {
      _tomlModule = mod;
      return mod;
    }
  } catch {}
  throw new Error(
    "Failed to load smol-toml module. Please run npm install smol-toml.",
  );
}

function parseToml(text) {
  return getToml().parse(text);
}

function stringifyToml(obj) {
  return getToml().stringify(obj);
}


export { _tomlModule, getToml, parseToml, stringifyToml };
