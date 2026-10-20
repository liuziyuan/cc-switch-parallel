# cc-switch-parallel

> A companion launcher for [cc-switch](https://github.com/farion1231/cc-switch) — launch Claude Code and Codex with per-provider isolated configs in parallel terminals, no switching required.

[English](README.md) | [中文](README_ZH.md)

> **cc-switch 4.0+'s aggregation mode (Stack) is supported.** Once aggregation is enabled in the desktop app, the TUI list gains a runtime virtual `Stack` entry — a single instance can use models from several providers in `/model`, running side by side with plain provider instances on the same machine. See [Aggregation mode](#aggregation-mode-cc-switch-40).

> **Prerequisite: [cc-switch](https://github.com/farion1231/cc-switch) must already be installed and configured.** `switch` is not a provider manager of its own — it reads the providers you have set up in cc-switch's database and adds **parallel launching** for Claude Code and Codex on top of it: each provider gets an isolated config directory, so several providers can run in different terminals at the same time.

## What it does

If you use [cc-switch](https://github.com/farion1231/cc-switch) to manage multiple AI providers (e.g. Claude Official, Zhipu GLM, GitHub Copilot), you normally have to **switch** the active provider — which changes the global `~/.claude/settings.json` or `~/.codex/config.toml` for **all** terminals.

`switch` takes a different approach: each terminal gets its own isolated config directory via `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, so you can run **Claude Official in one terminal and Zhipu GLM in another simultaneously**.

Since cc-switch 4.0 there is also **aggregation mode (Stack)**: a local proxy publishes models from several providers into a single `/model` list, switchable in-client without noticing. `switch` launches the aggregation entry in parallel just like any provider (the `◆ 聚合` group at the end of the TUI list), coexisting with plain instances — the aggregation instance's statusline even follows the `/model` pick to show the current billing provider.

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

**Quick launch from the command line:** skip the picker with `switch a` / `switch s` / `switch d` / `switch f` / `switch g` — identical to pressing the same letter in the TUI (same pin order, same replayed argv, same launch mode), with a one-line `→ provider · cli · mode` header on stderr. Only the bare key form qualifies; `switch a claude` still parses as a provider name. Full-auto slots ask for confirmation just like the TUI does, and refuse to launch where no terminal is available to confirm in.

**Pinning is persistent.** Highlight a Recent row and press `t` + `1`–`5` to pin it into that slot (or `t` on the provider screen — pinning drops you straight into the launch-mode pick, so the next keypress launches); pinned rows show a `*` marker and keep their slot across launches until you press `u` to unpin. Entries are keyed by provider id: renaming a provider in cc-switch keeps its slot, history and count — Recent follows the new name automatically.

**Change the launch mode:** highlight a Recent row and press `e`, then pick `⏎` Default / `2` Semi-auto / `3` Full-auto to switch that entry's mode in place (non-permission flags like `--continue` are kept).

Providers deleted in cc-switch stay listed but flagged red (`✗ missing`) — launching them is blocked; Enter (or their quick key) instead offers to remove them from Recent (`y` to confirm). Dead rows rank last so they never crowd out live ones, and `c` removes every dead entry in one go. You can also drop any entry manually: highlight it and press `x`, then `y`.

A Full-auto quick-launch row (`⚠`) asks for confirmation before launching with `--dangerously-skip-permissions` — picking Full-auto on the provider screen doesn't, since that path already takes two deliberate keypresses.

### Command mode

```bash
switch [global flags] <provider> <cmd> [args...]
switch [global flags] a|s|d|f|g
```

Everything after `<provider> <cmd>` is forwarded verbatim to the launched CLI. Global flags must come first.

#### Global flags

| Flag | Meaning |
| --- | --- |
| `--sync` | Ask to confirm config drift before launching (requires a TTY). |
| `--no-sync` | Suppress the drift warning entirely. |
| `--id <providerId>` / `--id=<providerId>` | Select a provider by id; use it when two providers share a name. |
| `--dry-run` | Print what a launch would write and run; no files are written and no process is started. |
| `--diff` | With `--dry-run`: compare the derived config with the instance file on disk. |
| `--show-secrets` | With `--dry-run`: show real values instead of `***` (prints credentials). |

`--diff` and `--show-secrets` are rejected without `--dry-run`. A trailing `--dry-run` is **not** a switch flag — it is forwarded to the launched CLI.

#### Launching a provider

```bash
switch "Claude Official" claude
switch "Zhipu GLM en" claude --continue
switch --id <providerId> claude --continue
switch --sync "Claude Official" claude       # confirm drift interactively first
switch --no-sync "Example Provider" codex    # silent launch
```

If several providers share a name, the launch is refused and the matching ids are printed; re-run with `--id`. A missing provider prints the available names. Both exit 1.

#### Recent slots

```bash
switch s          # Recent slot 2 — exactly what the TUI's `s` key does
switch --no-sync d
```

Only the bare key form qualifies; `switch a claude` is parsed as a provider named `a`. Full-auto slots ask for confirmation and require a terminal.

#### Dry run

```bash
switch --dry-run "Zhipu GLM en" claude --continue
switch --dry-run --diff "Zhipu GLM en" claude
switch --dry-run --show-secrets "Zhipu GLM en" claude
```

The output lists the provider, instance directory, command, environment, the effective `settings.json` / `config.toml`, and (with `--diff`) leaf-level changes against the current instance file. Credential-looking keys are masked as `***` by default.

`--dry-run` does not run the drift/sync pass, does not create the instance directory or statusline wrapper, does not back up or overwrite config, and does not write launch history or sync state. Quick slots do not support it; `--sync` / `--no-sync` are ignored.

### Other commands

#### `switch list [--json] [--app claude|codex]`

Lists providers read from the cc-switch DB, including the virtual aggregation entry.

- Columns: `APP`, `NAME`, `ID`, `KIND` (`provider` / `stack`), `CURRENT` (`*` when the desktop app points at it), `MEMBERS` (aggregation members), `STATUS` (`ok` or `invalid: …`).
- `--app` may be repeated; unknown apps, missing values and unknown flags exit 1.
- JSON: `{ "version": 1, "providers": [{ app, id, name, kind, aggregation, virtual, current, members, available, issues, nameAmbiguous }] }`.
- `available: false` means the row's config cannot be launched without repair; `issues` explains why. Duplicate names are flagged with `nameAmbiguous: true` — disambiguate with `switch --id`.
- Read-only. A missing or unreadable DB is reported as an error, never as an empty list.

#### `switch ps [--json]`

Prints one row per running switch-launched session — concurrent terminals on the same provider each get their own row:

```
  #  claude  Example Provider      cc-switch-parallel  ~/workspace/personal/cc-switch-parallel  up 3m   claude
  2  claude  Example Provider      project-a           ~/workspace/project-a                    up 2d   claude --continue
```

- `#` is a stable 1-based index for this invocation (oldest first), used by `ps kill` / `ps attach`. It can change between invocations.
- The tmux column falls back to the tty when not inside tmux. Aggregation instances show `provider → member` (the member currently paying).
- `--json`: `{ "version": 1, "sessions": [{ index, pid, cli, providerId, name, tmux, tty, cwd, startedAt, upMs, extraArgs, billingMember, status }] }`. `status` is `alive` or `unknown` (`unknown` = the pid exists but its identity could not be verified).
- Provably dead session files are cleaned up.

#### `switch ps kill <pid|index> [--force]`

Stops a session recorded by this tool.

- `#N` forces an index; `pid:<pid>` forces a pid; a bare number in `1..N` is treated as an index, otherwise as a pid.
- Only sessions whose recorded `lstart` still matches the process are signaled; `unknown` identities are refused.
- Without `--force`: requires a TTY, asks for confirmation, sends `SIGTERM`, then `SIGKILL` after 5 seconds.
- `--force`: no prompt, immediate `SIGKILL` — intended for scripts.
- Exit codes: `0` on success/already exited, `1` on refusal/failure, `130` when interrupted at the prompt.
- Only the CLI process is signaled; grandchild processes are not guaranteed to exit.

#### `switch ps attach <index>`

Focuses the tmux pane running that session.

- Inside tmux: `switch-client` + `select-pane`.
- Outside tmux: `select-window` + `select-pane` + `attach-session` (requires a TTY).
- Sessions not started inside tmux, a missing tmux binary, or no tmux server are reported as errors and exit 1.

#### `switch sync`

Detects config drift (plugins, settings fields, shared config) and writes the sync back after confirmation. Requires a TTY; non-interactive invocations exit 1. `switch --sync <provider> <cmd>` runs the same pass before a launch.

#### `switch doctor [--json]`

Diagnoses sqlite3, the cc-switch DB, CLI binaries, shared config sources, instance dirs, instructions symlinks, sync state and aggregation (live state, members, Stack row, proxy).

- `--json` prints only `{ "version": 1, "ok", "summary": { "total", "passed", "failed" }, "checks": [{ "label", "pass", "detail", "fixable" }] }` on stdout, with no ANSI.
- Exit code is `1` when any check fails, `0` otherwise (also in JSON mode).
- `--fix` is reserved and currently rejected (`--fix is not implemented yet.`). Unknown flags exit 1.

#### `switch clean [--all|--yes] [--force]`

Removes instance directories.

- With no flags: interactive selection (requires a TTY).
- `--all` / `--yes`: remove every instance directory without the picker; they do **not** bypass live-session protection.
- Live or unverifiable sessions block removal unless `--force` is given.
- Also removes the matching sync-state baselines and settings backups. Non-TTY without `--all` exits 1.

#### `switch customize [claude|codex] <provider>` / `--id <providerId>`

Creates or opens an instance-only `CLAUDE.md` / `AGENTS.md` (opens `$EDITOR`, falls back to the system editor). The provider can be selected by name or `--id`. Missing/ambiguous providers exit 1.

#### `switch uncustomize [claude|codex] <provider> [--yes]` / `--id <providerId> [--yes]`

Restores the shared global instructions symlink. Without `--yes` it asks for confirmation and requires a TTY; interrupt exits 130, refusal exits 1.

#### `switch update` / `switch self-update` / `switch --update`

Self-updates to the latest npm version. Errors exit 1.

#### `switch version` / `switch -v` / `switch --version`

Prints the installed version and, when available, the latest npm version.

#### `switch help` / `switch -h` / `switch --help`

Prints the full command list.

## Config drift & sync

**The mental model: config flows down on launch, and what you change inside a session should come back up.** `switch` generates each instance's config from cc-switch's database on every launch — edits made inside a session are the one exception, and the sync flow exists to capture them. The upward channel covers **every field** of a Claude instance's `settings.json` and of a Codex instance's `config.toml`: beyond plugin state, the generated statusLine, and Codex's `[tui] status_line` (all channel-owned, see below), env, permissions, hooks, models, approval policies etc. are detected, displayed, and written back per field. Changes are shown as dotted field paths, and on confirmation are written back with a **smart split**: fields that already exist in the shared config document go into that document, everything else goes into the provider's own config. For Codex the shared side is a TOML document, so a confirmed shared-direction write re-serializes it — comments and formatting are lost (the prompt tells you before you confirm).

### Shared config source (cc-switch 4.0.2+)

cc-switch 4.0 removed the "common config snippet" feature: shared settings now live **directly in the clients' live config files** (`~/.claude/settings.json`, `~/.codex/config.toml`), and the DB's `common_config_<app>` became a frozen legacy snapshot. `switch` chooses the source from the DB's `PRAGMA user_version`:

- **`user_version >= 20` (4.0.2+)**: reads **user keys** from the global live file using upstream's floor rules (hooks, permissions, enabledPlugins, user env, …); credentials, addresses, models and protocol keys never enter the shared projection. `statusLine` is a user key but stays in the live file for the statusline wrapper to read at render time — it is not inlined at prepare time. Upward sync writes back to the global file (file lock + read-then-CAS + backup + original file mode preserved).
- **`user_version <= 19` (3.x, 4.0.0/4.0.1)**: keeps using `common_config_<app>`.
- `CC_SWITCH_SHARED_SOURCE=live|legacy` forces either mode (4.0.0/4.0.1 share schema 19 with 3.20.4, so they cannot be told apart automatically).

In live mode the frozen DB snippet is **never read and never used as a fallback** — that is exactly why a config deleted in the desktop app used to keep applying. If the global file is missing or unparseable, the launch proceeds without shared settings and prints a note; `switch doctor` shows the active source and file status.

Even if you never sync, `switch` **backs up** an instance's main config file (`settings.json` / `config.toml`) to `~/.cc-switch/backups/<app>/<provider-id>/` (10 most recent kept) right before overwriting it, and warns on stderr which fields are about to be lost — edits never vanish silently. Upgrade note: this requires the per-instance baseline (`preparedSettings`); edits made before the upgrade can't be recognized and are only covered by the backup.

Codex credential files get the same treatment as Claude's: an OAuth/ChatGPT-login instance symlinks the **shared global** `~/.codex/auth.json` (the first launch seeds it from the DB), so token rotations the CLI performs mid-session survive every relaunch — a per-instance copy would be overwritten with the stale DB token and force a re-login. API-key instances keep an isolated real file. `settings.preserveCodexOfficialAuthOnSwitch` opts out and restores the legacy per-instance copy. Trade-off: providers with **different** ChatGPT accounts can no longer hold independent logins.

`switch` keeps a snapshot (`~/.cc-switch/sync-state.json`) of the config it last saw, and detects two kinds of drift on every launch:

- **Downward** — the shared config changed in the desktop app (the live file's user keys in live mode; `common_config_claude` / `common_config_codex` in legacy mode). Staleness is tracked **per instance**: the warning names exactly which providers still run the old config. Confirming the sync (y) regenerates those instances' config files in place and refreshes their baselines, so the warning goes away; **already-running sessions** still need a restart to pick up the new config (that's what "restart to apply" in the prompt means). `switch clean` also drops a removed instance's baseline, so stale warnings stop naming deleted providers.
- **Upward** — edits made inside a `switch`-launched session, captured via two channels:
  - **Plugins** (Claude only — Codex has no plugin concept): installed, removed, or toggled (`/plugin`), written back into the shared `enabledPlugins` (the global `~/.claude/settings.json` in live mode, `common_config_claude` in legacy mode). When multiple instances disagree, only instances whose plugin state was actually edited get a vote (a stale mirror of the old shared config doesn't); among edited instances the most recent change wins.
  - **Config fields**: non-plugin fields (env, permissions, hooks, models … for Claude; models, approval policies, MCP servers … for Codex) are shown as a leaf-level diff (arrays compare whole-block — element-level merging has no reliable primitive under RFC 7396) and written back with the smart split on confirmation. Arbitration mirrors the plugin channel: mirror instances get no vote; the winner per field is the most recently edited instance (mtime). Known limitation: a field that exists in the shared config is always written to the shared config — it reaches every consumer even if you meant to change one provider, because that's the only write that survives the merge order. Exception: credential-style sensitive keys (`*_TOKEN` / `*_KEY` / `*SECRET*` …) are never written back into the shared config — the edit stays in the instance, update it in the desktop app instead; deleting a sensitive key from the shared config is still allowed. Write-back goes through compare-and-swap on the stored text, so a concurrent desktop-app edit can never be clobbered — worst case you're asked to re-run `switch sync`.

In **TUI mode** drift is shown before the CLI selector and you can confirm the sync inline. In **command mode** it's a non-blocking warning on stderr — run `switch sync` to review and apply, pass `--sync` to confirm inline before launching, or `--no-sync` to suppress the warning entirely. The first run silently records a baseline, so existing plugins are never reported as "new".

## Instance statusline (provider tag)

Every `switch`-launched Claude instance shows **which provider it runs** right in the status line: each generated `settings.json` carries a statusLine whose wrapper script prints a `[provider]` tag (stable per-provider color) in front of the model indicator — `[Zhipu GLM en][Opus] │ myproject` with claude-hud — and then relays **your own global statusLine unchanged**: claude-hud, ccstatusline, a hand-rolled script, anything configured in `~/.claude/settings.json`. The statusline JSON from Claude Code is passed through untouched, so the global tool keeps rendering exactly what it always does; the provider tag is the only thing `switch` adds (when a statusline doesn't lead with the model, or none is configured, the tag simply sits at the start of the line). **With no global statusline configured**, the wrapper draws two basic rows itself (model, project, git branch, context usage); the visible items are switchable in the TUI.

- **Your global `~/.claude/settings.json` is never touched, and the generated entry is never synced back into cc-switch's database** — `statusLine` is a channel-owned path (like plugins): the overwrite guard ignores it and the upward sync yields it. Swap your global statusline tool and every instance follows on its next launch.
- No global statusline? Instances **draw two rows themselves**: `[provider][model] project git:(branch*)` on top, `Context █████░░░ 45% │ 5h ███░░░ 40% · W ████░░ 52%` below (when usage data exists). The project is the last cwd segment; git disappears outside a repository or when the command fails; context is omitted when unreported. Model, project, git, context and usage are five independent switches.
- **Display settings and statusline yield**: press `s` on the provider screen to open the global statusline panel (five switches; space or ⏎ toggles, esc returns). Changes are **effective immediately** — the wrapper reads `~/.cc-switch/statusline-preferences.json` on every render, no session restart needed. If `~/.claude/settings.json` configures a statusline (claude-hud or any other tool), the model/project/git/context rows **yield** to it: only the provider tag and the switchable usage cell remain, avoiding duplicated output. When claude-hud is detected, the panel highlights `⚡ claude-hud is active` in yellow, labels the four affected rows `on · via claude-hud` and locks them (space does nothing; the cursor still moves), while the usage row stays switchable; other relays behave the same and are labelled `via statusLine`. Field names follow claude-hud (`display.showModel`, `display.showProject`, `display.showContext` / `showContextBar`, `display.showUsage`, `gitStatus.enabled` / `showDirty`, `pathLevels`, …); missing fields or a corrupt file fall back to everything on.
- A `statusLine` set explicitly in a cc-switch provider config is **wrapped, not replaced**: the generated entry points at the wrapper and your explicit command is inlined as the wrapper's preferred relay source (the global `~/.claude/settings.json` is the fallback). Deliberate configuration keeps rendering — the provider tag is still added. On cc-switch 4.0.2+ (live mode) the frozen `common_config_*` is not merged, so a statusLine deleted in the desktop app cannot be resurrected.
- **Tag color is set in the TUI**: highlight a provider on the provider screen and press `o` to pick from auto (hash by name, the default) and the 16 ANSI classic colors (30–37 standard, 90–97 bright, rendered as live swatches); ⏎ saves, esc cancels. Stored in `~/.cc-switch/statusline-preferences.json` (owned by this CLI alone — the cc-switch desktop app and the database never read or write it); takes effect on that provider's next launch, running sessions keep the old color until restarted. Claude's color is consumed by the wrapper; Codex's color is consumed by the tmux status bar (see below).
- Customizing the statusline from **inside** an instance (`/statusline`) is pointless — the entry is regenerated on every launch. Edit the global file instead.

### Codex's status line

Codex CLI's status line is a **native built-in-item picker** (`[tui] status_line` in `config.toml`, Codex ≥ 0.105.0) with no external-command rendering — so Codex instances have no provider tag (this lands once upstream [openai/codex#17827](https://github.com/openai/codex/issues/17827) supports it). What `switch` guarantees is that the status line is ON with useful items: every launch injects `[tui] status_line = ["model-with-reasoning", "current-dir"]` and `status_line_use_colors = true` into the instance `config.toml`. **Only missing keys are filled** — explicit values in your provider/common TOML win (`status_line = []` opts out); the injected subtree is channel-owned like Claude's statusLine: ignored by the overwrite guard, yielded by the upward sync, never written back to the database. The model name usually distinguishes providers indirectly (each provider binds its own model), but same-model multi-account setups stay indistinguishable.

**Not in the TUI, but in the tmux status bar**: if you use [tmuxclihook](https://github.com/liuziyuan/tmux-claude-hooks-status) (≥ 0.4.0) inside tmux, `switch` injects `CC_SWITCH_PROVIDER` / `CC_SWITCH_PROVIDER_ID` environment variables when launching every CLI session, and the CLI's hook processes inherit them. tmuxclihook captures the variables and renders a colored `[provider]` segment in the aggregated status-bar row — for both claude and codex — and clears it automatically when the pane switches to a non-switch CLI. Tag colors share the same source as the claude wrapper (`statusline-preferences.json`, set with `o` on the provider screen); a color change takes effect on the status bar's next refresh, no session restart needed.

## Aggregation mode (cc-switch 4.0)

cc-switch 4.0's **aggregation mode** (codename Stack) runs a local HTTP proxy (default `127.0.0.1:15721`) and publishes models from several providers into Claude Code's `/model` list under `ccs-claude-<key>--<model>` ids (for Codex it's `ccs-<key>/<model>`, see below), so you can switch between them in-client without noticing. `switch` does not enter or leave the mode (that's a desktop-app action) — it **consumes it as one more parallel instance**: `[Z.AI GLM] [DeepSeek] [Stack]` instances coexist in tmux without affecting each other.

**Getting started**: after enabling aggregation in the cc-switch desktop app (pick a default provider, add member providers), the TUI provider list ends with a `◆ 聚合 · Stack (DeepSeek + Z.AI GLM)` group. The aggregation entry is a **runtime virtual provider row** (fixed id `__stack__`): it is never written into cc-switch's database (the desktop GUI shows no CLI-generated rows). Every TUI open / launch derives the current routing contract (base URL, ccs aliases, modelPicker) from live-state and the global `~/.claude/settings.json` — after the desktop app changes the proxy port, switches the default provider or clears the model list, the next action picks it up with no sync step. Launching it gives you an aggregation instance: models from several providers sit side by side in `/model` (Claude Code ≥ 2.1.243), and recent, pin, `o` coloring, `● live` and `switch ps` all behave like a plain provider — `ps` even appends the current billing member (`Stack → DeepSeek`, decoded from the instance's latest `/model` pick). Command mode works too: `switch Stack claude` / `switch Stack codex` (the virtual row is named `Stack`; when the database already has a provider with that name it shows as `Stack 2`).

The aggregation instance's statusline follows model switches in two ways:

- **Billing segment**: the wrapper decodes the `ccs-claude-<key>--` prefix from the model id at runtime and queries billing **directly against that member's real origin using that member's own credentials** (zhipu 5h/week windows, DeepSeek balance) — billing traffic never goes through the aggregation proxy, and the proxy is not involved. A model id without a prefix uses the default provider; an unknown key shows the usage segments of every recognizable member side by side. Usage queries support `https` only; plain `http` is allowed for loopback addresses only (`127.0.0.1` / `localhost` / `[::1]`, for local proxies) — requests carry the provider's own token, so remote plain http is refused.
- **Provider tag**: the TUI tag follows the current billing provider (`[DeepSeek]` / `[Z.AI GLM]`); the tmux status-bar tag still shows the provider name at launch (`Stack`). The semantics differ: tmux says "this pane is an aggregation instance", the TUI tag says "this is the current billing provider".

**Limitations and notes**:

- The aggregation proxy lives and dies with the cc-switch desktop process — after the desktop app quits, aggregation instances point at a dead proxy address (on exit the upstream only restores the global config; it never touches `switch`'s instance files); re-open the desktop app and they recover. Before launching an aggregation instance, `switch` runs a 300ms TCP probe of the proxy address and warns on stderr when unreachable (launch is not blocked); `switch doctor` also includes aggregation checks (live-state contract version, member rows present, virtual entry derivable, proxy reachability).
- The aggregation list in `/model` comes from the `modelPicker` key the desktop app writes into the global `~/.claude/settings.json`; `switch` syncs it from the global file on every aggregation launch, so after the desktop app changes the member list, **re-enter the instance** to see it (running sessions do not follow automatically). Clearing the list in the desktop app (back to built-in models) is a legal state too — the instance's aggregation list empties accordingly and never keeps a stale snapshot.
- The aggregation entry carries routing only (loopback address, proxy credential, `ccs` model aliases) and no shared-config content — `switch` **always merges the shared config** when launching an aggregation instance (hooks, permissions, …; from the global live file's user keys on 4.0.2+, from `common_config_*` on older schemas, same as a plain provider); routing identity env (`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`) and the `ccs` model aliases come from the aggregation entry and cannot be overridden by the shared config. Explicitly turning "use common config" off on the aggregation row in the desktop app still takes effect.
- After aggregation is turned off in the desktop app the entry remains (shown as "未激活" in the TUI; "N 个成员缺失" when the member rows are gone), and instances still launch but the proxy is not there — go back to a plain provider instance. The aggregation instance's `/model` no longer lists stale `ccs` entries pointing at the dead proxy.
- Instance-edit write-back (`switch sync`) does not apply to the aggregation entry: provider-side edits are marked blocked with an explanation (a virtual row has nothing to land in; the instance config is regenerated from desktop-app state on every launch); edits that land in the common config are still written back.
- **Upgrading from ≤ 0.19**: the first run automatically cleans up aggregation provider rows the old version wrote into the database (idempotent) and migrates launch history, pins and statusline colors to the virtual id `__stack__`; an aggregation row currently in use in the desktop app (is_current) is kept and reported. Running old aggregation instances are unaffected; their UUID directories can be removed with `switch clean` after the session ends.

### Codex aggregation

The Codex aggregation entry shares the architecture with claude (the same virtual row `__stack__`, the same TUI group and probe); the differences are the projection and the source of the model list:

- **Routing projection**: the virtual row is **derived from the global `~/.codex/config.toml` through a whitelist** on every call — only `model_provider`, `model`, `web_search`, `model_catalog_json` and the active `[model_providers.<id>]` table's `name/base_url/wire_api`, with `experimental_bearer_token = "PROXY_MANAGED"`, `requires_openai_auth = false` and `auth = {}` forced (real credentials never enter the aggregation row). Runtime/preference keys such as `[projects.*]`, `[hooks.state.*]`, `[tui]` and `model_reasoning_effort` are not projected, to avoid freezing in-progress state and triggering drift. The entry cannot be derived when the global config is missing, `model_provider` is a reserved official id, or the base_url is not loopback (`switch doctor` reports it while the stack is still on).
- **Common config**: like the claude aggregation row, the shared config is **always force-merged** (the global `~/.codex/config.toml` user-key projection on 4.0.2+, `common_config_codex` on older schemas), with identity protection after the merge — `model_provider`, the active provider's whole table, `model_catalog_json` and `web_search` follow the aggregation row (provider tables absent from the row are deleted), so the shared config cannot override routing identity; top-level `base_url/wire_api/experimental_bearer_token/requires_openai_auth` fallback channels are all removed. Explicitly turning "use common config" off on the aggregation row in the desktop app still takes effect.
- **Model list**: the `/model` list comes from the full catalog the desktop app writes into the global `~/.codex/cc-switch-model-catalog.json` (member id rule `ccs-<key>/<model>`, e.g. `ccs-deepseek/deepseek-flash`; default-provider models carry no prefix). On every aggregation launch `switch` **copies it byte-for-byte** into the instance directory — not rendered from a template, so every field the desktop app wrote is preserved; when the global catalog is missing/corrupt, the instance's existing copy is kept with a warning (the list may be stale). After the desktop app changes the member list, **re-enter the instance** to see it.
- **`/model` picks survive restarts**: the in-instance model pick is written to the instance `config.toml`'s `model` key, and aggregation instances carry it across launches (plain codex rows keep the established drift + sync flow, unchanged). When the pick points at a removed member or aggregation is off, the launch falls back to the default model with a notice.
- **Limitations**: Codex TUI's status line only supports built-in items (upstream openai/codex#17827), so aggregation instances have neither the claude-side wrapper billing segment nor the dynamic provider tag — the tmux status-bar provider segment (via tmuxclihook) still shows `Stack` as at launch, and `switch ps` does not decode the current billing member either. `switch doctor` includes codex aggregation checks (virtual entry derivable, proxy reachability).

## How it works

1. Reads provider configs from `~/.cc-switch/cc-switch.db` (SQLite, managed by cc-switch); the aggregation (Stack) entry is the exception — it is a runtime virtual row (id `__stack__`) derived from live-state and the global config, never stored in the database
2. Replicates cc-switch's Rust backend logic: JSON/TOML deep merge of shared config (live global user keys on 4.0.2+, the DB snapshot on older schemas), sanitize, Codex model catalog generation
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

**cc-switch is required** — this project adds parallel launching on top of it and cannot run without it.

- [cc-switch](https://github.com/farion1231/cc-switch) desktop app installed, with at least one provider configured (aggregation mode requires cc-switch 4.0+)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude`) on PATH
- [Codex](https://github.com/openai/codex) CLI (`codex`) on PATH (optional, for Codex support)
- Node.js ≥ 18 (`switch` verifies this at startup and exits with an upgrade hint on older runtimes — the statusline usage segment needs the global `fetch` added in Node 18)
- `sqlite3` CLI (pre-installed on macOS)

## License

MIT
