# cc-switch-parallel

> Launch Claude Code and Codex with per-provider isolated configs — run multiple providers in parallel terminals without switching.

## What it does

If you use [cc-switch](https://github.com/farion1231/cc-switch) to manage multiple AI providers (e.g. Claude Official, Zhipu GLM, GitHub Copilot), you normally have to **switch** the active provider — which changes the global `~/.claude/settings.json` or `~/.codex/config.toml` for **all** terminals.

`ccp` takes a different approach: each terminal gets its own isolated config directory via `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, so you can run **Claude Official in one terminal and Zhipu GLM in another simultaneously**.

## Install

```bash
npm install -g cc-switch-parallel
```

Or from source:

```bash
git clone https://github.com/liu-zy/cc-switch-parallel.git
cd cc-switch-parallel
npm link
```

## Usage

### Interactive mode

```bash
ccp
```

Shows a TUI — first select the CLI tool (claude / codex), then pick a provider, press Enter to launch.

### Command mode

```bash
ccp <provider> <cmd> [args...]
```

Examples:

```bash
ccp "Claude Official" claude
ccp "Zhipu GLM en" claude --continue
ccp "P&G Nezha" codex
ccp "GitHub Copilot" codex
```

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

## Requirements

- [cc-switch](https://github.com/farion1231/cc-switch) desktop app with providers configured
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`) on PATH
- [Codex](https://github.com/openai/codex) CLI (`codex`) on PATH (optional, for Codex support)
- Node.js ≥ 18
- `sqlite3` CLI (pre-installed on macOS)

## License

MIT
