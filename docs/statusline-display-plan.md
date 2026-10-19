# Statusline 显示内容配置（TUI）— 需求与设计

> 状态：已实现（待 PR）。本文档记录需求、设计决策与验证口径。
>
> 目标版本：0.23.0（功能 PR，按仓库规则 bump + 走 PR）。

## 1. 背景与目标

当前 `switch` 为每个 Claude 实例生成的 statusline wrapper 只做三件事：

1. 在最前面加 `[provider]` 标签；
2. 原样转发全局 `~/.claude/settings.json` 里配置的 statusline 工具（claude-hud、ccstatusline、手写脚本）；
3. 把 Z.AI 的 5 小时 / 周用量、DeepSeek 余额注入到转发行的 context 段之后。

当用户**没有配置全局 statusline**时，状态栏就只有 `[provider]` 标签和用量段，缺少模型名、项目名、git 分支、context 用量。

本功能目标：

- 在没有全局 statusline 时，由 wrapper 自己绘制这些基础内容；
- 显示项可在 TUI 中开关；
- 检测到 claude-hud 时**优先 claude-hud**，新增内容不叠加，只保留 provider 标签与现有用量段（用量段可关）；
- 配置字段名尽量对齐 claude-hud，渲染风格与 claude-hud 保持一致，方便用户在两者之间切换；
- 改动即时生效，不需要重启会话。

## 2. 已确认的产品决策

| 决策点 | 结论 |
| --- | --- |
| claude-hud 检测方式 | 读全局 `~/.claude/settings.json`，`statusLine.type === "command"` 且 `command` 含 `claude-hud` |
| 检测到 claude-hud 时保留什么 | `[provider]` 标签 + 现有用量段；新增的模型 / 项目 / git / context 全部不渲染；用量段可由开关关闭 |
| 自绘布局 | 两行，对齐 claude-hud expanded：第一行 `[模型] 项目 git:(分支*)`，第二行 `Context 条 % │ 5h … · W …` |
| 设置作用域 | 全局一套（所有 Claude provider 共用），存 `~/.cc-switch/statusline-preferences.json` 新增 section；key 命名对齐 claude-hud |
| TUI 入口 | provider 选择屏高亮任意行后按 `s`，与 `o`（标签颜色）并列 |
| 生效时机 | wrapper 运行时读取 preferences，改完下一次状态栏刷新即生效 |
| 默认开启项 | 模型名、项目名、git 分支、context 用量（用量段沿用现状默认开启） |
| 细节档位 | claude-hud 默认档：context 条形 + 百分比（70/85 阈值）；`git:(分支*)` 带 dirty 星号；项目只显示最后一段；模型保留原始 `display_name` |

## 3. 行为规格

### 3.1 模式判定

wrapper 每次渲染时按以下顺序判定：

1. 取 relay 命令：
   - provider 配置里显式写的 `statusLine` 被内联为 `RELAY_COMMAND`（优先）；
   - 否则读全局 `~/.claude/settings.json` 的 `statusLine.command`。
2. 若 relay 命令存在：
   - **不自绘新增项**（无论它是 claude-hud 还是其他工具），保持现有行为：`tag + relayed + 用量注入`；
   - 若命令小写后包含 `claude-hud`，判定为 `claude-hud`，否则判定为 `other`。
3. 若 relay 命令不存在：进入**自绘模式**，按 preferences 的开关渲染。

判定结果同时用于 TUI 面板顶部的提示文案。

**为什么不叠加到其他 relay**：无法知道第三方工具画了什么，叠加容易重复内容。只有完全没有 relay 时才由我们接管整行。

### 3.2 自绘布局

```
[Zhipu GLM][Opus 5.5] myproject git:(main*)
Context ███████░░░ 45% │ 5h ███░░░░░ 40% · W ████░░░░ 52%
```

第一行：

- `[provider]`：现有逻辑与颜色设置不变。
- `[模型]`：青色（`36`），紧跟 provider 标签（沿用现有 glue 规则）。
- `项目`：黄色（`33`），`stdin.cwd` 的最后 `pathLevels` 段（默认 1 段）。
- `git:(分支*)`：`git` 字面洋红（`35`），分支青色（`36`），dirty 星号跟随分支色；非 git 仓库、git 命令失败或超时时整段隐藏。
- 空的项自动省略，顺序固定：模型 → 项目 → git。

第二行：

