# cc-switch-parallel

> Launch Claude Code and Codex with per-provider isolated configs — run multiple providers in parallel terminals without switching.

[English](README.md) | [中文](README_ZH.md)

## What it does

If you use [cc-switch](https://github.com/farion1231/cc-switch) to manage multiple AI providers (e.g. Claude Official, Zhipu GLM, GitHub Copilot), you normally have to **switch** the active provider — which changes the global `~/.claude/settings.json` or `~/.codex/config.toml` for **all** terminals.

`switch` takes a different approach: each terminal gets its own isolated config directory via `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, so you can run **Claude Official in one terminal and Zhipu GLM in another simultaneously**.

## Install

```bash
npm install -g cc-switch-parallel
```

Or from source:

```bash
git clone https://github.com/liuziyuan/cc-switch-parallel.git
cd cc-switch-parallel
npm link
```

## Usage

### Interactive mode

```bash
switch
```

Shows a TUI — first select the CLI tool (claude / codex), then pick a provider, press Enter to launch.

**Recent (top 5):** the CLI screen lists your 5 most-used launches (`a s d f g` for one-key quick launch), ranked by use count with each row showing when it was last used (`· 2h`, `· 3d`, …). Command-mode launches (`switch "X" claude …`) count towards the ranking too, and a quick launch replays the recorded argv — if you launched with `--continue`, pressing the quick key launches with `--continue` again (rows carrying extra flags are marked `· +args`).

**Pinning is persistent.** Highlight a Recent row and press `t` + `1`–`5` to pin it into that slot (or `t` on the provider screen — pinning drops you straight into the launch-mode pick, so the next keypress launches); pinned rows show a `*` marker and keep their slot across launches until you press `u` to unpin. Entries are keyed by provider id: renaming a provider in cc-switch keeps its slot, history and count — Recent follows the new name automatically.

**Change the launch mode:** highlight a Recent row and press `e`, then pick `⏎` Default / `2` Semi-auto / `3` Full-auto to switch that entry's mode in place (non-permission flags like `--continue` are kept).

Providers deleted in cc-switch stay listed but flagged red (`✗ missing`) — launching them is blocked; Enter (or their quick key) instead offers to remove them from Recent (`y` to confirm). Dead rows rank last so they never crowd out live ones, and `c` removes every dead entry in one go. You can also drop any entry manually: highlight it and press `x`, then `y`.

A Full-auto quick-launch row (`⚠`) asks for confirmation before launching with `--dangerously-skip-permissions` — picking Full-auto on the provider screen doesn't, since that path already takes two deliberate keypresses.

### Command mode

```bash
switch [--sync|--no-sync] <provider> <cmd> [args...]
```

Examples:

```bash
switch "Claude Official" claude
switch "Zhipu GLM en" claude --continue
switch --sync "Claude Official" claude   # confirm config drift interactively before launching
switch --no-sync "P&G Nezha" codex       # launch silently, suppress the drift warning
```

### Other commands

```bash
switch ps         # List running switch-launched sessions
switch sync       # Detect & sync config drift (plugins, config fields, common config)
switch doctor     # Diagnose the environment (sqlite3, DB, binaries, instructions files, …)
switch clean      # Remove instance directories (interactive, or --all)
switch customize [claude|codex] <provider>          # Instance-only CLAUDE.md / AGENTS.md (opens editor)
switch uncustomize [claude|codex] <provider> [--yes] # Back to the shared global file
switch update     # Self-update to the latest npm version
switch --help     # List all commands
```

`switch ps` prints one row per session — concurrent terminals on the same provider each get their own row, never overwriting each other:

```
  claude  P&G Nezha      cc-switch-parallel  ~/workspace/personal/cc-switch-parallel  up 3m
  claude  P&G Nezha      RFP2                ~/workspace/company/daneng/RFP2         up 2d
```

The third column is the tmux session name (falls back to the terminal tty when not inside tmux); the fourth is the project directory where the session was started (`~`-abbreviated).

## Config drift & sync

**The mental model: config flows down on launch, and what you change inside a session should come back up.** `switch` generates each instance's config from cc-switch's database on every launch — edits made inside a session are the one exception, and the sync flow exists to capture them. The upward channel covers **every field** of a Claude instance's `settings.json` and of a Codex instance's `config.toml`: beyond plugin state, the generated statusLine, and Codex's `[tui] status_line` (all channel-owned, see below), env, permissions, hooks, models, approval policies etc. are detected, displayed, and written back per field. Changes are shown as dotted field paths, and on confirmation are written back with a **smart split**: fields that already exist in the common config go into `common_config_<app>` (otherwise the next launch would overwrite them with common's stale value), everything else goes into that provider's own config. For Codex the common side is a TOML document, so a confirmed common-direction write re-serializes it — comments and formatting in `common_config_codex` are lost (the prompt tells you before you confirm).

Even if you never sync, `switch` **backs up** an instance's main config file (`settings.json` / `config.toml`) to `~/.cc-switch/backups/<app>/<provider-id>/` (10 most recent kept) right before overwriting it, and warns on stderr which fields are about to be lost — edits never vanish silently. Upgrade note: this requires the per-instance baseline (`preparedSettings`); edits made before the upgrade can't be recognized and are only covered by the backup.

Codex credential files get the same treatment as Claude's: an OAuth/ChatGPT-login instance symlinks the **shared global** `~/.codex/auth.json` (the first launch seeds it from the DB), so token rotations the CLI performs mid-session survive every relaunch — a per-instance copy would be overwritten with the stale DB token and force a re-login. API-key instances keep an isolated real file. `settings.preserveCodexOfficialAuthOnSwitch` opts out and restores the legacy per-instance copy. Trade-off: providers with **different** ChatGPT accounts can no longer hold independent logins.

`switch` keeps a snapshot (`~/.cc-switch/sync-state.json`) of the config it last saw, and detects two kinds of drift on every launch:

- **Downward** — cc-switch's *common config* (`common_config_claude` / `common_config_codex`) changed in the desktop app. Staleness is tracked **per instance**: the warning names exactly which providers still run the old config. Confirming the sync (y) regenerates those instances' config files in place and refreshes their baselines, so the warning goes away; **already-running sessions** still need a restart to pick up the new config (that's what "restart to apply" in the prompt means). `switch clean` also drops a removed instance's baseline, so stale warnings stop naming deleted providers.
- **Upward** — edits made inside a `switch`-launched session, captured via two channels:
  - **Plugins** (Claude only — Codex has no plugin concept): installed, removed, or toggled (`/plugin`), written back into `common_config_claude.enabledPlugins`. When multiple instances disagree, only instances whose plugin state was actually edited get a vote (a stale mirror of the old common config doesn't); among edited instances the most recent change wins.
  - **Config fields**: non-plugin fields (env, permissions, hooks, models … for Claude; models, approval policies, MCP servers … for Codex) are shown as a leaf-level diff (arrays compare whole-block — element-level merging has no reliable primitive under RFC 7396) and written back with the smart split on confirmation. Arbitration mirrors the plugin channel: mirror instances get no vote; the winner per field is the most recently edited instance (mtime). Known limitation: a field that exists in the common config is always written to common — it would reach every common-config consumer even if you meant to change one provider, because that's the only write that survives the merge order. Exception: credential-style sensitive keys (`*_TOKEN` / `*_KEY` / `*SECRET*` …) are never written back into the common config — the edit stays in the instance, update it in the desktop app instead; deleting a sensitive key from the common config is still allowed. The Codex write-back goes through compare-and-swap on the stored TOML/JSON text, so a concurrent desktop-app edit can never be clobbered — worst case you're asked to re-run `switch sync`.

In **TUI mode** drift is shown before the CLI selector and you can confirm the sync inline. In **command mode** it's a non-blocking warning on stderr — run `switch sync` to review and apply, pass `--sync` to confirm inline before launching, or `--no-sync` to suppress the warning entirely. The first run silently records a baseline, so existing plugins are never reported as "new".

## Instance statusline (provider tag)

Every `switch`-launched Claude instance shows **which provider it runs** right in the status line: each generated `settings.json` carries a statusLine whose wrapper script prints a `[provider]` tag (stable per-provider color) in front of the model indicator — `[Zhipu GLM en][Opus] │ myproject` with claude-hud — and then relays **your own global statusLine unchanged**: claude-hud, ccstatusline, a hand-rolled script, anything configured in `~/.claude/settings.json`. The statusline JSON from Claude Code is passed through untouched, so the global tool keeps rendering exactly what it always does; the provider tag is the only thing `switch` adds (when a statusline doesn't lead with the model, or none is configured, the tag simply sits at the start of the line).

- **Your global `~/.claude/settings.json` is never touched, and the generated entry is never synced back into cc-switch's database** — `statusLine` is a channel-owned path (like plugins): the overwrite guard ignores it and the upward sync yields it. Swap your global statusline tool and every instance follows on its next launch.
- No global statusline? Instances simply show the provider tag.
- A `statusLine` set explicitly in cc-switch's provider or common config is **wrapped, not replaced**: the generated entry points at the wrapper and your explicit command is inlined as the wrapper's preferred relay source (the global `~/.claude/settings.json` is the fallback). Deliberate configuration keeps rendering — the provider tag is still added.
- **Tag color is set in the TUI**: highlight a provider on the provider screen and press `o` to pick from auto (hash by name, the default) and the 16 ANSI classic colors (30–37 standard, 90–97 bright, rendered as live swatches); ⏎ saves, esc cancels. Stored in `~/.cc-switch/statusline-preferences.json` (owned by this CLI alone — the cc-switch desktop app and the database never read or write it); takes effect on that provider's next launch, running sessions keep the old color until restarted.
- Customizing the statusline from **inside** an instance (`/statusline`) is pointless — the entry is regenerated on every launch. Edit the global file instead.

### Codex's status line

Codex CLI's status line is a **native built-in-item picker** (`[tui] status_line` in `config.toml`, Codex ≥ 0.105.0) with no external-command rendering — so Codex instances have no provider tag (this lands once upstream [openai/codex#17827](https://github.com/openai/codex/issues/17827) supports it). What `switch` guarantees is that the status line is ON with useful items: every launch injects `[tui] status_line = ["model-with-reasoning", "current-dir"]` and `status_line_use_colors = true` into the instance `config.toml`. **Only missing keys are filled** — explicit values in your provider/common TOML win (`status_line = []` opts out); the injected subtree is channel-owned like Claude's statusLine: ignored by the overwrite guard, yielded by the upward sync, never written back to the database. The model name usually distinguishes providers indirectly (each provider binds its own model), but same-model multi-account setups stay indistinguishable.

## How it works

1. Reads provider configs from `~/.cc-switch/cc-switch.db` (SQLite, managed by cc-switch)
2. Replicates cc-switch's Rust backend logic: JSON/TOML deep merge of common config, sanitize, Codex model catalog generation
3. Creates a per-provider instance directory at `~/.cc-switch/instances/<app>/<provider-id>/`
4. Writes the isolated `settings.json` / `config.toml` / `auth.json` / `cc-switch-model-catalog.json`
5. Symlinks shared resources (plugins, skills, projects, plans, credentials) from global `~/.claude/` — **zero data duplication**
6. Sets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` and `exec`s the CLI

### Instance directory layout

```
~/.cc-switch/instances/claude/<provider-id>/
  ├── settings.json           ← generated from DB (isolated per provider)
  ├── statusline-wrapper.mjs  ← generated statusline script (provider tag +
  │                              relay of your global statusline tool)
  ├── .credentials.json → ~/.claude/.credentials.json  (symlink, shared)
  ├── projects → ~/.claude/projects                      (symlink, shared)
  ├── plans → ~/.claude/plans                            (symlink, shared; existing
  │                              instance plans merged into the global dir on setup)
  ├── plugins → ~/.claude/plugins                         (symlink, shared)
  └── ...other symlinks (skills, cache, commands, etc.)

~/.cc-switch/instances/codex/<provider-id>/
  ├── config.toml             ← generated from DB (isolated per provider)
  ├── auth.json → ~/.codex/auth.json    (symlink for OAuth logins — one live,
  │                              token-rotation-safe copy; real per-instance
  │                              file for API-key providers)
  ├── AGENTS.md → ~/.codex/AGENTS.md    (symlink, shared — customize swaps it
  │                              for an editable per-instance file)
  └── ...other symlinks (skills, rules, caches, etc.)
```

Claude Code writes plans to `$CLAUDE_CONFIG_DIR/plans/`. That directory is device-shared: when an instance is set up (launch or config refresh), cc-switch first merges any plans already in the instance into `~/.claude/plans` (identical name+content is deduplicated; same-name different content is kept as `<name>.<provider-id>.md` — never overwritten), then replaces the instance's `plans` with a symlink. Other instances migrate the same way on their next setup; no full scan is performed.

Each instance is ~8KB — the heavy data (plugins, session history, credentials) is symlinked, not copied.

## Adding a new CLI

Each CLI is a small adapter (`APP_ADAPTERS` in `src/adapters.ts`). To add e.g. Gemini, add one object — `runTUI`, `launchProvider`, and `main` stay generic:

```js
const APP_ADAPTERS = {
  claude:  { appType, label, displayName, bin, envVar, commonConfigKey,
             setupInstance, prepare, launch, permissionArgs },
  codex:   { /* … */ },
  // gemini: { /* … */ },   ← add here
};
```

`setupInstance` creates the instance dir + symlinks, `prepare` generates the config files, `launch` spawns the CLI, `permissionArgs` maps the permission hotkey. Everything else is **capability-driven**: the overwrite guard, the sync flows, backups, and customize never branch on `appType` — an adapter opts in per layer by declaring the interface:

- `instanceSettingsFileName` / `readInstanceSettingsSnapshot` / `computeEffectiveSettings` — per-instance baseline + overwrite guard (backup, warning, self-healing backfill)
- `parseCommonSnippet` / `providerDocFromSettingsConfig` / `channelOwnedPath` / `detectSettingsDrift` / `syncSettingsBack` — the config-field upward channel; `detectSettingsDrift` is one line delegating to the shared `detectConfigDriftGeneric` pipeline (leaf diff, mtime arbitration, smart split), only the write-back differs per storage format (JSON `json_patch` for Claude; compare-and-swap TOML re-serialization for Codex)
- `detectPluginDrift` / `syncPluginsBack` / `readInstancePluginState` — plugin channel (Claude only; Codex has no plugin concept)
- `instructions` — customize/uncustomize support (CLAUDE.md via a live `@import`; AGENTS.md via a refreshable marked snapshot, since Codex has no import mechanism)
- `fullAutoFlag` — the flag shown verbatim in the TUI's full-auto confirmation

An adapter without an interface is simply "v2-shaped" for that layer and skips it — adding Gemini means filling in the rows you want, not touching the guard/sync machinery.

## Requirements

- [cc-switch](https://github.com/farion1231/cc-switch) desktop app with providers configured
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`) on PATH
- [Codex](https://github.com/openai/codex) CLI (`codex`) on PATH (optional, for Codex support)
- Node.js ≥ 18
- `sqlite3` CLI (pre-installed on macOS)

## License

MIT
