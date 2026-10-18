# 虚拟 Provider 方案：把聚合 Stack 行移出 cc-switch DB

## 1. 前因

### 1.1 当前实现

Claude 聚合（Stack）由 `ensureStackProviderRow()` 在打开 `switch` TUI 时自动创建：只要 `~/.cc-switch/live-state.json` 中 `apps.claude.stack.enabled === true`，且 DB 里还没有 loopback 聚合行，就向 `~/.cc-switch/cc-switch.db` 的 `providers` 表 `INSERT` 一行：

- `env.ANTHROPIC_BASE_URL` 指向 `127.0.0.1:15721`；
- `ANTHROPIC_AUTH_TOKEN = "PROXY_MANAGED"`；
- 四个 `ANTHROPIC_DEFAULT_*_MODEL` 别名；
- 全局 `settings.json` 的 `modelPicker` 快照；
- `meta = {}`，名下默认 `Stack`（冲突则 `Stack 2`）。

这样做的原因是：聚合实例需要一个 **provider id**，而项目里几乎所有路径都以 provider id 为键——实例目录、启动历史、statusline 颜色、同步、guard、TUI 列表。把行放进 DB，等于零成本复用整套机制。

### 1.2 引发的问题

- `~/.cc-switch/cc-switch.db` 是 **cc-switch 桌面端与 CLI 共用的真源**，所以这一行会出现在桌面端 GUI 的 provider 列表里。
- 它不是用户创建的配置，而是 CLI 自动生成的“启动身份”，出现在 GUI 中会造成困惑。
- 上游 `farion1231/cc-switch` 4.0.15 **不支持隐藏已保存的 provider**：
  - `providers` 表没有 `hidden/visible/archived/deleted` 字段；
  - GUI 的 provider 列表只有搜索过滤、排序、删除；
  - 唯一名为 `hidden` 的是“添加供应商”对话框里的预设隐藏；
  - `visibleApps` 隐藏的是整个 app，不是单个 provider。
- 直接删除 DB 行不可行：只要桌面端聚合仍开启，下次打开 `switch` TUI 时 `ensureStackProviderRow()` 会再次插入；而且删掉后 `switch` 里的启动入口也没了。

用户的实际诉求是：**桌面端 GUI 不显示 Stack，但 `switch` TUI 保留聚合入口。**

### 1.3 为什么不继续走“上游加 hidden”

- 需要给上游提 PR，周期不可控；
- 通用 `hidden` 字段与“系统自动行”的语义并不完全一致；
- 更根本的问题是：CLI 的内部启动身份本不该写进桌面端的真源。把它移出去，GUI 自然就不会显示，也不需要依赖上游。

---

## 2. 核心结论

**Stack 不必须存在于 DB 中。** CLI 需要的只是一个可寻址的 provider 身份，而这个身份可以在运行时合成。

聚合行的全部输入都可以从桌面端已有的状态派生：

| 内容 | 来源 |
|---|---|
| 是否开启、成员、key 路由、默认路由 | `~/.cc-switch/live-state.json` 的 `apps.<app>.stack` |
| Claude 路由身份与模型列表 | 全局 `~/.claude/settings.json` 的 `env` / `modelPicker` |
| Codex 路由身份 | 全局 `~/.codex/config.toml` |
| Codex 模型目录 | 全局 `~/.codex/cc-switch-model-catalog.json` |

因此**推荐纯运行时派生**，不落 DB，也不额外落配置文件：

- 不产生第二真源，不存在“桌面端改了、配置文件过期”的同步问题；
- `switch` TUI 每次打开都反映最新状态；
- 桌面端 GUI 完全看不到虚拟行；
- Codex 聚合可以复用同一套机制，不必再写 `ensureCodexStackProviderRow`。

如果确实需要持久化，配置文件中只应保存**不可派生的用户偏好**（例如是否显示聚合入口、固定虚拟 id），不要缓存路由身份或模型列表。

---