- `Context` 标签 dim；条形宽度默认 10 格；`showContextBar=false` 时只显示 `Context 45%`。
- context 颜色阈值与 claude-hud 默认一致：`<70` 绿（`32`）、`70–84` 黄（`33`）、`>=85` 红（`31`）。
- context 与用量之间用 ` │ `；用量内部 5h 与 W 之间用 ` · `（沿用现有注入段风格）。
- 用量段继续使用现有 Z.AI / DeepSeek 逻辑、缓存与阈值（Z.AI：`>=90` 红、`>=70` 黄；DeepSeek 余额 `<10` 红、`<20` 黄）。
- context 无数据时省略 context；用量无数据时省略用量；两者都无则不输出第二行。

### 3.3 数据来源与计算规则

| 内容 | 来源 | 规则 |
| --- | --- | --- |
| 模型名 | statusline stdin `model.display_name` | 为空时用 `model.id`；聚合实例若 id 形如 `ccs-claude-<key>--<model>`，去掉前缀显示 `<model>`；保留原始后缀（如 `(1M context)`） |
| 项目名 | `cwd`（回退 `workspace.current_dir`） | 按 `/` 与 `\` 切分，取最后 `pathLevels` 段；空值隐藏 |
| git 分支 | 在 cwd 执行 git | `git -c core.fsmonitor=false --no-optional-locks status --porcelain=v2 --branch -z --ignore-submodules=dirty`，1000ms 超时；解析 `# branch.head`；`(detached)` 时依次尝试 `git describe --tags --exact-match HEAD`、`detached:<oid7>`；存在非 `#` 记录即 dirty |
| context | stdin `context_window` | tokens = `current_usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens`；优先使用 `used_percentage`（有限且 >0），否则 `tokens / context_window_size * 100`；四舍五入并 clamp 到 0–100；无数据（0 / 缺失）隐藏 |
| 用量 | 现有 Z.AI / DeepSeek API | 完全复用现有缓存、SWR、阈值与错误退避；`showUsage=false` 时跳过读取与网络请求 |

性能预算：每次渲染至多一次 git 调用（1s 超时）；usage 走现有缓存（新鲜命中零网络）。与 claude-hud 自身每次渲染的做法一致。

### 3.4 与 claude-hud / relay 共存

| relay 状态 | 第一行 | 后续行 | 新增项 | 用量段 |
| --- | --- | --- | --- | --- |
| 无 relay | 自绘 | 自绘第二行 | 按开关渲染 | 按开关 |
| relay 含 `claude-hud` | `[provider]` + relay 输出 | relay 多行原样输出 | 不渲染 | 按开关注入到 relay 的 context 行；关闭时完全不注入 |
| relay 为其他工具 | 同上 | 同上 | 不渲染 | 同上 |

- claude-hud 存在时，`display.showUsage=false` 会同时跳过 usage 的 fetch、后台刷新和注入，避免无意义网络请求。
- 不做任何对全局 `~/.claude/settings.json` 的写入；现有 channel 专属路径规则不变。

## 4. 配置文件

路径：`~/.cc-switch/statusline-preferences.json`（本 CLI 独占）。在现有 `colors` 旁边新增字段：

```json
{
  "version": 1,
  "colors": {
    "claude": { "<providerId>": "36" },
    "codex": {}
  },
  "display": {
    "showModel": true,
    "showProject": true,
    "showContext": true,
    "showContextBar": true,
    "contextValue": "percent",
    "showUsage": true,
    "usageBarEnabled": true,
    "usageValue": "percent",
    "showTokenBreakdown": true,
    "modelFormat": "full"
  },
  "gitStatus": {
    "enabled": true,
    "showDirty": true,
    "showAheadBehind": false,
    "showFileStats": false
  },
  "pathLevels": 1
}
```

约定：

- 字段名与 claude-hud 对齐：`display.showModel`、`display.showProject`、`display.showContextBar`、`display.contextValue`、`display.showUsage`、`display.usageBarEnabled`、`display.usageValue`、`display.modelFormat`、`gitStatus.*`、`pathLevels`。
- `display.showContext` 是 claude-hud 没有的显式开关（claude-hud 用 `elementOrder` 控制 context 行是否出现）；这里单独加，语义更直接。
- `contextValue`、`usageValue`、`usageBarEnabled`、`modelFormat`、`showTokenBreakdown` 本期只实现 `percent` / `true` / `full` 行为，字段先保留，允许用户手改；后续再补 `tokens` / `remaining` / `both` / `compact` 等模式。
- `gitStatus.showAheadBehind`、`showFileStats` 本期不渲染，字段保留（完整档后续实现）。
- `version` 保持 1：新增字段全部可选，旧版 CLI 读到新文件只会忽略未知字段；读取时缺字段用默认值。
- 任何读取失败（缺失、损坏、类型错误）都 fail-open 到默认值（全部开启）。
- 写入沿用现有文件锁 + 原子写；颜色与显示项共享同一个文件，互不覆盖。

