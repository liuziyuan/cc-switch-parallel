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

**Recent (top 5)：** CLI 界面会列出最常用的 5 个启动组合，按 `a s d f g` 一键快速启动；按使用次数排序，每行尾部显示最近一次使用时间（`· 2h`、`· 3d` 等）。命令模式启动（`switch "X" claude …`）同样计入排序；快捷启动会重放当时的完整参数——上次带 `--continue` 启动，这次按快捷键也会带 `--continue`（带额外参数的行会以 `· +args` 标出）。

**置顶是持久的。** 高亮 Recent 行按 `t` + 数字 `1`–`5` 钉入对应槽位（provider 界面的 `t` 仍然可用——钉完会直接进入启动模式选择，选完即以该模式启动）；被钉的行带 `*` 标记，跨启动保持位置，直到按 `u` 取消置顶。条目以供应商 id 为键：在 cc-switch 中改名不会丢槽位和历史次数，Recent 自动跟随显示新名字。

**改启动模式：** 高亮 Recent 行按 `e`，再选 `⏎` Default / `2` Semi-auto / `3` Full-auto，即可就地修改该条目的启动模式（非权限参数如 `--continue` 保留）。

已在 cc-switch 中删除的供应商仍会列在 Recent 中，但以红色 `✗ missing` 标出——此时无法启动，按 Enter（或对应快捷键）会提示是否将其从 Recent 移除（`y` 确认）。失效条目排序靠后、不挤占有效条目，按 `c` 可一键清理全部失效条目。也可以主动删除任意条目：高亮后按 `x`，再按 `y` 确认。

Full-auto（`⚠`）的快捷启动行会先确认再以 `--dangerously-skip-permissions` 启动；provider 界面选 Full-auto 不再二次确认——那条路径本身已是两次明确按键。

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
switch ps         # 列出正在运行的、由 switch 启动的会话
switch sync       # 检测并同步配置漂移（插件、配置字段、通用配置）
switch doctor     # 诊断环境（sqlite3、数据库、二进制、instructions 文件等）
switch clean      # 删除实例目录（交互式，或 --all）
switch customize [claude|codex] <provider>           # 实例级 CLAUDE.md / AGENTS.md（打开编辑器）
switch uncustomize [claude|codex] <provider> [--yes] # 恢复共享的全局 instructions 文件
switch update     # 自更新到最新 npm 版本
switch --help     # 列出所有命令
```

`switch ps` 每个会话一行 —— 同一 provider 并发跑多个终端时各占一行，互不覆盖：

```
  claude  P&G Nezha      cc-switch-parallel  ~/workspace/personal/cc-switch-parallel  up 3m
  claude  P&G Nezha      RFP2                ~/workspace/company/daneng/RFP2         up 2d
