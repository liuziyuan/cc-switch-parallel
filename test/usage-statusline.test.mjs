import process from "node:process";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createServer } from "node:http";

// Fixture home MUST be set before the dynamic import: HOME-derived constants
// (CC_SWITCH_DIR, INSTANCES_DIR) are evaluated at module load.
const testHome = mkdtempSync(join(tmpdir(), "cc-launch-usage-"));
process.env.CC_LAUNCH_SKIP_MAIN = "1";
process.env.CC_SWITCH_TEST_HOME = testHome;

const { __test } = await import("../bin/cc-launch.mjs");
const {
  buildClaudeEffectiveSettings,
  buildStatusLineWrapperScript,
  buildUsageWrapperLines,
  extractClaudeUsageSource,
  resolveUsageIdentity,
  usageEndpointFor,
  buildUsageQueryConfig,
  isLoopbackBaseUrl,
  isAggregationProviderSettings,
  readStackState,
  readGlobalModelPicker,
  buildStackUsageConfig,
  USAGE_CACHE_FILENAME,
} = __test;

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
    enabled: true, language: "javascript", code: "", timeout: 10,
    templateType: "token_plan", autoQueryInterval: 5, codingPlanProvider: "zhipu",
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
    enabled: true, language: "javascript", code: "", timeout: 10,
    templateType: "balance", autoQueryInterval: 5, codingPlanProvider: "deepseek",
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
  writeFileSync(p, `process.stdout.write(${JSON.stringify([firstLine, ...extraLines].join("\n") + "\n")});`);
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
    { env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic", ANTHROPIC_AUTH_TOKEN: "t" } },
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
  for (const url of ["https://api.kimi.com/coding", "https://api.anthropic.com", "https://agent-gateway.example.com/x"]) {
    assert.equal(resolveUsageIdentity({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: "t" } }, {}), null);
  }
});

test("identity: usage_script.enabled false opts out; unknown explicit value falls to host", () => {
  assert.equal(resolveUsageIdentity(ZHIPU_SETTINGS, { usage_script: { ...ZHIPU_META.usage_script, enabled: false } }), null);
  // Unknown marker (e.g. a future desktop value) must not guess: plain
  // unknown host + unknown marker → null.
  assert.equal(
    resolveUsageIdentity({ env: { ANTHROPIC_BASE_URL: "https://x.example.com", ANTHROPIC_AUTH_TOKEN: "t" } },
      { usage_script: { codingPlanProvider: "zhipu_team" } }),
    null,
  );
});

test("identity: custom usage script code opts out", () => {
  const meta = { usage_script: { ...ZHIPU_META.usage_script, code: "fetch('https://x')" } };
  assert.equal(resolveUsageIdentity(ZHIPU_SETTINGS, meta), null);
});

test("identity: interval clamps into [1,60]; default 5", () => {
  assert.equal(resolveUsageIdentity(ZHIPU_SETTINGS, { usage_script: { autoQueryInterval: 0 } }).intervalMin, 5);
  assert.equal(resolveUsageIdentity(ZHIPU_SETTINGS, { usage_script: { autoQueryInterval: 999 } }).intervalMin, 60);
  assert.equal(resolveUsageIdentity(ZHIPU_SETTINGS, { usage_script: { autoQueryInterval: 2 } }).intervalMin, 2);
});

test("identity: token falls back to ANTHROPIC_API_KEY; both missing → null", () => {
  const cfg = { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_API_KEY: "k" } };
  assert.equal(resolveUsageIdentity(cfg, {}).token, "k");
  const noToken = { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" } };
  assert.equal(resolveUsageIdentity(noToken, {}), null);
});

// ─── endpoint derivation ──────────────────────────────────────────────

