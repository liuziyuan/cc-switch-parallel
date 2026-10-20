import process from "node:process";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createServer } from "node:http";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (CC_SWITCH_DIR, INSTANCES_DIR) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-usage-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { APP_ADAPTERS } = await import("../src/adapters.ts");
const { snapshotAliveByCli, isDeadEntry } = await import("../src/history.ts");
const { splitChangesByTarget } = await import("../src/upward.ts");
const { queryProviderById, queryProviderMatches, queryProvidersByApp, queryProvidersStrict } =
  await import("../src/db.ts");
const { buildClaudeEffectiveSettings } = await import("../src/claude-config.ts");
const { buildStatusLineWrapperScript, buildUsageWrapperLines } = await import(
  "../src/statusline.ts"
);
const {
  extractClaudeUsageSource,
  resolveUsageIdentity,
  usageEndpointFor,
  buildUsageQueryConfig,
  USAGE_CACHE_FILENAME,
} = await import("../src/stack/usage.ts");
const {
  isLoopbackBaseUrl,
  isAggregationProviderSettings,
  protectAggregationIdentityEnv,
  readStackState,
  readGlobalModelPicker,
  buildStackSettingsFromGlobal,
  virtualStackProviderFor,
  appendVirtualStackRow,
  buildStackUsageConfig,
  cleanupLegacyStackRows,
  probeTcpReachable,
  buildAggregationGroup,
} = await import("../src/stack/state.ts");
const { aggregationDoctorChecks } = await import("../src/commands/doctor.ts");
const { stackBillingMemberName } = await import("../src/commands/ps.ts");
const { VIRTUAL_STACK_PROVIDER_ID } = await import("../src/paths.ts");

const CC = join(testHome, ".cc-switch");
const INSTANCES = join(CC, "instances", "claude");
const GLOBAL_SETTINGS = join(testHome, ".claude", "settings.json");
const PROVIDER_ID = "usage-provider-id";

const ZHIPU_SETTINGS = {
  env: {
    ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: "zai-token",
  },
};
const ZHIPU_META = {
  usage_script: {
    enabled: true,
    language: "javascript",
    code: "",
    timeout: 10,
    templateType: "token_plan",
    autoQueryInterval: 5,
    codingPlanProvider: "zhipu",
  },
};
const DEEPSEEK_SETTINGS = {
  env: {
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_AUTH_TOKEN: "ds-token",
  },
};
const DEEPSEEK_META = {
  usage_script: {
    enabled: true,
    language: "javascript",
    code: "",
    timeout: 10,
    templateType: "balance",
    autoQueryInterval: 5,
    codingPlanProvider: "deepseek",
  },
};

function instanceFile(name = USAGE_CACHE_FILENAME) {
  return join(INSTANCES, PROVIDER_ID, name);
}

function cleanInstance() {
  rmSync(join(INSTANCES, PROVIDER_ID), { recursive: true, force: true });
}

function writeGlobalSettings(statusLine) {
  mkdirSync(join(testHome, ".claude"), { recursive: true });
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify(statusLine === undefined ? {} : { statusLine }));
}

// Claude-hud-shaped relay: a fixed-output node script, so the wrapper's
// relay path is exercised without depending on any real statusline tool.
// (A `printf` shell fixture would eat the usage line's `%` as a format
// specifier — node writes the bytes verbatim.)
function writeRelayScript(dir, firstLine, extraLines = []) {
  const p = join(dir, "relay.mjs");
  writeFileSync(
    p,
    `process.stdout.write(${JSON.stringify([firstLine, ...extraLines].join("\n") + "\n")});`,
  );
  return p;
}

// Must be an ASYNC spawn: spawnSync blocks this process's event loop, which
// would stall the in-process fixture server (accept happens on the loop) and
// make every child fetch time out. In production the wrapper fetches remote
// APIs, so only the test harness needs this care.
function runWrapper(wrapperPath, input, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapperPath], {
      env: { ...process.env, ...envExtra },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const STATUSLINE_INPUT = JSON.stringify({
  model: { id: "claude-opus", display_name: "Opus" },
  workspace: { current_dir: "/tmp" },
});

// ─── identity resolution ──────────────────────────────────────────────

test("identity: explicit codingPlanProvider zhipu (upstream desktop marker)", () => {
  const id = resolveUsageIdentity(ZHIPU_SETTINGS, ZHIPU_META);
  assert.equal(id.kind, "zhipu");
  assert.equal(id.authStyle, "bearer");
  assert.equal(id.endpoint, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(id.intervalMin, 5);
  assert.equal(id.token, "zai-token");
});

test("identity: host fallback — bigmodel.cn maps to zhipu without meta", () => {
  const id = resolveUsageIdentity(
    {
      env: {
        ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "t",
      },
    },
    {},
  );
  assert.equal(id.kind, "zhipu");
  assert.equal(id.endpoint, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
});

test("identity: deepseek — balance templateType + host, bearer auth", () => {
  const id = resolveUsageIdentity(DEEPSEEK_SETTINGS, DEEPSEEK_META);
  assert.equal(id.kind, "deepseek");
  assert.equal(id.authStyle, "bearer");
  assert.equal(id.endpoint, "https://api.deepseek.com/user/balance");
});

test("identity: kimi and unknown hosts never resolve", () => {
  for (const url of [
    "https://api.kimi.com/coding",
    "https://api.anthropic.com",
    "https://agent-gateway.example.com/x",
  ]) {
    assert.equal(
      resolveUsageIdentity({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: "t" } }, {}),
      null,
    );
  }
});

test("identity: usage_script.enabled false opts out; unknown explicit value falls to host", () => {
  assert.equal(
    resolveUsageIdentity(ZHIPU_SETTINGS, {
      usage_script: { ...ZHIPU_META.usage_script, enabled: false },
    }),
    null,
  );
  // Unknown marker (e.g. a future desktop value) must not guess: plain
  // unknown host + unknown marker → null.
  assert.equal(
    resolveUsageIdentity(
      { env: { ANTHROPIC_BASE_URL: "https://x.example.com", ANTHROPIC_AUTH_TOKEN: "t" } },
      { usage_script: { codingPlanProvider: "zhipu_team" } },
    ),
    null,
  );
});

test("identity: custom usage script code opts out", () => {
  const meta = { usage_script: { ...ZHIPU_META.usage_script, code: "fetch('https://x')" } };
  assert.equal(resolveUsageIdentity(ZHIPU_SETTINGS, meta), null);
});

test("identity: interval clamps into [1,60]; default 5", () => {
  assert.equal(
    resolveUsageIdentity(ZHIPU_SETTINGS, { usage_script: { autoQueryInterval: 0 } }).intervalMin,
    5,
  );
  assert.equal(
    resolveUsageIdentity(ZHIPU_SETTINGS, { usage_script: { autoQueryInterval: 999 } }).intervalMin,
    60,
  );
  assert.equal(
    resolveUsageIdentity(ZHIPU_SETTINGS, { usage_script: { autoQueryInterval: 2 } }).intervalMin,
    2,
  );
});

test("identity: token falls back to ANTHROPIC_API_KEY; both missing → null", () => {
  const cfg = {
    env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_API_KEY: "k" },
  };
  assert.equal(resolveUsageIdentity(cfg, {}).token, "k");
  const noToken = { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } };
  assert.equal(resolveUsageIdentity(noToken, {}), null);
});

// ─── endpoint derivation ──────────────────────────────────────────────

test("endpoint: origin-derived per kind; garbage baseUrl → null", () => {
  assert.equal(
    usageEndpointFor("zhipu", "https://api.z.ai/api/anthropic"),
    "https://api.z.ai/api/monitor/usage/quota/limit",
  );
  assert.equal(
    usageEndpointFor("deepseek", "https://api.deepseek.com/anthropic"),
    "https://api.deepseek.com/user/balance",
  );
  assert.equal(usageEndpointFor("zhipu", "not a url"), null);
  assert.equal(usageEndpointFor("kimi", "https://api.kimi.com/coding"), null);
  // Plain http is allowed only for loopback (local-proxy case); the token is
  // sent in clear, so remote http and non-http(s) schemes are refused.
  assert.equal(
    usageEndpointFor("zhipu", "http://127.0.0.1:15721"),
    "http://127.0.0.1:15721/api/monitor/usage/quota/limit",
  );
  assert.equal(
    usageEndpointFor("zhipu", "http://localhost:15721/anthropic"),
    "http://localhost:15721/api/monitor/usage/quota/limit",
  );
  assert.equal(
    usageEndpointFor("zhipu", "http://[::1]:15721/anthropic"),
    "http://[::1]:15721/api/monitor/usage/quota/limit",
  );
  assert.equal(usageEndpointFor("zhipu", "http://example.com/anthropic"), null);
  assert.equal(usageEndpointFor("zhipu", "file:///tmp/x"), null);
  assert.equal(usageEndpointFor("zhipu", "ftp://example.com/x"), null);
});

// ─── wrapper source: byte-stability and inline shape ──────────────────

test("wrapper: usageConfig null is byte-identical to omitting the argument", () => {
  const a = buildStatusLineWrapperScript("P", "/g/settings.json", null, "auto");
  const b = buildStatusLineWrapperScript("P", "/g/settings.json", null, "auto", null);
  assert.equal(a, b);
  // the usage RUNTIME must not be inlined (the refresh-skip guard in the
  // skeleton legitimately mentions the CC_LAUNCH_USAGE_REFRESH env name)
  assert.equal(a.includes("usageFetch"), false);
  assert.equal(a.includes("usageReadCache"), false);
});

test("wrapper: with usage config the runtime is inlined (url/token/cache, never in settings.json)", () => {
  const usageConfig = buildUsageQueryConfig(
    resolveUsageIdentity(ZHIPU_SETTINGS, ZHIPU_META),
    instanceFile(),
    instanceFile("statusline-wrapper.mjs"),
  );
  const src = buildStatusLineWrapperScript("P", "/g/settings.json", null, "auto", usageConfig);
  assert.ok(src.includes('"kind":"zhipu"'));
  assert.ok(src.includes("https://api.z.ai/api/monitor/usage/quota/limit"));
  assert.ok(src.includes("zai-token"));
  assert.ok(src.includes(JSON.stringify(instanceFile())));
  // generated lines are the tail of the script and parse as one module
  assert.ok(typeof buildUsageWrapperLines(usageConfig) === "object");

  const effective = buildClaudeEffectiveSettings(
    ZHIPU_SETTINGS,
    ZHIPU_META,
    "{}",
    "P",
    PROVIDER_ID,
  );
  assert.ok(effective.statusLine.command.includes("statusline-wrapper.mjs"));
  // the statusLine entry itself carries no usage data (the env token below is
  // the provider's own settings_config content, untouched)
  assert.equal(JSON.stringify(effective.statusLine).includes("zai-token"), false);
});

test("C3: settings.json identical with and without usage_script meta", () => {
  const withUsage = buildClaudeEffectiveSettings(
    ZHIPU_SETTINGS,
    ZHIPU_META,
    "{}",
    "P",
    PROVIDER_ID,
  );
  const withoutUsage = buildClaudeEffectiveSettings(ZHIPU_SETTINGS, {}, "{}", "P", PROVIDER_ID);
  assert.deepEqual(withUsage.statusLine, withoutUsage.statusLine);
});

// ─── e2e: run the generated wrapper against a local fixture server ────

function closeServer(server) {
  server.close();
  server.closeAllConnections?.();
}

function startFixtureServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function withWrapperServer(t, { kind, settings, meta, relayLine, respond }) {
  cleanInstance();
  const { server, port } = await startFixtureServer(respond);
  const baseUrl =
    kind === "deepseek"
      ? `http://127.0.0.1:${port}/anthropic`
      : `http://127.0.0.1:${port}/api/anthropic`;
  const identity = resolveUsageIdentity(
    { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "tok-123" } },
    meta,
  );
  assert.ok(identity, "fixture identity must resolve");
  const usageConfig = buildUsageQueryConfig(
    identity,
    instanceFile(),
    instanceFile("statusline-wrapper.mjs"),
  );
  const relayDir = join(testHome, "relay-bin");
  mkdirSync(relayDir, { recursive: true });
  const relayScript = relayLine ? writeRelayScript(relayDir, relayLine.head, relayLine.tail) : null;
  writeGlobalSettings(
    relayScript ? { type: "command", command: `${process.execPath} ${relayScript}` } : undefined,
  );
  const wrapperPath = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(
    wrapperPath,
    buildStatusLineWrapperScript("GLM", GLOBAL_SETTINGS, null, "auto", usageConfig),
  );
  // closeAllConnections: fetch's keep-alive sockets would stall plain close().
  t.after(() => closeServer(server));
  return { wrapperPath, usageConfig };
}

// Real shape (2026-10): {"code":200,"msg":...,"data":{level, limits:[...]}}
const ZHIPU_QUOTA_BODY = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    level: "pro",
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 40.4,
        total: 40000000,
        nextResetTime: 1770000000000,
      },
      {
        type: "TOKENS_LIMIT",
        unit: 6,
        number: 1,
        percentage: 52,
        total: 120000000,
        nextResetTime: 1770500000000,
      },
      { type: "TIME_LIMIT", percentage: 12, currentValue: 123, usage: 1000 },
    ],
  },
};

beforeEach(() => cleanInstance());

test("e2e zhipu: first render fetches, splices after context segment, caches", async (t) => {
  const requests = [];
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    relayLine: { head: "\x1b[36mOpus\x1b[0m │ Context █░░░░░ 12% │ $0.12" },
    respond: (req, res) => {
      requests.push({ auth: req.headers.authorization, lang: req.headers["accept-language"] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
    },
  });
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  // ANSI-stripped view of the first line
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const first = strip(out.split("\n")[0]);
  assert.ok(first.includes("5h ██░░░░ 40%"), first);
  assert.ok(first.includes("W ███░░░ 52%"), first);
  // context segment first, usage right after it, cost after usage
  const ctxIdx = first.indexOf("Context █░░░░░ 12%");
  const usageIdx = first.indexOf("5h ██░░░░ 40%");
  const costIdx = first.indexOf("$0.12");
  assert.ok(ctxIdx >= 0 && ctxIdx < usageIdx && usageIdx < costIdx, first);
  // zhipu auth: Bearer (api.z.ai rejects bare with business code 401 as of 2026-10)
  assert.deepEqual(requests, [{ auth: "Bearer tok-123", lang: "en-US,en" }]);
  // cache written with parsed data
  const cache = JSON.parse(readFileSync(instanceFile(), "utf8"));
  assert.deepEqual(cache.data, { kind: "zhipu", fiveH: 40, weekly: 52 });
});

test("e2e zhipu: fresh cache renders with zero requests; expired cache serves stale + refresh mode updates", async (t) => {
  let hits = 0;
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    relayLine: { head: "Opus │ Context █░░░░░ 12%" },
    respond: (req, res) => {
      hits++;
      res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
    },
  });
  const r1 = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r1.status, 0);
  assert.equal(hits, 1);
  const r2 = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r2.status, 0);
  assert.equal(hits, 1, "fresh TTL hit must not hit the network");
  // expire the cache, then run the detached-refresh mode by hand
  const cachePath = instanceFile();
  const cache = JSON.parse(readFileSync(cachePath, "utf8"));
  cache.ts = 0;
  writeFileSync(cachePath, JSON.stringify(cache));
  const r3 = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r3.status, 0);
  assert.ok(
    stripAnsi(r3.stdout).includes("5h ██░░░░ 40%"),
    "stale value still renders: " + JSON.stringify(r3.stdout),
  );
  const staleFirst = stripAnsi(r3.stdout.split("\n")[0]);
  assert.ok(
    staleFirst.includes("Context █░░░░░ 12%") &&
      staleFirst.indexOf("5h") > staleFirst.indexOf("Context"),
    "still spliced after context: " + JSON.stringify(r3.stdout),
  );
  const refresh = await runWrapper(wrapperPath, STATUSLINE_INPUT, {
    CC_LAUNCH_USAGE_REFRESH: "1",
  });
  assert.equal(refresh.status, 0);
  assert.equal(refresh.stdout, "", "refresh mode prints nothing");
  const updated = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.ok(updated.ts > 0, "refresh mode updates ts");
  assert.deepEqual(updated.data, { kind: "zhipu", fiveH: 40, weekly: 52 });
});

test("e2e zhipu: error backoff suppresses repeated sync fetches", async (t) => {
  let hits = 0;
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    relayLine: { head: "Opus │ Context █░░░░░ 12%" },
    respond: (req, res) => {
      hits++;
      res.statusCode = 500;
      res.end("{}");
    },
  });
  // A failure-only cache (data:null + errTs) used to be discarded by the
  // cache reader, making backedOff permanently false: every render paid a
  // fresh 1.5s sync fetch.
  writeFileSync(
    instanceFile(),
    JSON.stringify({
      v: 1,
      ts: 0,
      refreshTs: 0,
      errTs: Date.now(),
      data: null,
    }),
  );
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hits, 0, "backoff must suppress the sync fetch");
  assert.ok(!stripAnsi(r.stdout).includes("5h"), "no usage segment without data");
});

test("e2e zhipu: expired backoff retries once and clears errTs", async (t) => {
  let hits = 0;
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    relayLine: { head: "Opus │ Context █░░░░░ 12%" },
    respond: (req, res) => {
      hits++;
      res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
    },
  });
  writeFileSync(
    instanceFile(),
    JSON.stringify({
      v: 1,
      ts: 0,
      refreshTs: 0,
      errTs: Date.now() - 61_000,
      data: null,
    }),
  );
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hits, 1, "expired backoff allows exactly one retry");
  const cache = JSON.parse(readFileSync(instanceFile(), "utf8"));
  assert.equal(cache.errTs, 0, "successful fetch clears the error marker");
  assert.deepEqual(cache.data, { kind: "zhipu", fiveH: 40, weekly: 52 });
});

test("e2e zhipu: refresh dedup window suppresses a data-less sync fetch", async (t) => {
  let hits = 0;
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    relayLine: { head: "Opus │ Context █░░░░░ 12%" },
    respond: (req, res) => {
      hits++;
      res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
    },
  });
  // No data yet, but a background refresh was just spawned: don't pay a
  // second synchronous fetch while it is still in flight.
  writeFileSync(
    instanceFile(),
    JSON.stringify({
      v: 1,
      ts: 0,
      refreshTs: Date.now(),
      errTs: 0,
      data: null,
    }),
  );
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hits, 0, "dedup window must suppress the sync fetch");
});

test("e2e zhipu: detached refresh mode never runs the relay command", async (t) => {
  // The refresh child used to execute the relay (a full statusline tool run
  // on empty stdin) before reaching the fetch branch — observe the relay via
  // a marker file instead of stdout, which stays empty either way.
  const marker = join(testHome, "relay-ran-marker");
  rmSync(marker, { force: true });
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    meta: ZHIPU_META,
    relayLine: { head: "Opus │ Context █░░░░░ 12%" },
    respond: (req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
    },
  });
  // the wrapper inlined no RELAY_COMMAND — it reads the global settings at
  // run time, so swapping the entry takes effect for both runs below
  writeGlobalSettings({ type: "command", command: `touch ${marker}` });
  const normal = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(normal.status, 0, normal.stderr);
  assert.ok(existsSync(marker), "normal mode runs the relay");
  rmSync(marker, { force: true });
  const refresh = await runWrapper(wrapperPath, STATUSLINE_INPUT, { CC_LAUNCH_USAGE_REFRESH: "1" });
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.equal(refresh.stdout, "", "refresh mode prints nothing");
  assert.ok(!existsSync(marker), "refresh mode must not run the relay");
});

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

test("e2e zhipu: no context segment falls back to line tail; no relay renders after tag", async (t) => {
  let hits = 0;
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    relayLine: { head: "Opus │ $0.12" },
    respond: (req, res) => {
      hits++;
      res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
    },
  });
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0);
  const first = stripAnsi(r.stdout.split("\n")[0]);
  assert.ok(first.endsWith("│ 5h ██░░░░ 40% │ W ███░░░ 52%"), first);
  assert.ok(first.indexOf("$0.12") < first.indexOf("5h"), first);

  // no relay at all: self-drawn row 1, usage on row 2 (default 10-cell bar)
  cleanInstance();
  hits = 0;
  const { server, port } = await startFixtureServer((req, res) => {
    hits++;
    res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
  });
  t.after(() => closeServer(server));
  const identity = resolveUsageIdentity(
    {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        ANTHROPIC_AUTH_TOKEN: "tok",
      },
    },
    ZHIPU_META,
  );
  const usageConfig = buildUsageQueryConfig(
    identity,
    instanceFile(),
    instanceFile("statusline-wrapper.mjs"),
  );
  const wp = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(
    wp,
    buildStatusLineWrapperScript("GLM", GLOBAL_SETTINGS, null, "auto", usageConfig),
  );
  writeGlobalSettings(undefined);
  const r2 = await runWrapper(wp, STATUSLINE_INPUT);
  assert.equal(r2.status, 0);
  const out2 = stripAnsi(r2.stdout).replace(/\n+$/, "").split("\n");
  assert.ok(out2[0].startsWith("[GLM][Opus] tmp"), out2[0]);
  // COLUMNS in the test env is <100, so the self-drawn bar is 6 cells wide
  assert.ok(out2[1].startsWith("5h ██░░░░ 40%"), out2[1]);
  assert.ok(out2[1].includes(" · W ███░░░ 52%"), out2[1]);
});

test("e2e deepseek: bearer auth, balance rendering, currency symbols", async (t) => {
  const requests = [];
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "deepseek",
    settings: DEEPSEEK_SETTINGS,
    meta: DEEPSEEK_META,
    relayLine: { head: "Opus │ Context █░░░░░ 12%" },
    respond: (req, res) => {
      requests.push(req.headers.authorization);
      res.end(
        JSON.stringify({
          balance_infos: [{ currency: "USD", total_balance: "12.34" }],
          is_available: true,
        }),
      );
    },
  });
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0);
  const first = stripAnsi(r.stdout.split("\n")[0]);
  assert.ok(first.includes("[$12.34]"), first);
  assert.ok(first.indexOf("Context") < first.indexOf("[$12.34]"), first);
  assert.deepEqual(requests, ["Bearer tok-123"]);

  // CNY symbol
  cleanInstance();
  const { server, port } = await startFixtureServer((req, res) => {
    res.end(
      JSON.stringify({
        balance_infos: [{ currency: "CNY", total_balance: "88.00" }],
        is_available: true,
      }),
    );
  });
  t.after(() => closeServer(server));
  const identity = resolveUsageIdentity(
    {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
        ANTHROPIC_AUTH_TOKEN: "tok",
      },
    },
    DEEPSEEK_META,
  );
  const usageConfig = buildUsageQueryConfig(
    identity,
    instanceFile(),
    instanceFile("statusline-wrapper.mjs"),
  );
  const wp = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(wp, buildStatusLineWrapperScript("DS", GLOBAL_SETTINGS, null, "auto", usageConfig));
  const r2 = await runWrapper(wp, STATUSLINE_INPUT);
  assert.ok(stripAnsi(r2.stdout).includes("[¥88.00]"), r2.stdout);
});

