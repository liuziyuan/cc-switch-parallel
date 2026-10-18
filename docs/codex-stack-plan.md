# Codex 聚合（Stack）支持

> **状态：已落地（v0.21.0，`feat/codex-stack`）。** 本文写于 0.20.0 虚拟 provider 重构之前，
> 「自动建行 `ensureCodexStackProviderRow`（DB INSERT）」「新建行当次不可见修复」「补
> `probeTcpReachable`」「版本 0.18/0.19」等描述已过时——实际实现按
> [`docs/virtual-provider-plan.md`](virtual-provider-plan.md) §5 的路线：`VIRTUAL_STACK_APPS`
> 扩展 + `buildCodexStackSettingsFromGlobal` 虚拟行派生，不落 DB。白名单投影、身份保护键、
> catalog 原样复制、loopback+PROXY_MANAGED 签名等设计决策均已按本文实现。

## Context

桌面端 cc-switch 4.0 已经为 Codex 开启了聚合模式，运行时状态齐全：

- `~/.cc-switch/live-state.json`：`apps.codex.stack.enabled = true`，成员为 DeepSeek + Z.AI GLM；
- `~/.codex/config.toml`：`model_provider = "custom"`、`base_url = "http://127.0.0.1:15721/v1"`、`experimental_bearer_token = "PROXY_MANAGED"`、`requires_openai_auth = false`；
- `~/.codex/cc-switch-model-catalog.json`：4 个模型，成员 ID 规则为 `ccs-<stack key>/<model>`（如 `ccs-deepseek/deepseek-flash`），路由供应商 Z.AI 的模型不带前缀。

但 `cc-switch-parallel` 的聚合适配是 **claude only**（`bin/cc-launch.mjs` 中 `runTUI` 的 `if (adapter.appType === "claude")`，以及 `ensureStackProviderRow` 硬编码 `app_type='claude'`）。结果是：

- `switch codex` 的 provider 列表没有 Stack 行；
- 从该列表启动的 Codex 实例使用各 provider 的真实上游，不经过 15721 聚合代理；
- 用户无法在并行 Codex 实例里跨 DeepSeek / Z.AI GLM 切模型。

GUI 隐藏 Stack 的独立方案（把聚合行移出 DB、改为运行时虚拟 provider）已拆分到 [`docs/virtual-provider-plan.md`](virtual-provider-plan.md)。

> 基线提醒：当前工作区在 `fix/statusline-refresh-and-sideby-side` 分支，`bin/cc-launch.mjs` / `test/usage-statusline.test.mjs` 有约 70 行未提交改动（statusline refresh 优化）。实施前需先提交这部分工作，或另开 worktree，避免混入同一 PR。

---

## 范围 A：Codex 聚合支持（本仓库）

### 目标

1. 桌面端 Codex 聚合开启且 DB 无聚合行时，自动创建一行 Codex 聚合 provider（名称 `Stack`，冲突则 `Stack 2`）；
2. TUI 列表把该行下沉并标注 `◆ 聚合 · Stack（DeepSeek + Z.AI GLM）`，栈关闭时标 `（未激活）`；
3. 从该行启动的实例正确投影 `config.toml`、`auth.json`、`cc-switch-model-catalog.json` 到聚合代理；
4. common 配置合并时保护聚合身份键；
5. prepare 与 guard 的 `computeEffectiveSettings` 推导一致，catalog 变化不触发 drift。

### 关键设计决策

1. **catalog 原样复制，不重新生成**
   - 现有 `codexModelCatalogFromSettings` / `codexCatalogModelEntry` 只抽取 6 个输入字段、以 `gpt5_5_template.json` 为底重新生成，会丢失全局 catalog 中 11 个关键键（`comp_hash`、`use_responses_lite`、`multi_agent_version`、`auto_compact_token_limit`、`tool_mode` 等）以及原始 display name / priority。
   - 聚合行 `settings_config` **不存** `modelCatalog`；`prepare` 在写 `config.toml` 后读取 `~/.codex/cc-switch-model-catalog.json` 原始文本，校验 `models` 为非空数组后原子写入实例目录同名文件。
   - 全局 catalog 缺失/损坏：保留实例已有副本，打印警告；`model_catalog_json` 始终固定为常量，保证 prepare/guard 推导不受文件存在性影响。

2. **聚合行只投影路由身份白名单**
   - 抄：`model_provider`、`model`、`[model_providers.<id>]` 的 `name/base_url/wire_api`、`model_catalog_json`、`web_search`。
   - 强制：`experimental_bearer_token = "PROXY_MANAGED"`、`requires_openai_auth = false`、`auth = {}`。
   - 不抄：`[projects.*]`、`[hooks.state.*]`、`[tui]`、`[tui.model_availability_nux]`、`model_reasoning_effort` 等运行时/通用偏好，避免固化进行并触发 drift。

3. **聚合行识别签名**
   - `base_url` 为 loopback **且** `experimental_bearer_token === "PROXY_MANAGED"`，避免把用户自己的本地网关误判为聚合行。
   - 签名不依赖 live-state，保证 prepare 行为确定性；live-state 只用于自动建行门控和 TUI 标签。

