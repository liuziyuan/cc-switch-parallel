#!/usr/bin/env node
// switch: Claude Code / Codex 多供应商并行启动器
//
// 用法:
//   switch                                 # TUI 交互模式:先选 CLI 再选供应商
//   switch <provider> <cmd> [args...]     # 命令模式:直接指定供应商和 CLI
//
// 从 ~/.cc-switch/cc-switch.db 读取 provider 配置,生成独立实例目录,
// 通过 CLAUDE_CONFIG_DIR / CODEX_HOME 环境变量隔离启动。
// 不同 terminal 各用各的供应商配置,互不干扰。

import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  readlinkSync,
  statSync,
  lstatSync,
  readdirSync,
  unlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ─── 路径常量 ─────────────────────────────────────────────────────────

function getHomeDir() {
  const testHome = process.env.CC_SWITCH_TEST_HOME;
  if (testHome && testHome.trim()) return testHome.trim();
  return homedir();
}

const HOME = getHomeDir();
const CC_SWITCH_DIR = join(HOME, ".cc-switch");
const DB_PATH = join(CC_SWITCH_DIR, "cc-switch.db");
const SETTINGS_PATH = join(CC_SWITCH_DIR, "settings.json");
const INSTANCES_DIR = join(CC_SWITCH_DIR, "instances");

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const RESOURCES_DIR = join(SCRIPT_DIR, "..", "resources");

// ─── smol-toml 加载 ──────────────────────────────────────────────────

let _tomlModule = null;

function getToml() {
  if (_tomlModule) return _tomlModule;
  // 尝试从本包的 node_modules 解析
  const candidates = [
    join(SCRIPT_DIR, "..", "node_modules", "smol-toml"),
    join(SCRIPT_DIR, "..", "..", "node_modules", "smol-toml"),
  ];
  for (const p of candidates) {
    try {
      const mod = require(p);
      if (mod.parse && mod.stringify) {
        _tomlModule = mod;
        return mod;
      }
    } catch {}
  }
  try {
    const mod = require("smol-toml");
    if (mod.parse && mod.stringify) {
      _tomlModule = mod;
      return mod;
    }
  } catch {}
  throw new Error(
    "无法加载 smol-toml 模块。请运行 npm install smol-toml。",
  );
}

function parseToml(text) {
  return getToml().parse(text);
}

function stringifyToml(obj) {
  return getToml().stringify(obj);
}

// ─── DB 查询 ──────────────────────────────────────────────────────────

