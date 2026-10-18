# 调查报告：switch 聚合模式启动 Claude 无 tmux AI 状态（hooks 未合并进实例）

> 调查日期：2026-10-18
> 调查方：tmux-claude-hooks-status 仓库侧排查
> 状态：根因已实锤，**未做任何代码改动**，等待本仓库修复

## 现象

cc-switch 升级 4.0 并开启聚合（Stack）后：

- 用 `switch` 选择**聚合**入口启动 Claude CLI → tmux 状态栏**没有** claude 状态（tmux-claude-hooks-status 插件收不到任何 hook 事件）
- 用 `switch` 选择**其他 provider**（DeepSeek / Z.AI GLM 等）启动 → 状态正常

## 根因（一句话）

聚合 provider 行的 `meta` 是 `{}`（无 `commonConfigEnabled`），且其 `settings_config` 不含 common config 内容，导致 `providerUsesCommonConfig()` 判为「不使用通用配置」——`buildClaudeEffectiveSettings()` 跳过 `common_config_claude` 深合并，**实例 settings.json 里没有 hooks**，Claude CLI 读到的配置无 hooks，插件侧静默无事件。

## 失败链条

```
cc-switch 4.0 桌面 GUI 开启聚合
    ↓ 创建 loopback provider 行 "Stack"
      meta = '{}' （无 commonConfigEnabled）
      settings_config = { env: {ANTHROPIC_BASE_URL: http://127.0.0.1:15721, ...}, modelPicker }
      —— 不含 hooks，也不含 common config 的任何内容
    ↓
switch 启动 Stack → buildClaudeEffectiveSettings()
    ↓ providerUsesCommonConfig("claude", settingsConfig, meta, commonSnippet)
      • meta.commonConfigEnabled === undefined  → 落入 fallback
      • settingsContainCommonConfig → jsonIsSubset(settings, common)
        Stack 行 settings_config 不含 hooks → false
    ↓ 判定 = 不使用通用配置
    ↓ 跳过 mergeCommonOverProvider(effective, commonSnippet)
    ↓
实例 settings.json 写盘：hooks 缺失
    ↓
Claude CLI 读实例配置 → 无 hooks → 不再调用 tmux-ai-status
    ↓
tmux 状态栏无 claude 状态
```

对应代码位置（`bin/cc-launch.mjs`，v0.17.0 / commit 57fdc61）：

- `providerUsesCommonConfig()` — L933：`meta.commonConfigEnabled` 缺失时 fallback 到 subset 判定
- `settingsContainCommonConfig()` — L945：claude 分支用 `jsonIsSubset(settings, source)`
- `buildClaudeEffectiveSettings()` — L994：判定 false 则不合并 commonSnippet
- `isAggregationProviderSettings()` — L1716：loopback base URL 判定（可用于识别聚合行）
- `ensureStackProviderRow()` — L1808：TUI 自动创建的聚合行同样写 `meta='{}'`（L1849），与 GUI 创建的行为一致
- `mergeCommonOverProvider()` — L775：深合并，source（common）递归并入 target（provider）

## 证据链

### 1. DB 数据（`~/.cc-switch/cc-switch.db` providers 表，app_type='claude'）

```
id-c…|DeepSeek      |meta: {"commonConfigEnabled":true, …}
id-d…|Z.AI GLM     |meta: {"commonConfigEnabled":true, …}   ← is_current
id-a…|Example Provider    |meta: {"commonConfigEnabled":true, …}
id-b…|Example Provider B|meta: {"commonConfigEnabled":true, …}
id-e…|Stack        |meta: {}                                 ← 聚合行，唯一例外
```

Stack 行 created_at = 2026-10-18 09:36:48（桌面 GUI 写入，早于本仓库 v0.17.0 提交 10:58）。

### 2. 真源完好（排除插件/真源方向）

`settings` 表 `common_config_claude`：10 个 hook 事件（SessionStart/SessionEnd/UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/PermissionRequest/Notification/Stop/StopFailure）+ `tmux-ai-status` 条目 10 条俱在。

### 3. 实例配置对比（实锤）

