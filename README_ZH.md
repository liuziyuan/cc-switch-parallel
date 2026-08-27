# cc-switch-parallel

> 为 Claude Code 和 Codex 提供按 provider 隔离的配置启动 —— 在多个终端并行运行不同 provider，无需切换。

[English](README.md) | [中文](README_ZH.md)

## 它做什么

如果你用 [cc-switch](https://github.com/farion1231/cc-switch) 管理多个 AI 供应商（例如 Claude Official、Zhipu GLM、GitHub Copilot），通常你必须**切换**当前供应商 —— 这会改动全局的 `~/.claude/settings.json` 或 `~/.codex/config.toml`，影响**所有**终端。

`switch` 走了另一条路：每个终端通过 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 拥有自己隔离的配置目录，因此你可以**在一个终端跑 Claude Official，在另一个终端同时跑 Zhipu GLM**。

## 安装

```bash
npm install -g cc-switch-parallel
```

或从源码安装：

```bash
git clone https://github.com/liuziyuan/cc-switch-parallel.git
cd cc-switch-parallel
npm link
```

## 使用

### 交互模式

```bash
switch
```

弹出 TUI —— 先选择 CLI 工具（claude / codex），再选择 provider，按 Enter 启动。

**Recent (top 5)：** CLI 界面会列出最常用的 5 个启动组合，按 `a`–`g` 一键快速启动。顺序默认按使用次数自动排列；在 provider 界面按 `t` 再按数字 `1`–`5`，可以把当前高亮的供应商手动钉入对应槽位——原有条目顺位后移（原第 5 名被挤出）。置顶只调整顺序、不会启动。置顶是一次性的：该供应商再次真实启动后会脱离手工排序，回归按使用次数的自然排序。置顶以供应商名称为键，在 cc-switch 中改名即失效。

### 命令模式

```bash
switch [--sync|--no-sync] <provider> <cmd> [args...]
```

示例：

```bash
switch "Claude Official" claude
switch "Zhipu GLM en" claude --continue
switch --sync "Claude Official" claude   # 启动前就地交互确认配置漂移
switch --no-sync "P&G Nezha" codex       # 静默启动，抑制漂移警告
```

### 其他命令

```bash
switch sync       # 检测并同步配置漂移（插件、通用配置）
switch doctor     # 诊断环境（sqlite3、数据库、二进制等）
switch clean      # 删除实例目录（交互式，或 --all）
switch update     # 自更新到最新 npm 版本
switch --help     # 列出所有命令
```

## 配置漂移与同步

`switch` 会保存一份它上次看到的配置快照（`~/.cc-switch/sync-state.json`），并在每次启动时检测两类漂移：

- **下行** —— cc-switch 的*通用配置*（`common_config_claude` / `common_config_codex`）在桌面端被改动。陈旧状态**按实例跟踪**：警告会指出具体哪些 provider 还在用旧配置。确认同步（y）会就地重新生成这些实例的配置文件并刷新基线，提示随之消失；**正在运行的会话**仍需重启才能用上新配置（这正是提示里 "restart to apply" 的含义）。`switch clean` 删除实例目录时也会同步清掉它的基线，陈旧提示不会再点名已删除的 provider。
- **上行** —— 在 `switch` 启动的 Claude 会话里，插件/技能被安装、移除或切换（`/plugin`）。`switch` 会提示你，并可把改动回写进 cc-switch 的 `common_config_claude.enabledPlugins`。多个实例状态冲突时，只有插件状态被真实修改过的实例才有投票权（旧通用配置的陈旧镜像没有）；被修改过的实例之间，以最近的改动为准。

在 **TUI 模式**下，漂移会在 CLI 选择器之前展示，你可以就地确认同步。在**命令模式**下，它是在 stderr 上的非阻塞警告 —— 运行 `switch sync` 来查看并应用，加 `--sync` 可在启动前就地确认，加 `--no-sync` 则完全抑制警告。首次运行会静默记录一份基线，因此已有的插件永远不会被报告为「新增」。

## 工作原理

1. 从 `~/.cc-switch/cc-switch.db`（SQLite，由 cc-switch 管理）读取 provider 配置
2. 复刻 cc-switch 的 Rust 后端逻辑：通用配置的 JSON/TOML 深度合并、清理、Codex 模型目录生成
3. 在 `~/.cc-switch/instances/<app>/<provider-id>/` 创建每个 provider 的实例目录
4. 写入隔离的 `settings.json` / `config.toml` / `auth.json` / `cc-switch-model-catalog.json`
5. 从全局 `~/.claude/` 软链接共享资源（插件、技能、项目、凭据）—— **零数据复制**
6. 设置 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 并 `exec` 启动 CLI

### 实例目录布局

```
~/.cc-switch/instances/claude/<provider-id>/
  ├── settings.json           ← 从数据库生成（按 provider 隔离）
  ├── .credentials.json → ~/.claude/.credentials.json  （软链接，共享）
  ├── projects → ~/.claude/projects                      （软链接，共享）
  ├── plugins → ~/.claude/plugins                         （软链接，共享）
  └── ...其他软链接（skills、cache、commands 等）
```

每个实例仅约 8KB —— 重数据（插件、会话历史、凭据）都是软链接，而非复制。

## 添加新的 CLI

每个 CLI 都是一个小适配器（`bin/cc-launch.mjs` 里的 `APP_ADAPTERS`）。例如要添加 Gemini，只需加一个对象 —— `runTUI`、`launchProvider`、`main` 保持通用：

```js
const APP_ADAPTERS = {
  claude:  { appType, label, displayName, bin, envVar, commonConfigKey,
             setupInstance, prepare, launch, permissionArgs },
  codex:   { /* … */ },
  // gemini: { /* … */ },   ← 加在这里
};
```

`setupInstance` 创建实例目录 + 软链接，`prepare` 生成配置文件，`launch` 启动 CLI，`permissionArgs` 映射权限快捷键。可选的 `detectPluginDrift` / `syncPluginsBack`（目前仅 Claude）提供按 CLI 的插件同步；可选的 `readInstancePluginState` 让按实例的漂移基线记录该 CLI 的插件状态。

## 系统要求

- [cc-switch](https://github.com/farion1231/cc-switch) 桌面应用，并已配置 provider
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI（`claude`）在 PATH 中
- [Codex](https://github.com/openai/codex) CLI（`codex`）在 PATH 中（可选，用于 Codex 支持）
- Node.js ≥ 18
- `sqlite3` CLI（macOS 已预装）

## License

MIT