## 5. TUI 交互

### 5.1 入口

provider 选择屏（已有 `o` 设置标签颜色的那一层）高亮任意行后按 `s`，进入全局 statusline 设置面板。

### 5.2 面板

检测到 claude-hud 时的实际渲染：

```
◆ Statusline display

  ⚡ claude-hud is active — model / project / git / context are rendered by claude-hud
  Locked rows are supplied by claude-hud; turn it off to use the built-in renderer

  ❯ ● Model name  on · via claude-hud
    ● Project name  on · via claude-hud
    ● Git branch  on · via claude-hud
    ● Context usage  on · via claude-hud
    ● Provider usage (Z.AI / DeepSeek)  on

↑↓ navigate   space/⏎ toggle   esc back
```

- 五项：模型名、项目名、git 分支、context 用量、用量段。
- `↑↓` / `j k` 移动；空格或 `⏎` 切换并立即写文件；`esc` 返回 provider 屏。
- 保存失败时在提示行显示 `✗ Failed to save statusline preference`。
- **检测到 claude-hud**：
  - 顶部用黄色加粗 + `⚡` 高亮 `claude-hud is active`；
  - 前四项锁定（空格无效，光标仍可移动），值保留 on/off 并追加 ` · via claude-hud`；
  - 增加一行说明：`Locked rows are supplied by claude-hud; turn it off to use the built-in renderer`；
  - 用量段保持可切换，不加来源标注。
- **检测到其他 relay**：同样锁定与高亮，来源标注为 ` · via statusLine`，说明行为 `remove it to use the built-in renderer`。
- **未检测到 relay**：顶部用 dim 显示 `Self-drawn statusline — all switches apply (effective immediately)`，五项均可切换。
- 检测在打开面板时计算一次（读取全局 `~/.claude/settings.json`）。
- 高亮的是 Codex provider 时按 `s` 仍可打开同一面板，但追加黄色提示：`Codex has no external statusline yet — these switches apply to Claude instances only`。
- 面板行由纯函数 `buildStatuslinePanelLines` 生成，便于单元测试（TUI 无伪 TTY 测试）。

### 5.3 生效

- preferences 不内联进 wrapper；wrapper 每次执行时读取。
- 改完开关后，下一次状态栏刷新（Claude Code 自身的状态栏刷新间隔，通常约 1 秒）即按新设置渲染。
- 标签颜色仍是下次启动生效，行为不变。

## 6. 实现落点

| 文件 | 改动 |
| --- | --- |
| `src/statusline-colors.ts` | 扩展为 preferences 模块：新增 `loadStatuslineDisplay()`、`saveStatuslineDisplay(key, value)`、`detectStatuslineRelayTool()`；复用现有锁与原子写。若实现时觉得文件名不贴切，可拆出 `src/statusline-prefs.ts`，但必须保持同一文件的并发语义 |
| `src/statusline.ts` | `buildStatusLineWrapperScript` 注入 preferences 路径与 relay 检测；新增自绘 tail 生成函数；改造 usage tail（runtime 读 `showUsage`，关闭时跳过 fetch/注入）；保持 stack（聚合）实例的 ccs key 解码与 tag 跟随逻辑 |
| `src/tui.ts` | 新增 `statusline` 模式、光标索引、`canStatusline` / `onStatusline` 回调；`s` 键；面板渲染与置灰逻辑 |
| `src/main.ts` | 向 provider 层传入 statusline 设置回调与检测结果 |
| `src/paths.ts` | 无改动（复用 `STATUSLINE_PREFS_PATH`） |
| `README_ZH.md` / `README.md` | 「实例 statusline」章节补充自绘模式、TUI `s` 面板、claude-hud 检测与让位、配置 key 说明 |
| `package.json` | `0.22.0` → `0.23.0` |

实现约束：