test("e2e failures: server 500, malformed JSON, missing weekly — degrade silently", async (t) => {
  const cases = [
    (req, res) => {
      res.statusCode = 500;
      res.end("boom");
    },
    // business-level rejection: HTTP 200 + {"code":401,"success":false}
    (req, res) => {
      res.end(JSON.stringify({ code: 401, msg: "token expired or incorrect", success: false }));
    },
    (req, res) => {
      res.end("<html>not json</html>");
    },
    (req, res) => {
      res.end(
        JSON.stringify({ limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 10 }] }),
      );
    },
    (req, res) => {
      res.end(JSON.stringify({ limits: [{ type: "TIME_LIMIT", percentage: 5 }] }));
    },
  ];
  for (const respond of cases) {
    // withWrapperServer registers t.after(close) — a failed assertion can't
    // leak the server handle and stall the test process.
    const { wrapperPath } = await withWrapperServer(t, {
      kind: "zhipu",
      settings: ZHIPU_SETTINGS,
      meta: ZHIPU_META,
      relayLine: { head: "Opus │ Context █░░░░░ 12% │ $0.12" },
      respond,
    });
    const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
    assert.equal(r.status, 0);
    const first = stripAnsi(r.stdout.split("\n")[0]);
    assert.equal(first, "[GLM] Opus │ Context █░░░░░ 12% │ $0.12", `no usage for case: ${first}`);
  }
});

test("e2e: Chinese context label and pipe separator still splice; color thresholds", async (t) => {
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    relayLine: { head: "Opus | 上下文 ██░░░░░░ 21% | $0.10" },
    respond: (req, res) => {
      res.end(
        JSON.stringify({
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 95 },
            { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 75 },
          ],
        }),
      );
    },
  });
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0);
  const first = stripAnsi(r.stdout.split("\n")[0]);
  // the context bar in the relay is 8 cells — the usage bars follow it
  assert.ok(first.includes("5h ████████ 95%"), first);
  assert.ok(first.includes("W ██████░░ 75%"), first);
  assert.ok(first.indexOf("上下文") < first.indexOf("5h"), first);
  assert.ok(first.indexOf("5h") < first.indexOf("$0.10"), first);
  // red for >=90 on the fill; the pct number shares the fill color and the
  // empty bar cells stay dim (75% → 6 fill + 2 empty on the 8-cell bar)
  assert.ok(r.stdout.includes("\x1b[91m"), "90+ uses red");
  assert.ok(r.stdout.includes("\x1b[93m"), "70-89 uses yellow");
  assert.ok(r.stdout.includes("\x1b[91m 95%"), "pct number shares fill color");
  assert.ok(r.stdout.includes("\x1b[93m 75%"), "pct number shares fill color");
  assert.ok(r.stdout.includes("\x1b[0m\x1b[2m░░"), "empty bar cells dim");
});

test("e2e zhipu: 100% window renders ⚠ Limit without bar/pct; windows independent", async (t) => {
  const respond = (five, weekly) => (req, res) => {
    res.end(
      JSON.stringify({
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: five },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: weekly },
        ],
      }),
    );
  };
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    relayLine: { head: "Opus │ Context █░░░░░ 12%" },
    respond: respond(100, 60),
  });
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0, r.stderr);
  const first = stripAnsi(r.stdout.split("\n")[0]);
  assert.ok(first.includes("5h ⚠ Limit"), first);
  assert.ok(
    !first.includes("5h █") && !first.includes("5h 100%"),
    "no bar/pct when limited: " + first,
  );
  assert.ok(first.includes("W ████░░ 60%"), first);
  assert.ok(r.stdout.includes("\x1b[91m⚠ Limit"), "Limit renders red");

  // 99.6 rounds to the clamped 100 → Limit, while the other window stays a bar
  cleanInstance();
  const { server, port } = await startFixtureServer(respond(99.6, 40));
  t.after(() => closeServer(server));
  const identity = resolveUsageIdentity(
    {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        ANTHROPIC_AUTH_TOKEN: "tok",
      },
    },
    ZHIPU_META,
  );
  const usageConfig = buildUsageQueryConfig(
    identity,
    instanceFile(),
    instanceFile("statusline-wrapper.mjs"),
  );
  const wp = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(
    wp,
    buildStatusLineWrapperScript("GLM", GLOBAL_SETTINGS, null, "auto", usageConfig),
  );
  const r2 = await runWrapper(wp, STATUSLINE_INPUT);
  assert.equal(r2.status, 0, r2.stderr);
  const first2 = stripAnsi(r2.stdout.split("\n")[0]);
  assert.ok(first2.includes("5h ⚠ Limit"), "99.6 rounds to Limit: " + first2);
  assert.ok(first2.includes("W ██░░░░ 40%"), "40% of 6 → 2 fill: " + first2);
});

test("e2e deepseek: balance thresholds — <10 red, <20 yellow, else white; NaN falls back to white", async (t) => {
  const cases = [
    ["9.99", "\x1b[91m"],
    ["10", "\x1b[93m"],
    ["19.99", "\x1b[93m"],
    ["20", "\x1b[97m"],
    ["88.00", "\x1b[97m"],
    ["oops", "\x1b[97m"], // unparsable balance must not trip the alarm
  ];
  for (const [bal, code] of cases) {
    const { wrapperPath } = await withWrapperServer(t, {
      kind: "deepseek",
      settings: DEEPSEEK_SETTINGS,
      meta: DEEPSEEK_META,
      relayLine: { head: "Opus │ Context █░░░░░ 12%" },
      respond: (req, res) => {
        res.end(
          JSON.stringify({
            balance_infos: [{ currency: "USD", total_balance: bal }],
            is_available: true,
          }),
        );
      },
    });
    const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      r.stdout.includes(code + "$" + bal),
      `${bal} → ${JSON.stringify(code)}: ${JSON.stringify(r.stdout)}`,
    );
  }
});

test("e2e: multi-line claude-hud layout — usage anchors at the CONTEXT row, not line 0", async (t) => {
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    // real claude-hud shape: model/git row, THEN a context row (10-cell bar,
    // no separator on it), then a hooks row. line 0 has no context segment.
    // The branch name CONTAINS the word "context" — it must not hijack the
    // anchor (a word alone is not a context segment; it needs a % or a bar).
    relayLine: {
      head: "[Opus] │ ~/proj │ git:(fix/usage-context-line-and-separator)",
      tail: ["Context ░░░░░░░░░░ 0%", "2 CLAUDE.md | 10 hooks"],
    },
    respond: (req, res) => {
      res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
    },
  });
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0, r.stderr);
  const outLines = stripAnsi(r.stdout).replace(/\n+$/, "").split("\n");
  // line 0 stays the model/git row — usage must NOT land there
  assert.ok(outLines[0].includes("[Opus]") && !outLines[0].includes("5h"), outLines[0]);
  // usage sits on the context row, right after it — joined by the DETECTED
  // separator (│), never a bare space, even though the context row itself
  // has no separator
  assert.ok(
    outLines[1].includes("Context ░░░░░░░░░░ 0% │ 5h") &&
      outLines[1].indexOf("5h") > outLines[1].indexOf("Context"),
    outLines[1],
  );
  // bar width follows the context row's 10-cell bar (40%→4, 52%→5)
  assert.ok(outLines[1].includes("5h ████░░░░░░ 40%"), outLines[1]);
  assert.ok(outLines[1].includes("W █████░░░░░ 52%"), outLines[1]);
  // inner separator mirrors the relay's own (│ on the model row)
  assert.ok(outLines[1].includes("40% │ W"), outLines[1]);
  // hooks row untouched, still after the usage
  assert.ok(outLines[2].includes("CLAUDE.md"), outLines[2]);
});

test("e2e: separator detection — | relay mirrors |, standalone falls back to ·", async (t) => {
  // relay that uses ONLY "|" (no │): inner separator must be " | "
  const { wrapperPath } = await withWrapperServer(t, {
    kind: "zhipu",
    settings: ZHIPU_SETTINGS,
    meta: ZHIPU_META,
    relayLine: { head: "Opus | Context █░░░░░ 12% | $0.12" },
    respond: (req, res) => res.end(JSON.stringify(ZHIPU_QUOTA_BODY)),
  });
  const r = await runWrapper(wrapperPath, STATUSLINE_INPUT);
  assert.equal(r.status, 0);
  const first = stripAnsi(r.stdout.split("\n")[0]);
  assert.ok(first.includes("40% | W"), first);

  // no relay at all: standalone default " · "
  cleanInstance();
  const { server, port } = await startFixtureServer((req, res) =>
    res.end(JSON.stringify(ZHIPU_QUOTA_BODY)),
  );
  t.after(() => closeServer(server));
  const identity = resolveUsageIdentity(
    {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        ANTHROPIC_AUTH_TOKEN: "tok",
      },
    },
    ZHIPU_META,
  );
  const usageConfig = buildUsageQueryConfig(
    identity,
    instanceFile(),
    instanceFile("statusline-wrapper.mjs"),
  );
  const wp = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(
    wp,
    buildStatusLineWrapperScript("GLM", GLOBAL_SETTINGS, null, "auto", usageConfig),
  );
  writeGlobalSettings(undefined);
  const r2 = await runWrapper(wp, STATUSLINE_INPUT);
  assert.equal(r2.status, 0);
  const out2 = stripAnsi(r2.stdout).replace(/\n+$/, "").split("\n");
  assert.ok(out2[0].startsWith("[GLM][Opus] tmp"), out2[0]);
  assert.ok(out2[1].includes("40% · W"), out2[1]);
});

// ─── aggregation (cc-switch 4.0 Stack) ────────────────────────────────

const STACK_PROVIDER_ID = "stack-provider-id";
const STACK_SETTINGS = {
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721", ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED" },
};
const LIVE_STATE_PATH_T = join(CC, "live-state.json");
const PICKER_FIXTURE = {
  replaceBuiltInOptions: true,
  options: [
    {
      model: "ccs-claude-zhipu--glm-5.3[1M]",
      label: "glm-5.3（Z.AI GLM）",
      description: "glm-5.3 · 1M",
    },
  ],
};

function writeLiveState(stack, proxyRoute) {
  mkdirSync(CC, { recursive: true });
  writeFileSync(
    LIVE_STATE_PATH_T,
    JSON.stringify({
      version: 1,
      apps: {
        claude: { mode: "proxy", ...(proxyRoute ? { proxy_route: proxyRoute } : {}), stack },
      },
    }),
  );
}
function removeLiveState() {
  rmSync(LIVE_STATE_PATH_T, { force: true });
}
function stackInstanceFile(name) {
  return join(INSTANCES, STACK_PROVIDER_ID, name);
}
function cleanStackInstance() {
  rmSync(join(INSTANCES, STACK_PROVIDER_ID), { recursive: true, force: true });
}
// The virtual id's instance dir — the durable "aggregation was used" trace the
// dormant virtual row keys on. Distinct from cleanStackInstance (old row id).
function cleanVirtualStackInstance() {
  rmSync(join(INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true, force: true });
}