function queryDB(sql) {
  try {
    const json = execFileSync("sqlite3", ["-json", DB_PATH, sql], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    return JSON.parse(json || "[]");
  } catch (e) {
    if (e.status === 1 && (!e.stdout || !e.stderr)) return [];
    throw e;
  }
}

function sqlQuote(str) {
  return "'" + String(str).replace(/'/g, "''") + "'";
}

function queryProvider(name, appType) {
  const rows = queryDB(
    `SELECT id, name, settings_config, category, meta FROM providers WHERE name = ${sqlQuote(name)} AND app_type = ${sqlQuote(appType)} ORDER BY id LIMIT 1`,
  );
  return rows[0] || null;
}

function queryProvidersByApp(appType) {
  return queryDB(
    `SELECT id, name FROM providers WHERE app_type = ${sqlQuote(appType)} ORDER BY COALESCE(sort_index, 999999), created_at ASC, id ASC`,
  );
}

function queryCommonConfig(appType) {
  const key = `common_config_${appType}`;
  const rows = queryDB(`SELECT value FROM settings WHERE key = ${sqlQuote(key)}`);
  return rows[0]?.value || null;
}

// ─── 设置读取 ─────────────────────────────────────────────────────────

function loadSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// ─── JSON 工具函数 (复刻 Rust json_deep_merge / json_is_subset) ──────

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function jsonDeepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function jsonDeepMerge(target, source) {
  if (isPlainObject(target) && isPlainObject(source)) {
    for (const [key, sourceValue] of Object.entries(source)) {
      if (key in target) {
        jsonDeepMerge(target[key], sourceValue);
      } else {
        target[key] = sourceValue;
      }
    }
  }
  return target;
}

function jsonIsSubset(target, source) {
  if (isPlainObject(source)) {
    if (!isPlainObject(target)) return false;
    for (const [key, sourceValue] of Object.entries(source)) {
      if (!(key in target)) return false;
      if (!jsonIsSubset(target[key], sourceValue)) return false;
    }
    return true;
  }
  if (Array.isArray(source)) {
    if (!Array.isArray(target)) return false;
    return source.every((srcItem) =>
      target.some((tgtItem) => jsonIsSubset(tgtItem, srcItem)),
    );
  }
  return target === source;
}

// ─── TOML 工具函数 (复刻 Rust merge_toml_table_like) ──────────────────

function tomlDeepMerge(target, source) {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (key in target && isPlainObject(target[key]) && isPlainObject(sourceValue)) {
      tomlDeepMerge(target[key], sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
  return target;
}

function tomlIsSubset(target, source) {
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!(key in target)) return false;
    const targetValue = target[key];
    if (isPlainObject(sourceValue)) {
      if (!isPlainObject(targetValue)) return false;
      if (!tomlIsSubset(targetValue, sourceValue)) return false;
    } else if (Array.isArray(sourceValue)) {
      if (!Array.isArray(targetValue)) return false;
      if (!sourceValue.every((s) =>
        targetValue.some((t) => JSON.stringify(t) === JSON.stringify(s))
      )) return false;
    } else {
      if (JSON.stringify(targetValue) !== JSON.stringify(sourceValue)) return false;
    }
  }
  return true;
}

// ─── Common config 判断 (复刻 Rust provider_uses_common_config) ──────

function providerUsesCommonConfig(appType, settingsConfig, meta, snippet) {
  const snippetTrimmed = (snippet || "").trim();
  if (!snippetTrimmed) return false;
  const explicit = meta?.commonConfigEnabled;
  if (explicit !== undefined && explicit !== null) {
    return explicit && snippetTrimmed.length > 0;
  }
  return settingsContainCommonConfig(appType, settingsConfig, snippetTrimmed);
}

function settingsContainCommonConfig(appType, settings, snippetTrimmed) {
  if (!snippetTrimmed) return false;
  if (appType === "claude") {
    try {
      const source = JSON.parse(snippetTrimmed);
      if (isPlainObject(source)) return jsonIsSubset(settings, source);
    } catch { return false; }
  } else if (appType === "codex") {
    const configToml = settings?.config || "";
    if (!configToml.trim()) return false;
    try {
      const targetDoc = parseToml(configToml);
      const sourceDoc = parseToml(snippetTrimmed);
      return tomlIsSubset(targetDoc, sourceDoc);
    } catch { return false; }
  }
  return false;
}

// ─── Claude 配置生成 ──────────────────────────────────────────────────

const CLAUDE_SANITIZE_KEYS = [
  "api_format", "apiFormat",
  "openrouter_compat_mode", "openrouterCompatMode",
];

function sanitizeClaudeSettings(settings) {
  const v = jsonDeepClone(settings);
  if (isPlainObject(v)) {
    for (const key of CLAUDE_SANITIZE_KEYS) delete v[key];
  }
  return v;
}

function applyKimiForCodingContextDefaults(effective, providerSettings) {
  const baseUrl = providerSettings?.env?.ANTHROPIC_BASE_URL;
  if (!baseUrl || baseUrl.trim().replace(/\/$/, "") !== "https://api.kimi.com/coding") return;
  const env = effective.env || (effective.env = {});
  const providerEnv = providerSettings?.env || {};
  const KIMI_TOKENS = "262144";
  for (const key of ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"]) {
    env[key] = providerEnv[key] || KIMI_TOKENS;
  }
}

function buildClaudeEffectiveSettings(settingsConfig, meta, commonSnippet) {
  let effective = jsonDeepClone(settingsConfig);
  if (providerUsesCommonConfig("claude", settingsConfig, meta, commonSnippet)) {
    try {
      const source = JSON.parse(commonSnippet.trim());
      jsonDeepMerge(effective, source);
    } catch (e) {
      console.error(`⚠ 通用配置合并失败: ${e.message}`);
    }
  }
  applyKimiForCodingContextDefaults(effective, settingsConfig);
  return sanitizeClaudeSettings(effective);
}

// ─── Codex 配置生成 ──────────────────────────────────────────────────

const CODEX_OFFICIAL_PROVIDER_ID = "codex-official";
const CODEX_RESERVED_MODEL_PROVIDER_IDS = [
  "amazon-bedrock", "openai", "ollama", "lmstudio", "oss", "ollama-chat",
];
const CC_SWITCH_CATALOG_FILENAME = "cc-switch-model-catalog.json";
const CODEX_WEB_SEARCH_REJECT_HOSTS = [
  "xiaomimimo.com", "longcat.chat", "minimax.io", "minimaxi.com",
];
const CODEX_WEB_SEARCH_REJECT_MODEL_PREFIXES = ["mimo", "longcat", "minimax", "qwen3-coder"];
const ONE_M_CONTEXT_MARKER = "[1m]";

const CONFIRMED_TEXT_ONLY_TAILS = [
  "ark-code-latest", "deepseek-chat", "deepseek-reasoner",
  "deepseek-v4-flash", "deepseek-v4-pro",
  "glm-5.1", "glm-5.2",
  "kat-coder", "kat-coder-pro", "kat-coder-pro v1", "kat-coder-pro v2",
  "kat-coder-pro-v1", "kat-coder-pro-v2",
  "ling-2.5-1t", "longcat-2.0", "longcat-flash-chat",
  "minimax-m2.7", "minimax-m2.7-highspeed", "mimo-v2.5-pro",
  "qwen3-coder-480b", "qwen3-coder-480b-a35b-instruct",
  "qwen3-coder-flash", "qwen3-coder-next", "qwen3-coder-plus",
  "step-3.5-flash", "step-3.5-flash-2603", "us.deepseek.r1-v1",
];

function normalizeModelId(value) {
  let n = value.trim().replace(/^models\//, "").trim().toLowerCase();
  if (n.endsWith(ONE_M_CONTEXT_MARKER)) {
    n = n.slice(0, -ONE_M_CONTEXT_MARKER.length).trim();
  }
  return n;
}

function isConfirmedTextOnlyModel(model) {
  const normalized = normalizeModelId(model);
  const tail = normalized.split("/").pop();
  return CONFIRMED_TEXT_ONLY_TAILS.includes(tail);
}

function imageInputCapabilityFromModalities(model, modalities) {
  const declared = modalities
    ? modalities.some((m) => m.trim().toLowerCase() === "image")
    : undefined;
  if (declared === true) return "Supported";
  if (declared === false) return "Unsupported";
  if (isConfirmedTextOnlyModel(model)) return "Unsupported";
  return "Unknown";
}

function codexCatalogInputModalities(model, declaredModalities) {
  const cap = imageInputCapabilityFromModalities(model, declaredModalities);
  return cap === "Unsupported" ? ["text"] : ["text", "image"];
}

function parsePositiveU64(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value > 0 ? value : undefined;
  if (typeof value === "string") {
    const n = parseInt(value.trim(), 10);
    return !isNaN(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

function codexCatalogModelSpecs(settingsConfig) {
  const models = settingsConfig?.modelCatalog?.models;
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const specs = [];
  for (const mc of models) {
    const model = mc.model?.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    specs.push({
      model,
      displayName: [mc.displayName, mc.display_name].find((v) => v?.trim())?.trim() || undefined,
      contextWindow: parsePositiveU64([mc.contextWindow, mc.context_window].find((v) => v !== undefined)),
      supportsParallelToolCalls: [mc.supportsParallelToolCalls, mc.supports_parallel_tool_calls].find((v) => v !== undefined),
      inputModalities: [mc.inputModalities, mc.input_modalities].find((v) => v !== undefined),
      baseInstructions: [mc.baseInstructions, mc.base_instructions].find((v) => v?.trim()),
    });
  }
  return specs;
}

function resolveCodexCatalogToolProfile(provider) {
  if (provider.id === CODEX_OFFICIAL_PROVIDER_ID && provider.category === "official") {
    return "NativeResponses";
  }
  if (provider.meta?.providerType === "xai_oauth") return "NativeResponses";
  const apiFormat = provider.meta?.apiFormat;
  if (apiFormat === "anthropic") return "Anthropic";
  if (apiFormat === "openai_responses") return "NativeResponses";
  return "ProxyChat";
}

function loadTemplate(profile) {
  const filename = profile === "ProxyChat" ? "gpt5_5_template.json" : "codex_native_responses_template.json";
  return JSON.parse(readFileSync(join(RESOURCES_DIR, filename), "utf8"));
}

function codexCatalogModelEntry(template, spec, priority, profile, defaultContextWindow) {
  const entry = jsonDeepClone(template);
  const displayName = spec.displayName || spec.model;
  const contextWindow = spec.contextWindow || defaultContextWindow;
  entry.slug = spec.model;
  entry.display_name = displayName;
  entry.description = displayName;
  entry.context_window = contextWindow;
  entry.max_context_window = contextWindow;
  entry.priority = 1000 + priority;
  entry.additional_speed_tiers = [];
  entry.service_tiers = [];
  entry.availability_nux = null;
  entry.upgrade = null;
  entry.input_modalities = codexCatalogInputModalities(spec.model, spec.inputModalities);
  if (profile !== "ProxyChat") {
    for (const key of ["apply_patch_tool_type", "web_search_tool_type", "tools", "model_messages"]) {
      delete entry[key];
    }
    entry.shell_type = "shell_command";
    if (spec.baseInstructions?.trim()) entry.base_instructions = spec.baseInstructions.trim();
    if (spec.supportsParallelToolCalls !== undefined) entry.supports_parallel_tool_calls = spec.supportsParallelToolCalls;
  }
  return entry;
}

function codexModelCatalogFromSettings(settingsConfig, configText, profile) {
  const specs = codexCatalogModelSpecs(settingsConfig);
  if (specs.length === 0) return null;
  const defaultContextWindow = extractTopLevelU64(configText, "model_context_window") || 128000;
  const template = loadTemplate(profile);
  const entries = specs.map((spec, i) => codexCatalogModelEntry(template, spec, i, profile, defaultContextWindow));
  return { models: entries };
}

function extractTopLevelU64(configText, field) {
  try {
    const doc = parseToml(configText);
    const v = doc[field];
    if (typeof v === "number") return v > 0 ? v : undefined;
  } catch {}
  return undefined;
}

function extractCodexBaseUrl(configText) {
  try {
    const doc = parseToml(configText);
    const activeProvider = doc.model_provider;
    if (activeProvider && doc.model_providers?.[activeProvider]?.base_url) {
      return doc.model_providers[activeProvider].base_url;
    }
    return doc.base_url || undefined;
  } catch {}
  return undefined;
}

function codexNativeGatewayRejectsWebSearch(configText) {
  const baseUrl = extractCodexBaseUrl(configText)?.toLowerCase();
  if (baseUrl && CODEX_WEB_SEARCH_REJECT_HOSTS.some((h) => baseUrl.includes(h))) return true;
  try {
    const doc = parseToml(configText);
    const model = doc.model?.trim().toLowerCase();
    if (model) {
      const tail = model.split("/").pop();
      if (CODEX_WEB_SEARCH_REJECT_MODEL_PREFIXES.some((p) => tail.startsWith(p))) return true;
    }
  } catch {}
  return false;
}

function setCodexModelCatalogField(configObj, hasCatalog) {
  if (hasCatalog) {
    configObj.model_catalog_json = CC_SWITCH_CATALOG_FILENAME;
  } else if (configObj.model_catalog_json === CC_SWITCH_CATALOG_FILENAME) {
    delete configObj.model_catalog_json;
  }
}

function setCodexWebSearchField(configObj, disable) {
  if (disable) {
    configObj.web_search = "disabled";
  } else if (configObj.web_search === "disabled") {
    delete configObj.web_search;
  }
}

function isCustomCodexModelProviderId(id) {
  const trimmed = id.trim();
  return trimmed.length > 0 && !CODEX_RESERVED_MODEL_PROVIDER_IDS.some((r) => r.toLowerCase() === trimmed.toLowerCase());
}

function setCodexExperimentalBearerToken(configObj, token) {
  const providerId = configObj.model_provider;
  if (!providerId || !isCustomCodexModelProviderId(providerId)) {
    configObj.experimental_bearer_token = token;
    return;
  }
  if (configObj.model_providers?.[providerId]) {
    configObj.model_providers[providerId].experimental_bearer_token = token;
    return;
  }
  configObj.experimental_bearer_token = token;
}

function extractCodexAuthApiKey(auth) {
  const key = auth?.OPENAI_API_KEY;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

function codexAuthHasLoginMaterial(auth) {
  if (!isPlainObject(auth)) return false;
  for (const [key, value] of Object.entries(auth)) {
    if (key === "auth_mode") continue;
    if (key === "OPENAI_API_KEY") {
      if (typeof value === "string" && value.trim()) return true;
      continue;
    }
    if (value === null) continue;
    if (typeof value === "string" && value.trim()) return true;
    if (Array.isArray(value) && value.length) return true;
    if (isPlainObject(value) && Object.keys(value).length) return true;
    return true;
  }
  return false;
}

function buildCodexConfig(settingsConfig, meta, category, commonSnippet, provider, settings) {
  const configText = settingsConfig.config || "";
  let effectiveConfigText = configText;

  // Common config merge (TOML)
  if (providerUsesCommonConfig("codex", settingsConfig, meta, commonSnippet)) {
    try {
      const target = parseToml(configText || "");
      const source = parseToml(commonSnippet.trim());
      tomlDeepMerge(target, source);
      effectiveConfigText = stringifyToml(target);
    } catch (e) {
      console.error(`⚠ Codex 通用配置合并失败: ${e.message}`);
    }
  }

  const profile = resolveCodexCatalogToolProfile({
    id: provider.id,
    category,
    meta: { apiFormat: meta?.apiFormat, providerType: meta?.providerType },
  });
  const catalog = codexModelCatalogFromSettings(settingsConfig, effectiveConfigText, profile);

  let configObj;
  try {
    configObj = parseToml(effectiveConfigText || "");
  } catch (e) {
    throw new Error(`无法解析 Codex config.toml: ${e.message}`);
  }

  if (catalog) {
    setCodexModelCatalogField(configObj, true);
    let disableWebSearch = false;
    if (profile === "Anthropic") {
      disableWebSearch = true;
    } else if (profile === "NativeResponses") {
      disableWebSearch = codexNativeGatewayRejectsWebSearch(stringifyToml(configObj));
    }
    setCodexWebSearchField(configObj, disableWebSearch);
  } else {
    setCodexModelCatalogField(configObj, false);
    if (profile === "Anthropic") setCodexWebSearchField(configObj, true);
  }

  let finalConfigText = stringifyToml(configObj);
  const auth = settingsConfig.auth || {};
  const apiKey = extractCodexAuthApiKey(auth);

  // Third-party provider: inject bearer token
  if (category !== "official" && apiKey) {
    const preserveOfficialAuth = settings.preserveCodexOfficialAuthOnSwitch || false;
    if (!preserveOfficialAuth) {
      try {
        const configObj2 = parseToml(finalConfigText);
        setCodexExperimentalBearerToken(configObj2, apiKey);
        finalConfigText = stringifyToml(configObj2);
      } catch (e) {
        console.error(`⚠ 注入 bearer token 失败: ${e.message}`);
      }
    }
  }

  return { configText: finalConfigText, auth, catalog, apiKey, profile };
}

// ─── 实例目录初始化 ──────────────────────────────────────────────────

function ensureSymlink(target, linkPath) {
  if (existsSync(linkPath) || isBrokenSymlink(linkPath)) {
    try {
      const stats = lstatSyncSafe(linkPath);
      if (stats?.isSymbolicLink()) {
        if (readlinkSync(linkPath) === target) return;
        unlinkSync(linkPath);
      } else {
        // 非 symlink 的实体文件/目录。Claude Code 首次启动时会自动创建
        // plugins/ 等空目录,这些应该被 symlink 替换。
        // 但如果里面已有实质内容(非空),保留并警告,避免误删用户数据。
        const dirEntries = readdirSyncSafe(linkPath);
        if (dirEntries && dirEntries.length > 0) {
          console.error(`⚠ ${linkPath} 已存在且非空,跳过 symlink (目标: ${target})`);
          return;
        }
        rmSync(linkPath, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`⚠ 无法替换 ${linkPath} 为 symlink: ${e.message}`);
      return;
    }
  }
  try {
    symlinkSync(target, linkPath);
  } catch {}
}

function isBrokenSymlink(path) {
  try { return lstatSyncSafe(path)?.isSymbolicLink() === true; } catch { return false; }
}

function lstatSyncSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

function readdirSyncSafe(path) {
  try { return readdirSync(path); } catch { return null; }
}

// 从全局 ~/.claude 共享到实例目录的路径列表。
// 目录用 symlink,文件也用 symlink —— 这些是设备级共享资源,
// 不应因 CLAUDE_CONFIG_DIR 指向实例目录而缺失。
// 从全局 ~/.claude/ 共享到实例目录的路径列表。
// 目录用 symlink,文件也用 symlink —— 这些是设备级共享资源,
// 不应因 CLAUDE_CONFIG_DIR 指向实例目录而缺失。
const CLAUDE_SHARED_PATHS = [
  ".credentials.json",
  "projects",
  "plugins",
  "skills",
  "commands",
  "cache",
  "CLAUDE.md",
  "keybindings.json",
  "settings.local.json",
  "config.json",
  ".claude.json",  // 含 oauthAccount 等 OAuth 登录信息,缺失会导致重新登录
];

function setupClaudeInstance(providerId) {
  const instanceDir = join(INSTANCES_DIR, "claude", providerId);
  mkdirSync(instanceDir, { recursive: true });
  const globalClaudeDir = join(HOME, ".claude");

  // .claude.json 存在两个位置:
  //   - CLAUDE_CONFIG_DIR 未设置时: ~/.claude.json (HOME 根目录)
  //   - CLAUDE_CONFIG_DIR 设置时: $CLAUDE_CONFIG_DIR/.claude.json
  // 全局的 ~/.claude.json 含 oauthAccount 等 OAuth 登录信息,
  // 实例目录缺它会导致 Claude Code 要求重新登录。
  const globalDotClaudeJson = join(HOME, ".claude.json");
  if (existsSync(globalDotClaudeJson)) {
    ensureSymlink(globalDotClaudeJson, join(instanceDir, ".claude.json"));
  }

  for (const name of CLAUDE_SHARED_PATHS) {
    const globalPath = join(globalClaudeDir, name);
    if (existsSync(globalPath)) {
      ensureSymlink(globalPath, join(instanceDir, name));
    }
  }
  return instanceDir;
}

function setupCodexInstance(providerId) {
  const instanceDir = join(INSTANCES_DIR, "codex", providerId);
  mkdirSync(instanceDir, { recursive: true });
  return instanceDir;
}

// ─── 原子写入 ─────────────────────────────────────────────────────────

function atomicWrite(path, data) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.tmp.${basename(path)}.${Date.now()}.${process.pid}`);
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

// ─── CLI 启动 ─────────────────────────────────────────────────────────

const APP_CONFIGS = {
  claude: { appType: "claude", envVar: "CLAUDE_CONFIG_DIR" },
  codex: { appType: "codex", envVar: "CODEX_HOME" },
};

function launchClaude(providerId, settingsConfig, meta, commonSnippet, settings, extraArgs) {
  const instanceDir = setupClaudeInstance(providerId);
  const effective = buildClaudeEffectiveSettings(settingsConfig, meta, commonSnippet);
  atomicWrite(join(instanceDir, "settings.json"), JSON.stringify(effective, null, 2));

  process.stderr.write(`\x1b[2mCLAUDE_CONFIG_DIR=${instanceDir} claude ${extraArgs.join(" ")}\x1b[0m\n`);

  const result = spawnSync("claude", extraArgs, {
    stdio: "inherit",
    env: { ...process.env, CLAUDE_CONFIG_DIR: instanceDir },
  });
  process.exit(result.status || 0);
}

function launchCodex(providerId, settingsConfig, meta, category, commonSnippet, settings, extraArgs) {
  const instanceDir = setupCodexInstance(providerId);
  const { configText, auth, catalog, apiKey } = buildCodexConfig(
    settingsConfig, meta, category, commonSnippet,
    { id: providerId }, settings,
  );

  atomicWrite(join(instanceDir, "config.toml"), configText);

  const authPath = join(instanceDir, "auth.json");
  const globalAuthPath = join(HOME, ".codex", "auth.json");

  if (!apiKey && !codexAuthHasLoginMaterial(auth)) {
    if (existsSync(globalAuthPath)) {
      ensureSymlink(globalAuthPath, authPath);
    } else {
      atomicWrite(authPath, JSON.stringify({}, null, 2));
    }
  } else {
    const authContent = apiKey
      ? { OPENAI_API_KEY: apiKey }
      : codexAuthHasLoginMaterial(auth) ? auth : {};
    atomicWrite(authPath, JSON.stringify(authContent, null, 2));
  }

  if (catalog) {
    atomicWrite(join(instanceDir, CC_SWITCH_CATALOG_FILENAME), JSON.stringify(catalog, null, 2));
  }

  process.stderr.write(`\x1b[2mCODEX_HOME=${instanceDir} codex ${extraArgs.join(" ")}\x1b[0m\n`);

  const result = spawnSync("codex", extraArgs, {
    stdio: "inherit",
    env: { ...process.env, CODEX_HOME: instanceDir },
  });
  process.exit(result.status || 0);
}

// ─── TUI 交互模式 ─────────────────────────────────────────────────────

function tuiSelect(prompt, options) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      reject(new Error("TUI 模式需要交互式终端。请使用命令模式: switch <provider> <cmd>"));
      return;
    }

    let selected = 0;
    const totalLines = options.length + 1;

    function render() {
      process.stdout.write(`\x1b[${totalLines}A\x1b[J`);
      process.stdout.write(`\x1b[1m◆ ${prompt}\x1b[0m\n`);
      for (let i = 0; i < options.length; i++) {
        if (i === selected) {
          process.stdout.write(`\x1b[36m❯ ${options[i].label}\x1b[0m\n`);
        } else {
          process.stdout.write(`  ${options[i].label}\n`);
        }
      }
    }

    process.stdout.write(`\x1b[1m◆ ${prompt}\x1b[0m\n`);
    for (let i = 0; i < options.length; i++) {
      if (i === selected) {
        process.stdout.write(`\x1b[36m❯ ${options[i].label}\x1b[0m\n`);
      } else {
        process.stdout.write(`  ${options[i].label}\n`);
      }
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (data) => {
      const key = data.toString();
      if (key === "\x03") {
        cleanup();
        reject(new Error("取消"));
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(options[selected]);
        return;
      }
      if (key === "\x1b[A" || key === "k") {
        selected = (selected - 1 + options.length) % options.length;
        render();
      }
      if (key === "\x1b[B" || key === "j") {
        selected = (selected + 1) % options.length;
        render();
      }
    };

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("data", onData);
      process.stdout.write(`\x1b[${totalLines}A\x1b[J`);
    }

    process.stdin.on("data", onData);
  });
}

async function runTUI() {
  const cliOptions = [
    { label: "claude", value: "claude" },
    { label: "codex", value: "codex" },
  ];
  const cli = await tuiSelect("选择 CLI 工具", cliOptions);
  const appConfig = APP_CONFIGS[cli.value];
  if (!appConfig) throw new Error(`不支持的 CLI: ${cli.value}`);

  const providers = queryProvidersByApp(appConfig.appType);
  if (providers.length === 0) {
    console.error(`✗ 没有找到 ${appConfig.appType} 的供应商配置。请先在 cc-switch 中配置。`);
    process.exit(1);
  }
  const providerOptions = providers.map((p) => ({ label: p.name, value: p.id }));
  const selected = await tuiSelect(
    `选择供应商 (${cli.value === "claude" ? "Claude Code" : "Codex"})`,
    providerOptions,
  );
  const provider = providers.find((p) => p.id === selected.value);
  await launchProvider(cli.value, provider.name, []);
}

// ─── 启动逻辑 ─────────────────────────────────────────────────────────

async function launchProvider(cmd, providerName, extraArgs) {
  const appConfig = APP_CONFIGS[cmd];
  if (!appConfig) {
    console.error(`✗ 不支持的命令: ${cmd}。目前支持: claude, codex`);
    process.exit(1);
  }

  const row = queryProvider(providerName, appConfig.appType);
  if (!row) {
    console.error(`✗ 未找到供应商 "${providerName}" (${appConfig.appType})`);
    console.error(`  可用供应商:`);
    queryProvidersByApp(appConfig.appType).forEach((p) => console.error(`    ${p.name}`));
    process.exit(1);
  }

  const settingsConfig = JSON.parse(row.settings_config || "{}");
  const meta = JSON.parse(row.meta || "{}");
  const category = row.category;
  const commonSnippet = queryCommonConfig(appConfig.appType);
  const settings = loadSettings();

  if (cmd === "claude") {
    launchClaude(row.id, settingsConfig, meta, commonSnippet, settings, extraArgs);
  } else if (cmd === "codex") {
    launchCodex(row.id, settingsConfig, meta, category, commonSnippet, settings, extraArgs);
  }
}

// ─── 主入口 ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    try {
      await runTUI();
    } catch (e) {
      if (e.message !== "取消") console.error(`✗ ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (args.length < 2) {
    console.error(`用法: switch <provider> <cmd> [args...]`);
    console.error(`  或: switch  (交互模式)`);
    console.error(`示例: switch "Claude Official" claude`);
    console.error(`      switch "Zhipu GLM en" claude --continue`);
    console.error(`      switch "P&G Nezha" codex`);
    process.exit(1);
  }

  const providerName = args[0];
  const cmd = args[1];
  const extraArgs = args.slice(2);
  await launchProvider(cmd, providerName, extraArgs);
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