- `prepare` 与 guard 的 `computeEffectiveSettings` 两条路径生成的 `settings.json` 必须仍然完全一致。preferences 只在 wrapper **运行时**读取，不参与 wrapper 内容生成，因此不影响两条路径的一致性。
- wrapper 仍是单文件、无外部依赖，逻辑以字符串模板生成（与现有 `buildUsageWrapperLines` 风格一致）。
- 自绘逻辑必须同时覆盖普通 provider 与聚合（Stack）实例；聚合实例的模型名按 3.3 的 ccs 前缀规则处理。

## 7. 边界与失败模式

| 场景 | 行为 |
| --- | --- |
| preferences 缺失 / 损坏 / 字段非法 | 全部使用默认值（开启），不影响启动与渲染 |
| 非 git 仓库 / 无 git / 超时 | 隐藏 git 段，其他内容正常；不报错、不阻塞 |
| context 数据为 0 或缺失 | 隐藏 context；第二行只剩余用量或无第二行 |
| usage 请求失败 | 现有沉默行为：不显示用量；后台退避不变 |
| relay 配置存在但执行失败 / 输出为空 | 仍按「有 relay」处理，不自绘（保持行为可预测）；只有标签与可用的用量段 |
| 宽度不足 | 不做主动截断/换行，交给 Claude Code 的 statusline 渲染与终端处理（与现状一致） |
| 配置了 provider 级内联 statusLine | 视为 relay，同样让位；不叠加自绘内容 |
| Codex 实例 | 本期不适用（Codex 原生 statusline 不支持外部命令）；TUI 面板只影响 Claude |

## 8. 测试计划

1. **wrapper 生成单测**：自绘 tail 包含模型/项目/git/context/usage 片段；无 relay 时走自绘；有 relay 时不包含自绘片段；`showUsage=false` 时不生成 fetch 调用。
2. **wrapper 端到端**：临时 HOME + 临时 git 仓库，喂入构造的 stdin JSON，断言：
   - 两行输出与颜色码符合规格；
   - 非 git 仓库隐藏 git 段；
   - `used_percentage` 与 `current_usage` 两条 context 计算路径；
   - 检测到 claude-hud 时输出等于「tag + relay 输出 + 用量注入」；
   - 各开关关闭后的输出。
3. **preferences**：读取 fail-open、并发写（扩展现有 `statusline-prefs-concurrency.test.mjs`）、颜色与显示项互不覆盖。
4. **TUI**：`s` 进入/esc 退出、切换写入、检测到 relay 时前四项置灰（扩展 `tui-color.test.mjs` 的交互测试模式）。
5. **回归基线**：现有 `statusline.test.mjs` 中断言「无 usage 时 wrapper 字节一致」的用例需要按新模式更新；更新前确认这些断言的真实意图，不要放宽到失去保护。
6. 全量 `npm test` + `npm run typecheck`；注意 `node --test` 的句柄泄漏，测试开头清理共享表。

## 9. 明确不做

- 不解析 transcript，不实现 token breakdown / 会话 token 统计 / 工具、Agent、Todo 等活动行。
- 不在 claude-hud 或其他 relay 存在时叠加任何新增项。
- 不修改全局 `~/.claude/settings.json`，不把 statusline 配置写回 cc-switch 数据库。
- 不做 Codex 的 TUI 内 statusline（受上游 openai/codex#17827 限制）。
- 不新增 `switch statusline` 子命令；入口只在 TUI。
- 不新增第三方依赖。

## 10. 已确认的 4 个细节

以下细节已按 review 结论确定，实现与测试均以此为准：

1. **其他 relay 与 claude-hud 一视同仁**：只要存在任意 relay（provider 内联或全局配置，不只是 claude-hud）就不自绘新增项；TUI 面板区分提示 `claude-hud` 与 `other`，但不做针对 ccstatusline 的格式解析或特殊兼容。
2. **第一行 model 与 project 之间用一个空格**：`[Opus 5.5] myproject git:(main*)`。
3. **自绘第二行的用量风格沿用现有注入段**：`5h ███ 40% · W ████ 52%`（不使用 claude-hud 的 `Usage … | Weekly …`）。
4. **relay 配置存在但执行失败/输出为空时仍不让位回退**：`HAS_RELAY` 只由「是否配置了命令」决定；这样布局不会在 relay 偶发失败时跳变，也尊重 `CLAUDE_HUD_DISABLE=1` 等故意输出空的行为。
