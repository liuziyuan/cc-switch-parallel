// ─── commands/dry-run ─────────────────────────────────────────────────
// Derive what a launch WOULD write and run, without any of the write side
// effects: no sync pass, no legacy-stack cleanup, no instance setup, no
// overwrite backup, no prepare, no baseline/history recording, no spawn.

import { join } from "node:path";
import { APP_ADAPTERS } from "../adapters.js";
import { loadSettings, queryProvidersByApp } from "../db.js";
import { diffSettingsLeaves, jsonNormalize, parseJsonObject } from "../json-utils.js";
import { INSTANCES_DIR } from "../paths.js";
import { formatAmbiguousProvider, formatAvailableProviders, resolveProviderRef, type ProviderRef } from "../provider-ref.js";
import { redactArgv, redactAtPath, redactSecrets } from "../redact.js";
import { buildLaunchExtraEnv } from "../sessions.js";
import { readSharedConfig } from "../shared-config.js";
import { aggregationBaseUrlFor, probeTcpReachable } from "../stack/state.js";
import { stringifyToml } from "../toml.js";
import type { SettingsChange } from "../types.js";

type DryRunOptions = { diff?: boolean; showSecrets?: boolean };

type DryRunPlan = {
  app: string;
  id: string;
  name: string;
  instanceDir: string;
  envVar: string;
  bin: string;
  extraArgs: string[];
  env: Record<string, string>;
  effective: any;
  configText: string;
  configFileName: string;
  current: any | null;
  changes: SettingsChange[] | null;
  warnings: string[];
};

async function buildDryRunPlan(
  cmd: string,
  ref: ProviderRef,
  extraArgs: string[],
  opts: DryRunOptions,
): Promise<DryRunPlan | { error: string }> {
  const adapter = APP_ADAPTERS[cmd];
  if (!adapter) {
    return { error: `Unsupported command: ${cmd}. Supported: ${Object.keys(APP_ADAPTERS).join(", ")}` };
  }
  const resolved = resolveProviderRef(ref, adapter.appType);
  if (!resolved.ok) {
    if (resolved.error === "ambiguous") {
      return { error: formatAmbiguousProvider(ref?.name || "", adapter.appType, resolved.matches, cmd) };
    }
    const label = ref?.id ? `id "${ref.id}"` : `"${ref?.name || ""}"`;
    return { error: `Provider ${label} not found (${adapter.appType})` };
  }
  const row = resolved.row;
  const warnings: string[] = [];
  const parsedSettingsConfig = parseJsonObject(row.settings_config);
  const parsedMeta = parseJsonObject(row.meta);
  if (!parsedSettingsConfig) {
    warnings.push(`Provider "${row.name}" has malformed settings_config JSON — an empty config is shown.`);
  }
  if (!parsedMeta) {
    warnings.push(`Provider "${row.name}" has malformed meta JSON — empty meta is shown.`);
  }
  const settingsConfig = parsedSettingsConfig ?? {};
  const meta = parsedMeta ?? {};
  const shared = readSharedConfig(adapter.appType);
  const settings = loadSettings();
  const instanceDir = join(INSTANCES_DIR, adapter.appType, row.id);
  const effective = adapter.computeEffectiveSettings(
    settingsConfig, meta, row.category, shared, row.id, settings, { writeWrapper: false },
  );
  if (!effective) return { error: `Could not derive an effective config for "${row.name}".` };

  const configFileName = adapter.instanceSettingsFileName;
  const configText = configFileName === "config.toml"
    ? stringifyToml(effective)
    : JSON.stringify(effective, null, 2);

  const aggBaseUrl = aggregationBaseUrlFor(adapter.appType, settingsConfig);
  if (aggBaseUrl && !(await probeTcpReachable(aggBaseUrl))) {
    warnings.push(`aggregation proxy ${aggBaseUrl} is unreachable — open the cc-switch desktop app with aggregation on.`);
  }

  let current: any | null = null;
  let changes: SettingsChange[] | null = null;
  if (opts.diff) {
    current = adapter.readInstanceSettingsSnapshot(instanceDir);
    if (current !== null) {
      changes = diffSettingsLeaves(jsonNormalize(current), jsonNormalize(effective));
    }
  }

  return {
    app: adapter.appType,
    id: row.id,
    name: row.name,
    instanceDir,
    envVar: adapter.envVar,
    bin: adapter.bin,
    extraArgs,
    env: { [adapter.envVar]: instanceDir, ...buildLaunchExtraEnv(row.name, row.id) },
    effective,
    configText,
    configFileName,
    current,
    changes,
    warnings,
  };
}

function showValue(value: unknown): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

function renderDryRunPlan(plan: DryRunPlan, opts: DryRunOptions): string {
  const lines: string[] = [
    "Dry run — no files written, no process launched.",
    "",
    `Provider:  ${plan.name} (${plan.app}, id: ${plan.id})`,
    `Instance:  ${plan.instanceDir}`,
  ];
  const argv = redactArgv(plan.extraArgs, opts);
  lines.push(`Command:   ${plan.envVar}=${plan.instanceDir} ${plan.bin}${argv.map((a) => ` ${a}`).join("")}`);
  lines.push("Env:");
  for (const [key, value] of Object.entries(plan.env)) lines.push(`  ${key}=${value}`);

  lines.push("");
  lines.push(opts.showSecrets
    ? `Effective ${plan.configFileName}:`
    : `Effective ${plan.configFileName} (redacted; use --show-secrets to reveal):`);
  const redacted = redactSecrets(plan.effective, opts);
  lines.push(plan.configFileName === "config.toml"
    ? stringifyToml(redacted).trimEnd()
    : JSON.stringify(redacted, null, 2));

  if (opts.diff) {
    lines.push("");
    lines.push("Diff vs current instance file:");
    if (plan.current === null) {
      lines.push("  (no instance config yet — the first launch will create it)");
    } else if (!plan.changes || !plan.changes.length) {
      lines.push("  (no differences)");
    } else {
      for (const c of plan.changes) {
        const segments = c.segments ?? c.path.split(".");
        const from = redactAtPath(c.from, segments, opts);
        const to = redactAtPath(c.to, segments, opts);
        if (c.op === "add") lines.push(`  + ${c.path} = ${showValue(to)}`);
        else if (c.op === "remove") lines.push(`  - ${c.path} = ${showValue(from)}`);
        else lines.push(`  ~ ${c.path}: ${showValue(from)} -> ${showValue(to)}`);
      }
    }
  }

  if (plan.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of plan.warnings) lines.push(`  ⚠ ${w}`);
  }
  return lines.join("\n");
}

async function runDryRun(
  cmd: string,
  ref: ProviderRef,
  extraArgs: string[],
  opts: DryRunOptions,
): Promise<void> {
  const plan = await buildDryRunPlan(cmd, ref, extraArgs, opts);
  if ("error" in plan) {
    console.error(`✗ ${plan.error}`);
    const adapter = APP_ADAPTERS[cmd];
    if (adapter && plan.error.startsWith("Provider ")) {
      try {
        console.error(formatAvailableProviders(queryProvidersByApp(adapter.appType)));
      } catch {}
    }
    process.exit(1);
  }
  console.log(renderDryRunPlan(plan, opts));
}


export { buildDryRunPlan, renderDryRunPlan, runDryRun };
