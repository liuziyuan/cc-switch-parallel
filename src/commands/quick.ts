// ─── commands/quick (`switch a|s|d|f|g`) ───────────────────────────────

import { APP_ADAPTERS } from "../adapters.js";
import { confirmSync } from "../drift.js";
import { QUICK_KEYS, loadHistory, permLabel, quickItemsFor, snapshotAliveByCli } from "../history.js";
import { launchProvider } from "../launch.js";
import { launchRefForQuick } from "../tui.js";

// `switch s` is the command-line twin of pressing `s` in the picker: long-time
// users know their slots and shouldn't have to open the TUI first. Only the
// bare single token qualifies — `switch s claude` stays the provider-name
// path, so a provider literally named "s" keeps working.
function isQuickLaunchKey(token: unknown) {
  return typeof token === "string" && QUICK_KEYS.includes(token);
}

// Same alive snapshot + pin merge the TUI uses, so a slot resolves to the same
// provider, argv and mode whether it was reached by a keypress or by typing
// the key. Rows with a provider id launch by id (rename-safe); stored names
// only display.
function resolveQuickItem(key: string) {
  const aliveByCli = snapshotAliveByCli();
  const { entries, order } = loadHistory();
  return quickItemsFor(entries, order, aliveByCli).find((q) => q.key === key) ?? null;
}

async function runQuickLaunch(key: string, syncFlag: string | null) {
  const item = resolveQuickItem(key);
  if (!item) {
    console.error(`✗ Recent slot "${key}" is empty — run \`switch\` to launch something first (Recent fills as you use it).`);
    process.exit(1);
  }
  if (item.dead) {
    console.error(`✗ Recent slot "${key}" points to "${item.provider}", which no longer exists in cc-switch.`);
    console.error(`  Open \`switch\` and press c to clean dead entries.`);
    process.exit(1);
  }
  // Same rule as the TUI quick keys: a Full-auto row replays a
  // --dangerously-skip-permissions argv, so it never launches without an
  // explicit yes. Non-TTY callers can't confirm and are told the explicit path.
  // The dangerous flag is per-CLI (Codex spells it differently).
  const dangerFlag = APP_ADAPTERS[item.cli]?.permissionArgs?.("3").join(" ") ?? "--dangerously-skip-permissions";
  if (item.hotkey === "3") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(`✗ Recent slot "${key}" is Full-auto (${item.provider}) — no terminal to confirm in.`);
      console.error(`  Launch it explicitly instead: switch "${item.provider}" ${item.cli} ${dangerFlag}`);
      process.exit(1);
    }
    const outcome = await confirmSync(
      [`Recent slot ${key}: ${item.provider} · ${item.cli} · ${permLabel(item.hotkey)}`],
      `Launch "${item.provider}" with ${dangerFlag}?`,
    );
    if (outcome !== "yes") {
      console.error(outcome === "interrupt" ? "Aborted." : "Cancelled — nothing launched.");
      process.exit(outcome === "interrupt" ? 130 : 1);
    }
  }
  // Replay exactly what the TUI would: the recorded argv, falling back to the
  // bare permission flags for entries recorded before extraArgs existed.
  const args = item.extraArgs.length > 0
    ? item.extraArgs
    : APP_ADAPTERS[item.cli]?.permissionArgs?.(item.hotkey) ?? [];
  console.error(`→ ${item.label}`);
  await launchProvider(item.cli, launchRefForQuick(item), args, syncFlag, { hotkey: item.hotkey });
}

export { isQuickLaunchKey, resolveQuickItem, runQuickLaunch };
