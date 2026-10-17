# CLAUDE.md

cc-switch-parallel — 为 Claude Code / Codex 提供按 provider 隔离的配置启动(详见 README_ZH.md)。

## 待办:Codex 支持自定义 statusline 后,移除 tmux 状态栏 provider 标签方案

Codex TUI 内目前无法显示 provider 标签:原生 `[tui] status_line` 仅支持内置字段选择,无外部命令渲染(上游 openai/codex#17827,截至 v0.163 未实现)。当前过渡方案是 launch 时注入 `CC_SWITCH_PROVIDER` / `CC_SWITCH_PROVIDER_ID` 环境变量,由 tmux-claude-hooks-status(≥ v0.4.0)的 codex hooks 捕获后在 tmux 状态栏渲染 provider 段——该能力本质是 switch 的需求,tmuxclihook 只是承载方。

**当 Codex CLI 支持外部命令渲染 status line 时(#17827 落地或等效机制,判定:codex 文档 docs/config.md 出现外部命令 statusline 配置项),做以下迁移:**

1. codex adapter 改用与 claude 相同的 wrapper 注入模式(`applyStatusLineInjection` / `buildStatusLineWrapperScript`),provider 标签直接进 Codex TUI 内;`o` 设色的 codex 桶(statusline-preferences.json)改由 wrapper 消费
2. 移除 `buildLaunchExtraEnv` 的 env 注入与 tmuxclihook 侧的捕获/渲染(同步清理 tmux-claude-hooks-status 仓库 CLAUDE.md 中的同名条目)
3. `CODEX_STATUS_LINE_ITEMS` 的 fill-if-absent 注入相应调整(外部命令模式下的默认值策略)
4. 更新 README_ZH「Codex 的状态栏」与「实例 statusline」两节

在此之前,不要给 codex 添加 statusline wrapper 类的注入(原生无挂载点),也不要移除 env 注入(tmuxclihook 的 provider 段依赖它)。
