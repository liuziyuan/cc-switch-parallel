// ─── tui (split from bin/cc-launch.mjs) ─────────────────────────────

import { join, resolve } from "node:path";
import { APP_ADAPTERS } from "./adapters.js";
import { buildRunningSet } from "./commands/ps.js";
import { queryProvidersByApp } from "./db.js";
import { detectAndPromptSync } from "./drift.js";
import {
  QUICK_KEYS,
  insertManualOrder,
  loadHistory,
  permLabel,
  quickItemsFor,
  removeAllDeadPairs,
  removeHistoryPair,
  setEntryHotkey,
  snapshotAliveByCli,
  unpinPair,
} from "./history.js";
import { launchProvider } from "./launch.js";
import { VIRTUAL_STACK_APPS } from "./paths.js";
import {
  buildAggregationGroup,
  cleanupLegacyStackRows,
  reportLegacyStackCleanup,
} from "./stack/state.js";
import { clipFrame, fitLine, installTerminalGuard, sanitizeText } from "./terminal-utils.js";
import {
  STATUSLINE_COLOR_CHOICES,
  STATUSLINE_DISPLAY_ITEMS,
  detectStatuslineRelay,
  loadStatuslineDisplay,
  saveStatuslineColor,
  saveStatuslineDisplay,
  statuslineColorFor,
} from "./statusline-colors.js";

// ─── TUI interactive mode ──────────────────────────────────────────────

