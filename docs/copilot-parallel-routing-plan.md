# 让 Copilot 与 Claude Official 在 switch 下并行运行(不依赖 cc-switch 桌面本地路由)

## Context(为什么做这个改动)

用户同时使用两套工具:

1. **cc-switch 桌面应用**(farion1231/cc-switch):通过"本地路由(local proxy)"切换供应商。开启 `enableLocalProxy` 后,它启动一个本地 HTTP 代理(Axum,`127.0.0.1:端口`),并调用 `takeover_live_config_strict` **备份并改写全局 `~/.claude/settings.json`**,把 `env.ANTHROPIC_BASE_URL` 指向本地代理。代理负责注入 Copilot 的 GitHub OAuth token、格式转换、故障转移。
2. **本项目 `cc-switch-parallel`(`switch` 命令)**:理念是"每终端独立隔离",通过 `CLAUDE_CONFIG_DIR` 让不同终端同时用不同供应商,互不切换。

冲突核心:cc-switch 桌面的本地路由是**全局接管**模式,且 `official_provider_supports_proxy_takeover` 对 **Claude 官方返回 false**(只对 Codex 官方返回 true)。因此:
- 开本地路由 → Copilot 能用(代理注入 token),但 Claude Official 在托盘被禁用(自身 OAuth 不应走代理)。
- 关本地路由 → Claude Official 能用,Copilot 不能用(无代理注入 GitHub OAuth token,直连 `api.githubcopilot.com` 会 401)。

这与 `switch` 命令"并行运行多供应商"的目标直接违背。

**调查结论**:问题可解决。`switch` 已用 `CLAUDE_CONFIG_DIR` 隔离实例(写自己的 `settings.json`、symlink `.credentials.json`),**Claude Official 实例完全不受全局接管影响**(已验证:DB 里 Claude Official `settings_config={}`,实例 settings.json 为空,走默认 `api.anthropic.com` + symlink 来的 OAuth)。唯一缺失的是 **Copilot 的 token 注入**——cc-switch 桌面代理只在内存里持有 Copilot JWT(不落盘),`switch` 作为独立 Node 进程读不到。磁盘上 `~/.cc-switch/copilot_auth.json` 只存**长期 GitHub OAuth token**(`ghu_*`)。

**解决思路**:在 `switch` 内置一个**进程级轻量本地代理**,只为当前终端的 Copilot 实例服务:用 `copilot_auth.json` 里的 GitHub token 换取短期 Copilot JWT(复刻 cc-switch 的 `fetch_copilot_token_with_github_token`),给每个请求注入 Copilot 需要的一组 editor headers,透传到 `api.githubcopilot.com`。代理随 `claude` 进程退出而销毁。Claude Official 走原路径不触发代理,两者 `CLAUDE_CONFIG_DIR` 不同、互不影响,且**不依赖 cc-switch 桌面本地路由的开关状态**。

## 关键事实(调查所得)

- Copilot token 换取端点:`GET https://api.github.com/copilot_internal/v2/token`,Header `Authorization: token <github_token>` + `User-Agent: GitHubCopilotChat/0.38.2` + `Editor-Version: vscode/1.110.1` + `Editor-Plugin-Version: copilot-chat/0.38.2`。响应 `{token, expires_at}`,到期前 60 秒需刷新(cc-switch 源码 `src-tauri/src/proxy/providers/copilot_auth.rs:1330-1383`)。
- 账号选择:provider `meta.authBinding.accountId`(或 `meta.githubAccountId`)指定用哪个 GitHub 账号,回退 `copilot_auth.json` 的 `default_account_id`。
- Copilot 注入的 headers(`src-tauri/src/proxy/forwarder.rs:1627-1670` + `providers/claude.rs:918-958`):`Authorization: Bearer <copilot_token>`、`editor-version`、`editor-plugin-version`、`copilot-integration-id: vscode-chat`、`user-agent: GitHubCopilotChat/0.38.2`、`x-github-api-version: 2025-10-01`、`openai-intent: conversation-agent`、`x-initiator: user`、`x-interaction-type: conversation-agent`。
- Copilot `apiFormat: "anthropic"`(DB meta 已确认)→ 端点直接接受 `/v1/messages`,**无需格式转换**。
- Claude Code 的 `settings.json.env` 只能设环境变量,无法设任意 HTTP headers → **直连 + 环境变量 token 不可行**(缺 editor headers 会被 401/403)。必须走代理。
- GHES 特例:`is_ghes(domain)` 为 true 时直接用 GitHub token 作 Bearer 不换 Copilot token。本项目场景是 github.com,需换取。GHES 留 TODO。

## 要改的文件

**仅 `/Users/liuziyuan/work/home/cc-switch-parallel/bin/cc-launch.mjs`**(单文件项目)。无需改 cc-switch 桌面应用,无需新增独立文件(代理逻辑内嵌)。

## 实现步骤

### 1. 新增 Copilot token 换取与缓存

在 `cc-launch.mjs` 的 Claude 配置生成区(约第 257-295 行 `buildClaudeEffectiveSettings` 附近)后新增:

- `readCopilotAuthStore()`:读 `~/.cc-switch/copilot_auth.json`,返回 `{accounts, default_account_id}`。
- `resolveCopilotAccount(meta)`:按 `meta.authBinding.accountId` / `meta.githubAccountId` 选账号,回退 `default_account_id`,返回 `{github_token, github_domain, account_id}`。文件缺失或账号缺失 → 抛错并提示"请先在 cc-switch 桌面应用登录 GitHub Copilot 账号"。
- `fetchCopilotToken(githubToken, domain)`:Node `fetch` 调 `https://api.github.com/copilot_internal/v2/token`,401→"GitHub token 过期,请在 cc-switch 重新授权",403→"该账号无 Copilot 订阅",返回 `{token, expires_at}`。
- `getValidCopilotToken(account)`:进程内缓存 token,`expires_at - now > 60` 直接复用,否则刷新(串行 `await`,单进程无需锁)。

### 2. 新增轻量 HTTP 代理

在"CLI 启动"区(约第 714 行)前新增 `startCopilotProxy(account, upstreamBase)`:

- `import http from "node:http"`(放文件顶部 import 区)。
- `http.createServer(async (req, res) => {...})`:
  - `await getValidCopilotToken(account)` 取 token。
  - 收集 body(`for await (const c of req)`),`new URL(req.url, upstreamBase)` 拼上游。
  - `fetch(upstreamUrl, {method, body, headers})`,headers 注入上述 Copilot 一组 headers + 白名单透传客户端的 `content-type`/`accept`/`anthropic-version`/`anthropic-beta`(不透传 `x-api-key`/`authorization`,避免污染)。
  - `res.writeHead(upRes.status, ...)`,**流式 pipe**:`upRes.body.getReader()` 循环 `read()` + `res.write()`,支持 SSE(`/v1/messages` 流式响应不能 `await text()`)。
  - catch → `502`。
- `server.listen(0, "127.0.0.1")` → resolve `server`(OS 分配端口,`server.address().port` 取回)。

### 3. 改 `launchClaude`(第 721-733 行)接入代理

- 改 `launchClaude` 为 `async`(调用方 `launchProvider` 第 887 行已是 `async`,加 `await`)。
- 顶部加 `isCopilot` 判断:`meta?.providerType === "github_copilot" || meta?.authBinding?.authProvider === "github_copilot" || effective?.env?.ANTHROPIC_BASE_URL?.includes("githubcopilot.com")`。
- Copilot 分支:`resolveCopilotAccount` → 预换 token(失败则报错退出,不启动 claude)→ `startCopilotProxy(account, effective.env.ANTHROPIC_BASE_URL)` → 把 `effective.env.ANTHROPIC_BASE_URL` 改写为 `http://127.0.0.1:<port>` → `atomicWrite` settings.json → `spawnSync("claude", ...)`(保持原 `CLAUDE_CONFIG_DIR=instanceDir`)。
- 非 Copilot 分支:原路径不变。
- `spawnSync` 后 `process.exit`,代理 server 随进程销毁,无需显式关闭。

### 4. 边界处理

- `copilot_auth.json` 缺失/账号缺失 → 清晰报错 + 不启动。
- GitHub token 401 → 提示去 cc-switch 重新授权。
- 多终端并行同一 Copilot 账号:各自进程独立代理、独立换 token(`/copilot_internal/v2/token` 支持并发),`CLAUDE_CONFIG_DIR` 与端口均不同,隔离。
- 多终端不同 Copilot 账号:按 `accountId` 区分,天然隔离。
- Claude Official 与 Copilot 并行:Official 不触发代理(无 `providerType: github_copilot`),走原路径;两者 `CLAUDE_CONFIG_DIR` 不同,互不影响。
- cc-switch 桌面本地路由同时开启:桌面接管改写全局 `~/.claude/settings.json`,但 switch 用 `CLAUDE_CONFIG_DIR` 隔离的实例 settings.json(不读全局),不受影响。`copilot_auth.json` 双方只读 `github_token`,token 缓存各自进程内,无写冲突。
- GHES:暂不支持,留 TODO(检测到 `github_domain !== "github.com"` 时报错提示)。
- `settings.local.json` 覆盖:实例 symlink 了全局 `settings.local.json`,若用户手写 `env.ANTHROPIC_BASE_URL` 会覆盖实例 settings.json → Copilot 模式下检测并警告。

## 验证(端到端)

1. **token 换取单独验证**:`node -e` 调 `fetchCopilotToken`,确认能拿到 Copilot JWT(不碰代理)。
2. **代理转发验证**:`startCopilotProxy` 起来后,用 `curl -N` 打代理 `/v1/messages`,确认 SSE 流式转发正常、无 401。
3. **端到端**:`switch "GitHub Copilot" claude` → 能正常对话。
4. **并行验证**(核心目标):同时开两个终端:
   - 终端 A:`switch "GitHub Copilot" claude`
   - 终端 B:`switch "Claude Official" claude`
   - 两者各自正常工作,互不影响。
5. **独立性验证**:把 cc-switch 桌面本地路由开关切换(开→关、关→开),重跑步骤 4,确认两个终端均不受影响。
6. **既有功能回归**:`switch "Zhipu GLM en" claude`、`switch "P&G Nezha" codex` 等非 Copilot 路径仍正常(未走代理)。

## 复用的现有逻辑

- `cc-launch.mjs` 的 `setupClaudeInstance`(第 652 行)、`buildClaudeEffectiveSettings`(第 283 行)、`atomicWrite`(第 706 行)、`ensureSymlink`(第 592 行)直接复用,不改。
- token 换取的协议参数(GitHub OAuth client、editor headers、`/copilot_internal/v2/token` 端点、60 秒刷新缓冲)复刻自 cc-switch 源码 `src-tauri/src/proxy/providers/copilot_auth.rs`,不自己发明。