test("endpoint: origin-derived per kind; garbage baseUrl → null", () => {
  assert.equal(usageEndpointFor("zhipu", "https://api.z.ai/api/anthropic"), "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(usageEndpointFor("deepseek", "https://api.deepseek.com/anthropic"), "https://api.deepseek.com/user/balance");
  assert.equal(usageEndpointFor("zhipu", "not a url"), null);
  assert.equal(usageEndpointFor("kimi", "https://api.kimi.com/coding"), null);
});

// ─── wrapper source: byte-stability and inline shape ──────────────────

test("wrapper: usageConfig null is byte-identical to omitting the argument", () => {
  const a = buildStatusLineWrapperScript("P", "/g/settings.json", null, "auto");
  const b = buildStatusLineWrapperScript("P", "/g/settings.json", null, "auto", null);
  assert.equal(a, b);
  assert.equal(a.includes("USAGE"), false);
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

  const effective = buildClaudeEffectiveSettings(ZHIPU_SETTINGS, ZHIPU_META, "{}", "P", PROVIDER_ID);
  assert.ok(effective.statusLine.command.includes("statusline-wrapper.mjs"));
  // the statusLine entry itself carries no usage data (the env token below is
  // the provider's own settings_config content, untouched)
  assert.equal(JSON.stringify(effective.statusLine).includes("zai-token"), false);
});

test("C3: settings.json identical with and without usage_script meta", () => {
  const withUsage = buildClaudeEffectiveSettings(ZHIPU_SETTINGS, ZHIPU_META, "{}", "P", PROVIDER_ID);
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
  const baseUrl = kind === "deepseek" ? `http://127.0.0.1:${port}/anthropic` : `http://127.0.0.1:${port}/api/anthropic`;
  const identity = resolveUsageIdentity(
    { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: "tok-123" } },
    meta,
  );
  assert.ok(identity, "fixture identity must resolve");
  const usageConfig = buildUsageQueryConfig(identity, instanceFile(), instanceFile("statusline-wrapper.mjs"));
  const relayDir = join(testHome, "relay-bin");
  mkdirSync(relayDir, { recursive: true });
  const relayScript = relayLine ? writeRelayScript(relayDir, relayLine.head, relayLine.tail) : null;
  writeGlobalSettings(relayScript ? { type: "command", command: `${process.execPath} ${relayScript}` } : undefined);
  const wrapperPath = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(wrapperPath, buildStatusLineWrapperScript("GLM", GLOBAL_SETTINGS, null, "auto", usageConfig));
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
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40.4, total: 40000000, nextResetTime: 1770000000000 },
      { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 52, total: 120000000, nextResetTime: 1770500000000 },
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
  assert.ok(stripAnsi(r3.stdout).includes("5h ██░░░░ 40%"), "stale value still renders: " + JSON.stringify(r3.stdout));
  const staleFirst = stripAnsi(r3.stdout.split("\n")[0]);
  assert.ok(
    staleFirst.includes("Context █░░░░░ 12%") && staleFirst.indexOf("5h") > staleFirst.indexOf("Context"),
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

  // no relay at all: usage follows the bare tag
  cleanInstance();
  hits = 0;
  const { server, port } = await startFixtureServer((req, res) => {
    hits++;
    res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
  });
  t.after(() => closeServer(server));
  const identity = resolveUsageIdentity(
    { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`, ANTHROPIC_AUTH_TOKEN: "tok" } },
    ZHIPU_META,
  );
  const usageConfig = buildUsageQueryConfig(identity, instanceFile(), instanceFile("statusline-wrapper.mjs"));
  const wp = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(wp, buildStatusLineWrapperScript("GLM", GLOBAL_SETTINGS, null, "auto", usageConfig));
  writeGlobalSettings(undefined);
  const r2 = await runWrapper(wp, STATUSLINE_INPUT);
  assert.equal(r2.status, 0);
  const first2 = stripAnsi(r2.stdout.split("\n")[0]);
  assert.ok(first2.startsWith("[GLM] 5h ██░░░░ 40%"), first2);
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
      res.end(JSON.stringify({ balance_infos: [{ currency: "USD", total_balance: "12.34" }], is_available: true }));
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
    res.end(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "88.00" }], is_available: true }));
  });
  t.after(() => closeServer(server));
  const identity = resolveUsageIdentity(
    { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`, ANTHROPIC_AUTH_TOKEN: "tok" } },
    DEEPSEEK_META,
  );
  const usageConfig = buildUsageQueryConfig(identity, instanceFile(), instanceFile("statusline-wrapper.mjs"));
  const wp = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(wp, buildStatusLineWrapperScript("DS", GLOBAL_SETTINGS, null, "auto", usageConfig));
  const r2 = await runWrapper(wp, STATUSLINE_INPUT);
  assert.ok(stripAnsi(r2.stdout).includes("[¥88.00]"), r2.stdout);
});