```

第三列是 tmux 会话名（不在 tmux 里运行时回退显示终端 tty），第四列是启动时所在的项目目录（`~` 缩写）。

## 配置漂移与同步

**心智模型：配置在启动时向下下发，你在会话里改的东西应该能被收回来。** `switch` 每次启动都从 cc-switch 数据库生成各实例的配置——会话内的改动是唯一的例外，同步机制就是为收编它而存在的。上行通道覆盖 Claude 实例 `settings.json` 与 Codex 实例 `config.toml` 的**全部字段**：插件状态、生成的 statusLine 与 Codex 的 `[tui] status_line`（三者均为 channel 专属，见下文）之外的 env、permissions、hooks、模型、审批策略等都会被检测、展示、按字段归属写回。Codex CLI 自己写入实例 `config.toml` 的**运行时状态**（`projects.*` 项目信任、`hooks.state.*` hook 信任哈希、`tui` 下的一次性标记）不属于用户配置，上行同步与覆盖守卫都会忽略它们；它们由启动路径单独携带——每次重新生成 `config.toml` 时从现有文件原样保留，因此 hook 授权与项目信任不会因重启丢失，也不会再触发同步提示。改动展示为字段路径（dotted path），确认后按**智能拆分**写回——通用配置里已有的字段写回 `common_config_<app>`（否则下次启动时通用配置的旧值会盖掉它），其余写回该 provider 的配置。Codex 的通用配置是 TOML 文档，确认通用方向的写回会重新序列化整个文档——`common_config_codex` 里的注释与排版会丢失（确认前提示会明确告知）。

即使你不做同步，`switch` 在覆盖实例主配置文件（`settings.json` / `config.toml`）之前也会自动把它**备份**到 `~/.cc-switch/backups/<app>/<provider-id>/`（保留最近 10 份），并在 stderr 警告即将被覆盖的字段——改动永不静默丢失。升级说明：本机制需要实例级基线（`preparedSettings`）；升级前做出的会话内改动无法被识别，只会被备份兜底。

Codex 的凭据文件与 Claude 同构：OAuth（ChatGPT 登录）型实例 symlink 共享的全局 `~/.codex/auth.json`（首次启动用 DB 里的登录材料做种子），CLI 在会话内刷新的 token 从此在每次重启后都还在——按实例独立拷贝会被 DB 旧值覆盖、强制重新登录。API-key 型实例保留独立的真实文件。`settings.preserveCodexOfficialAuthOnSwitch` 可退出该行为、回到旧的按实例拷贝。代价：使用**不同** ChatGPT 账号的多个 provider 无法各自持有独立登录态。

`switch` 会保存一份它上次看到的配置快照（`~/.cc-switch/sync-state.json`），并在每次启动时检测两类漂移：

- **下行** —— cc-switch 的*通用配置*（`common_config_claude` / `common_config_codex`）在桌面端被改动。陈旧状态**按实例跟踪**：警告会指出具体哪些 provider 还在用旧配置。确认同步（y）会就地重新生成这些实例的配置文件并刷新基线，提示随之消失；**正在运行的会话**仍需重启才能用上新配置（这正是提示里 "restart to apply" 的含义）。`switch clean` 删除实例目录时也会同步清掉它的基线，陈旧提示不会再点名已删除的 provider。
- **上行** —— 在 `switch` 启动的会话里改动配置，分两个通道收编：
  - **插件**（仅 Claude——Codex 没有插件概念）：安装、移除或切换（`/plugin`），写回 `common_config_claude.enabledPlugins`。多个实例状态冲突时，只有插件状态被真实修改过的实例才有投票权（旧通用配置的陈旧镜像没有）；被修改过的实例之间，以最近的改动为准。
  - **配置字段**：非插件字段（Claude 的 env、permissions、hooks、模型等；Codex 的模型、审批策略、MCP 服务器等）按叶子级 diff 展示（数组按整块比较——元素级合并在 RFC 7396 下没有可靠原语），确认后按智能拆分写回。仲裁与插件通道同语义：与基线一致的镜像实例无票，各字段的胜者是最新修改（mtime）的实例。已知限制：某字段在通用配置中存在、但你只想改单个 provider 时，它仍会写进通用配置、波及所有启用通用配置的 provider——这是「通用配置覆盖 provider」合并语义下唯一不丢改动的选择。例外：含凭据命名的敏感字段（`*_TOKEN` / `*_KEY` / `*SECRET*` 等）不会被写回通用配置——改动保留在实例内，需在桌面端手动更新；从通用配置删除敏感字段则不受限。Codex 的写回基于存储文本的 compare-and-swap（CAS）：桌面端并发写入永远不会被覆盖——最坏情况是提示你重跑 `switch sync`。

在 **TUI 模式**下，漂移会在 CLI 选择器之前展示，你可以就地确认同步。在**命令模式**下，它是在 stderr 上的非阻塞警告 —— 运行 `switch sync` 来查看并应用，加 `--sync` 可在启动前就地确认，加 `--no-sync` 则完全抑制警告。首次运行会静默记录一份基线，因此已有的插件永远不会被报告为「新增」。

## 实例 statusline（provider 标签）

每个由 `switch` 启动的 Claude 实例都会在状态栏里显示**当前运行的是哪个 provider**：生成的 `settings.json` 自带一个 statusLine，其 wrapper 脚本在模型名前打上 `[provider]` 标签（每个 provider 颜色稳定）——配合 claude-hud 的效果是 `[Zhipu GLM en][Opus] │ myproject`——然后**原样转发你自己的全局 statusLine**：claude-hud、ccstatusline、手写脚本，任何配置在 `~/.claude/settings.json` 里的工具都照常工作。Claude Code 传给 statusline 的 JSON 原样透传，全局工具渲染出的内容与直接启动时完全一致；provider 标签是 `switch` 唯一添加的东西（若 statusline 首字符不是模型名、或根本没配 statusline，标签就放在行首）。

- **你的全局 `~/.claude/settings.json` 永远不会被改动，生成的 statusLine 也不会被同步回 cc-switch 数据库**——`statusLine` 是 channel 专属路径（与插件同机制）：覆盖守卫忽略它，上行同步对它让权。全局换任何 statusline 工具，所有实例下次启动自动跟随。
- 全局没有配 statusline？实例就只显示 provider 标签。
- 在 cc-switch 的 provider 或通用配置里显式写的 `statusLine` 会被**包装而非替换**：生成的条目指向 wrapper，你的显式命令被内联为 wrapper 的首选转发源（全局 `~/.claude/settings.json` 作为回退）。刻意的配置照常渲染——provider 标签照样添加。
- **标签颜色在 TUI 里设置**：provider 选择屏高亮某行后按 `o`，从 auto（按名字哈希，默认）+ 16 个 ANSI 经典色（30–37 标准、90–97 亮色，带色块预览）中选取，⏎ 保存、esc 取消。存于 `~/.cc-switch/statusline-preferences.json`（本 CLI 独有——cc-switch 桌面端与数据库都不读不写），下次启动该 provider 的实例时生效，运行中的会话保持旧色直至重启。claude 的颜色由 wrapper 消费；codex 的颜色由 tmux 状态栏消费（见下节）。
- 在实例**内部**自定义 statusline（`/statusline`）没有意义——该条目每次启动都会重新生成。请改全局配置文件。

### Codex 的状态栏

Codex CLI 的状态栏是**原生内置字段选择式**（`config.toml` 的 `[tui] status_line`，需 Codex ≥ 0.105.0），不支持外部命令渲染——所以 Codex 实例的 TUI 内没有 provider 标签（等上游 [openai/codex#17827](https://github.com/openai/codex/issues/17827) 支持后跟进）。`switch` 每次启动会保证状态栏开启并显示有用的字段：向实例 `config.toml` 注入 `[tui] status_line = ["model-with-reasoning", "current-dir"]` 与 `status_line_use_colors = true`。**只填充缺失的键**——你在 provider/通用 TOML 里显式写的值优先（`status_line = []` 即关闭）；注入的子树与 Claude 的 statusLine 同为 channel 专属：覆盖守卫忽略、上行同步让权、永不写回数据库。模型名通常能间接区分 provider（各 provider 绑定的模型不同），但同模型多账号的场景区分不了。

**TUI 内没有，tmux 状态栏上有**：若你在 tmux 里使用 [tmuxclihook](https://github.com/liuziyuan/tmux-claude-hooks-status)（≥ 0.4.0），`switch` 启动每个 CLI 会话时都会注入 `CC_SWITCH_PROVIDER` / `CC_SWITCH_PROVIDER_ID` 环境变量，CLI 的 hooks 进程会继承它们；tmuxclihook 捕获后在状态栏聚合行里渲染彩色 `[provider]` 段——claude 与 codex 都显示，同一 pane 换非 switch 启动的 CLI 时自动清除。标签颜色与 claude wrapper 同源（`statusline-preferences.json`，provider 界面按 `o` 设置），改色后状态栏下一次刷新即生效，无需重启会话。

## 聚合模式（cc-switch 4.0）

cc-switch 4.0 的**聚合模式**（代号 Stack）在本地起一个 HTTP 代理（默认 `127.0.0.1:15721`），把多家供应商的模型以 `ccs-claude-<key>--<model>` id 发布进 Claude Code 的 `/model` 列表，客户端内即可无感切换。`switch` 不进入/退出该模式（那是桌面端的动作），而是把它**当作并行中的一员来消费**——tmux 里 `[Z.AI GLM] [DeepSeek] [聚合]` 三类实例并存互不影响。

**使用方式**：在 cc-switch 桌面端开启聚合（选定默认供应商、加入成员供应商）后，TUI 的 provider 列表尾部会出现 `◆ 聚合 · Stack（DeepSeek + Z.AI GLM）` 分组。聚合入口是一个**运行时虚拟 provider 行**（固定 id `__stack__`）：不写入 cc-switch 数据库（桌面端 GUI 不会显示任何 CLI 生成的行），每次打开 TUI / 启动时从 live-state 与全局 `~/.claude/settings.json` **现算**最新路由契约（base URL、ccs 别名、modelPicker）——桌面端改代理端口、切换默认供应商或清空模型列表后无需任何同步步骤，下次操作即生效。选中它启动即得到聚合实例：`/model` 里多家供应商的模型同列（Claude Code ≥ 2.1.243），recent、pin、`o` 配色、`● live`、`switch ps` 与普通 provider 完全一致——`ps` 还会在聚合实例名后显示当前计费成员（`Stack → DeepSeek`，解码自该实例 `/model` 的最新选择）。

聚合实例的 statusline 有两点跟随模型切换：

- **计费段**：wrapper 在运行时从模型 id 解出 `ccs-claude-<key>--` 前缀，按 key 用**该成员自己的凭据直连其真实 origin** 查询计费（zhipu 5h/周窗口、DeepSeek 余额）——计费流量不经聚合代理，代理也不参与。无前缀的模型 id 走默认供应商；key 未登记时并列显示所有可识别成员的用量段。
- **provider 标签**：TUI 内标签动态跟随当前计费供应商（`[DeepSeek]` / `[Z.AI GLM]`）；tmux 状态栏标签仍显示启动时的 provider 名（`Stack`）——两者语义不同：tmux 标识「此 pane 是聚合实例」，TUI 标签标识「当前计费供应商」。

**限制与注意**：

- 聚合代理随 cc-switch 桌面进程生灭——桌面端退出后聚合实例会指向已死的代理地址（上游退出时只恢复全局配置，不会碰 `switch` 的实例文件），重开桌面端即恢复。`switch` 启动聚合实例前会对代理地址做一次 300ms TCP 探测，不可达时在 stderr 警告（不阻塞启动）；`switch doctor` 亦含聚合检查（live-state 契约版本、成员行在位、虚拟入口派生、代理可达性）。
- `/model` 的聚合列表来自桌面端写进全局 `~/.claude/settings.json` 的 `modelPicker` 键；`switch` 在每次启动聚合实例时从全局同步它，所以桌面端改聚合名单后**重进实例**即可见（运行中的会话不自动跟）。桌面端把列表清空（恢复内置模型）同样是合法状态——实例的聚合列表随之清空，不会沿用旧快照。
- 聚合入口只承载路由（loopback 地址、代理凭据、`ccs` 模型别名），不含通用配置内容——`switch` 启动聚合实例时**始终合并通用配置**（hooks、permissions 等，与普通 provider 一致）；路由身份 env（`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`）与 `ccs` 模型别名以聚合入口为准，通用配置覆盖不了它们。在桌面端对聚合行显式关闭「使用通用配置」仍然生效。
- 桌面端关闭聚合后，聚合入口仍在（TUI 显示「未激活」；成员行已删时显示「N 个成员缺失」），实例照常启动但代理不在——请回到普通 provider 实例。聚合实例的 `/model` 不再列指向死代理的 ccs 旧条目。
- 实例编辑写回（`switch sync`）对聚合入口不生效：provider 侧改动会被标记为 blocked 并说明原因（虚拟行不落库，实例配置每次启动由桌面端状态重新生成）；落在通用配置上的改动照常写回。
- **从 ≤ 0.19 升级**：首次运行会自动清理旧版写入数据库的聚合 provider 行（幂等），并把启动历史、置顶与 statusline 颜色迁移到虚拟 id `__stack__`；正在桌面端使用中的聚合行（is_current）会保留并提示。运行中的旧聚合实例不受影响，其 UUID 目录在会话结束后可用 `switch clean` 清理。
- Codex 侧暂不支持（其模型目录机制需彻底重启，玩法受限）。

## 工作原理

1. 从 `~/.cc-switch/cc-switch.db`（SQLite，由 cc-switch 管理）读取 provider 配置；聚合（Stack）入口除外——它是运行时虚拟行（id `__stack__`），由 live-state 与全局配置现算，不落库
2. 复刻 cc-switch 的 Rust 后端逻辑：通用配置的 JSON/TOML 深度合并、清理、Codex 模型目录生成
3. 在 `~/.cc-switch/instances/<app>/<provider-id>/` 创建每个 provider 的实例目录
4. 写入隔离的 `settings.json` / `config.toml` / `auth.json` / `cc-switch-model-catalog.json`
5. 从全局 `~/.claude/` 软链接共享资源（插件、技能、项目、凭据）—— **零数据复制**
6. 设置 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 并 `exec` 启动 CLI

### 实例目录布局

```
~/.cc-switch/instances/claude/<provider-id>/
  ├── settings.json           ← 从数据库生成（按 provider 隔离）
  ├── statusline-wrapper.mjs  ← 生成的 statusline 脚本（provider 标签 +
  │                              转发你的全局 statusline 工具）
  ├── .credentials.json → ~/.claude/.credentials.json  （软链接，共享）
  ├── projects → ~/.claude/projects                      （软链接，共享）
  ├── plugins → ~/.claude/plugins                         （软链接，共享）
  └── ...其他软链接（skills、cache、commands 等）

