// ─── stack/state (split from bin/cc-launch.mjs) ─────────────────────────────

import { join } from "node:path";
import net from "node:net";
import { queryDB, queryProviderById, sqlQuote } from "../db.js";
import type { ProviderRow } from "../types.js";
import { VIRTUAL_STACK_PROVIDER_ID } from "../paths.js";
export { cleanupLegacyStackRows, reportLegacyStackCleanup } from "./legacy-cleanup.js";
import {
  AGGREGATION_IDENTITY_ENV_KEYS,
  AGGREGATION_MODEL_ALIAS_KEYS,
  aggregationBaseUrlFor,
  isAggregationProviderSettings,
  isCodexAggregationProviderSettings,
  isLoopbackBaseUrl,
  protectAggregationIdentityEnv,
  providerIsAggregation,
} from "./aggregation.js";
import { readStackState } from "./live-state.js";
export { readGlobalModelPicker, readStackState } from "./live-state.js";
import { appendVirtualStackRowCore, virtualStackProviderForCore } from "./virtual-row.js";
export {
  STACK_SETTINGS_DERIVERS,
  buildCodexStackSettingsFromGlobal,
  buildStackSettingsFromGlobal,
  codexStackDormantSettings,
} from "./virtual-row.js";
import { buildUsageQueryConfig, resolveUsageIdentity } from "./usage.js";

// ─── cc-switch 4.0 aggregation (Stack) ────────────────────────────────
// Upstream cc-switch 4.0 "aggregation" runs a local HTTP proxy (default
// 127.0.0.1:15721) that publishes member providers' models into one Claude
// Code /model picker under `ccs-claude-<key>--<model>` ids. This CLI never
// enters/exits the mode (that is a desktop-app action) — it only CONSUMES its
// state so a proxy-endpoint provider behaves like any other parallel member:
//
//   • a provider whose env.ANTHROPIC_BASE_URL points at a loopback address is
//     treated as an aggregation instance: its wrapper gets a per-key usage map
//     (each member queried with its OWN credentials, direct to the member's
//     real origin — the proxy never sees usage traffic), the current key is
//     decoded at runtime from the statusline model id, and the instance
//     settings.json picks up the desktop app's `modelPicker` block (the /model
//     list lives in settings.json, NOT in /v1/models discovery).
//   • live-state.json is device-local upstream state with no stability
//     promise: every read here is fail-open (missing/corrupt/off → the
//     aggregation features silently vanish, the single-provider path runs).
//   • the TUI shows loopback providers under an aggregation label with the
//     live member names, and can auto-create the entry row when the desktop
//     app has aggregation on but no loopback provider exists yet.

// Loopback host = the aggregation proxy endpoint (a plain provider never
// points at one; a user's own local gateway would simply not match a live
// stack and fall through to the regular single-provider path).
//
// Moved to stack/aggregation.ts so usage.ts can reuse it without importing
// this module. Re-exported below to keep the public surface stable.

// `model` on a codex AGGREGATION instance is carried across prepare
// (mergeCodexRuntimeState's isAgg branch) and has no DB row to sync into
// (virtual entry, or a hand-managed proxy row) — the edit would only ever
// surface as a blocked sync prompt, and the carry means prepare does NOT
// overwrite it. Yield the path like runtime state in the guard and the drift
// diff. Plain codex rows are unaffected: their /model pick still flows
// through guard + sync write-back (established semantics).
function isCodexAggModelPath(appType: any, providerId: any, path: any) {
  if (appType !== "codex" || path !== "model") return false;
  if (providerId === VIRTUAL_STACK_PROVIDER_ID) return true;
  try {
    const row = queryProviderById(providerId, "codex");
    return !!row && isCodexAggregationProviderSettings(JSON.parse(row.settings_config || "{}"));
  } catch {
    return false;
  }
}

// 300ms TCP probe of a base URL's host:port. Warn-only by design — the
// aggregation proxy lives and dies with the desktop app (README: "re-open
// the desktop app"), so an unreachable proxy must gate nothing, just say so.
async function probeTcpReachable(baseUrl: string, timeoutMs = 300): Promise<boolean> {
  try {
    const u = new URL(baseUrl);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (!u.hostname || !Number.isFinite(port)) return false;
    return await new Promise((resolve) => {
      const socket = net.connect({ host: u.hostname, port });
      const done = (ok: any) => {
        socket.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        done(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        done(false);
      });
    });
  } catch {
    return false;
  }
}

// Derive the virtual aggregation row with the DB names injected. The file-only
// halves live in stack/live-state and stack/virtual-row, so db.ts can use them
// without importing this module (breaks the db → state cycle).
function takenProviderNames(appType: any) {
  try {
    return queryDB(`SELECT name FROM providers WHERE app_type = ${sqlQuote(appType)}`).map(
      (r) => r.name,
    );
  } catch {
    return [];
  }
}

function virtualStackProviderFor(appType: any) {
  return virtualStackProviderForCore(appType, takenProviderNames(appType));
}

function appendVirtualStackRow(rows: any, appType: any) {
  return appendVirtualStackRowCore(rows, appType, takenProviderNames(appType));
}

