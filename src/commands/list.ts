// ─── commands/list ────────────────────────────────────────────────────

import { APP_ADAPTERS } from "../adapters.js";
import { queryProviderRowsByApp } from "../db.js";
import { isPlainObject, parseJsonObject } from "../json-utils.js";
import { providerIsAggregation, readStackState } from "../stack/state.js";
import { parseToml } from "../toml.js";
import { displayWidth, padDisplay, sanitizeText } from "../terminal-utils.js";
import type { ProviderRow } from "../types.js";

// ─── switch list ──────────────────────────────────────────────────────

type ListMember = { id: string; name: string | null };

type ListProviderRow = {
  app: string;
  id: string;
  name: string;
  kind: "provider" | "stack";
  aggregation: boolean;
  virtual: boolean;
  current: boolean;
  members: ListMember[] | null;
  available: boolean;
  issues: string[];
  nameAmbiguous: boolean;
};

type ListArgs = { json: boolean; apps: string[] } | { error: string };

function parseListArgs(args: string[]): ListArgs {
  let json = false;
  const apps: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--app") {
      const v = args[++i];
      if (!v) return { error: "missing --app value" };
      apps.push(v);
      continue;
    }
    if (a.startsWith("--app=")) {
      const v = a.slice("--app=".length);
      if (!v) return { error: "missing --app value" };
      apps.push(v);
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  const known = Object.keys(APP_ADAPTERS);
  const unique: string[] = [];
  for (const app of apps) {
    if (!known.includes(app))
      return { error: `unknown app "${app}". Supported: ${known.join(", ")}` };
    if (!unique.includes(app)) unique.push(app);
  }
  return { json, apps: unique.length ? unique : known };
}

// "Available" means the row's own config can be launched without repair —
// not that the CLI binary is installed (that is doctor's job). A malformed
// settings_config is the one condition prepare cannot recover from.
function settingsIssues(appType: string, row: ProviderRow): string[] {
  const parsed = parseJsonObject(row.settings_config);
  if (!isPlainObject(parsed)) return ["settings_config is not a JSON object"];
  const issues: string[] = [];
  if (appType === "codex" && typeof parsed.config === "string" && parsed.config.trim()) {
    try {
      parseToml(parsed.config);
    } catch {
      issues.push("config TOML is unparseable");
    }
  }
  return issues;
}

function listProviders(apps: string[]): ListProviderRow[] {
  const out: ListProviderRow[] = [];
  for (const app of apps) {
    const rows = queryProviderRowsByApp(app, true);
    let stack: any = null;
    try {
      stack = readStackState(app);
    } catch {}
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    const nameCounts = new Map<string, number>();
    for (const r of rows) nameCounts.set(r.name, (nameCounts.get(r.name) || 0) + 1);
    for (const r of rows) {
      const virtual = !!r.is_virtual;
      const parsed = parseJsonObject(r.settings_config);
      const aggregation = virtual || (isPlainObject(parsed) && providerIsAggregation(app, parsed));
      const issues = settingsIssues(app, r);
      let members: ListMember[] | null = null;
      if (aggregation) {
        const ids = Array.isArray(stack?.members) ? stack.members : [];
        members = ids.map((id: string) => ({ id, name: nameById.get(id) ?? null }));
      }
      out.push({
        app,
        id: sanitizeText(r.id),
        name: sanitizeText(r.name),
        kind: virtual ? "stack" : "provider",
        aggregation,
        virtual,
        current: !!r.is_current,
        members,
        available: issues.length === 0,
        issues: issues.map((i) => sanitizeText(i)),
        nameAmbiguous: (nameCounts.get(r.name) || 0) > 1,
      });
    }
  }
  return out;
}

function renderListTable(rows: ListProviderRow[]): void {
  if (!rows.length) {
    console.log("No providers found.");
    return;
  }
  const headers = {
    app: "APP",
    name: "NAME",
    id: "ID",
    kind: "KIND",
    current: "CURRENT",
    members: "MEMBERS",
    status: "STATUS",
  };
  const cells = rows.map((r) => ({
    app: r.app,
    name: r.nameAmbiguous ? `${r.name} (ambiguous)` : r.name,
    id: r.id,
    kind: r.kind,
    current: r.current ? "*" : "-",
    members: r.members && r.members.length ? r.members.map((m) => m.name ?? m.id).join(" + ") : "-",
    status: r.available ? "ok" : `invalid: ${r.issues.join("; ")}`,
  }));
  const all = [headers, ...cells];
  const width = (key: string) => Math.max(...all.map((c: any) => displayWidth(c[key])), 1);
  const wApp = width("app");
  const wName = width("name");
  const wId = width("id");
  const wKind = width("kind");
  const wCurrent = width("current");
  const wMembers = width("members");
  console.log("");
  for (const c of all) {
    console.log(
      `  ${padDisplay(c.app, wApp)}  ${padDisplay(c.name, wName)}  ${padDisplay(c.id, wId)}  ` +
        `${padDisplay(c.kind, wKind)}  ${padDisplay(c.current, wCurrent)}  ` +
        `${padDisplay(c.members, wMembers)}  ${c.status}`,
    );
  }
  console.log("");
}

function renderListJson(rows: ListProviderRow[]): string {
  return JSON.stringify({ version: 1, providers: rows }, null, 2);
}

function runList(args: string[]): void {
  const parsed = parseListArgs(args);
  if ("error" in parsed) {
    console.error(`✗ ${parsed.error}`);
    console.error("Usage: switch list [--json] [--app claude|codex]");
    process.exit(1);
  }
  let rows: ListProviderRow[];
  try {
    rows = listProviders(parsed.apps);
  } catch (e: any) {
    console.error(`✗ Failed to read providers: ${e?.message || e}`);
    process.exit(1);
  }
  if (parsed.json) console.log(renderListJson(rows));
  else renderListTable(rows);
}

export { listProviders, parseListArgs, renderListJson, renderListTable, runList };
