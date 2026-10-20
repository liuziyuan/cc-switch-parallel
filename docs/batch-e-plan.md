# 批次 E：功能增强候选与调查

> 基线：v0.21.6（批次 A–D 已合入 main）。当前 v0.26.0：命令扩展见 PR #58，遗留项修复见 PR #59（均已合并发布），P1 增强见本 PR（详见第 7 节）。
> 性质：本文记录的是**功能增强**，不是缺陷修复。A–D 修完后，E 中没有一项是严格必须的；应结合实际使用场景挑选。

## 1. 背景

批次 A–D 已分别处理：

- A：statusline 退避/进程风暴、Codex 运行时状态合并、含点键写回、软链、坏 provider 行、catalog 容错、usage endpoint。
- B：history 损坏保护、原型污染、凭据/备份权限、usage 缓存 tmp。
- C：跨进程文件锁、sync-state 合并、会话三态、clean 活跃保护、置顶去重、DB 超时/错误分类。
- D：TUI 终端恢复/resize、控制字符清洗、Ctrl-C 中止、非 TTY sync、编辑器 shell 解析、ps/tmux、wrapper TTY stdin。

当前测试 298 项全绿。E 的目标是提升可用性/可观测性，不改变既有正确性保证。

## 2. 候选清单总览

| 候选 | 价值 | 粗略成本 | 必要性判断 |
|---|---|---|---|
| Copilot 并行路由 | 最大功能缺口（官方 + Copilot 真正并行） | 高 | **已放弃**（不再使用 Copilot，见 3.1） |
| `switch list [--json]` | 脚本/CI/排查 provider | 低 | 建议做（最小 E） |
| `switch ps --json` | 自动化/监控/二次处理 | 低 | 建议做（最小 E） |
| `switch ps kill/attach` | 并行会话管理 | 中 | 按需 |
| `switch doctor --fix` / `--json` | 自愈断链/基线；CI 可读 | 中 | 可选 |
| `switch launch --dry-run` | 排查实例配置问题 | 中 | 可选，诊断价值高 |
| shell completion | 输入体验 | 低–中 | 非必要 |
| TUI 搜索/过滤 | provider 很多时（>15）才明显 | 中 | **已放弃**（见 3.8） |
| 提示语言统一 | 一致性 | 低 | 打磨项，非必要 |
| `ps` 批量查询优化 | 减少 sqlite3/ps 进程 | 低 | 当前延迟可接受，不必要 |
| Windows 支持 | 跨平台 | 高 | 不用 Windows 就不做 |
| catalog 模板跟进 | 跟随上游模型更新 | 持续维护 | 按需 |

## 3. 逐项调查

### 3.1 Copilot 并行路由

**状态：已放弃（2026-10-20）。** 使用者已完全不再使用 GitHub Copilot，本项不实施；下方调查内容仅作历史记录保留，不再作为待办。

**现状**

- `docs/copilot-parallel-routing-plan.md` 已有完整设计，但代码未实现。
- Copilot provider 的 JWT 由 cc-switch 桌面代理在内存中持有；磁盘上的 `~/.cc-switch/copilot_auth.json` 只存长期 GitHub OAuth token。
- `switch` 当前只能按 provider 直连上游；Claude Official 与 Copilot 无法在同一组并行终端里同时使用（Copilot 需要 editor headers 与短期 JWT，`settings.json.env` 无法表达）。

**目标**

- 为 Copilot 实例内置一个进程级轻量本地代理：用 GitHub token 换短期 Copilot token，注入 `Authorization`/editor headers，透传到 `api.githubcopilot.com`；代理随 CLI 退出销毁。
- Claude Official 走原路径，不受影响。

**实现要点**

- 复用 `docs/copilot-parallel-routing-plan.md` 中记录的端点与 header 清单。
- 账号选择：`meta.authBinding.accountId` / `meta.githubAccountId`，回退 `copilot_auth.json.default_account_id`。
- token 缓存与提前 60s 刷新；代理端口随机回环，写入实例 `ANTHROPIC_BASE_URL`。
- 失败模式：换取 token 失败/代理不可用时的明确报错；不阻塞其他 provider。
- 需要新增代理生命周期管理（随 `launchTracked` 启动/退出）。

**成本/风险**

- 高：新增 HTTP 代理、token 刷新、streaming 透传、headers 兼容；需要真实 Copilot 账号验证。
- 依赖桌面端 `copilot_auth.json` 的 schema，可能随上游变化。