test("e2e failures: server 500, malformed JSON, missing weekly — degrade silently", async (t) => {
  const cases = [
    (req, res) => { res.statusCode = 500; res.end("boom"); },
    // business-level rejection: HTTP 200 + {"code":401,"success":false}
    (req, res) => { res.end(JSON.stringify({ code: 401, msg: "token expired or incorrect", success: false })); },
    (req, res) => { res.end("<html>not json</html>"); },
    (req, res) => { res.end(JSON.stringify({ limits: [{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 10 }] })); },
    (req, res) => { res.end(JSON.stringify({ limits: [{ type: "TIME_LIMIT", percentage: 5 }] })); },
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
      res.end(JSON.stringify({
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 95 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 75 },
        ],
      }));
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
    res.end(JSON.stringify({
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: five },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: weekly },
      ],
    }));
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
  assert.ok(!first.includes("5h █") && !first.includes("5h 100%"), "no bar/pct when limited: " + first);
  assert.ok(first.includes("W ████░░ 60%"), first);
  assert.ok(r.stdout.includes("\x1b[91m⚠ Limit"), "Limit renders red");

  // 99.6 rounds to the clamped 100 → Limit, while the other window stays a bar
  cleanInstance();
  const { server, port } = await startFixtureServer(respond(99.6, 40));
  t.after(() => closeServer(server));
  const identity = resolveUsageIdentity(
    { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`, ANTHROPIC_AUTH_TOKEN: "tok" } },
    ZHIPU_META,
  );
  const usageConfig = buildUsageQueryConfig(identity, instanceFile(), instanceFile("statusline-wrapper.mjs"));
  const wp = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(wp, buildStatusLineWrapperScript("GLM", GLOBAL_SETTINGS, null, "auto", usageConfig));
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
        res.end(JSON.stringify({ balance_infos: [{ currency: "USD", total_balance: bal }], is_available: true }));
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
    outLines[1].includes("Context ░░░░░░░░░░ 0% │ 5h") && outLines[1].indexOf("5h") > outLines[1].indexOf("Context"),
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
  const { server, port } = await startFixtureServer((req, res) => res.end(JSON.stringify(ZHIPU_QUOTA_BODY)));
  t.after(() => closeServer(server));
  const identity = resolveUsageIdentity(
    { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`, ANTHROPIC_AUTH_TOKEN: "tok" } },
    ZHIPU_META,
  );
  const usageConfig = buildUsageQueryConfig(identity, instanceFile(), instanceFile("statusline-wrapper.mjs"));
  const wp = instanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, PROVIDER_ID), { recursive: true });
  writeFileSync(wp, buildStatusLineWrapperScript("GLM", GLOBAL_SETTINGS, null, "auto", usageConfig));
  writeGlobalSettings(undefined);
  const r2 = await runWrapper(wp, STATUSLINE_INPUT);
  assert.equal(r2.status, 0);
  const first2 = stripAnsi(r2.stdout.split("\n")[0]);
  assert.ok(first2.includes("40% · W"), first2);
});

// ─── aggregation (cc-switch 4.0 Stack) ────────────────────────────────

const STACK_PROVIDER_ID = "stack-provider-id";
const STACK_SETTINGS = {
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15721", ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED" },
};
const LIVE_STATE_PATH_T = join(CC, "live-state.json");
const PICKER_FIXTURE = {
  replaceBuiltInOptions: true,
  options: [{ model: "ccs-claude-zhipu--glm-5.3[1M]", label: "glm-5.3（Z.AI GLM）", description: "glm-5.3 · 1M" }],
};