## 3. 现状依赖清单

虚拟 provider 不是“零成本”改动，因为以下路径都假设 provider 一定来自 DB：

| 路径 | 当前依赖 | 虚拟化后的处理 |
|---|---|---|
| `queryProvider` / `queryProviderById` / `queryProvidersByApp` | 启动按名称/id 查 DB；TUI 全量读 DB | 查询层合并虚拟行 |
| `queryProvidersStrict` / `snapshotAliveByCli` / `isDeadEntry` | 启动历史的存活判定只用 DB 行 | 虚拟 id 必须纳入 alive 集合，否则历史会被判 dead 并清理 |
| 实例目录 | `instances/<app>/<providerId>/` | 使用固定虚拟 id |
| `recordLaunch` / `launch_history.json` | 按 `cli|providerId` 记录、去重、清理 | 固定虚拟 id 可正常工作，但需清理白名单 |
| `statusline-preferences.json` | 按 providerId 存颜色 | 固定虚拟 id 可正常工作 |
| `syncStackManagedRow` | 启动前把桌面端 live 契约同步回 DB 行 | 改为每次从 live-state 现算，不写 DB |
| guard / `detectConfigDriftGeneric` / `splitChangesByTarget` | 实例编辑按 providerId 写回 DB 行 | 虚拟行跳过写回，只提示或丢弃 |
| `runTUI` | 先查 DB，再对聚合行分组 | 直接使用合并后的虚拟行 |
| 现有 DB 中的 Stack 行 | GUI 会显示 | 一次性清理，并移除 `INSERT` |

---

## 4. 目标设计

### 4.1 虚拟身份

- 固定 id：`__stack__`（`providers` 主键是 `(id, app_type)`，Claude/Codex 各一行，互不冲突）；
- 名称：`Stack`；
- 实例目录：`~/.cc-switch/instances/<app>/__stack__/`；
- 虚拟行标记：内部字段 `is_virtual: true`，不写入 DB、不参与写回。

### 4.2 派生函数

新增 `virtualProviderFor(appType)`，返回与 DB row 同形的对象：

```js
{
  id: "__stack__",
  app_type: appType,
  name: "Stack",
  settings_config: "<JSON 字符串>",
  meta: "{}",
  category: null,
  is_virtual: true,
}
```

- Claude：`settings_config` 由 live-state + 全局 `settings.json` 派生（loopback env、四个模型别名、`modelPicker`）；
- Codex：`settings_config` 由 live-state + 全局 `config.toml` 派生（`model_provider`、`model_providers.<id>` 的 `base_url/wire_api`、强制 `PROXY_MANAGED` / `requires_openai_auth=false`、`model_catalog_json` 常量），`auth = {}`。

栈未开启时：仍可返回虚拟行，但标记“未激活”，TUI 标签显示 `（未激活）`；是否允许启动由用户决定（与现有行为一致：行仍可启动，只是代理不路由）。

### 4.3 查询层合并

- `queryProvider`（按名称）与 `queryProviderById`：DB 未命中时回退到虚拟行；
- `queryProvidersByApp`：DB 结果 + 虚拟行，排序时聚合行沉底；
- `queryProvidersStrict` / `snapshotAliveByCli`：把虚拟 id 加入 alive 集合；
- 保持现有 fail-open 语义：DB 不可用时不能因为虚拟行逻辑而报错。

### 4.4 启动与同步

- `launchProvider` 通过合并查询拿到虚拟行，后续 `setupInstance` / `prepare` / `recordLaunch` 照常执行；
- `syncStackManagedRow` 改为“现算虚拟行”，不写 DB；
- drift/guard 检测到虚拟行的实例编辑时：不写回 DB，给出提示（聚合行由桌面端状态驱动，实例配置每次 prepare 会重建）。

### 4.5 TUI