// Per-member usage config map for an aggregation instance. A member's KEY in
// stack.keys is its identity: the ccs model id decodes to that key and the tag
// follows it even when no usage identity is resolvable. Members without a
// resolvable identity stay in `names` (rendered as a placeholder) but are
// absent from `map` (no usage cell, never an error).
function buildStackUsageConfig(stack: any, instanceDir: any, wrapperPath: any) {
  const keys = Object.entries(stack.keys) as [string, string][];
  const map: Record<string, any> = {};
  const names: Record<string, any> = {};
  if (!keys.length) return null;
  // One read for all members. The old per-member loop queried them one by one,
  // so a transient write lock could drop the FIRST member while later ones
  // succeeded — the exact "known member silently loses its usage" failure.
  // all-or-nothing keeps attribution and usage config consistent.
  const ids = [...new Set(keys.map(([, providerId]) => providerId))];
  const rows = new Map<string, ProviderRow>();
  try {
    const quoted = ids.map((id) => sqlQuote(id)).join(", ");
    const list = queryDB(
      `SELECT id, name, settings_config, meta FROM providers ` +
        `WHERE app_type = ${sqlQuote("claude")} AND id IN (${quoted})`,
    ) as ProviderRow[];
    for (const row of list) rows.set(row.id, row);
  } catch {
    // A failed read degrades every member to a placeholder — never to another
    // member's quota.
  }
  for (const [key, providerId] of keys) {
    const row = rows.get(providerId) ?? null;
    names[key] = row?.name || key;
    let sc: any = null;
    let meta: any = null;
    try {
      sc = row ? JSON.parse(row.settings_config) : null;
    } catch {
      sc = null;
    }
    try {
      meta = row ? JSON.parse(row.meta) : null;
    } catch {
      meta = null;
    }
    const cfg = buildUsageQueryConfig(
      resolveUsageIdentity(sc, meta),
      join(instanceDir, `usage-stack-${key}.json`),
      wrapperPath,
    );
    if (!cfg) continue;
    map[key] = cfg;
  }
  let defaultKey: string | null = null;
  if (stack.proxyRoute) {
    // Attribution is by member identity, not by usage availability: the
    // default member may legitimately have no usage config (placeholder).
    defaultKey = Object.keys(stack.keys).find((k) => stack.keys[k] === stack.proxyRoute) || null;
  }
  return { defaultKey, names, map, selfPath: wrapperPath };
}

// TUI helper: the aggregation group for an app's provider list. The entry is
// the RUNTIME-VIRTUAL row (virtualStackProviderFor) — never written to the DB,
// so the desktop GUI sees nothing — plus any DB rows matching the loopback +
// PROXY_MANAGED signature (legacy auto-created rows pending one-time cleanup,
// and hand-made ones, which today already take the aggregation label). Every
// loopback provider is labeled with the live member names — "◆ Aggregation ·
// Stack (DeepSeek + Z.AI GLM)", or "(inactive)" when the desktop app has the
// stack off (the entry still launches; it just proxies nothing until
// re-enabled). Returns { ids: Set, labels: Map<id, label> }, or null when no
// aggregation provider exists at all.
function buildAggregationGroup(appType: any) {
  const rows = queryDB(
    `SELECT id, name, settings_config FROM providers WHERE app_type = ${sqlQuote(appType)}`,
  );
  const aggRows: any[] = [];
  for (const r of rows) {
    try {
      if (providerIsAggregation(appType, JSON.parse(r.settings_config))) aggRows.push(r);
    } catch {}
  }
  const virtual = virtualStackProviderFor(appType);
  if (virtual && !aggRows.some((r) => r.id === virtual.id)) aggRows.push(virtual);
  if (!aggRows.length) return null;
  const stack = readStackState(appType);
  const nameById = new Map(rows.map((r) => [r.id, r.name]));
  const memberIds = stack ? [...new Set(stack.members)] : [];
  const members = memberIds.map((id) => nameById.get(id)).filter(Boolean);
  // A member whose provider row is gone renders as a silent short-list
  // today — say so, or the missing usage segment reads as a bug.
  const missingCount = memberIds.length - members.length;
  const missingText = stack && missingCount > 0 ? `, ${missingCount} member(s) missing` : "";
  const memberText = members.length
    ? ` (${members.join(" + ")}${missingText})`
    : stack
      ? missingCount > 0
        ? ` (${missingCount} member(s) missing)`
        : ""
      : " (inactive)";
  return {
    ids: new Set(aggRows.map((r) => r.id)),
    labels: new Map(aggRows.map((r) => [r.id, `◆ Aggregation · ${r.name}${memberText}`])),
  };
}

export {
  AGGREGATION_IDENTITY_ENV_KEYS,
  AGGREGATION_MODEL_ALIAS_KEYS,
  aggregationBaseUrlFor,
  appendVirtualStackRow,
  buildAggregationGroup,
  buildStackUsageConfig,
  isAggregationProviderSettings,
  isCodexAggModelPath,
  isCodexAggregationProviderSettings,
  isLoopbackBaseUrl,
  probeTcpReachable,
  protectAggregationIdentityEnv,
  providerIsAggregation,
  virtualStackProviderFor,
};