test("aggregation unit: loopback detection + PROXY_MANAGED stack signature", () => {
  assert.equal(isLoopbackBaseUrl("http://127.0.0.1:15721"), true);
  assert.equal(isLoopbackBaseUrl("http://localhost:15721"), true);
  assert.equal(isLoopbackBaseUrl("http://[::1]:15721"), true);
  assert.equal(isLoopbackBaseUrl("https://api.z.ai/api/anthropic"), false);
  assert.equal(isLoopbackBaseUrl(""), false);
  assert.equal(isLoopbackBaseUrl("not a url"), false);
  assert.equal(isAggregationProviderSettings(STACK_SETTINGS), true);
  // a user's own local gateway (loopback + REAL token) is not a Stack row
  assert.equal(
    isAggregationProviderSettings({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", ANTHROPIC_AUTH_TOKEN: "sk-gateway" },
    }),
    false,
  );
  // the placeholder without a loopback base URL is not one either
  assert.equal(
    isAggregationProviderSettings({
      env: {
        ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
        ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
      },
    }),
    false,
  );
  assert.equal(isAggregationProviderSettings(ZHIPU_SETTINGS), false);
});

test("aggregation unit: readStackState is fail-open", () => {
  removeLiveState();
  assert.equal(readStackState("claude"), null); // missing file
  writeFileSync(LIVE_STATE_PATH_T, "{corrupt");
  assert.equal(readStackState("claude"), null); // corrupt JSON
  writeLiveState({ enabled: false, members: ["x"], keys: { k: "x" } });
  assert.equal(readStackState("claude"), null); // disabled
  writeLiveState({ enabled: true, members: [], keys: {} });
  assert.equal(readStackState("claude"), null); // empty roster
  writeLiveState(
    { enabled: true, members: ["m1", "m2", "orphan"], keys: { zhipu: "m1", deepseek: "m2" } },
    "m1",
  );
  const st = readStackState("claude");
  assert.deepEqual(st.keys, { zhipu: "m1", deepseek: "m2" });
  assert.deepEqual(st.members, ["m1", "m2"]); // orphan (not in keys) filtered
  assert.equal(st.proxyRoute, "m1");
  // contract gate: an unknown version is a schema this build cannot read —
  // both the file-level version and the app's contract block read as "off"
  const liveStack = { enabled: true, members: ["m1"], keys: { zhipu: "m1" } };
  writeFileSync(
    LIVE_STATE_PATH_T,
    JSON.stringify({ version: 2, apps: { claude: { stack: liveStack } } }),
  );
  assert.equal(readStackState("claude"), null, "file version 2 → off");
  writeFileSync(
    LIVE_STATE_PATH_T,
    JSON.stringify({
      version: 1,
      apps: { claude: { contract: { version: 2 }, stack: liveStack } },
    }),
  );
  assert.equal(readStackState("claude"), null, "contract version 2 → off");
  writeFileSync(LIVE_STATE_PATH_T, JSON.stringify({ apps: { claude: { stack: liveStack } } }));
  assert.notEqual(readStackState("claude"), null, "no version field → tolerated");
  removeLiveState();
});

test("aggregation unit: readGlobalModelPicker — empty options is a legal cleared state", () => {
  writeGlobalSettings(undefined);
  assert.equal(readGlobalModelPicker(), null, "no key at all → absence");
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({ modelPicker: { replaceBuiltInOptions: true, options: [] } }),
  );
  const empty = readGlobalModelPicker();
  assert.notEqual(empty, null, "cleared list is a legal state, not absence");
  assert.deepEqual(empty.options, []);
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify({ modelPicker: PICKER_FIXTURE }));
  assert.deepEqual(readGlobalModelPicker(), PICKER_FIXTURE);
  // non-array options → not a picker shape we recognize
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify({ modelPicker: { options: "garbage" } }));
  assert.equal(readGlobalModelPicker(), null);
});

test("aggregation: probeTcpReachable — live port passes, dead/garbage fail fast", async () => {
  const srv = createServer(() => {});
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  assert.equal(
    await probeTcpReachable(`http://127.0.0.1:${port}/api/anthropic`),
    true,
    "listening port",
  );
  await new Promise((r) => srv.close(r));
  assert.equal(await probeTcpReachable(`http://127.0.0.1:${port}/api`), false, "port just closed");
  assert.equal(await probeTcpReachable("not a url"), false, "garbage URL");
  assert.equal(await probeTcpReachable("http://127.0.0.1:1/"), false, "port 1 refused");
});