- 直接列出虚拟行，标签 `◆ 聚合 · Stack（DeepSeek + Z.AI GLM）`；
- 栈关闭时 `◆ 聚合 · Stack（未激活）`；
- 不再需要“建行后重新查询”的修复，因为虚拟行在查询阶段就已存在。

### 4.6 旧行清理

- 移除 `ensureStackProviderRow()` 的 `INSERT`（保留投影/派生逻辑）；
- 检测并删除旧 DB 聚合行（签名：loopback base URL + `PROXY_MANAGED`），避免 GUI 继续显示；
- 清理应幂等，并打印一次提示；也可放进 `switch doctor --fix`。

---

## 5. 与 Codex 聚合的关系

- Codex 聚合不再需要 `ensureCodexStackProviderRow` / DB 行，直接复用虚拟 provider 层；
- 建议拆成两个 PR：
  1. **虚拟 provider 重构**：Claude 先行，保证启动、历史、颜色、同步、TUI 全回归；
  2. **Codex 聚合**：在虚拟层上接入 Codex 的配置投影与 catalog 复制；
- 若合并为一个 PR，至少分 commit，并按项目规则 bump 版本（minor）。

---

## 6. 代码量估算

| 项 | 行数 |
|---|---:|
| 虚拟行派生 + 查询层合并 | 60–100 |
| 启动 / sync / guard / 历史适配 | 80–140 |
| TUI + 旧行清理 | 30–60 |
| **生产代码合计** | **200–350** |
| 测试 | 300–500 |
| 文档 | 20–40 |
| **总计** | **约 550–900 行** |

工作量约 **1–2 人日**，主要成本在回归验证，而不是新增代码。

---

## 7. 风险

1. **核心查询层回归**：`queryProvider*` 被启动、TUI、doctor、usage 等多处调用，合并逻辑必须保持 fail-open。
2. **启动历史误清**：虚拟 id 未纳入 alive 集合时，`isDeadEntry` 会把聚合启动记录判死并清理。
3. **双源边界**：虚拟行只读派生，绝不能写回 DB；guard/drift 必须显式跳过。
4. **旧行清理**：签名判定要足够严格（loopback + `PROXY_MANAGED`），避免误删用户自己的本地网关 provider；清理要幂等。
5. **上游行为变化**：如果桌面端未来也把聚合行写进 DB，会与虚拟行重复，需要明确“CLI 不写 DB”的约定。
6. **并发改动**：当前工作区正在被另一会话修改（`fix/statusline-refresh-and-sideby-side`，含 `syncStackManagedRow`、`probeTcpReachable` 等未提交内容），实施前需先收敛。

---

## 8. 验证

### 单测

- 查询层合并：DB 有/无聚合行、虚拟行优先级、DB 不可用 fail-open；
- alive 快照包含虚拟 id，历史不清空；
- 虚拟行启动：实例目录为 `__stack__`，config 正确；
- drift/guard 对虚拟行不写 DB；
- TUI 标签：成员名、未激活态；
- 旧行清理幂等且不误删本地网关。

### 手工

1. 清理旧 Stack 行后打开桌面端 GUI：provider 列表不再出现 Stack；
2. 打开 `switch` TUI：仍能看到 `◆ 聚合 · Stack（…）`；
3. 启动：实例目录为 `~/.cc-switch/instances/<app>/__stack__/`，配置指向 15721，`/model` 列表正确；
4. 启动历史与 statusline 颜色按虚拟 id 正常保留；
5. 关闭桌面端聚合：标签显示“未激活”，启动给出代理不可达警告但不阻断；
6. 普通 provider 的列表、启动、同步行为不变；
7. `npm test` 全绿。

---

## 9. 迁移与回滚

- **迁移**：先移除 `ensureStackProviderRow` 的写入，再清理旧行；两步都需幂等。
- **回滚**：保留虚拟层实现，可通过开关回退到“DB 行”模式；或直接 revert 本 PR（旧行会在下次 TUI 打开时自动重建）。
- **版本**：按项目规则 bump minor，走 PR，不直接 push main。
