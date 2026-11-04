/**
 * Integration harness: loads lib/index.js with stub DSH services so the
 * trigger / idle-gate / retry-gate / summarize wiring runs end to end without
 * a live harness. Copies lib/ into a sandbox whose node_modules provides the
 * @deepseek-ai/* bare specifiers.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const SANDBOX = path.join(HERE, ".sandbox");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function stub(name, file, body) {
  write(path.join(SANDBOX, "node_modules", ...name.split("/"), "package.json"),
    JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js", exports: { ".": "./index.js", "./package.json": "./package.json" } }));
  write(path.join(SANDBOX, "node_modules", ...name.split("/"), file), body);
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
write(path.join(SANDBOX, "package.json"), JSON.stringify({ type: "module" }));
fs.cpSync(path.join(PKG, "lib"), path.join(SANDBOX, "lib"), { recursive: true });

stub("@deepseek-ai/schemastery", "index.js", `
const field = () => ({ optional: () => field(), default: () => field(), description: () => field(), min: () => field(), max: () => field(), step: () => field() });
export default { number: field, string: field, boolean: field, object: (fields) => ({ fields, parse: (v) => v }) };
`);
stub("@deepseek-ai/dsh-llm", "index.js", `
export class LlmError extends Error { constructor(m, c, o) { super(m, o); this.code = c; } }
export function contentHasImage(blocks) { return blocks.some((b) => b.type === "image"); }
export class BlockAssembler {
  constructor() { this._blocks = []; this.finish = { kind: "stop" }; this.usage = { input: 10, output: 20 }; }
  push(chunk) { if (chunk?.text) this._blocks.push({ type: "text", text: chunk.text }); }
  blocks() { return this._blocks; }
}
`);
stub("@deepseek-ai/dsh-compaction-basic", "index.js", `
export default class BasicCompactionEngine {
  constructor(ctx, config) { this.ctx = ctx; this.config = { thresholdRatio: 0.9, headroomTokens: 0, maxTokens: 8192, ...config }; this.calls = []; }
  async compactNow(agent, signal) { this.calls.push({ agent, hasSignal: !!(signal && typeof signal.aborted === "boolean") }); return { shadowedSeqs: ["s1", "s2"], shadowedTokenCount: 36_500 }; }
}
`);

process.env.DSH_HANDOFF_SETTINGS_FILE = path.join(SANDBOX, "settings-missing.json");
const { default: HandoffCompaction } = await import(pathToFileURL(path.join(SANDBOX, "lib", "index.js")).href);

function makeCtx({ totalTokens, contextWindow = 250_000, defaultMaxTokens = 20_000 }) {
  const handlers = {};
  const logs = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(["info", m]),
      warn: (m) => logs.push(["warn", m]),
    },
    tokenMeter: { measure: () => ({ totalTokens, nodes: [] }) },
    llm: {
      resolveModelInfo: async () => ({ context: { contextWindow }, defaultMaxTokens }),
      stream: async function* () { yield { text: "## 用户目标与原始要求\n- x" }; },
    },
    on(event, fn) { (handlers[event] ??= []).push(fn); },
    handlers,
    logs,
  };
  return ctx;
}

function makeAgent({ model = "qwen3.8-flash-next", maxTokens = 20_000, reasoningEffort } = {}) {
  const config = { provider: "qwen", model, maxTokens, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
  return {
    options: { provider: "qwen", model },
    session: {
      id: "session-test",
      requestHeader: () => ({ config }),
      toolHistory: () => [],
    },
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("dry-run fires at exactly 32,400 on an assumed 40K window", async () => {
  const ctx = makeCtx({ totalTokens: 32_400 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000, reservedCompletionTokensOverride: 4_000, idleDelayMs: 5, dryRun: true });
  const agent = makeAgent();
  ctx.handlers["agent/status"][0]({ agent, status: "idle" });
  await delay(30);
  const hit = ctx.logs.find(([, m]) => m.includes("DRY-RUN"));
  if (!hit) throw new Error("no DRY-RUN log; got: " + JSON.stringify(ctx.logs));
  if (!hit[1].includes("32400")) throw new Error("threshold not 32400: " + hit[1]);
  if (plugin.calls.length !== 0) throw new Error("dry-run must not mutate");
});

test("below threshold stays quiet", async () => {
  const ctx = makeCtx({ totalTokens: 32_399 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000, reservedCompletionTokensOverride: 4_000, idleDelayMs: 5, dryRun: true });
  const agent = makeAgent();
  ctx.handlers["agent/status"][0]({ agent, status: "idle" });
  await delay(30);
  if (ctx.logs.some(([, m]) => m.includes("DRY-RUN"))) throw new Error("fired below threshold");
  if (plugin.calls.length !== 0) throw new Error("mutated below threshold");
});

test("non-idle status never arms a check", async () => {
  const ctx = makeCtx({ totalTokens: 50_000 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000, reservedCompletionTokensOverride: 4_000, idleDelayMs: 5, dryRun: false });
  const agent = makeAgent();
  ctx.handlers["agent/status"][0]({ agent, status: "running" });
  await delay(30);
  if (plugin.calls.length !== 0) throw new Error("acted while running");
});

test("real run calls compactNow once and then holds at the retry gate", async () => {
  const ctx = makeCtx({ totalTokens: 40_000 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000, reservedCompletionTokensOverride: 4_000, idleDelayMs: 5, dryRun: false, minIntervalMs: 60_000 });
  const agent = makeAgent();
  ctx.handlers["agent/status"][0]({ agent, status: "idle" });
  await delay(40);
  if (plugin.calls.length !== 1) throw new Error("expected one compactNow, got " + plugin.calls.length);
  if (!plugin.calls[0].hasSignal) throw new Error("no abort signal passed");
  ctx.handlers["agent/status"][0]({ agent, status: "idle" });
  await delay(40);
  if (plugin.calls.length !== 1) throw new Error("retry gate let a second attempt through");
  if (!ctx.logs.some(([, m]) => m.includes("holding: retry gate"))) throw new Error("no retry-gate log");
});

test("summarize replays the prefix and appends the handoff instruction", async () => {
  const ctx = makeCtx({ totalTokens: 0 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000, dryRun: true, maxTokens: 4096 });
  let seen;
  ctx.llm.stream = async function* (options) { seen = options; yield { text: "## ok" }; };
  const agent = makeAgent();
  const result = await plugin.summarize({ messages: [{ role: "system", content: "SYS" }, { role: "user", content: "OLD" }], tools: [{ name: "t" }] }, agent);
  if (seen.messages.length !== 3) throw new Error("instruction not appended: " + seen.messages.length);
  const last = seen.messages.at(-1);
  if (last.role !== "user" || !last.content[0].text.includes("交接文档")) throw new Error("wrong instruction tail");
  if (seen.provider !== "qwen" || seen.model !== "qwen3.8-flash-next") throw new Error("wrong route");
  if (seen.maxTokens !== 4096) throw new Error("maxTokens not forwarded");
  if (seen.purpose !== "compaction") throw new Error("purpose not set");
  if (!Array.isArray(result.summary) || result.provider !== "qwen") throw new Error("bad summarize result");
});

test("summarize forwards the routed reasoning effort", async () => {
  const ctx = makeCtx({ totalTokens: 0 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000, dryRun: true });
  let seen;
  ctx.llm.stream = async function* (options) { seen = options; yield { text: "## ok" }; };
  const agent = makeAgent({ reasoningEffort: "xhigh" });
  await plugin.summarize({ messages: [{ role: "user", content: "OLD" }] }, agent);
  if (seen.reasoningEffort !== "xhigh") throw new Error("reasoningEffort not forwarded: " + JSON.stringify(seen.reasoningEffort));
});

test("summarize omits a foreign summary target's reasoning effort", async () => {
  const ctx = makeCtx({ totalTokens: 0 });
  const plugin = new HandoffCompaction(ctx, {
    contextWindowOverride: 40_000,
    dryRun: true,
    summarizationProvider: "other",
    summarizationModel: "summary-model",
  });
  let seen;
  ctx.llm.stream = async function* (options) { seen = options; yield { text: "## ok" }; };
  const agent = makeAgent({ reasoningEffort: "xhigh" });
  await plugin.summarize({ messages: [{ role: "user", content: "OLD" }] }, agent);
  if ("reasoningEffort" in seen) throw new Error("foreign summary target should not inherit the routed effort");
  if (seen.provider !== "other" || seen.model !== "summary-model") throw new Error("wrong summary route");
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