test("aggregation doctor checks: off / unparseable / version gate / live-stack matrix", async (t) => {
  cleanStackInstance();
  // aggregation off — a single pass, nothing else probed
  removeLiveState();
  let checks = await aggregationDoctorChecks();
  assert.equal(checks.length, 1);
  assert.equal(checks[0].pass, true);
  assert.ok(checks[0].detail.includes("off"));
  // unparseable live-state
  writeFileSync(LIVE_STATE_PATH_T, "{corrupt");
  checks = await aggregationDoctorChecks();
  assert.equal(checks[0].pass, false);
  // unsupported file-level version
  writeFileSync(LIVE_STATE_PATH_T, JSON.stringify({ version: 9, apps: {} }));
  checks = await aggregationDoctorChecks();
  assert.equal(checks[0].pass, false);
  assert.ok(checks[0].detail.includes("9"));
  // live stack: members present + virtual entry + proxy state. The proxy
  // URL the entry derives from comes from the global env, so it can be
  // pointed at a port that is genuinely dead (bound then released).
  const srv = createServer(() => {});
  t.after(() => {
    srv.closeAllConnections?.();
    try {
      srv.close();
    } catch {}
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const livePort = srv.address().port;
  setupStackDB([
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
    [
      "agg-doc",
      "Stack",
      { ANTHROPIC_BASE_URL: `http://127.0.0.1:${livePort}`, ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED" },
      {},
    ],
  ]);
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${livePort}` } }),
  );
  writeLiveState({ enabled: true, members: ["m-ds"], keys: { deepseek: "m-ds" } }, "m-ds");
  const byLabel = (cs) => Object.fromEntries(cs.map((c) => [c.label, c]));
  checks = await aggregationDoctorChecks();
  assert.equal(byLabel(checks)["aggregation members"].pass, true);
  assert.equal(byLabel(checks)["aggregation Stack row"].pass, true);
  assert.ok(byLabel(checks)["aggregation Stack row"].detail.includes("virtual entry derived"));
  assert.equal(byLabel(checks)["aggregation proxy"].pass, true, "proxy up while server listens");
  await new Promise((r) => srv.close(r));
  checks = await aggregationDoctorChecks();
  assert.equal(byLabel(checks)["aggregation proxy"].pass, false, "proxy down after close");
  // member row deleted → members check fails, naming the dangling key
  sql(`DELETE FROM providers WHERE id = 'm-ds'`);
  checks = await aggregationDoctorChecks();
  assert.equal(byLabel(checks)["aggregation members"].pass, false);
  assert.ok(byLabel(checks)["aggregation members"].detail.includes("deepseek"));
  // legacy DB rows (pre-virtualization) are reported as pending auto-cleanup
  checks = await aggregationDoctorChecks();
  assert.ok(byLabel(checks)["aggregation Stack row"].detail.includes("1 legacy DB row"));
  // the virtual entry needs no DB row at all — and the proxy probe still runs
  // against the derived base URL (now down: the server was closed above)
  sql(`DELETE FROM providers WHERE id = 'agg-doc'`);
  checks = await aggregationDoctorChecks();
  assert.equal(byLabel(checks)["aggregation Stack row"].pass, true);
  assert.ok(byLabel(checks)["aggregation Stack row"].detail.includes("virtual entry derived"));
  assert.equal(byLabel(checks)["aggregation proxy"].pass, false);
  removeLiveState();
  writeGlobalSettings(undefined);
  cleanVirtualStackInstance();
  sql(`DELETE FROM providers WHERE id IN ('m-ds', 'agg-doc')`);
});

test("aggregation unit: stackBillingMemberName decode matrix (ps billing suffix)", () => {
  setupStackDB([
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
  ]);
  // zhipu maps to a row that does not exist — the dangling case
  const stack = {
    keys: { deepseek: "m-ds", zhipu: "m-gone" },
    members: ["m-ds"],
    proxyRoute: null,
  };
  assert.equal(stackBillingMemberName("ccs-claude-deepseek--deepseek-chat[1M]", stack), "DeepSeek");
  assert.equal(
    stackBillingMemberName("CCS-CLAUDE-DEEPSEEK--x", stack),
    "DeepSeek",
    "uppercase id decodes the same",
  );
  assert.equal(
    stackBillingMemberName("ccs-claude-zhipu--glm", stack),
    null,
    "key → deleted provider row",
  );
  assert.equal(stackBillingMemberName("ccs-claude-nope--x", stack), null, "unregistered key");
  assert.equal(
    stackBillingMemberName("glm-5.3[1M]", stack),
    null,
    "non-ccs pick has no member to name",
  );
  assert.equal(stackBillingMemberName("", stack), null);
  assert.equal(stackBillingMemberName("ccs-claude-deepseek--x", null), null, "stack off");
  sql(`DELETE FROM providers WHERE id = 'm-ds'`);
});

test("aggregation: modelPicker syncs into effective settings only while stack is live", () => {
  cleanStackInstance();
  removeLiveState();
  writeGlobalSettings(undefined);
  // stack off → the provider row's own snapshot survives untouched
  // (hand-made row: meta carries no stackManaged marker)
  const snap = buildClaudeEffectiveSettings(
    { ...STACK_SETTINGS, modelPicker: "snapshot" },
    {},
    "{}",
    "Stack",
    STACK_PROVIDER_ID,
  );
  assert.equal(snap.modelPicker, "snapshot");
  // stack on + global picker → synced (fresh contract from the desktop app)
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify({ modelPicker: PICKER_FIXTURE }));
  writeLiveState({ enabled: true, members: ["m1"], keys: { zhipu: "m1" } }, "m1");
  const live = buildClaudeEffectiveSettings(
    { ...STACK_SETTINGS, modelPicker: "snapshot" },
    {},
    "{}",
    "Stack",
    STACK_PROVIDER_ID,
  );
  assert.deepEqual(live.modelPicker, PICKER_FIXTURE);
  // stack on + CLEARED global list (empty options) → the picker drops
  // entirely instead of keeping a stale row snapshot
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({ modelPicker: { replaceBuiltInOptions: true, options: [] } }),
  );
  const cleared = buildClaudeEffectiveSettings(
    { ...STACK_SETTINGS, modelPicker: "snapshot" },
    {},
    "{}",
    "Stack",
    STACK_PROVIDER_ID,
  );
  assert.equal(cleared.modelPicker, undefined, "cleared desktop list drops the picker");
  removeLiveState();
  // stack off + MANAGED row → the stale ccs snapshot drops (dead-proxy ids
  // must not linger in /model); a hand-made row's snapshot survives
  const managed = buildClaudeEffectiveSettings(
    { ...STACK_SETTINGS, modelPicker: "snapshot" },
    { stackManaged: true },
    "{}",
    "Stack",
    STACK_PROVIDER_ID,
  );
  assert.equal(
    managed.modelPicker,
    undefined,
    "managed row's snapshot drops when the stack is off",
  );
  removeLiveState();
  cleanStackInstance();
});

// ─── aggregation forced common merge (hooks fix) ──────────────────────
// A Stack row's settings_config is routing-only (loopback env + modelPicker),
// so providerUsesCommonConfig's subset fallback can never see the common
// content and the row used to launch without hooks (the tmux plugin went
// silent). Aggregation rows now merge the common config unconditionally —
// except when meta carries an explicit commonConfigEnabled:false — with the
// routing identity (base URL / auth / model aliases) protected afterwards.

// captureStderr: guards against merge warnings leaking AND lets malformed-
// snippet assertions pin the warning text (pattern from guard.test.mjs).
let stderrBuf = "";
function captureStderr(fn) {
  stderrBuf = "";
  const orig = process.stderr.write;
  process.stderr.write = (s) => {
    stderrBuf += s;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
}

// Common config shaped like the real one: hooks (tmux plugin) + env that is
// NOT identity (CLAUDE_CODE_* merges normally).
const STACK_COMMON = JSON.stringify({
  env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
  hooks: {
    SessionStart: [
      { matcher: "", hooks: [{ type: "command", command: "tmux-ai-status sessionstart" }] },
    ],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "tmux-ai-status stop" }] }],
  },
  permissions: { allow: ["Bash(ls:*)"] },
});

test("aggregation: meta={} row still merges the common config — hooks land, identity env untouched", () => {
  removeLiveState(); // stack off — merge must NOT depend on desktop state
  const effective = buildClaudeEffectiveSettings(STACK_SETTINGS, {}, STACK_COMMON);
  assert.ok(effective.hooks.SessionStart, "hooks merged");
  assert.ok(effective.hooks.Stop, "hooks merged");
  assert.equal(effective.permissions.allow[0], "Bash(ls:*)");
  assert.equal(effective.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1");
  // routing identity survives the merge
  assert.equal(effective.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15721");
  assert.equal(effective.env.ANTHROPIC_AUTH_TOKEN, "PROXY_MANAGED");
  // stack on → same merge (the decision is row-shape × meta, not desktop state)
  writeLiveState({ enabled: true, members: ["m1"], keys: { zhipu: "m1" } }, "m1");
  const live = buildClaudeEffectiveSettings(STACK_SETTINGS, {}, STACK_COMMON);
  assert.ok(live.hooks.SessionStart);
  removeLiveState();
});

test("aggregation: common env can never re-point or re-auth the loopback row", () => {
  const hostile = JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: "https://evil.example.com",
      ANTHROPIC_AUTH_TOKEN: "common-bearer",
      ANTHROPIC_API_KEY: "common-key",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    },
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "tmux-ai-status stop" }] }],
    },
  });
  // row HAS base URL + token → row values restored; row LACKS API_KEY →
  // the planted key is deleted outright (AUTH_TOKEN outranks API_KEY in the
  // Claude CLI, so a surviving common key would hijack auth)
  const effective = buildClaudeEffectiveSettings(STACK_SETTINGS, {}, hostile);
  assert.equal(effective.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15721");
  assert.equal(effective.env.ANTHROPIC_AUTH_TOKEN, "PROXY_MANAGED");
  assert.equal(effective.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(
    effective.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
    "1",
    "non-identity env merges normally",
  );
  assert.ok(effective.hooks.Stop);
});

test("aggregation: protectAggregationIdentityEnv unit — row env wins, ccs model aliases kept, scalar-env wreckage rebuilt", () => {
  const row = {
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
      ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "ccs-zhipu--glm-5.3",
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "glm-5.3（Z.AI GLM）",
    },
  };
  const effective = {
    env: {
      ANTHROPIC_BASE_URL: "https://common.example.com",
      ANTHROPIC_AUTH_TOKEN: "common-bearer",
      ANTHROPIC_API_KEY: "common-key",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "direct-sonnet",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "common-opus-alias", // row lacks it — harmless, kept
    },
  };
  protectAggregationIdentityEnv(effective, row);
  assert.equal(effective.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15721");
  assert.equal(effective.env.ANTHROPIC_AUTH_TOKEN, "PROXY_MANAGED");
  assert.equal(effective.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(
    effective.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    "ccs-zhipu--glm-5.3",
    "row alias wins",
  );
  assert.equal(
    effective.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME,
    "glm-5.3（Z.AI GLM）",
    "row alias name restored",
  );
  assert.equal(
    effective.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    "common-opus-alias",
    "alias the row lacks is not deleted",
  );

  // a scalar/mismatched common `env` full-overwrites the row's env object in
  // the merge fallthrough — the guard rebuilds env instead of crashing
  const wrecked = { env: "scalar-garbage" };
  protectAggregationIdentityEnv(wrecked, row);
  assert.equal(wrecked.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15721");
  assert.equal(wrecked.env.ANTHROPIC_AUTH_TOKEN, "PROXY_MANAGED");
});

test("aggregation: explicit commonConfigEnabled:false still wins on a loopback row", () => {
  // the desktop app can turn the common config off on the Stack row itself —
  // the explicit meta choice outranks the forced merge either way
  const effective = buildClaudeEffectiveSettings(
    STACK_SETTINGS,
    { commonConfigEnabled: false },
    STACK_COMMON,
  );
  assert.equal(effective.hooks, undefined);
  assert.equal(effective.permissions, undefined);
});

test("aggregation: local-gateway row (loopback + real token) is NOT force-merged anymore", () => {
  // v0.17.1's loopback-only signature mistook a user's own gateway row
  // (LiteLLM, one-api …) for a Stack row: forced common merge + identity-key
  // deletion. The PROXY_MANAGED signature puts gateway rows back on the
  // normal subset fallback — a full gateway row is not a subset of the
  // common config, so nothing merges and its own auth survives untouched.
  const gateway = {
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", ANTHROPIC_AUTH_TOKEN: "sk-gateway" },
  };
  const effective = buildClaudeEffectiveSettings(gateway, {}, STACK_COMMON);
  assert.equal(effective.hooks, undefined, "no forced merge for gateway rows");
  assert.equal(effective.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, undefined);
  assert.equal(effective.env.ANTHROPIC_AUTH_TOKEN, "sk-gateway");
  // control: the SAME row as a Stack row (placeholder token) still merges
  const stack = buildClaudeEffectiveSettings(STACK_SETTINGS, {}, STACK_COMMON);
  assert.ok(stack.hooks.SessionStart, "control: Stack rows keep force-merging");
});

test("aggregation: common statusLine becomes the wrapper relay source, never the entry itself", () => {
  cleanStackInstance();
  writeGlobalSettings({ type: "command", command: "echo global-relay" });
  const common = JSON.stringify({
    statusLine: { type: "command", command: "echo from-common" },
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "tmux-ai-status stop" }] }],
    },
  });
  const effective = buildClaudeEffectiveSettings(
    STACK_SETTINGS,
    {},
    common,
    "Stack",
    STACK_PROVIDER_ID,
  );
  assert.ok(effective.statusLine.command.includes("statusline-wrapper.mjs"));
  assert.equal(JSON.stringify(effective.statusLine).includes("from-common"), false);
  // an explicit provider/common statusLine is the wrapper's PREFERRED relay
  // source (inlined at generation time, ahead of the global fallback)
  const wrapper = readFileSync(stackInstanceFile("statusline-wrapper.mjs"), "utf8");
  assert.ok(wrapper.includes("echo from-common"), "common relay inlined");
  assert.equal(JSON.stringify(effective.statusLine).includes("echo from-common"), false);
  cleanStackInstance();
});

test("aggregation: malformed and non-object common snippets never corrupt the row", () => {
  const base = JSON.parse(JSON.stringify(STACK_SETTINGS));
  // invalid JSON → warning, settings untouched
  captureStderr(() => buildClaudeEffectiveSettings(base, {}, "{not json"));
  assert.ok(stderrBuf.includes("Common config merge failed"));
  // non-object snippet → skipped by the object guard (would previously
  // full-overwrite the settings through mergeCommonOverProvider's scalar branch)
  captureStderr(() => {
    const effective = buildClaudeEffectiveSettings(base, { commonConfigEnabled: true }, "[1,2]");
    assert.equal(stderrBuf, "", "object guard skips silently");
    assert.deepEqual(effective, base);
  });
});

test("non-aggregation row keeps the legacy meta={} subset behavior (no forced merge)", () => {
  // Z.AI GLM settings contain none of the common content → subset fallback
  // says "not using common" → no merge, exactly as before this fix
  const effective = buildClaudeEffectiveSettings(ZHIPU_SETTINGS, {}, STACK_COMMON);
  assert.equal(effective.hooks, undefined);
  assert.equal(effective.permissions, undefined);
  assert.equal(effective.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
});

test("split: aggregation instance edits route by where the key lives — hooks→common, identity token→provider, common token→rejected", () => {
  const commonObj = JSON.parse(STACK_COMMON); // hooks + CLAUDE_CODE_* env, no ANTHROPIC_*
  const providerSettings = {
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721", ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED" },
  };
  const { commonPatch, providerPatch, rejected } = splitChangesByTarget(
    [
      {
        path: "hooks.Stop",
        op: "replace",
        to: [{ matcher: "", hooks: [{ type: "command", command: "tmux-ai-status stop2" }] }],
      },
      { path: "env.ANTHROPIC_AUTH_TOKEN", op: "replace", to: "user-rotated" },
    ],
    STACK_PROVIDER_ID,
    commonObj,
    providerSettings,
  );
  // hooks live in the common config → edit goes UP to common (shared by all
  // instances), never into the aggregation row
  assert.deepEqual(commonPatch.hooks.Stop, [
    { matcher: "", hooks: [{ type: "command", command: "tmux-ai-status stop2" }] },
  ]);
  // the row's own env is the routing identity → stays on the provider row
  assert.equal(providerPatch.env?.ANTHROPIC_AUTH_TOKEN, "user-rotated");
  // and when the common config DID carry the token, the sensitive gate rejects
  const hostile = { env: { ANTHROPIC_AUTH_TOKEN: "common-bearer" } };
  const r2 = splitChangesByTarget(
    [{ path: "env.ANTHROPIC_AUTH_TOKEN", op: "replace", to: "user-rotated" }],
    STACK_PROVIDER_ID,
    hostile,
    providerSettings,
  );
  assert.equal(r2.commonPatch.env?.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(r2.rejected.length, 1);
});

test("aggregation e2e: claude adapter prepare writes hooks into the instance settings.json", () => {
  cleanStackInstance();
  writeGlobalSettings(undefined);
  const claude = APP_ADAPTERS.claude;
  claude.prepare(
    join(INSTANCES, STACK_PROVIDER_ID),
    STACK_PROVIDER_ID,
    STACK_SETTINGS,
    {},
    null,
    STACK_COMMON,
    {},
  );
  const written = JSON.parse(readFileSync(stackInstanceFile("settings.json"), "utf8"));
  assert.ok(written.hooks.SessionStart, "hooks on disk");
  assert.ok(written.hooks.Stop, "hooks on disk");
  assert.equal(written.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15721", "loopback intact on disk");
  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, "PROXY_MANAGED");
  cleanStackInstance();
});

// Real sqlite DB (same CLI the tool uses — sync-codex.test.mjs pattern) with
// the live member rows, so buildStackUsageConfig resolves each member with
// its OWN credentials the same way a direct provider would.
function sql(statement) {
  return execFileSync("sqlite3", [join(CC, "cc-switch.db"), ".timeout 3000", statement], {
    encoding: "utf8",
  });
}

function setupStackDB(members) {
  mkdirSync(CC, { recursive: true });
  sql(`CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
    created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
    meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0, provider_type TEXT,
    PRIMARY KEY (id, app_type));`);
  for (const [id, name, env, meta] of members) {
    sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta)
      VALUES ('${id}', 'claude', '${name}',
      '${JSON.stringify({ env }).replace(/'/g, "''")}',
      '${JSON.stringify(meta).replace(/'/g, "''")}');`);
  }
}

test("aggregation: buildStackUsageConfig resolves members with own creds; unresolvable members drop out", () => {
  cleanStackInstance();
  setupStackDB([
    [
      "m-zai",
      "Z.AI GLM",
      { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "zai-tok" },
      ZHIPU_META,
    ],
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
    [
      "m-nz",
      "Example Provider",
      { ANTHROPIC_BASE_URL: "https://agent-gateway.example.com/x", ANTHROPIC_AUTH_TOKEN: "nz" },
      {},
    ],
  ]);
  writeLiveState(
    {
      enabled: true,
      members: ["m-ds", "m-zai", "m-nz"],
      keys: { deepseek: "m-ds", zhipu: "m-zai", nezha: "m-nz" },
    },
    "m-zai",
  );
  const stack = readStackState("claude");
  const cfg = buildStackUsageConfig(
    stack,
    join(INSTANCES, STACK_PROVIDER_ID),
    stackInstanceFile("statusline-wrapper.mjs"),
  );
  assert.deepEqual(Object.keys(cfg.map).sort(), ["deepseek", "zhipu"]); // nezha unresolvable → absent
  assert.equal(cfg.map.zhipu.url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(cfg.map.zhipu.token, "zai-tok");
  assert.equal(cfg.map.deepseek.url, "https://api.deepseek.com/user/balance");
  assert.equal(cfg.map.deepseek.token, "ds-tok");
  assert.equal(cfg.map.zhipu.cachePath.endsWith("usage-stack-zhipu.json"), true); // per-key cache buckets
  assert.equal(cfg.defaultKey, "zhipu"); // proxy_route member
  assert.deepEqual(cfg.names, { zhipu: "Z.AI GLM", deepseek: "DeepSeek" });
  removeLiveState();
});

test("aggregation virtual row: buildStackSettingsFromGlobal derives the live contract", () => {
  writeGlobalSettings(undefined);
  // no global settings / non-loopback env → no contract to derive
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } }),
  );
  assert.equal(buildStackSettingsFromGlobal(), null);
  // loopback env + aliases + picker → full contract, aliases copied only as strings
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "ccs-claude-zhipu--glm-5.3[1M]",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 42, // non-string tiers are skipped
      },
      modelPicker: PICKER_FIXTURE,
    }),
  );
  const d = buildStackSettingsFromGlobal();
  assert.equal(d.baseUrl, "http://127.0.0.1:15721");
  assert.equal(d.settings.env.ANTHROPIC_AUTH_TOKEN, "PROXY_MANAGED");
  assert.equal(d.settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "ccs-claude-zhipu--glm-5.3[1M]");
  assert.equal(d.settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
  assert.deepEqual(d.settings.modelPicker, PICKER_FIXTURE);
  // a CLEARED desktop picker (empty options array) is not snapshotted
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721" },
      modelPicker: { replaceBuiltInOptions: true, options: [] },
    }),
  );
  assert.equal(
    buildStackSettingsFromGlobal().settings.modelPicker,
    undefined,
    "empty desktop list must not snapshot",
  );
  writeGlobalSettings(undefined);
});