4. **身份保护键**
   - 硬保护（行有则恢复，行无则删除）：`model_provider`、`model_providers.<id>` 整张表、`model_catalog_json`、`web_search`、顶层 `base_url/wire_api/experimental_bearer_token/requires_openai_auth`。
   - 软保护：`model`（行有值时行值优先，行缺失时保留 common）。
   - 整表恢复可防止 common 通过 `env_key`、`http_headers` 等旁路认证键劫持代理。

5. **auth**
   - 聚合行 `auth = {}`；现有 prepare 会软链全局 `~/.codex/auth.json`（不存在则写 `{}`），不会写入真实 key。
   - `buildCodexConfig` 对聚合行强制跳过 bearer 注入，防止误配的 `OPENAI_API_KEY` 覆盖 `PROXY_MANAGED`。

### 实施阶段

| 阶段 | 内容 | 预计生产代码 |
|---|---|---:|
| 1. 纯函数与签名 | `codexSettingsDoc`、`codexActiveProvider`、`isCodexAggregationProviderSettings`、`sanitizeCodexAggregationProviderTable`、`protectCodexAggregationIdentity`、`readGlobalCodexCatalogText` | 80–120 行 |
| 2. 配置生成与实例投影 | `buildCodexConfig` 增加聚合分支（强制 common 合并 + 身份保护 + 跳过 catalog 重生成 + 跳过 bearer 注入）；codex `prepare` 复制全局 catalog | 60–90 行 |
| 3. 自动建行与 TUI | `ensureCodexStackProviderRow`；抽出泛型 `buildAggregationGroup(appType, capability)`；adapter 增加 `aggregation` 能力；`runTUI` 去掉 claude-only 分支；修复新建行当次不可见（`providers` 改 `let` 并在建行后重新查询） | 90–130 行 |
| 4. 启动探测 | 复用/补 `probeTcpReachable`（当前基线没有，可先合入 `feat/proxy-health-and-doctor`，或本 PR 内补约 20 行）；`launchProvider` 按 `adapter.aggregation.rowBaseUrl` 探测 | 5–25 行 |
| 5. 文档与版本 | 更新 `README_ZH.md` 聚合章节；版本 bump（若 `feat/proxy-health-and-doctor` 已占用 0.18.0，则本 PR 用 0.19.0） | 15–25 行 |

### 新增/修改的关键位置

- 新增函数集中在 `bin/cc-launch.mjs` 的聚合段（`ensureStackProviderRow` 附近）与 Codex 配置段（`buildCodexConfig` 附近）。
- 修改：`readStackState`（可选返回 `contract`）、`buildCodexConfig`、codex adapter `prepare`、`APP_ADAPTERS.claude/.codex`、`runTUI`、`launchProvider`、`__test` 导出。
- 不动：`CODEX_SHARED_PATHS`、`setupCodexInstance`、`guardInstanceConfigBeforeOverwrite`、baseline 记录（catalog 不纳入 drift）。
- 新建测试：`test/codex-stack.test.mjs`，沿用 `test/sync-codex.test.mjs` 的临时 HOME + sqlite fixture 模式。

### 代码量估算

| 类别 | 行数 |
|---|---:|
| 生产代码 `bin/cc-launch.mjs` | **300–440 行** |
| 新增测试 `test/codex-stack.test.mjs` + 现有微调 | **400–650 行** |
| 文档 | **15–25 行** |
| 合计 | **约 750–1100 行** |

工作量约 **1–2 人日**（含手工端到端验证）。不含 Codex statusline wrapper / usage 分桶——Codex 原生状态栏不支持外部命令（上游 #17827），这块无法移植，也不在本次范围。

### 验证

1. `npm test`（`node --test test/*.test.mjs`）全绿。
2. 手工：桌面端 Codex 聚合开启 → 打开 `switch codex` 列表 → 自动出现 `◆ 聚合 · Stack（DeepSeek + Z.AI GLM）`；启动后实例 `config.toml` 的五元组正确、catalog 与全局字节一致；`/model` 列表含 4 个模型；选 `ccs-deepseek/...` 后请求经 15721 路由。
3. 关闭聚合后：TUI 标签显示 `（未激活）`，启动给出代理不可达警告但不阻断。
4. 回归：普通 Codex provider 仍从 `settings_config.modelCatalog` 生成 catalog，行为不变。
5. 改动走 PR（不直接 push main）。

---

## 风险

1. **catalog schema 漂移**：原样复制天然兼容，不要模板重生成。
2. **全局 config 非 loopback**：不自动建行，避免死行；按 loopback 通配，不硬编码 15721。
3. **真实凭据进入聚合行**：投影只用白名单并强制 `PROXY_MANAGED`；prepare 强制 `auth={}`。
4. **common 误配/恶意植入**：整表恢复 `model_providers.<id>` 并删除顶层回退身份键。
5. **TUI 新建行当次不可见**：修复 `runTUI` 的 stale provider 列表。
6. **上行 drift 写坏聚合行**：建议对聚合行过滤身份路径，或至少在 README 说明聚合行由桌面端管理。
7. **分支并发**：当前工作区有未提交的 statusline 改动；实施前先提交/另开 worktree。`probeTcpReachable` 仅在 `feat/proxy-health-and-doctor`，需协调合并顺序与版本号。