**判断**：已放弃——使用者不再使用 Copilot，即使将来需要并行，也不在本项目范围内重新评估。

### 3.2 `switch list [--json]`

**现状**

- `main.ts` 的命令分发只有交互 TUI 与 `switch <provider> <cmd>`；没有非交互列表。
- 数据来源现成：`queryProvidersByApp(appType)`（含虚拟 Stack 行）、`APP_ADAPTERS`、`buildAggregationGroup`。

**目标**

- `switch list` 输出表格：app、provider 名、id、是否聚合、是否当前/可用。
- `switch list --json` 输出稳定 JSON（脚本/CI 用）。
- 可选 `--app claude|codex` 过滤。

**实现要点**

- 新 `src/commands/list.ts`；复用 `queryProvidersByApp` 与 `VIRTUAL_STACK_APPS`。
- JSON schema 固定：`{ app, id, name, aggregation, members?, available }`。
- 无需 DB 写入；只读命令。

**成本/风险**：低。大量 provider 时输出长度可控（分 app）。

**判断**：建议做；与 `ps --json` 一起构成最小 E。

### 3.3 `switch ps --json`

**现状**

- `runPs` 已收集 `cli`、`name`、`tmux`、`dir`、`up`、`args`；`session` 内含 pid、startedAt、tty、cwd、extraArgs。
- 输出为人读表格；`stackBillingMemberName` 可解码聚合实例的当前计费成员。

**目标**

- `switch ps --json`：每个会话一行对象，字段稳定（pid、cli、providerId、name、tmux、cwd、startedAt、upMs、extraArgs、billingMember、status）。
- 复用现有 `readSessions`/`sessionLiveness`；`status` 暴露 alive/unknown。

**实现要点**

- 把 `runPs` 的数据收集与渲染拆开：`collectRunningSessions()` → 表格/JSON 两个渲染器。
- 控制字符清洗在数据层完成（已有 `sanitizeText`）。

**成本/风险**：低。JSON 字段一旦固定，后续需保持兼容。

**判断**：建议做。

### 3.4 `switch ps kill/attach`

**现状**

- `ps` 只读；会话文件包含 pid、tty、tmux 名。
- `tmuxSessionByTty` 提供 tty→tmux session 映射，但没有 pane id。

**目标（可选）**

- `switch ps kill <pid|index>`：向会话进程发送 SIGTERM（必要时 `--force` 用 SIGKILL），只允许操作本工具记录的会话。
- `switch ps attach <index>`：在 tmux 中 `select-pane -t <pane>`；需要从 `list-panes` 同时取 `pane_id`/`pane_tty`。
- 二次确认，避免误杀。

**风险**

- 信号语义（CLI 可能自行处理 SIGTERM）；需要明确“先 TERM，超时再 KILL”。
- attach 依赖 tmux，非 tmux 环境只能报错。
- 需要防止伪造 session 文件导致向任意 pid 发信号（校验 pid 存活 + lstart 匹配）。

**判断**：按需；不做也不影响核心用法。

### 3.5 `switch doctor --fix` / `--json`

**现状**

- `runDoctor` 只读检查：sqlite3、DB、二进制、common config、实例目录、instructions 软链、sync-state、聚合 live-state/代理。
- 已有可复用的修复原语：`setupClaudeInstance`/`setupCodexInstance`（重建软链）、`recordInstanceBaseline`、`ensureSymlink`、`pruneInstanceBaselines`/`pruneInstanceSettingsBackups`。

**目标**

- `--fix`：只修复可安全自愈的问题（断链、缺失实例目录、基线缺失）；不删除用户数据、不修改 DB provider 行。
- `--json`：`[{label, pass, detail, fixable}]`，便于 CI/脚本。
- 明确打印“已修复/无法修复”。

**风险**

- 自动修复必须白名单化；不要对聚合代理不可达、DB 不可读等做“修复”。
- `--fix` 不应触发 prepare 覆盖用户实例配置（用 `setupInstance` + 软链修复即可，避免直接 `prepare`）。

**判断**：可选；目前重启一次通常也能自愈。

### 3.6 `switch launch --dry-run`

**现状**