```
聚合实例 ~/.cc-switch/instances/claude/d4d19431-240b-4fc9-b854-ecc13f836607/settings.json
    → hooks: null（缺失）
普通实例 ~/.cc-switch/instances/claude/e48e4e5c-…/settings.json（Z.AI GLM）
    → tmux-ai-status hooks 10 条俱在
```

### 4. 全局文件旁证（问题精确限于 switch 实例 prepare 路径）

`~/.claude/settings.json` 当前为聚合 env（`ANTHROPIC_BASE_URL=http://127.0.0.1:15721`）**且 hooks 俱在** —— GUI 直启（裸 `claude`）场景有状态。缺口只在 `switch` 的实例 settings.json 写盘这一步。

### 5. 为什么三方全静默（排查时无任何报错）

- tmux 插件侧 `check --json` 报 `status:ok, mode:ccswitch`：claude adapter 在 cc-switch 模式下 integrity 检查的是 **DB 真源**，真源完好 → 判 ok
- 真源 ok → 插件 `_maybe_repair_hooks`（60s 自修复）永不触发
- switch 侧 prepare 正常写盘无报错——只是按判定「不该合并」就没合并

即：缺口在「真源 → 实例」的合并步，而现有的健康检查只覆盖「真源」和「实例写盘是否成功」，两头都是绿的。

## 修复方向（建议，待本仓库定夺）

### 方案 A（推荐）：聚合行强制视作使用通用配置

在 `buildClaudeEffectiveSettings()`（或 `providerUsesCommonConfig()`）对 `isAggregationProviderSettings(settingsConfig)` 命中的行强制走 common 合并。

语义正确性：聚合只是端点替换（loopback 代理分发成员凭据），hooks / statusline / permissions 等通用配置理应跟随实例。GUI 创建的行与 TUI `ensureStackProviderRow` 创建的行一次覆盖。

**合并安全性已验证**：当前 `common_config_claude` 的 `env` 段只有 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`，不含 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`；`mergeCommonOverProvider` 是同 key 递归深合并，不会覆盖聚合的 loopback env。但若担心用户 common config 未来写入 `ANTHROPIC_*` 覆盖 loopback，可在聚合行场景对 `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_AUTH_TOKEN` 做合并后回写保护（以 provider 行值为准）——是否需要此防护由本仓库权衡。

### 方案 B（一次性数据修复，不推荐单用）

给现有 Stack 行 meta 补 `commonConfigEnabled:true`。缺点：GUI 重建聚合行 / 换机 / TUI 自动建行都会复发，不收敛。

### 临时解（用户当下可用，无需改码）

cc-switch GUI 里给 Stack provider 勾选「使用通用配置」→ meta 写入 `commonConfigEnabled:true` → 下次 `switch` 启动即恢复。同样有方案 B 的复发缺点。

## 验收清单（修完后）

1. `switch` 启动聚合入口 → 检查 `~/.cc-switch/instances/<stack-id>/settings.json`：`hooks` 含 tmux 插件 10 事件；`env.ANTHROPIC_BASE_URL` 仍为 loopback；`modelPicker` 保留
2. TUI 内跑一轮工具调用 → tmux 状态栏出现 claude 状态符号（`>` / `!` 等）
3. 非聚合 provider（如 Z.AI GLM）启动 → 回归：实例 hooks 依旧、行为不变
4. 聚合关闭（desktop stack off）时该行走普通单 provider 路径的行为不回归
5. 覆盖测试建议：unit 断言「聚合 settings + meta={} + 含 hooks 的 commonSnippet → effective 含 hooks 且 loopback env 未被覆盖」；e2e 断言 prepare 写盘后实例 settings.json 含 hooks

## 相关背景（tmux-claude-hooks-status 侧，无需那边改动）

- 插件 claude adapter 的 hooks 真源即 `common_config_claude`（SQLite），靠 switch prepare 时深合并进实例生效——本次缺口正是这条链路
- 插件侧 check/自修复只看真源，实例侧缺失对插件不可见（本次排查已确认这是预期设计，不改）
- 现场还观察到 volta 副本 stale 条目（`check --json` 的 `drift.stale`），与本问题无关，插件仓库自行处理