function writeLiveState(stack, proxyRoute) {
  mkdirSync(CC, { recursive: true });
  writeFileSync(LIVE_STATE_PATH_T, JSON.stringify({
    version: 1,
    apps: { claude: { mode: "proxy", ...(proxyRoute ? { proxy_route: proxyRoute } : {}), stack } },
  }));
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

test("aggregation unit: loopback detection", () => {
  assert.equal(isLoopbackBaseUrl("http://127.0.0.1:15721"), true);
  assert.equal(isLoopbackBaseUrl("http://localhost:15721"), true);
  assert.equal(isLoopbackBaseUrl("http://[::1]:15721"), true);
  assert.equal(isLoopbackBaseUrl("https://api.z.ai/api/anthropic"), false);
  assert.equal(isLoopbackBaseUrl(""), false);
  assert.equal(isLoopbackBaseUrl("not a url"), false);
  assert.equal(isAggregationProviderSettings(STACK_SETTINGS), true);
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
  writeLiveState({ enabled: true, members: ["m1", "m2", "orphan"], keys: { zhipu: "m1", deepseek: "m2" } }, "m1");
  const st = readStackState("claude");
  assert.deepEqual(st.keys, { zhipu: "m1", deepseek: "m2" });
  assert.deepEqual(st.members, ["m1", "m2"]); // orphan (not in keys) filtered
  assert.equal(st.proxyRoute, "m1");
  removeLiveState();
});

test("aggregation unit: readGlobalModelPicker needs a non-empty options array", () => {
  writeGlobalSettings(undefined);
  assert.equal(readGlobalModelPicker(), null);
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify({ modelPicker: { replaceBuiltInOptions: true, options: [] } }));
  assert.equal(readGlobalModelPicker(), null);
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify({ modelPicker: PICKER_FIXTURE }));
  assert.deepEqual(readGlobalModelPicker(), PICKER_FIXTURE);
});

test("aggregation: modelPicker syncs into effective settings only while stack is live", () => {
  cleanStackInstance();
  removeLiveState();
  writeGlobalSettings(undefined);
  // stack off → the provider row's own snapshot survives untouched
  const snap = buildClaudeEffectiveSettings({ ...STACK_SETTINGS, modelPicker: "snapshot" }, {}, "{}", "Stack", STACK_PROVIDER_ID);
  assert.equal(snap.modelPicker, "snapshot");
  // stack on + global picker → synced (fresh contract from the desktop app)
  writeFileSync(GLOBAL_SETTINGS, JSON.stringify({ modelPicker: PICKER_FIXTURE }));
  writeLiveState({ enabled: true, members: ["m1"], keys: { zhipu: "m1" } }, "m1");
  const live = buildClaudeEffectiveSettings({ ...STACK_SETTINGS, modelPicker: "snapshot" }, {}, "{}", "Stack", STACK_PROVIDER_ID);
  assert.deepEqual(live.modelPicker, PICKER_FIXTURE);
  removeLiveState();
  cleanStackInstance();
});

// Real sqlite DB (same CLI the tool uses — sync-codex.test.mjs pattern) with
// the live member rows, so buildStackUsageConfig resolves each member with
// its OWN credentials the same way a direct provider would.
function sql(statement) {
  return execFileSync("sqlite3", [join(CC, "cc-switch.db"), ".timeout 3000", statement], { encoding: "utf8" });
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
    ["m-zai", "Z.AI GLM", { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "zai-tok" }, ZHIPU_META],
    ["m-ds", "DeepSeek", { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "ds-tok" }, DEEPSEEK_META],
    ["m-nz", "P&G Nezha", { ANTHROPIC_BASE_URL: "https://agent-gateway.example.com/x", ANTHROPIC_AUTH_TOKEN: "nz" }, {}],
  ]);
  writeLiveState(
    { enabled: true, members: ["m-ds", "m-zai", "m-nz"], keys: { deepseek: "m-ds", zhipu: "m-zai", nezha: "m-nz" } },
    "m-zai",
  );
  const stack = readStackState("claude");
  const cfg = buildStackUsageConfig(stack, join(INSTANCES, STACK_PROVIDER_ID), stackInstanceFile("statusline-wrapper.mjs"));
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