- `launchProvider` 的流程：`detectAndPromptSync` → `resolveProviderRef`（内部 `queryProviderMatches` / `queryProviderById`）→ `setupInstance` → `guard` → `prepare` → `recordInstanceBaseline` → `recordLaunch` → `launchTracked`。
- 纯推导部分已有：`adapter.computeEffectiveSettings(...)`（与 prepare 的 C3 契约一致），Claude 侧 `buildClaudeEffectiveSettings`，Codex 侧 `buildCodexConfig`。

**目标**

- `switch --dry-run [--diff] [--show-secrets] <provider> <cmd> [args...]`（flag 必须在最前）：打印将写入的 effective config、实例目录、将执行的命令与环境变量；不写文件、不启动 CLI、不计入 history。
- 可选 `--diff`：与当前实例文件对比，展示变化。

**实现要点**

- 复用 `computeEffectiveSettings`；注意它会生成 statusline wrapper（有写文件副作用）——dry-run 需要把 wrapper 写入路径替换为只读推导，或接受临时目录写入后清理。
- 不调用 `setupInstance`/`prepare`/`recordLaunch`。

**风险**

- statusline 注入的写副作用需要隔离，否则 dry-run 不再是只读。
- 输出可能包含 token（effective config 的 env）；默认脱敏，`--show-secrets` 才显示。

**判断**：可选；对排查配置问题价值高。

### 3.7 shell completion

**现状**

- 无 completion 生成器。命令集合在 `src/main.ts` 的分发与 `printHelp` 中硬编码。

**目标**

- `switch completions zsh|bash|fish` 输出脚本；或提供安装说明。
- 补全 provider 名（静态命令补全 + 动态 provider 名）。

**风险**

- 动态 provider 补全会调用 DB，需要限制超时/失败静默。
- 三种 shell 的脚本需要分别维护。

**判断**：体验项，非必要。

### 3.8 TUI 搜索/过滤

**状态：已放弃（2026-10-20）。** provider 数量保持较小，不做搜索/过滤；下方内容仅作历史记录保留。

**现状**

- `tui.ts` 的 provider/Recent 列表用 `selected` 索引 + 方向键；无过滤状态。
- 当前 provider 数量通常 <15，Recent 5 行。

**目标**

- `/` 进入过滤模式，按名称子串过滤 provider；esc 清除；过滤后保持 selected 合法。
- 可选：长名字截断已由 `fitLine` 覆盖。

**风险**

- 需要新增输入态与渲染分支；与现有 `param/pin/color/confirm` 模式的状态机交互要清晰。
- 过滤期间的数字键/方向键语义。

**判断**：已放弃。

### 3.9 提示语言统一

**现状**

- 大多数 CLI 提示为英文；聚合/运行时相关新增提示为中文（`main.ts`、`drift.ts`、`stack/state.ts`、部分 doctor 输出）。

**目标**

- 统一为**英文**（自然语言提示），不引入 i18n 运行时：命令名、flag、配置键、路径与上游原始输出同样保持英文。

**推荐方案**

1. **语言定为英文**：项目是 npm 公开包，`description`、README.md、issue/PR 均以英文为主，现有 CLI 提示也大多为英文；新增的中文提示（`main.ts`、`drift.ts`、`stack/state.ts`、部分 doctor 输出）逐步改回英文，作为唯一提示语言。
2. **统一格式**：成功 `✓`、失败 `✗`；错误统一为 `<action> failed: <reason>`。
3. **盘点**：`grep -rn "console\.(log|error)" src/` 逐条过一遍，按文件分批替换，控制 diff 规模。
4. **分两个 PR**：先命令模式（launch/sync/doctor/ps/clean/customize/update），再 TUI 提示、空状态与确认文案。
5. **同步测试**：现有断言多为英文/中文字串，改为匹配新文案的固定片段（不匹配整句），与代码同 PR 提交。
6. **不翻译**：转发给被启动 CLI 的参数与输出、`ps`/`tmux` 字段、DB/文件系统错误原文；保留原文，只在外面套英文前缀。
7. **验收**：`npm test` 全绿；`switch --help` 与 README/README_ZH 中的示例输出同步。

**风险**：低；但会改动大量字符串与测试断言，且可能影响用户脚本对输出的 grep（在 CHANGELOG 注明）。

**判断**：纯打磨；建议在 E 的其他命令落地后单独一个 PR 做。

### 3.10 `ps` 批量查询性能

**现状**