test("aggregation virtual row: virtualStackProviderFor three states + name dodging", () => {
  cleanStackInstance();
  removeLiveState();
  writeGlobalSettings(undefined);
  setupStackDB([
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
  ]);
  // never used aggregation (no stack, no __stack__ instance dir) → null, zero noise
  assert.equal(virtualStackProviderFor("claude"), null);
  // dormant: stack off but a __stack__ instance dir exists → fallback base URL, no aliases/picker
  mkdirSync(join(INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true });
  const dormant = virtualStackProviderFor("claude");
  assert.ok(dormant);
  assert.equal(dormant.id, VIRTUAL_STACK_PROVIDER_ID);
  assert.equal(dormant.name, "Stack");
  assert.equal(dormant.is_virtual, true);
  assert.equal(dormant.app_type, "claude");
  assert.equal(dormant.category, null);
  let sc = JSON.parse(dormant.settings_config);
  assert.deepEqual(sc.env, {
    ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
  });
  assert.equal(sc.modelPicker, undefined);
  assert.equal(JSON.parse(dormant.meta).stackManaged, true, "virtual rows are stackManaged");
  // other apps (codex until its stack lands) never get a virtual row
  assert.equal(virtualStackProviderFor("codex"), null);
  // live: stack on + loopback global env → full derived row, fresh on every call
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "ccs-claude-zhipu--glm-5.3[1M]",
      },
      modelPicker: PICKER_FIXTURE,
    }),
  );
  writeLiveState({ enabled: true, members: ["m-ds"], keys: { deepseek: "m-ds" } }, "m-ds");
  const live = virtualStackProviderFor("claude");
  sc = JSON.parse(live.settings_config);
  assert.equal(sc.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15721");
  assert.equal(sc.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "ccs-claude-zhipu--glm-5.3[1M]");
  assert.deepEqual(sc.modelPicker, PICKER_FIXTURE);
  // name dodging: a DB row already named "Stack" pushes the virtual entry to "Stack 2"
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta)
    VALUES ('m-stackname', 'claude', 'Stack', '{}', '{}')`);
  const dodged = virtualStackProviderFor("claude");
  assert.equal(dodged.name, "Stack 2");
  sql(`DELETE FROM providers WHERE id = 'm-stackname'`);
  // cleanup
  removeLiveState();
  writeGlobalSettings(undefined);
  cleanVirtualStackInstance();
});

test("aggregation virtual row: appendVirtualStackRow merges at query exits, DB wins on id collision", () => {
  cleanVirtualStackInstance();
  removeLiveState();
  writeGlobalSettings(undefined);
  setupStackDB([
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
  ]);
  mkdirSync(join(INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true });
  // dormant entry exists → appended to a projection-shaped list
  const list = appendVirtualStackRow([{ id: "m-ds", name: "DeepSeek" }], "claude");
  assert.deepEqual(
    list.map((r) => r.id),
    ["m-ds", VIRTUAL_STACK_PROVIDER_ID],
  );
  assert.equal(list[1].name, "Stack");
  // DB already carries a __stack__ id → not appended (DB wins)
  const collided = appendVirtualStackRow(
    [{ id: VIRTUAL_STACK_PROVIDER_ID, name: "Stack" }],
    "claude",
  );
  assert.equal(collided.length, 1);
  // null entry (aggregation never used) → rows pass through untouched
  cleanVirtualStackInstance();
  assert.deepEqual(appendVirtualStackRow([{ id: "m-ds", name: "DeepSeek" }], "claude"), [
    { id: "m-ds", name: "DeepSeek" },
  ]);
});

test("aggregation: query layer merges the virtual row — DB first, fail-open exits", () => {
  cleanVirtualStackInstance();
  removeLiveState();
  writeGlobalSettings(undefined);
  // desktop aggregation on: global env loopback + live stack
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "ccs-claude-zhipu--glm-5.3[1M]",
      },
      modelPicker: PICKER_FIXTURE,
    }),
  );
  writeLiveState({ enabled: true, members: ["m-ds"], keys: { deepseek: "m-ds" } }, "m-ds");
  setupStackDB([]);
  sql(`DELETE FROM providers WHERE app_type = 'claude'`); // shared DB — drop other tests' rows
  setupStackDB([
    // a user's OWN local gateway row — loopback + REAL token; it must never
    // collide with the virtual entry's name dodge or signature scans
    [
      "m-gw",
      "My LiteLLM",
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", ANTHROPIC_AUTH_TOKEN: "sk-gateway" },
      {},
    ],
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
  ]);
  // byId: the virtual id resolves to the derived row; a real row still wins first
  const v = queryProviderById(VIRTUAL_STACK_PROVIDER_ID, "claude");
  assert.ok(v, "virtual id resolves via queryProviderById");
  assert.equal(v.is_virtual, true);
  assert.equal(JSON.parse(v.settings_config).env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15721");
  assert.equal(
    JSON.parse(v.settings_config).modelPicker.options.length,
    PICKER_FIXTURE.options.length,
  );
  assert.equal(queryProviderById("m-gw", "claude").name, "My LiteLLM", "real rows unaffected");
  // byId for an app without a virtual layer → null even for the magic id
  assert.equal(queryProviderById(VIRTUAL_STACK_PROVIDER_ID, "codex"), null);
  // byName: the derived display name resolves; unknown names stay null
  assert.equal(queryProviderMatches(v.name, "claude")[0]?.is_virtual, true);
  assert.equal(queryProviderMatches("no-such-provider", "claude").length, 0);
  // byApp: virtual row appended at the tail; a DB row already owning the id wins
  const list = queryProvidersByApp("claude");
  assert.deepEqual(
    list.map((r) => r.id),
    ["m-ds", "m-gw", VIRTUAL_STACK_PROVIDER_ID],
  );
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta)
    VALUES ('${VIRTUAL_STACK_PROVIDER_ID}', 'claude', 'Stack', '{}', '{}')`);
  const collided = queryProvidersByApp("claude");
  assert.equal(
    collided.filter((r) => r.id === VIRTUAL_STACK_PROVIDER_ID).length,
    1,
    "DB row wins the id, no duplicate",
  );
  sql(`DELETE FROM providers WHERE id = '${VIRTUAL_STACK_PROVIDER_ID}'`);
  // strict: same merge on the error-propagating exit
  const strict = queryProvidersStrict("claude");
  assert.deepEqual(
    strict.map((r) => r.id),
    ["m-ds", "m-gw", VIRTUAL_STACK_PROVIDER_ID],
  );
  // gateway row untouched by everything above
  assert.equal(
    JSON.parse(queryProviderById("m-gw", "claude").settings_config).env.ANTHROPIC_AUTH_TOKEN,
    "sk-gateway",
  );
  removeLiveState();
  writeGlobalSettings(undefined);
  cleanVirtualStackInstance();
});

test("aggregation: queryProvider name dodge — a DB row named Stack keeps the name, the virtual entry moves", () => {
  cleanVirtualStackInstance();
  removeLiveState();
  writeGlobalSettings(undefined);
  setupStackDB([]);
  sql(`DELETE FROM providers WHERE app_type = 'claude'`); // shared DB — drop other tests' rows
  setupStackDB([
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
    [
      "m-user",
      "Stack",
      { ANTHROPIC_BASE_URL: "https://example.com", ANTHROPIC_AUTH_TOKEN: "sk-user" },
      {},
    ],
  ]);
  mkdirSync(join(INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true });
  assert.equal(queryProviderMatches("Stack", "claude")[0].id, "m-user", "DB-first by name");
  assert.equal(
    queryProviderMatches("Stack 2", "claude")[0]?.is_virtual,
    true,
    "virtual entry answers under the dodged name",
  );
  rmSync(join(INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true, force: true });
  sql(`DELETE FROM providers WHERE id = 'm-user'`);
});

test("aggregation: virtual id is alive — history survives snapshotAliveByCli/isDeadEntry", () => {
  cleanVirtualStackInstance();
  removeLiveState();
  writeGlobalSettings(undefined);
  setupStackDB([]);
  sql(`DELETE FROM providers WHERE app_type = 'claude'`); // shared DB — drop other tests' rows
  setupStackDB([
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
  ]);
  // dormant entry (stack off + instance dir) is enough to be alive
  mkdirSync(join(INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true });
  const aliveByCli = snapshotAliveByCli();
  const snap = aliveByCli.get("claude");
  assert.ok(snap, "snapshot built");
  assert.ok(snap.idSet.has(VIRTUAL_STACK_PROVIDER_ID), "virtual id in the alive set");
  assert.equal(snap.nameById.get(VIRTUAL_STACK_PROVIDER_ID), "Stack");
  const entry = {
    cli: "claude",
    providerId: VIRTUAL_STACK_PROVIDER_ID,
    provider: "Stack",
    count: 11,
    lastUsed: Date.now(),
  };
  assert.equal(isDeadEntry(entry, aliveByCli), false, "migrated history entry stays alive");
  // no instance dir + stack off → not in the set → dead (honest: nothing to launch)
  rmSync(join(INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true, force: true });
  const alive2 = snapshotAliveByCli();
  assert.equal(isDeadEntry(entry, alive2), true, "without the dormant trace the entry reads dead");
  cleanVirtualStackInstance();
});