~/.cc-switch/instances/codex/<provider-id>/
  ├── config.toml             ← 从数据库生成（按 provider 隔离）
  ├── auth.json → ~/.codex/auth.json    （OAuth 登录为软链接——唯一活副本，
  │                                token 刷新永不丢失；API-key 型为独立真实文件）
  ├── AGENTS.md → ~/.codex/AGENTS.md    （软链接，共享——customize 会将其替换
  │                                为可编辑的实例级文件）
  └── ...其他软链接（skills、rules、cache 等）
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

`setupInstance` 创建实例目录 + 软链接，`prepare` 生成配置文件，`launch` 启动 CLI，`permissionArgs` 映射权限快捷键。其余一切都是**能力驱动**的：覆盖守卫、同步流程、备份、customize 从不按 `appType` 分支——adapter 按层声明接口即可接入：

- `instanceSettingsFileName` / `readInstanceSettingsSnapshot` / `computeEffectiveSettings` —— 实例基线 + 覆盖守卫（备份、警告、自愈回填）
- `parseCommonSnippet` / `providerDocFromSettingsConfig` / `channelOwnedPath` / `detectSettingsDrift` / `syncSettingsBack` —— 配置字段上行通道；`detectSettingsDrift` 只是一行委托给共享的 `detectConfigDriftGeneric` 管线（叶子 diff、mtime 仲裁、智能拆分），仅写回因存储格式而异（Claude 走 JSON `json_patch`；Codex 走 TOML 重序列化 + compare-and-swap）
- `detectPluginDrift` / `syncPluginsBack` / `readInstancePluginState` —— 插件通道（仅 Claude；Codex 没有插件概念）
- `instructions` —— customize/uncustomize 支持（CLAUDE.md 走活的 `@import`；AGENTS.md 走可刷新的标记快照——Codex 没有 import 机制）
- `fullAutoFlag` —— TUI Full-auto 确认文案里原样展示的 flag

缺少某个接口的 adapter 在该层就是 "v2 形状"，自然跳过——添加 Gemini 意味着填你想要的那些行，而不是去改守卫/同步的机器。

## 系统要求

- [cc-switch](https://github.com/farion1231/cc-switch) 桌面应用，并已配置 provider
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI（`claude`）在 PATH 中
- [Codex](https://github.com/openai/codex) CLI（`codex`）在 PATH 中（可选，用于 Codex 支持）
- Node.js ≥ 18
- `sqlite3` CLI（macOS 已预装）

## License

MIT