- `runPs` 对每个实例调用一次 `queryProviderById`（每次启动一个 sqlite3 进程）。
- `buildRunningSet`/`sessionLiveness` 对每个 session 调用 `ps`（lstart 校验可能再查一次）。
- 当前会话数量下延迟为几十毫秒，可接受。

**目标（可选）**

- 一次 `SELECT id,name FROM providers` 构建 id→name 映射。
- 一次 `ps -p pid1,pid2,... -o pid=,lstart=` 批量校验。

**判断**：不必要；等会话数量/延迟成为问题再做。

### 3.11 Windows 支持

**现状**

- 依赖 `ps(1)`、`sqlite3` CLI、`/bin/sh`（编辑器与 statusline relay）、符号链接权限。
- 文档未声明 Windows 支持。

**判断**：明确不支持即可；除非有实际 Windows 用户需求。

### 3.12 catalog 模板维护

**现状**

- `resources/gpt5_5_template.json` / `codex_native_responses_template.json` 固定模型元数据（reasoning levels、tools 等）。
- 上游 Codex 模型更新时需要手动跟进。

**判断**：按上游变化维护；可加 doctor 检查模板版本/字段。

## 4. 建议范围

### 最小 E —— 已完成（PR #58，v0.25.0）

1. ✅ `switch list [--json] [--app]`
2. ✅ `switch ps --json`

两项共享“收集 → 渲染”的结构，同一 PR 完成。

### 按实际需求选择 —— 已完成（PR #58，v0.25.0）

- ✅ **频繁管理并行 tmux 会话** → `ps kill/attach`。
- ✅ **经常排查实例配置** → `launch --dry-run`（前置 flag，含 `--diff` / `--show-secrets`）。
- ✅ **CI/自动化** → `doctor --json`；`doctor --fix`（严格白名单，见第 7 节）。

### 建议延后 —— 未做

- shell completion、ps 性能优化、Windows 支持、catalog 模板跟进。

### 已放弃

- **Copilot 并行路由**：使用者不再使用 Copilot（2026-10-20）。
- **TUI 搜索/过滤**：provider 数量保持较小（2026-10-20）。

## 5. 不属于 E 的遗留项（复核后状态）

| 项目 | 类型 | 现状 |
|---|---|---|
| 同名 provider 静默取第一个 | **已过时 / 已修复** | 文档原说法不成立：`queryProvider` 已不再执行 `ORDER BY id LIMIT 1`，且生产代码无调用（已删除）。launch / dry-run / customize 均走 `queryProviderMatches` + `resolveProviderRef` 并报歧义。v1 history 迁移已改为“同名不绑定 + 一次性警告”，not-found 提示改为输出 `id  name`。 |
| CI 仅 Ubuntu + Node 22 | 工程 / **已修复** | CI 矩阵改为 Node 18.20.8 / 20 / 22 / 24（`push main` 也触发）；新增 Biome lint 与原生 test coverage（85/79/82）；publish 前执行 typecheck/test/build。测试脚本改为 `node --import tsx --test`，Node 18/20 可运行（本地需 ≥18.18）。 |
| `noImplicitAny: false` | 工程 / **未做** | 开启后 464 个错误、25 个文件（前 5 文件占 54%）；单独立项，采用一次性修复，不做 `@ts-nocheck` 棘轮。 |
| `stack/state.ts ↔ stack/catalog.ts` 循环导入 | 工程 / **已修复（最小）** | 抽出 `src/stack/aggregation.ts`，state 不再 import catalog，公开面不变。剩余 `db ↔ state ↔ history` 与 13 文件 SCC 记录为后续独立项。 |
| `main.ts` 的 update/__test 面 | 工程 / **已修复** | 实际 `runUpdate` 为 46 行（连同 helper 89 行），`__test` 为 108 项且 107 项只是转出口。已抽出 `commands/update.ts` 与 `commands/args.ts`，20 个测试改为直接 import 源模块，`__test` 已删除。 |
| catalog 模板字段跟进 | 维护 | 上游模型更新时手动同步。 |

## 6. 验收标准（已实施项）