test("aggregation: wrapper source — stack tail inlines map, decode and makeTag; no stack keeps legacy bytes", () => {
  const usageConfig = buildUsageQueryConfig(resolveUsageIdentity(ZHIPU_SETTINGS, ZHIPU_META), instanceFile(), instanceFile("statusline-wrapper.mjs"));
  const legacy = buildStatusLineWrapperScript("P", "/g/settings.json", null, "auto", usageConfig);
  assert.equal(legacy.includes("makeTag"), false);
  assert.equal(legacy.includes("ccs-claude-"), false);
  const stackCfg = { defaultKey: "zhipu", names: { zhipu: "Z.AI GLM" }, map: { zhipu: usageConfig }, selfPath: "/w.mjs" };
  const src = buildStatusLineWrapperScript("Stack", "/g/settings.json", null, "auto", null, stackCfg);
  assert.ok(src.includes("makeTag"));
  assert.ok(src.includes("ccs-claude-"));
  assert.ok(src.includes("Z.AI GLM"));
});

const DEEPSEEK_BALANCE_BODY = {
  is_available: true,
  balance_infos: [{ total_balance: "12.34", currency: "USD" }],
};

async function withStackWrapper(t, { modelId, displayName, proxyRoute, liveMembers }) {
  cleanStackInstance();
  const { server, port } = await startFixtureServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/api/monitor")) res.end(JSON.stringify(ZHIPU_QUOTA_BODY));
    else if (req.url.includes("/user/balance")) res.end(JSON.stringify(DEEPSEEK_BALANCE_BODY));
    else res.end("{}");
  });
  t.after(() => closeServer(server));
  setupStackDB([
    ["m-zai", "Z.AI GLM", { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`, ANTHROPIC_AUTH_TOKEN: "zai-tok" }, ZHIPU_META],
    ["m-ds", "DeepSeek", { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic`, ANTHROPIC_AUTH_TOKEN: "ds-tok" }, DEEPSEEK_META],
  ]);
  writeLiveState(
    { enabled: true, members: liveMembers || ["m-zai", "m-ds"], keys: { zhipu: "m-zai", deepseek: "m-ds" } },
    proxyRoute,
  );
  const stack = readStackState("claude");
  const stackConfig = buildStackUsageConfig(stack, join(INSTANCES, STACK_PROVIDER_ID), stackInstanceFile("statusline-wrapper.mjs"));
  const relayDir = join(testHome, "relay-bin");
  mkdirSync(relayDir, { recursive: true });
  const relayScript = writeRelayScript(relayDir, "[Opus] │ Context █░░░░░ 12% │ $0.12");
  writeGlobalSettings({ type: "command", command: `${process.execPath} ${relayScript}` });
  const wrapperPath = stackInstanceFile("statusline-wrapper.mjs");
  mkdirSync(join(INSTANCES, STACK_PROVIDER_ID), { recursive: true });
  writeFileSync(wrapperPath, buildStatusLineWrapperScript("Stack", GLOBAL_SETTINGS, null, "auto", null, stackConfig));
  const input = JSON.stringify({ model: { id: modelId, display_name: displayName ?? modelId }, workspace: { current_dir: "/tmp" } });
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
  assert.ok(JSON.parse(readFileSync(stackInstanceFile("usage-stack-zhipu.json"), "utf8")).data.fiveH === 40);
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
  writeFileSync(stackInstanceFile("usage-stack-zhipu.json"), JSON.stringify({ v: 1, ts: now, refreshTs: now, errTs: 0, data: { kind: "zhipu", fiveH: 40, weekly: 52 } }));
  writeFileSync(stackInstanceFile("usage-stack-deepseek.json"), JSON.stringify({ v: 1, ts: now, refreshTs: now, errTs: 0, data: { kind: "deepseek", balance: "12.34", currency: "USD", sym: "$" } }));
  const r = await runWrapper(wrapperPath, input);
  assert.equal(r.status, 0, r.stderr);
  const first = stripAnsiPublic(r.stdout.split("\n")[0]);
  assert.ok(first.includes("[Stack]"), first); // tag stays on the launch provider
  assert.ok(first.includes("5h"), first);
  assert.ok(first.includes("[$12.34]"), first); // both members side by side
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
});

function stripAnsiPublic(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