// hotkeys: [{key,label}] | undefined  (key matches a raw keypress)
// interactive: when true (provider layer), Enter drills into param region
//              instead of resolving; esc goes back. When false (CLI layer),
//              number keys jump straight to resolve.
// quickItems: [{key,label,cli,providerId,provider,hotkey,extraArgs,pairKey,
//               dead,pinned}] | undefined  (top5 quick-launch; pressing the
//               key resolves a {quick:true,...} object. dead: provider no
//               longer exists in cc-switch → selectable but not launchable;
//               Enter/key on it opens the remove confirm. pinned: row holds a
//               manual top5 slot → `*` marker + `u` unpin.)
// pinContext + onPin (provider layer): `t` pins the highlighted option into
//               the Recent top5 slots. onPin(item, pos) with item =
//               {cli, providerId, provider}; returns the effective slot 1-5,
//               or null on failure.
// colorContext + onColor + getCurrentColor (provider layer): `o` opens the
//               tag-color picker for the highlighted provider. onColor(item,
//               value) persists the choice (returns non-null on success);
//               getCurrentColor(item) returns the stored value ("auto" default)
//               so the cursor and the ● mark land on the current choice.
// statuslineContext + onStatusline + getStatuslineDisplay + getStatuslineRelay
//               (provider layer): `s` opens the display-settings panel.
//               onStatusline(key, value) persists one boolean switch; the
//               display getter returns the normalized preferences; the relay
//               getter reports whether a global statusLine already owns the
//               model/project/git/context rows (then only the usage switch
//               applies). Settings are global (not per provider).
// quickPin + onPin/onUnpin/onRemove/onCleanup (CLI layer): `t`/`u`/`x`/`c` on
//               the Recent region. quickPin is deliberately separate from
//               pinContext so a CLI-layer `t` can never capture a plain CLI
//               option (e.g. "claude") as a pin target.
// onEditParam (CLI layer): `e` on a live Recent row re-enters the param region
//               in edit context — ⏎/2/3 then calls onEditParam(q, hotkey)
//               (q = the quick item; hotkey undefined = Default). Returns
//               non-null on success, null on failure (notice shows the error).
// onRefreshQuickItems(): rebuild quickItems after any history mutation so the
//               shown order/dead/pinned state matches disk. Newly surfaced
//               natural-filler rows need their dead flag from the caller's
//               alive snapshot — tuiSelect itself has no DB access.
function readDisplayPath(obj, path) {
  let cur = obj;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Rows for the `s` statusline panel. Pure (no terminal access) so the layout
// and the claude-hud annotation are unit-testable; `width` is the usable
// column count after the panel's 4-column outer padding.
function buildStatuslinePanelLines({
  display,
  relayKind = "none",
  context = null,
  cursor = 0,
  width = 76,
}) {
  const lines: string[] = [];
  const text = (s) => fitLine(sanitizeText(s), Math.max(1, width - 2));
  const row = (s, style) => {
    const body = `  ${text(s)}`;
    if (style === "highlight") return `\x1b[1m\x1b[33m${body}\x1b[0m`;
    if (style === "warning") return `\x1b[33m${body}\x1b[0m`;
    if (style === "dim") return `\x1b[90m${body}\x1b[0m`;
    if (style === "cursor") return `\x1b[36m${body}\x1b[0m`;
    return body;
  };

  // The relay owns the model/project/git/context rows; say so loudly, then
  // annotate each locked switch with who actually supplies it.
  if (relayKind === "claude-hud") {
    lines.push(
      row(
        "⚡ claude-hud is active — model / project / git / context are rendered by claude-hud",
        "highlight",
      ),
    );
  } else if (relayKind === "other") {
    lines.push(row("⚡ A custom statusLine is active — new items are not stacked", "highlight"));
  } else {
    lines.push(row("Self-drawn statusline — all switches apply (effective immediately)", "dim"));
  }
  if (context === "codex") {
    lines.push(
      row(
        "Codex has no external statusline yet — these switches apply to Claude instances only",
        "warning",
      ),
    );
  }
  lines.push("");
  if (relayKind !== "none") {
    lines.push(
      row(
        relayKind === "claude-hud"
          ? "Locked rows are supplied by claude-hud; turn it off to use the built-in renderer"
          : "Locked rows are supplied by the custom statusLine; remove it to use the built-in renderer",
        "dim",
      ),
    );
  }

  const sourceLabel =
    relayKind === "claude-hud" ? "claude-hud" : relayKind === "other" ? "statusLine" : null;
  const relayLocked = relayKind !== "none";
  for (let i = 0; i < STATUSLINE_DISPLAY_ITEMS.length; i++) {
    const item = STATUSLINE_DISPLAY_ITEMS[i];
    const enabled = !!readDisplayPath(display, item.key);
    const locked = relayLocked && item.key !== "display.showUsage";
    const value = enabled ? "on" : "off";
    const suffix = locked ? ` · via ${sourceLabel}` : "";
    const label = `${i === cursor ? "❯" : " "} ${enabled ? "●" : "○"} ${item.label}  ${value}${suffix}`;
    lines.push(row(label, i === cursor ? "cursor" : locked ? "dim" : "normal"));
  }

  lines.push("");
  lines.push(row("↑↓ navigate   space/⏎ toggle   esc back", "dim"));
  return lines;
}

function tuiSelect(prompt: string, options: any[], optsArg?: any): Promise<any> {
  // Backward-compat: accept a bare hotkeys array as 3rd arg.
  const opts = Array.isArray(optsArg) ? { hotkeys: optsArg } : optsArg || {};
  const hotkeys = opts.hotkeys || [];
  const interactive = !!opts.interactive;
  let quickItems = opts.quickItems || []; // mutable: refreshed after mutations
  const canRemove = typeof opts.onRemove === "function";
  const canCleanup = typeof opts.onCleanup === "function";
  const canUnpin = typeof opts.onUnpin === "function";
  const canEditParam = typeof opts.onEditParam === "function"; // CLI layer `e`
  const pinOptions = !!opts.pinContext && typeof opts.onPin === "function"; // provider layer
  const pinQuick = !!opts.quickPin && typeof opts.onPin === "function"; // CLI layer
  const canColor = typeof opts.onColor === "function" && typeof opts.getCurrentColor === "function"; // provider layer `o`
  const canStatusline =
    typeof opts.onStatusline === "function" && typeof opts.getStatuslineDisplay === "function"; // provider layer `s`
  const refreshQuick =
    typeof opts.onRefreshQuickItems === "function" ? opts.onRefreshQuickItems : null;

  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(
        new Error(
          "TUI mode requires an interactive terminal. Use command mode: switch <provider> <cmd>",
        ),
      );
      return;
    }

    let selected = 0;
    let mode = "select"; // "select" | "param" | "pin" | "confirm" | "color"
    let lastDrawnLines = 0;
    let lastNotice: any = null;
    let cleaned = false;
    let guard: { dispose: () => void } | null = null;
    let pinTarget: any = null; // {cli, providerId, provider, label} captured entering pin mode
    let confirmAction: any = null; // {kind:"remove"|"cleanup"|"launch", target} in confirm mode
    let paramEdit: any = null; // {q} Recent row being mode-edited — param mode, edit context
    let colorTarget: any = null; // {cli, providerId, provider, label} captured entering color mode
    let colorIndex = 0; // STATUSLINE_COLOR_CHOICES cursor
    let colorCurrentValue = "auto"; // stored preference when color mode was entered — renders the ● mark
    let statuslineIndex = 0; // STATUSLINE_DISPLAY_ITEMS cursor
    let statuslineDisplay: any = null; // normalized display preferences while the panel is open
    let statuslineRelay: any = null; // detectStatuslineRelay() result while the panel is open

    const hasHint = hotkeys.length > 0;

    const navTotal = () => options.length + quickItems.length;
    // After any quickItems mutation (refresh/cleanup): an out-of-range
    // selected index would crash the Enter path (`q.dead` on undefined) with
    // raw mode still on — the terminal would hang.
    function clampSelected() {
      if (selected >= navTotal()) selected = Math.max(0, navTotal() - 1);
    }
    function refreshQuickItems() {
      if (!refreshQuick) return;
      quickItems = refreshQuick() || [];
      clampSelected();
    }

    // ANSI redraw counts LINES — a soft-wrapped row would leave ghosts on
    // every repaint. Keep generated text within the terminal width (CJK
    // counted double, matching most terminal renderers).
    function fit(str, pad) {
      const cols = (process.stdout.columns || 80) - pad;
      // sanitizeText strips user-provided ANSI/control characters; fitLine
      // truncates by display width (CJK/emoji) instead of code units.
      return fitLine(sanitizeText(str), Math.max(1, cols));
    }

    // Lines for a given mode (without trailing newline). notice renders one
    // extra dim row below the hints — passed per-render, so it disappears on
    // the next state change without any cleanup bookkeeping.
    function buildLines(m, notice) {
      const lines: string[] = [];
      lines.push(`\x1b[1m\x1b[36m◆ ${fit(prompt, 4)}\x1b[0m`);
      lines.push("");
      const locked =
        m === "param" || m === "pin" || m === "confirm" || m === "color" || m === "statusline";
      // unified navigation space: [0..options.length-1] = options,
      // [options.length..options.length+quickItems.length-1] = quickItems
      for (let i = 0; i < options.length; i++) {
        const num = String(i + 1);
        if (locked) {
          const mark = i === selected ? "▸" : " ";
          lines.push(`\x1b[90m${mark} ${num} ${fit(options[i].label, 8)}\x1b[0m`);
        } else if (i === selected) {
          lines.push(`\x1b[36m❯ ${num} ${fit(options[i].label, 8)}\x1b[0m`);
        } else {
          lines.push(`\x1b[90m  ${num} ${fit(options[i].label, 8)}\x1b[0m`);
        }
      }
      if (m === "param") {
        lines.push("");
        const head = paramEdit
          ? `Edit "${paramEdit.q.provider}" · ${permLabel(paramEdit.q.hotkey)} → pick new mode`
          : hotkeys.map((h) => `${h.key} ${h.label}`).join("   ");
        lines.push(`  \x1b[1m\x1b[36m${fit(head, 4)}\x1b[0m`);
        if (paramEdit) {
          lines.push(
            `  \x1b[1m\x1b[36m${fit(hotkeys.map((h) => `${h.key} ${h.label}`).join("   "), 4)}\x1b[0m`,
          );
        }
        lines.push(`  \x1b[90mesc ← back\x1b[0m`);
      } else if (m === "pin") {
        lines.push("");
        lines.push(
          `  \x1b[1m\x1b[36m${fit(`Pin "${pinTarget.label}" into Recent top5 · press 1-5   esc cancel`, 4)}\x1b[0m`,
        );
      } else if (m === "color") {
        // Single-column list of 17 choices with true-color-free ANSI swatches
        // (██ renders in the terminal's own palette) — same ↑↓/jk semantics
        // as the select list, so no arrow-key relearning.
        lines.push("");
        lines.push(
          `  \x1b[1m\x1b[36m${fit(`Tag color for "${colorTarget.label}" · ⏎ apply   esc cancel`, 4)}\x1b[0m`,
        );
        for (let i = 0; i < STATUSLINE_COLOR_CHOICES.length; i++) {
          const c = STATUSLINE_COLOR_CHOICES[i];
          const swatch = `${c.swatch}██\x1b[0m`;
          const cur = c.value === colorCurrentValue ? " \x1b[32m● current\x1b[0m" : "";
          lines.push(
            i === colorIndex
              ? `\x1b[36m❯ ${swatch} ${c.label}${cur}\x1b[0m`
              : `\x1b[90m  ${swatch} ${c.label}${cur}\x1b[0m`,
          );
        }
      } else if (m === "statusline") {
        lines.push(
          ...buildStatuslinePanelLines({
            display: statuslineDisplay,
            relayKind: statuslineRelay?.kind || "none",
            context: opts.statuslineContext,
            cursor: statuslineIndex,
            width: (process.stdout.columns || 80) - 4,
          }),
        );
      } else if (m === "confirm") {
        lines.push("");
        const { kind, target } = confirmAction;
        // Provider names are user-controlled text; strip control/ANSI before
        // they reach the terminal (the surrounding styling is ours).
        const provider = sanitizeText(target.provider);
        let head;
        if (kind === "launch") {
          // One keypress away from the adapter's full-auto flag — the only
          // confirm in the TUI that guards a launch rather than a deletion.
          const flag = APP_ADAPTERS[target.cli]?.fullAutoFlag ?? "--dangerously-skip-permissions";
          head = `\x1b[33m⚠ "${provider}" would launch Full-auto (${flag})\x1b[0m — launch?`;
        } else if (kind === "cleanup") {
          head = `Remove ${target.count} dead ${target.count === 1 ? "entry" : "entries"} from Recent?`;
        } else if (target.dead) {
          head = `\x1b[31m✗ "${provider}" no longer exists in cc-switch\x1b[0m — remove from Recent?`;
        } else {
          head = `Remove "${provider}" from Recent?`;
        }
        lines.push(
          `  ${head}   \x1b[1m\x1b[36my confirm\x1b[0m\x1b[90m · any other key cancel\x1b[0m`,
        );
      } else if (interactive) {
        lines.push("");
        const pinHint = pinOptions ? `   t pin top5` : "";
        const colorHint = canColor ? `   o tag color` : "";
        const statuslineHint = canStatusline ? `   s statusline` : "";
        lines.push(
          `  \x1b[90m${fit(`↑↓ navigate   ⏎ confirm${pinHint}${colorHint}${statuslineHint}   esc ← back to CLI`, 4)}\x1b[0m`,
        );
      } else {
        // CLI layer select mode: optionally show top5 quick-launch region
        if (quickItems.length > 0) {
          lines.push("");
          lines.push(`  \x1b[90mRecent (top 5):\x1b[0m`);
          for (let i = 0; i < quickItems.length; i++) {
            const q = quickItems[i];
            const isSel = selected === options.length + i;
            // Provider deleted in cc-switch: keep the row (history + pin may
            // still be wanted) but flag it red and make it non-launchable.
            // A pinned row keeps its manual slot — marked `*` so a persistent
            // pin never reads as "the ranking is broken".
            const flag = q.dead
              ? `\x1b[31m ✗ missing\x1b[0m`
              : q.running
                ? `\x1b[32m ● live\x1b[0m`
                : "";
            const pin = q.pinned ? "*" : " ";
            const text = fit(`${q.key} ${pin}${q.label}`, 6);
            if (locked) {
              const mark = isSel ? "▸" : " ";
              lines.push(`  \x1b[90m${mark} ${text}\x1b[0m${flag}`);
            } else if (isSel) {
              lines.push(`\x1b[36m❯ ${text}\x1b[0m${flag}`);
            } else {
              lines.push(
                `  \x1b[36m${text.slice(0, 1)}\x1b[0m \x1b[90m${text.slice(2)}\x1b[0m${flag}`,
              );
            }
          }
        }
        lines.push("");
        // Context-sensitive hints: only the keys that apply where the cursor
        // is, and short enough that the full key list (with t/u/x/c active)
        // still fits an 80-col terminal without soft-wrapping.
        const parts = ["↑↓ nav"];
        if (quickItems.length === 0 || selected < options.length) {
          parts.push(`⏎/1-${options.length} sel`);
        }
        if (quickItems.length > 0)
          parts.push(`${QUICK_KEYS[0]}-${QUICK_KEYS[quickItems.length - 1]} quick`);
        if (quickItems.length > 0 && selected >= options.length) {
          if (pinQuick) parts.push("t pin");
          if (canUnpin && quickItems[selected - options.length]?.pinned) parts.push("u unpin");
          if (canEditParam && !quickItems[selected - options.length]?.dead) parts.push("e edit");
          if (canRemove) parts.push("x rm");
        }
        const deadCount = quickItems.filter((q) => q.dead).length;
        if (canCleanup && deadCount > 0) parts.push("c clean");
        parts.push("esc exit");
        lines.push(`  \x1b[90m${fit(parts.join("   "), 4)}\x1b[0m`);
      }
      if (notice) {
        lines.push("");
        lines.push(`  \x1b[32m${fit(notice, 4)}\x1b[0m`);
      }
      return lines;
    }

    function render(m: any, notice: any = null) {
      lastNotice = notice;
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      // Clip to the terminal height (keeping the last/notice row) and cap
      // each line by display width, so no row soft-wraps and throws off the
      // line count used for the next repaint.
      const lines = clipFrame(buildLines(m, notice), rows).map((line) => fitLine(line, cols));
      if (lastDrawnLines > 0) {
        process.stdout.write(`\x1b[${lastDrawnLines}A\x1b[J`);
      }
      process.stdout.write(lines.join("\n") + "\n");
      lastDrawnLines = lines.length;
    }

    render(mode);

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onResize = () => {
      try {
        // A resize invalidates the old frame geometry entirely: clear, reset
        // the line counter, and repaint instead of moving up by stale lines.
        process.stdout.write("\x1b[2J\x1b[H");
        lastDrawnLines = 0;
        render(mode, lastNotice);
      } catch {}
    };
    process.stdout.on("resize", onResize);

    const onInputClosed = () => {
      cleanup();
      reject(new Error("Input closed"));
    };
    process.stdin.on("end", onInputClosed);
    process.stdin.on("close", onInputClosed);
    process.stdin.on("error", onInputClosed);

    guard = installTerminalGuard({ cleanup });

    function handleData(data) {
      const key = data.toString();
      if (key === "\x03") {
        cleanup();
        reject(new Error("Cancelled"));
        return;
      }

      if (mode === "param") {
        // Param region: hotkey or Enter resolves with hotkey; esc goes back.
        // Two contexts share the region: launching a highlighted option (the
        // resolve path) and `e` mode-editing a Recent row (the paramEdit path —
        // writes history, refreshes the row, stays in the TUI).
        if (key === "\x1b") {
          mode = "select";
          paramEdit = null;
          render(mode);
          return;
        }
        const hit = hotkeys.find((h) => h.key === key);
        if (hit || key === "\r" || key === "\n") {
          const hk = hit ? hit.key : undefined; // ⏎ = Default
          if (paramEdit) {
            const { q } = paramEdit;
            paramEdit = null;
            mode = "select";
            const ok = opts.onEditParam(q, hk) !== null;
            if (ok) refreshQuickItems();
            render(
              mode,
              ok
                ? `✓ "${q.provider}" → ${permLabel(hk)}${hk === "3" ? " — will confirm before launch" : ""}`
                : `✗ Edit failed (history write error)`,
            );
            return;
          }
          cleanup();
          resolve({ ...options[selected], hotkey: hk });
          return;
        }
        return; // ignore arrows/other keys in param mode
      }

      if (mode === "pin") {
        // Pin region: pick a slot 1-5, esc cancels. Never launches.
        if (key === "\x1b") {
          mode = "select";
          render(mode);
          return;
        }
        const n = parseInt(key, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= 5) {
          const slot = opts.onPin(pinTarget, n);
          // Provider layer: a pin used to strand the user back on the select
          // list with no way to pick a launch mode — esc from there discards
          // the selection entirely. Drop straight into the param region
          // instead: the very next keypress (⏎/2/3) launches the pinned pair.
          if (slot && interactive && hasHint) {
            mode = "param";
            render(mode, `✓ Pinned "${pinTarget.label}" to Recent #${slot} — pick launch mode`);
            return;
          }
          mode = "select";
          // CLI layer stays put after pinning — refresh so the new order is
          // visible immediately; the provider layer re-enters via esc anyway.
          if (slot && !interactive) refreshQuickItems();
          render(
            mode,
            slot
              ? interactive
                ? `✓ Pinned "${pinTarget.label}" to Recent #${slot} — esc back to CLI to see it`
                : `✓ Pinned "${pinTarget.label}" to Recent #${slot}`
              : `✗ Pin failed (history write error)`,
          );
          return;
        }
        return; // ignore Enter/arrows/everything else while pinning
      }

      if (mode === "color") {
        // Color region: navigate the 17 choices, ⏎ saves the preference, esc
        // cancels. Never launches; every other key is ignored (same stance
        // as pinning) so stray input can't mutate state.
        if (key === "\x1b[A" || key === "k") {
          colorIndex =
            (colorIndex - 1 + STATUSLINE_COLOR_CHOICES.length) % STATUSLINE_COLOR_CHOICES.length;
          render(mode);
          return;
        }
        if (key === "\x1b[B" || key === "j") {
          colorIndex = (colorIndex + 1) % STATUSLINE_COLOR_CHOICES.length;
          render(mode);
          return;
        }
        if (key === "\r" || key === "\n") {
          const choice = STATUSLINE_COLOR_CHOICES[colorIndex];
          mode = "select";
          const ok = opts.onColor(colorTarget, choice.value) !== null;
          render(
            mode,
            ok
              ? `✓ Tag color for "${colorTarget.label}" → ${choice.label} — next launch`
              : `✗ Failed to save color preference`,
          );
          return;
        }
        if (key === "\x1b") {
          mode = "select";
          render(mode);
          return;
        }
        return; // ignore everything else while choosing a color
      }

      if (mode === "statusline") {
        // Display panel: arrows move, space/⏎ toggles and saves immediately,
        // esc returns. Rows owned by a relay are locked (dimmed) but still
        // navigable, so the user can read what is and is not in effect.
        if (key === "\x1b[A" || key === "k") {
          statuslineIndex =
            (statuslineIndex - 1 + STATUSLINE_DISPLAY_ITEMS.length) %
            STATUSLINE_DISPLAY_ITEMS.length;
          render(mode);
          return;
        }
        if (key === "\x1b[B" || key === "j") {
          statuslineIndex = (statuslineIndex + 1) % STATUSLINE_DISPLAY_ITEMS.length;
          render(mode);
          return;
        }
        if (key === "\x1b") {
          mode = "select";
          render(mode);
          return;
        }
        if (key === " " || key === "\r" || key === "\n") {
          const item = STATUSLINE_DISPLAY_ITEMS[statuslineIndex];
          const relayLocked = (statuslineRelay?.kind || "none") !== "none";
          if (relayLocked && item.key !== "display.showUsage") return;
          const current = !!readDisplayPath(statuslineDisplay, item.key);
          const ok = opts.onStatusline(item.key, !current) !== null;
          if (ok) statuslineDisplay = opts.getStatuslineDisplay();
          render(
            mode,
            ok
              ? `✓ ${item.label} → ${current ? "off" : "on"} — effective now`
              : "✗ Failed to save statusline preference",
          );
          return;
        }
        return; // ignore everything else while in the display panel
      }

      if (mode === "confirm") {
        // Confirm region: y executes the pending action, any other key —
        // esc, n, arrows — cancels back to select untouched.
        if (key === "y" || key === "Y") {
          const { kind, target } = confirmAction;
          confirmAction = null;
          mode = "select";
          if (kind === "launch") {
            cleanup();
            resolve({
              quick: true,
              cli: target.cli,
              provider: target.provider,
              hotkey: target.hotkey,
              extraArgs: target.extraArgs,
            });
            return;
          }
          if (kind === "cleanup") {
            const removed = opts.onCleanup();
            if (removed > 0) refreshQuickItems();
            render(
              mode,
              removed >= 0
                ? `✓ Removed ${removed} dead ${removed === 1 ? "entry" : "entries"} from Recent`
                : `✗ Cleanup failed (history write error)`,
            );
            return;
          }
          const ok = opts.onRemove(target.pairKey) !== null;
          if (ok) refreshQuickItems();
          render(
            mode,
            ok
              ? `✓ Removed "${target.provider}" from Recent`
              : `✗ Remove failed (history write error)`,
          );
          return;
        }
        confirmAction = null;
        mode = "select";
        render(mode);
        return;
      }

      // select mode
      // esc (bare \x1b) — must check AFTER arrow sequences below in practice,
      // but arrow keys arrive as full \x1b[A / \x1b[B which don't equal bare \x1b.
      // Unified navigation space: options + quickItems (CLI layer only).
      if (key === "\x1b[A" || key === "k") {
        selected = (selected - 1 + navTotal()) % navTotal();
        render(mode);
        return;
      }
      if (key === "\x1b[B" || key === "j") {
        selected = (selected + 1) % navTotal();
        render(mode);
        return;
      }
      // Resolve a quick item: dead rows offer cleanup, Full-auto rows ask for
      // explicit confirmation (one keypress = --dangerously-skip-permissions),
      // everything else launches immediately. Dead wins over the Full-auto
      // confirm — that launch is guaranteed to fail anyway.
      const tryQuick = (q) => {
        selected = options.length + Math.max(0, quickItems.indexOf(q));
        if (q.dead) {
          confirmAction = { kind: "remove", target: q };
          mode = "confirm";
          render(mode);
          return;
        }
        if (q.hotkey === "3") {
          confirmAction = { kind: "launch", target: q };
          mode = "confirm";
          render(mode);
          return;
        }
        cleanup();
        resolve({
          quick: true,
          cli: q.cli,
          provider: q.provider,
          hotkey: q.hotkey,
          extraArgs: q.extraArgs,
        });
      };
      if (key === "\r" || key === "\n") {
        // If selection is on a quick item, resolve it as quick-launch —
        // unless the provider is gone, then offer cleanup instead.
        if (!interactive && quickItems.length > 0 && selected >= options.length) {
          tryQuick(quickItems[selected - options.length]);
          return;
        }
        if (interactive && hasHint) {
          mode = "param";
          render(mode);
          return;
        }
        cleanup();
        resolve(options[selected]);
        return;
      }
      // quick-launch key (top5, CLI layer only)
      const qHit = quickItems.find((q) => q.key === key);
      if (qHit) {
        tryQuick(qHit);
        return;
      }
      // `x`: remove the highlighted quick item from Recent (confirm follows)
      if (canRemove && key === "x" && quickItems.length > 0 && selected >= options.length) {
        confirmAction = { kind: "remove", target: quickItems[selected - options.length] };
        mode = "confirm";
        render(mode);
        return;
      }
      // `e`: edit the highlighted Recent row's launch mode (param region
      // follows). Dead rows are silently ignored — they can't launch, so a
      // mode is meaningless there.
      if (canEditParam && key === "e" && quickItems.length > 0 && selected >= options.length) {
        const q = quickItems[selected - options.length];
        if (!q.dead) {
          paramEdit = { q };
          mode = "param";
          render(mode);
        }
        return;
      }
      // `u`: unpin the highlighted Recent row (idempotent; entry stays)
      if (canUnpin && key === "u" && quickItems.length > 0 && selected >= options.length) {
        const q = quickItems[selected - options.length];
        const ok = opts.onUnpin(q.pairKey) !== null;
        if (ok) refreshQuickItems();
        render(
          mode,
          ok
            ? `✓ Unpinned "${q.provider}" — back to natural ranking`
            : `✗ Unpin failed (history write error)`,
        );
        return;
      }
      // `c`: bulk-remove every dead entry from Recent (confirm follows)
      if (canCleanup && key === "c") {
        const deadCount = quickItems.filter((q) => q.dead).length;
        if (deadCount > 0) {
          confirmAction = { kind: "cleanup", target: { count: deadCount } };
          mode = "confirm";
          render(mode);
          return;
        }
      }
      // `s` opens the global statusline display panel (provider layer only).
      // Settings are global (one set for every provider); the highlighted row
      // only supplies the Codex notice.
      if (interactive && canStatusline && key === "s" && selected < options.length) {
        statuslineDisplay = opts.getStatuslineDisplay();
        statuslineRelay =
          typeof opts.getStatuslineRelay === "function"
            ? opts.getStatuslineRelay()
            : { kind: "none", command: null };
        statuslineIndex = 0;
        mode = "statusline";
        render(mode);
        return;
      }
      // `o` colors the highlighted provider's statusline tag (provider layer
      // only). colorTarget mirrors pinTarget's structured shape; the cursor
      // lands on the stored choice so re-entering shows where you are.
      if (interactive && canColor && key === "o" && selected < options.length) {
        colorTarget = {
          cli: opts.colorContext,
          providerId: options[selected].value,
          provider: options[selected].label,
          label: options[selected].label,
        };
        colorCurrentValue = opts.getCurrentColor(colorTarget);
        const at = STATUSLINE_COLOR_CHOICES.findIndex((c) => c.value === colorCurrentValue);
        colorIndex = at >= 0 ? at : 0;
        mode = "color";
        render(mode);
        return;
      }
      // `t` pins into the Recent top5 slots. Two distinct layers, deliberately
      // gated separately: provider layer captures the highlighted provider;
      // CLI layer captures the highlighted Recent row. pinTarget is always a
      // structured {cli, providerId, provider} — never the display label.
      if (interactive && pinOptions && key === "t" && selected < options.length) {
        pinTarget = {
          cli: opts.pinContext,
          providerId: options[selected].value,
          provider: options[selected].label,
          label: options[selected].label,
        };
        mode = "pin";
        render(mode);
        return;
      }
      if (pinQuick && key === "t" && quickItems.length > 0 && selected >= options.length) {
        const q = quickItems[selected - options.length];
        pinTarget = {
          cli: q.cli,
          providerId: q.providerId,
          provider: q.provider,
          label: q.provider,
        };
        mode = "pin";
        render(mode);
        return;
      }
      // number key
      const n = parseInt(key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
        selected = n - 1;
        if (interactive) {
          render(mode); // just highlight, wait for Enter
          return;
        }
        // CLI layer: number jumps straight to resolve
        cleanup();
        resolve(options[selected]);
        return;
      }
      if (key === "\x1b") {
        // bare esc in select mode
        cleanup();
        if (interactive) {
          // provider layer: go back to CLI selection
          reject(new Error("BACK_TO_CLI"));
        } else {
          // CLI layer: exit
          reject(new Error("Cancelled"));
        }
        return;
      }
    }

    const onData = (data) => {
      // A throw inside any callback (history write, custom handler, DB read)
      // used to escape the EventEmitter with raw mode still on.
      try {
        handleData(data);
      } catch (e: any) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        process.stdin.setRawMode(false);
      } catch {}
      try {
        process.stdin.removeListener("data", onData);
      } catch {}
      try {
        process.stdin.removeListener("end", onInputClosed);
      } catch {}
      try {
        process.stdin.removeListener("close", onInputClosed);
      } catch {}
      try {
        process.stdin.removeListener("error", onInputClosed);
      } catch {}
      try {
        process.stdout.removeListener("resize", onResize);
      } catch {}
      // pause() is required, not just removeListener: stdin is still in
      // flowing mode from the resume() at entry, and a flowing stream with no
      // data listeners keeps READING tty bytes (discarding them) — the spawned
      // CLI would lose keystrokes. Masked for years by spawnSync freezing the
      // event loop; surfaced when launch switched to async spawn.
      try {
        process.stdin.pause();
      } catch {}
      if (lastDrawnLines > 0) {
        try {
          process.stdout.write(`\x1b[${lastDrawnLines}A\x1b[J`);
        } catch {}
      }
      try {
        guard?.dispose();
      } catch {}
    }

    process.stdin.on("data", onData);
  });
}