- `list` / `ps --json`：字段稳定、只读、无控制字符；`npm test` 新增对应单测。
- `ps kill/attach`：只操作本工具记录且 lstart 匹配的会话；二次确认；失败明确报错。
- `doctor --fix`：严格白名单（断链、缺失实例目录、基线缺失）；`doctor --json` 可被 `jq` 解析。
- `launch --dry-run`：不写实例文件、不启动 CLI、不计入 history；默认脱敏 token。
- **help 完整性（硬性要求）**：所有 `switch` 命令、子命令与 flag（含 `--json`、`--app`、`--fix`、`--dry-run`、`--id`、`--sync/--no-sync` 等）都必须出现在 `switch --help` 中，含一行用法与简短说明；新增/修改命令的 PR 必须同时更新 `printHelp()`、命令缺参时的 `Usage:` 提示和 README_ZH。help 中不得出现未实现或已移除的命令。实施 E 的相应项后逐一核对：
  - `switch list [--json] [--app claude|codex]`
  - `switch ps [--json]`、`switch ps kill <pid|index> [--force]`、`switch ps attach <index>`
  - `switch doctor [--json]`
  - `switch --dry-run [--diff] [--show-secrets] <provider> <cmd> [args...]`
  - `switch completions zsh|bash|fish`（若实施）
- **README 完整性（硬性要求）**：`README.md` 与 `README_ZH.md` 都必须为**每一个**命令写清楚：用途、完整语法（含所有 flag 与别名）、行为与输出、典型示例、失败/边界场景。新增或修改命令的 PR 必须同步两份 README，且两份内容结构保持一致。README 中不得出现已移除/未实现的命令。

## 7. 当前状态与剩余待办（2026-10-20）

### 已完成

- **任务 6–11 命令扩展**：PR #58，`v0.25.0`（已合并并发布）。
  - `list [--json] [--app]`、`ps --json`、`ps kill/attach`、`doctor --json`、`--dry-run [--diff] [--show-secrets]`
  - help 分组 + 两份 README 全命令说明 + 防漂移测试
- **第 5 节遗留项**：PR #59，`v0.25.1`（已合并并发布）。
  - 删除死 API `queryProvider`；v1 history 迁移同名不绑定 + 一次性警告；not-found 输出 `id  name`
  - CI 矩阵 Node 18.20.8 / 20 / 22 / 24 + Biome lint + coverage（85/79/82）+ publish 门禁
  - 断开 `stack/state.ts ↔ stack/catalog.ts` 循环（`src/stack/aggregation.ts`）
  - `main.ts` 抽出 `commands/update.ts` / `commands/args.ts`；`__test` 退场

- **`ps kill` / `ps attach` 真实 tmux 验收**（2026-10-20，tmux 3.8）：在独立验收 session 中确认了 tmux 内 `attach`（`switch-client` + `select-pane`）、表格 tmux 列、交互 kill 的取消与确认、`--force` SIGTERM、非 tmux 非 TTY 报错、tmux 不在 PATH 报错，以及伪造 `lstart` 的会话不会被误杀（只清理会话文件）。tmux server 不存在的分支仍由单测覆盖（当前环境无法在不影响现有 server 的情况下模拟）。

- **P1 增强**（本 PR，`v0.26.0`）：
  - `doctor --fix` 严格白名单（断链、缺失实例目录、基线缺失；基线仅在实例内容与当前推导完全一致时补记）
  - 用户可见提示统一为英文（命令模式与 TUI；功能性正则保留）
  - `smol-toml` 1.7.1 → 1.9.1，并在解析包装层把 null-prototype 结果还原为普通对象

### 流程剩余

无。本地与远端已合并分支已于 2026-10-20 清理。

### E 其他未做

| 项 | 状态 | 说明 |
|---|---|---|
| shell completion | 延后 | 命令集仍小；动态 provider 补全需限制 DB 调用 |
| `ps` 批量查询性能 | 不做 | 当前延迟可接受 |
| Windows 支持 | 不做 | 依赖 `ps` / `sqlite3` / `/bin/sh` 与软链 |
| catalog 模板跟进 | 按需 | 上游模型更新时同步 |

### 单独立项（第 5 节剩余）

- `noImplicitAny`：464 个错误、25 个文件；一次性修复，不做 `@ts-nocheck` 棘轮。
- 完整 aggregation 抽取：把 loopback / 签名判定搬入 `aggregation.ts`，`usage.ts` 复用。
- 剩余循环依赖：`db ↔ state ↔ history`、13 文件 SCC。
- `main()` 路由进一步拆分（163 行，本次未动）。
- formatter 未启用（仅 lint）。

## 8. 不在本文范围

- A–D 已完成的正确性/安全/并发/终端修复，不再重复。
- 与本仓库无关的 cc-switch 桌面端功能。