test("split: virtual provider option routes provider-target edits to rejected, common still flows", () => {
  const commonObj = { hooks: { Stop: "common-stop" } };
  const providerSettings = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721" } };
  const changes = [
    { path: "env.ANTHROPIC_AUTH_TOKEN", op: "replace", to: "user-rotated" }, // provider-target
    { path: "hooks.Stop", op: "replace", to: "edited-stop" }, // common-target
  ];
  // without the flag: provider-target edits land in the provider patch (real rows)
  const plain = splitChangesByTarget(
    changes,
    VIRTUAL_STACK_PROVIDER_ID,
    commonObj,
    providerSettings,
  );
  assert.equal(plain.providerPatch.env?.ANTHROPIC_AUTH_TOKEN, "user-rotated");
  assert.equal(plain.rejected.length, 0);
  // with the flag: provider-target → rejected, common-target still flows
  const virt = splitChangesByTarget(
    changes,
    VIRTUAL_STACK_PROVIDER_ID,
    commonObj,
    providerSettings,
    { virtualProvider: true },
  );
  assert.deepEqual(virt.providerPatch, {}, "no provider patch for a row that cannot be written");
  assert.equal(virt.commonPatch.hooks.Stop, "edited-stop");
  assert.equal(virt.rejected.length, 1);
  assert.equal(virt.rejected[0].path, "env.ANTHROPIC_AUTH_TOKEN");
});

test("cleanupLegacyStackRows: deletes signature rows, migrates history/pins/colors, idempotent", () => {
  removeLiveState();
  writeGlobalSettings(undefined);
  setupStackDB([]);
  sql(`DELETE FROM providers WHERE app_type = 'claude'`);
  const LEGACY_AGG_ID = "11111111-2222-3333-4444-555555555555";
  const LEGACY_SC = JSON.stringify({
    env: { ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED", ANTHROPIC_BASE_URL: "http://127.0.0.1:15721" },
  });
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta)
    VALUES ('${LEGACY_AGG_ID}', 'claude', 'Stack', '${LEGACY_SC.replace(/'/g, "''")}', '{"stackManaged":true}')`);
  // a user's own gateway: loopback + REAL token — never matches the signature
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta)
    VALUES ('m-gw2', 'claude', 'My LiteLLM', '${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4000", ANTHROPIC_AUTH_TOKEN: "sk-gw" } }).replace(/'/g, "''")}', '{}')`);
  // history pointing at the legacy id, with a pin slot on it
  const HISTORY_FILE = join(CC, "launch_history.json");
  writeFileSync(
    HISTORY_FILE,
    JSON.stringify({
      version: 2,
      entries: [
        {
          cli: "claude",
          providerId: LEGACY_AGG_ID,
          provider: "Stack",
          hotkey: null,
          extraArgs: [],
          count: 11,
          lastUsed: 100,
        },
        {
          cli: "claude",
          providerId: "m-gw2",
          provider: "My LiteLLM",
          hotkey: null,
          extraArgs: [],
          count: 3,
          lastUsed: 50,
        },
      ],
      order: [`claude|${LEGACY_AGG_ID}`, null, null, null, null],
    }),
  );
  // colors keyed on the legacy id
  const PREFS_FILE = join(CC, "statusline-preferences.json");
  writeFileSync(
    PREFS_FILE,
    JSON.stringify({ version: 1, colors: { claude: { [LEGACY_AGG_ID]: "32" } } }),
  );

  const result = cleanupLegacyStackRows();
  assert.ok(result);
  assert.deepEqual(
    result.removed.map((r) => r.id),
    [LEGACY_AGG_ID],
  );
  assert.equal(result.skippedCurrent.length, 0);
  // row deleted, gateway untouched
  assert.equal(
    sql(`SELECT COUNT(*) AS n FROM providers WHERE id = '${LEGACY_AGG_ID}'`).trim(),
    "0",
  );
  assert.equal(sql(`SELECT COUNT(*) AS n FROM providers WHERE id = 'm-gw2'`).trim(), "1");
  // history migrated to the virtual id, pin slot followed
  const hist = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
  assert.equal(hist.entries[0].providerId, VIRTUAL_STACK_PROVIDER_ID);
  assert.equal(hist.entries[0].count, 11);
  assert.equal(hist.entries[1].providerId, "m-gw2", "unrelated entry untouched");
  assert.deepEqual(hist.order, [`claude|${VIRTUAL_STACK_PROVIDER_ID}`, null, null, null, null]);
  // colors migrated
  const prefs = JSON.parse(readFileSync(PREFS_FILE, "utf8"));
  assert.equal(prefs.colors.claude[VIRTUAL_STACK_PROVIDER_ID], "32");
  assert.equal(prefs.colors.claude[LEGACY_AGG_ID], undefined);
  // idempotent: no signature rows left → null
  assert.equal(cleanupLegacyStackRows(), null);
  sql(`DELETE FROM providers WHERE id = 'm-gw2'`);
  rmSync(HISTORY_FILE, { force: true });
  rmSync(PREFS_FILE, { force: true });
});

test("cleanupLegacyStackRows: is_current rows are skipped, duplicate history merges keep the stronger", () => {
  removeLiveState();
  writeGlobalSettings(undefined);
  setupStackDB([]);
  sql(`DELETE FROM providers WHERE app_type = 'claude'`);
  const CUR_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const OLD_ID = "99999999-8888-7777-6666-555555555555";
  const OLD2_ID = "77777777-6666-5555-4444-333333333333";
  const sig = (base) =>
    JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED", ANTHROPIC_BASE_URL: base } });
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta, is_current)
    VALUES ('${CUR_ID}', 'claude', 'Stack', '${sig("http://127.0.0.1:15721").replace(/'/g, "''")}', '{}', 1)`);
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta)
    VALUES ('${OLD_ID}', 'claude', 'Stack 2', '${sig("http://127.0.0.1:15720").replace(/'/g, "''")}', '{}')`);
  sql(`INSERT OR REPLACE INTO providers (id, app_type, name, settings_config, meta)
    VALUES ('${OLD2_ID}', 'claude', 'Stack 3', '${sig("http://127.0.0.1:15719").replace(/'/g, "''")}', '{}')`);
  // two legacy rows sharing a hotkey — both entries rewrite onto the virtual
  // id and must merge, keeping the stronger (count 7)
  const HISTORY_FILE = join(CC, "launch_history.json");
  writeFileSync(
    HISTORY_FILE,
    JSON.stringify({
      version: 2,
      entries: [
        {
          cli: "claude",
          providerId: CUR_ID,
          provider: "Stack",
          hotkey: null,
          extraArgs: [],
          count: 20,
          lastUsed: 200,
        },
        {
          cli: "claude",
          providerId: OLD_ID,
          provider: "Stack 2",
          hotkey: null,
          extraArgs: [],
          count: 5,
          lastUsed: 300,
        },
        {
          cli: "claude",
          providerId: OLD2_ID,
          provider: "Stack 3",
          hotkey: null,
          extraArgs: [],
          count: 7,
          lastUsed: 100,
        },
      ],
      order: [null, null, null, null, null],
    }),
  );
  const result = cleanupLegacyStackRows();
  assert.ok(result);
  assert.equal(result.removed.length, 2, "both non-current rows go");
  assert.deepEqual(result.skippedCurrent, ["Stack"]);
  assert.equal(
    sql(`SELECT COUNT(*) AS n FROM providers WHERE id = '${CUR_ID}'`).trim(),
    "1",
    "current row survives",
  );
  const hist = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
  assert.equal(hist.entries.length, 2, "rewritten duplicates merged");
  assert.equal(
    hist.entries[0].providerId,
    CUR_ID,
    "the skipped row's entry is NOT migrated (row still lives)",
  );
  assert.equal(hist.entries[0].count, 20);
  assert.equal(hist.entries[1].providerId, VIRTUAL_STACK_PROVIDER_ID);
  assert.equal(hist.entries[1].count, 7, "stronger count wins the merge");
  // cleanup the skipped row for later tests
  sql(`DELETE FROM providers WHERE id IN ('${CUR_ID}', '${OLD_ID}', '${OLD2_ID}')`);
  rmSync(HISTORY_FILE, { force: true });
});

test("aggregation: virtual entry re-derives the live contract on every query (no mirror step)", () => {
  cleanVirtualStackInstance();
  removeLiveState();
  writeGlobalSettings(undefined);
  // desktop re-points the port, swaps alias tiers, clears the picker — stack
  // live. The old launch-time mirror (syncStackManagedRow) wrote this into a
  // DB row; the virtual entry simply recomputes it, so every query sees the
  // fresh contract and nothing ever lands in the DB.
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "ccs-claude-deepseek--new",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "ccs-claude-deepseek--old-flash",
      },
      modelPicker: { replaceBuiltInOptions: true, options: [{ model: "old" }] },
    }),
  );
  writeLiveState({ enabled: true, members: ["m-ds"], keys: { deepseek: "m-ds" } }, "m-ds");
  let v = queryProviderById(VIRTUAL_STACK_PROVIDER_ID, "claude");
  let sc = JSON.parse(v.settings_config);
  assert.equal(sc.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15721", "fresh base URL");
  assert.equal(sc.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "ccs-claude-deepseek--new", "fresh alias");
  assert.deepEqual(sc.modelPicker.options, [{ model: "old" }], "picker snaps in");
  // desktop drops the haiku tier, re-points the port and clears the picker
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:15720",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "ccs-claude-deepseek--new",
      },
    }),
  );
  v = queryProviderById(VIRTUAL_STACK_PROVIDER_ID, "claude");
  sc = JSON.parse(v.settings_config);
  assert.equal(sc.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15720", "re-pointed");
  assert.equal(sc.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined, "dropped tier is gone");
  assert.equal(sc.modelPicker, undefined, "cleared picker drops");
  // nothing was ever written to the DB
  assert.equal(
    sql(`SELECT COUNT(*) AS n FROM providers WHERE settings_config LIKE '%PROXY_MANAGED%'`).trim(),
    "0",
    "virtual entry never lands in the DB",
  );
  removeLiveState();
  writeGlobalSettings(undefined);
  cleanVirtualStackInstance();
});

test("aggregation TUI label: member rows missing from the DB surface in the label", () => {
  cleanVirtualStackInstance();
  removeLiveState();
  writeGlobalSettings(undefined);
  // loopback global env so the virtual entry derives with the live contract
  writeFileSync(
    GLOBAL_SETTINGS,
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721" } }),
  );
  setupStackDB([
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
  ]);
  // "m-gone" is in the stack but has no provider row (an id no other test
  // inserts — the DB is shared across the file)
  writeLiveState(
    { enabled: true, members: ["m-ds", "m-gone"], keys: { deepseek: "m-ds", zhipu: "m-gone" } },
    "m-ds",
  );
  const group = buildAggregationGroup("claude");
  assert.ok(group);
  assert.ok(group.ids.has(VIRTUAL_STACK_PROVIDER_ID), "virtual entry joins the group");
  assert.ok(group.labels.get(VIRTUAL_STACK_PROVIDER_ID).includes("DeepSeek"));
  assert.ok(group.labels.get(VIRTUAL_STACK_PROVIDER_ID).includes("1 member(s) missing"));
  // dormant path: stack off, instance dir present → group survives as (inactive)
  removeLiveState();
  mkdirSync(join(INSTANCES, VIRTUAL_STACK_PROVIDER_ID), { recursive: true });
  const dormant = buildAggregationGroup("claude");
  assert.ok(dormant);
  assert.ok(dormant.labels.get(VIRTUAL_STACK_PROVIDER_ID).includes("inactive"));
  writeGlobalSettings(undefined);
  cleanVirtualStackInstance();
  removeLiveState();
  sql(`DELETE FROM providers WHERE app_type = 'claude'`);
});