// Quick-launch rows carry everything a replay needs: the pair identity
// (providerId when known, name as fallback/display), the last permission
// mode, and the full original argv (extraArgs) so `--continue`-style flags
// survive into the next quick launch.
// Launch refs: prefer the provider id so the launched row is exactly the
// selected one even when several providers share a name. Legacy quick items
// without a providerId fall back to the name (and can surface ambiguity).
function launchRefForQuick(q: any) {
  return q?.providerId ? { id: q.providerId, name: q.provider } : { name: q?.provider };
}
function launchRefForRow(row: any) {
  return row?.id ? { id: row.id, name: row.name } : { name: row?.name };
}

async function runTUI() {
  const sync = await detectAndPromptSync({ tui: true });
  if (sync.interrupted) {
    const err: any = new Error("Interrupted");
    err.exitCode = 130;
    throw err;
  }
  if (sync.inputClosed) {
    const err: any = new Error("Input closed before confirmation");
    err.exitCode = 1;
    throw err;
  }
  if (sync.needsTTY) throw new Error("TUI mode requires an interactive terminal.");
  // One-time migration of pre-virtualization aggregation rows (idempotent).
  reportLegacyStackCleanup(cleanupLegacyStackRows());

  const cliOptions = Object.entries(APP_ADAPTERS).map(([value, adapter]) => ({
    label: adapter.label,
    value,
  }));

  // CLI layer + provider layer loop: esc on provider goes back to CLI selection.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // One alive snapshot per loop iteration feeds both dead-flagging and
    // display names, so a cc-switch rename surfaces without touching history.
    // Fail-open: on DB error everything reads alive (launch fails loudly later).
    const aliveByCli = snapshotAliveByCli();
    const runningSet = buildRunningSet();
    const buildQuickItems = () => {
      const { entries, order } = loadHistory();
      // Shared projection with command mode's `switch a|s|d|f|g` — only the
      // ● live marker is TUI-specific.
      return quickItemsFor(entries, order, aliveByCli).map((q) => ({
        ...q,
        running: runningSet.has(q.providerId),
      }));
    };

    const cli = await tuiSelect("Select CLI tool", cliOptions, {
      quickItems: buildQuickItems(),
      quickPin: true,
      // hotkeys power the `e` mode-edit param region (CLI-layer Enter never
      // enters it: interactive=false), keyed off the same ⏎/2/3 hotkeys the
      // provider layer uses.
      hotkeys: [
        { key: "⏎", label: "Default" },
        { key: "2", label: "Semi-auto" },
        { key: "3", label: "Full-auto ⚠" },
      ],
      onPin: (item, pos) => insertManualOrder(item, pos, aliveByCli),
      onUnpin: (key) => unpinPair(key, aliveByCli),
      onEditParam: (q, hotkey) => setEntryHotkey(q.pairKey, hotkey, q.cli, aliveByCli),
      onRemove: (key) => removeHistoryPair(key, aliveByCli),
      onCleanup: () => removeAllDeadPairs(aliveByCli),
      onRefreshQuickItems: buildQuickItems,
    });

    // Quick-launch path: letter key bypasses provider + permission selection
    // and replays the recorded argv (falling back to the bare permission flags
    // for pre-extraArgs entries).
    if (cli.quick) {
      const args =
        cli.extraArgs.length > 0 ? cli.extraArgs : APP_ADAPTERS[cli.cli].permissionArgs(cli.hotkey);
      await launchProvider(cli.cli, launchRefForQuick(cli), args, null, { hotkey: cli.hotkey });
      return;
    }

    const adapter = APP_ADAPTERS[cli.value];
    if (!adapter) throw new Error(`Unsupported CLI: ${cli.value}`);

    const providers = queryProvidersByApp(adapter.appType);
    if (providers.length === 0) {
      console.error(
        `✗ No provider config found for ${adapter.appType}. Please configure one in cc-switch first.`,
      );
      process.exit(1);
    }
    let providerOptions = providers.map((p) => ({ label: p.name, value: p.id }));
    // cc-switch 4.0 aggregation: the virtual entry (and any DB rows matching
    // the loopback signature) sink to the tail of the list under a labeled
    // group showing the live member names — launch, recent, pin and colors
    // behave exactly like any other provider.
    if (VIRTUAL_STACK_APPS.has(adapter.appType)) {
      const group = buildAggregationGroup(adapter.appType);
      if (group) {
        const plain = providers.filter((p) => !group.ids.has(p.id));
        const aggs = providers.filter((p) => group.ids.has(p.id));
        providerOptions = [
          ...plain.map((p) => ({ label: p.name, value: p.id })),
          ...aggs.map((p) => ({ label: group.labels.get(p.id) || p.name, value: p.id })),
        ];
      }
    }
    let selected;
    try {
      selected = await tuiSelect(`Select provider (${adapter.displayName})`, providerOptions, {
        hotkeys: [
          { key: "⏎", label: "Default" },
          { key: "2", label: "Semi-auto" },
          { key: "3", label: "Full-auto ⚠" },
        ],
        interactive: true,
        pinContext: cli.value,
        onPin: (item, pos) => insertManualOrder(item, pos, aliveByCli),
        // `o` tag color — both CLIs. claude's color is consumed by the
        // wrapper at prepare time; codex's native status_line has no custom
        // text/color slot (upstream #17827), so the codex color is consumed
        // by the tmuxclihook status bar's provider segment instead (same
        // statusline-preferences.json, per-CLI buckets).
        colorContext: cli.value,
        onColor: (target, value) => saveStatuslineColor(cli.value, target.providerId, value),
        getCurrentColor: (target) => statuslineColorFor(cli.value, target.providerId),
        // `s` display settings are global; statuslineContext only drives the
        // Codex notice (Codex has no external statusline command yet).
        statuslineContext: cli.value,
        onStatusline: (key, value) => saveStatuslineDisplay(key, value),
        getStatuslineDisplay: () => loadStatuslineDisplay(),
        getStatuslineRelay: () => detectStatuslineRelay(),
      });
    } catch (e: any) {
      if (e.message === "BACK_TO_CLI") continue; // esc on provider → back to CLI
      throw e; // Ctrl+C → propagate to main()
    }
    const provider = providers.find((p) => p.id === selected.value);
    await launchProvider(
      cli.value,
      launchRefForRow(provider),
      adapter.permissionArgs(selected.hotkey),
      null,
      { hotkey: selected.hotkey },
    );
    return;
  }
}

export { buildStatuslinePanelLines, launchRefForQuick, launchRefForRow, runTUI, tuiSelect };
