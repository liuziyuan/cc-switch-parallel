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

**Pinning is persistent.** Highlight a Recent row and press `t` + `1`–`5` to pin it into that slot (or `t` on the provider screen); pinned rows show a `*` marker and keep their slot across launches until you press `u` to unpin. Entries are keyed by provider id: renaming a provider in cc-switch keeps its slot, history and count — Recent follows the new name automatically.

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
switch sync       # Detect & sync config drift (plugins, common config)
switch doctor     # Diagnose the environment (sqlite3, DB, binaries, …)
switch clean      # Remove instance directories (interactive, or --all)
switch update     # Self-update to the latest npm version
switch --help     # List all commands
```

## Config drift & sync

`switch` keeps a snapshot (`~/.cc-switch/sync-state.json`) of the config it last saw, and detects two kinds of drift on every launch:

- **Downward** — cc-switch's *common config* (`common_config_claude` / `common_config_codex`) changed in the desktop app. Staleness is tracked **per instance**: the warning names exactly which providers still run the old config. Confirming the sync (y) regenerates those instances' config files in place and refreshes their baselines, so the warning goes away; **already-running sessions** still need a restart to pick up the new config (that's what "restart to apply" in the prompt means). `switch clean` also drops a removed instance's baseline, so stale warnings stop naming deleted providers.
- **Upward** — a plugin/skill was installed, removed, or toggled inside a `switch`-launched Claude session (`/plugin`). `switch` warns you and can write the change back into cc-switch's `common_config_claude.enabledPlugins`. When multiple instances disagree, only instances whose plugin state was actually edited get a vote (a stale mirror of the old common config doesn't); among edited instances the most recent change wins.

In **TUI mode** drift is shown before the CLI selector and you can confirm the sync inline. In **command mode** it's a non-blocking warning on stderr — run `switch sync` to review and apply, pass `--sync` to confirm inline before launching, or `--no-sync` to suppress the warning entirely. The first run silently records a baseline, so existing plugins are never reported as "new".

## How it works

1. Reads provider configs from `~/.cc-switch/cc-switch.db` (SQLite, managed by cc-switch)
2. Replicates cc-switch's Rust backend logic: JSON/TOML deep merge of common config, sanitize, Codex model catalog generation
3. Creates a per-provider instance directory at `~/.cc-switch/instances/<app>/<provider-id>/`
4. Writes the isolated `settings.json` / `config.toml` / `auth.json` / `cc-switch-model-catalog.json`
5. Symlinks shared resources (plugins, skills, projects, credentials) from global `~/.claude/` — **zero data duplication**
6. Sets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` and `exec`s the CLI

### Instance directory layout

```
~/.cc-switch/instances/claude/<provider-id>/
  ├── settings.json           ← generated from DB (isolated per provider)
  ├── .credentials.json → ~/.claude/.credentials.json  (symlink, shared)
  ├── projects → ~/.claude/projects                      (symlink, shared)
  ├── plugins → ~/.claude/plugins                         (symlink, shared)
  └── ...other symlinks (skills, cache, commands, etc.)
```

Each instance is ~8KB — the heavy data (plugins, session history, credentials) is symlinked, not copied.

## Adding a new CLI

Each CLI is a small adapter (`APP_ADAPTERS` in `bin/cc-launch.mjs`). To add e.g. Gemini, add one object — `runTUI`, `launchProvider`, and `main` stay generic:

```js
const APP_ADAPTERS = {
  claude:  { appType, label, displayName, bin, envVar, commonConfigKey,
             setupInstance, prepare, launch, permissionArgs },
  codex:   { /* … */ },
  // gemini: { /* … */ },   ← add here
};
```

`setupInstance` creates the instance dir + symlinks, `prepare` generates the config files, `launch` spawns the CLI, `permissionArgs` maps the permission hotkey. Optional `detectPluginDrift` / `syncPluginsBack` (Claude only today) add per-CLI plugin sync; optional `readInstancePluginState` lets the per-instance drift baseline record that CLI's plugin state.

## Requirements

- [cc-switch](https://github.com/farion1231/cc-switch) desktop app with providers configured
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`) on PATH
- [Codex](https://github.com/openai/codex) CLI (`codex`) on PATH (optional, for Codex support)
- Node.js ≥ 18
- `sqlite3` CLI (pre-installed on macOS)

## License

MIT