test("aggregation: wrapper source — stack tail inlines map, decode and makeTag; no stack keeps legacy bytes", () => {
  const usageConfig = buildUsageQueryConfig(
    resolveUsageIdentity(ZHIPU_SETTINGS, ZHIPU_META),
    instanceFile(),
    instanceFile("statusline-wrapper.mjs"),
  );
  const legacy = buildStatusLineWrapperScript("P", "/g/settings.json", null, "auto", usageConfig);
  assert.equal(legacy.includes("makeTag"), false);
  assert.equal(legacy.includes("ccs-claude-"), false);
  const stackCfg = {
    defaultKey: "zhipu",
    names: { zhipu: "Z.AI GLM" },
    map: { zhipu: usageConfig },
    selfPath: "/w.mjs",
  };
  const src = buildStatusLineWrapperScript(
    "Stack",
    "/g/settings.json",
    null,
    "auto",
    null,
    stackCfg,
  );
  assert.ok(src.includes("makeTag"));
  assert.ok(src.includes("ccs-claude-"));
  assert.ok(src.includes("Z.AI GLM"));
});

test("wrapper source: usage cache temp files are unique per writer", () => {
  const usageConfig = buildUsageQueryConfig(
    resolveUsageIdentity(ZHIPU_SETTINGS, ZHIPU_META),
    instanceFile(),
    instanceFile("statusline-wrapper.mjs"),
  );
  const legacy = buildStatusLineWrapperScript("P", "/g/settings.json", null, "auto", usageConfig);
  assert.ok(legacy.includes('USAGE.cachePath + ".tmp." + process.pid'));
  const stackCfg = {
    defaultKey: "zhipu",
    names: { zhipu: "Z.AI GLM" },
    map: { zhipu: usageConfig },
    selfPath: "/w.mjs",
  };
  const stacked = buildStatusLineWrapperScript(
    "Stack",
    "/g/settings.json",
    null,
    "auto",
    null,
    stackCfg,
  );
  assert.ok(stacked.includes('cfg.cachePath + ".tmp." + process.pid'));
});

const DEEPSEEK_BALANCE_BODY = {
  is_available: true,
  balance_infos: [{ total_balance: "12.34", currency: "USD" }],
};

async function withStackWrapper(t, { modelId, displayName, proxyRoute, liveMembers, onRequest }) {
  cleanStackInstance();
  const { server, port } = await startFixtureServer((req, res) => {
    onRequest?.(req);
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/api/monitor")) res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
    else if (req.url.includes("/user/balance")) res.end(JSON.stringify(DEEPSEEK_BALANCE_BODY));
    else res.end("{}");
  });
  t.after(() => closeServer(server));
  setupStackDB([
    [
      "m-zai",
      "Z.AI GLM",
      {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        ANTHROPIC_AUTH_TOKEN: "zai-tok",
      },
      ZHIPU_META,
    ],
    [
      "m-ds",
      "DeepSeek",
      { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`, ANTHROPIC_AUTH_TOKEN: "ds-tok" },
      DEEPSEEK_META,
    ],
  ]);
  writeLiveState(
    {
      enabled: true,
      members: liveMembers || ["m-zai", "m-ds"],
      keys: { zhipu: "m-zai", deepseek: "m-ds" },
    },
    proxyRoute,
  );
  const stack = readStackState("claude");
  const stackConfig = buildStackUsageConfig(
    stack,
    join(INSTANCES, STACK_PROVIDER_ID),
    stackInstanceFile("statusline-wrapper.mjs"),
  );
  const relayDir = join(testHome, "relay-bin");
  mkdirSync(relayDir, { recursive: true });
  const relayScript = writeRelayScript(relayDir, "[Opus] │ Context █░░░░░ 12% │ $0.12");
  writeGlobalSettings({ type: "command", command: `${process.execPath} ${relayScript}` });
  const wrapperPath = stackInstanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, STACK_PROVIDER_ID), { recursive: true });
  writeFileSync(
    wrapperPath,
    buildStatusLineWrapperScript("Stack", GLOBAL_SETTINGS, null, "auto", null, stackConfig),
  );
  const input = JSON.stringify({
    model: { id: modelId, display_name: displayName ?? modelId },
    workspace: { current_dir: "/tmp" },
  });
  return { wrapperPath, input, port };
}

test("aggregation e2e: deepseek ccs id → balance cell + tag follows member name; cache per key", async (t) => {
  const { wrapperPath, input } = await withStackWrapper(t, {
    modelId: "ccs-claude-deepseek--deepseek-flash[1m]",
    proxyRoute: "m-zai",
  });
  const r = await runWrapper(wrapperPath, input);
  assert.equal(r.status, 0, r.stderr);
  const first = stripAnsiPublic(r.stdout.split("\n")[0]);
  assert.ok(first.includes("[DeepSeek]"), first); // tag follows the billable member
  assert.ok(first.includes("[$12.34]"), first); // deepseek balance cell after context
  assert.ok(first.indexOf("Context") < first.indexOf("[$12.34]"), first);
  const cache = JSON.parse(readFileSync(stackInstanceFile("usage-stack-deepseek.json"), "utf8"));
  assert.deepEqual(cache.data, { kind: "deepseek", balance: "12.34", currency: "USD", sym: "$" });
});

test("aggregation e2e: zhipu ccs id → quota bars + tag follows; [1m] lowercase id decodes", async (t) => {
  const { wrapperPath, input } = await withStackWrapper(t, {
    modelId: "ccs-claude-zhipu--glm-5.3-flash[1m]",
    proxyRoute: "m-zai",
  });
  const r = await runWrapper(wrapperPath, input);
  assert.equal(r.status, 0, r.stderr);
  const first = stripAnsiPublic(r.stdout.split("\n")[0]);
  assert.ok(first.includes("[Z.AI GLM]"), first);
  assert.ok(first.includes("5h ██░░░░ 40%"), first);
  assert.ok(first.includes("W ███░░░ 52%"), first);
  assert.ok(
    JSON.parse(readFileSync(stackInstanceFile("usage-stack-zhipu.json"), "utf8")).data.fiveH === 40,
  );
});

test("aggregation e2e: unregistered ccs key falls to the side-by-side form (all members, cache-only)", async (t) => {
  // Pre-seed both per-key caches so the side-by-side render has last-known
  // data without any sync fetch.
  const { wrapperPath, input } = await withStackWrapper(t, {
    modelId: "ccs-claude-unknown--whatever",
    proxyRoute: null, // no default → and the key is unknown anyway
  });
  mkdirSync(join(INSTANCES, STACK_PROVIDER_ID), { recursive: true });
  const now = Date.now();
  writeFileSync(
    stackInstanceFile("usage-stack-zhipu.json"),
    JSON.stringify({
      v: 1,
      ts: now,
      refreshTs: now,
      errTs: 0,
      data: { kind: "zhipu", fiveH: 40, weekly: 52 },
    }),
  );
  writeFileSync(
    stackInstanceFile("usage-stack-deepseek.json"),
    JSON.stringify({
      v: 1,
      ts: now,
      refreshTs: now,
      errTs: 0,
      data: { kind: "deepseek", balance: "12.34", currency: "USD", sym: "$" },
    }),
  );
  const r = await runWrapper(wrapperPath, input);
  assert.equal(r.status, 0, r.stderr);
  const first = stripAnsiPublic(r.stdout.split("\n")[0]);
  assert.ok(first.includes("[Stack]"), first); // tag stays on the launch provider
  assert.ok(first.includes("5h"), first);
  assert.ok(first.includes("[$12.34]"), first); // both members side by side
  // each cell carries its member key — the stable ccs id segment
  assert.ok(first.includes("zhipu 5h"), first);
  assert.ok(first.includes("deepseek [$12.34]"), first);
});

test("aggregation e2e: prefix-less model id routes to the default member", async (t) => {
  const { wrapperPath, input } = await withStackWrapper(t, {
    modelId: "glm-5.3-flash", // direct-style id, no ccs prefix
    proxyRoute: "m-zai",
  });
  const r = await runWrapper(wrapperPath, input);
  assert.equal(r.status, 0, r.stderr);
  const first = stripAnsiPublic(r.stdout.split("\n")[0]);
  assert.ok(first.includes("[Z.AI GLM]"), first);
  assert.ok(first.includes("5h ██░░░░ 40%"), first);
  // attributed form renders bare — no member-key prefix when the model
  // routes to exactly one member
  assert.ok(!first.includes("zhipu "), first);
});

test("aggregation side-by-side: failed members stay in backoff (no spawn storm)", async (t) => {
  const urls = [];
  const { wrapperPath, input } = await withStackWrapper(t, {
    modelId: "ccs-claude-unknown--whatever",
    proxyRoute: null,
    onRequest: (req) => urls.push(req.url),
  });
  const now = Date.now();
  // Both members failed within the backoff window. Their ts stays 0 forever,
  // which used to keep anyMissing true and fork a refresh on every render.
  for (const key of ["zhipu", "deepseek"]) {
    writeFileSync(
      stackInstanceFile(`usage-stack-${key}.json`),
      JSON.stringify({
        v: 1,
        ts: 0,
        refreshTs: 0,
        errTs: now,
        data: null,
      }),
    );
  }
  const r = await runWrapper(wrapperPath, input);
  assert.equal(r.status, 0, r.stderr);
  await new Promise((resolve) => setTimeout(resolve, 300)); // let a stray spawn fire
  assert.equal(urls.length, 0, "no refresh while both members are backed off");
});

test("aggregation refresh: REFRESH_KEYS narrows the refresh to listed members", async (t) => {
  const urls = [];
  const { wrapperPath, input } = await withStackWrapper(t, {
    modelId: "ccs-claude-unknown--whatever",
    proxyRoute: null,
    onRequest: (req) => urls.push(req.url),
  });
  const staleTs = Date.now() - 10 * 60_000; // older than the 5-minute TTL
  writeFileSync(
    stackInstanceFile("usage-stack-zhipu.json"),
    JSON.stringify({
      v: 1,
      ts: staleTs,
      refreshTs: 0,
      errTs: 0,
      data: { kind: "zhipu", fiveH: 40, weekly: 52 },
    }),
  );
  writeFileSync(
    stackInstanceFile("usage-stack-deepseek.json"),
    JSON.stringify({
      v: 1,
      ts: staleTs,
      refreshTs: 0,
      errTs: 0,
      data: { kind: "deepseek", balance: "12.34", currency: "USD", sym: "$" },
    }),
  );
  const r = await runWrapper(wrapperPath, input, {
    CC_LAUNCH_USAGE_REFRESH: "1",
    CC_LAUNCH_USAGE_REFRESH_KEYS: "zhipu",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(urls.length, 1, "only the listed member is refreshed");
  assert.ok(urls[0].includes("/api/monitor"), urls[0]);
  assert.ok(
    JSON.parse(readFileSync(stackInstanceFile("usage-stack-zhipu.json"), "utf8")).ts > staleTs,
  );
  assert.equal(
    JSON.parse(readFileSync(stackInstanceFile("usage-stack-deepseek.json"), "utf8")).ts,
    staleTs,
    "unlisted member keeps its old timestamp",
  );
});

function stripAnsiPublic(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
