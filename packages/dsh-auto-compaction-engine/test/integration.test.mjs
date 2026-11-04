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
const TEMPLATE = path.join(SANDBOX, "template.md");
const TWO_SECTION_TEMPLATE = path.join(SANDBOX, "template-two.md");

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
  constructor(ctx, config) { this.ctx = ctx; this.config = { thresholdRatio: 0.9, headroomTokens: 0, maxTokens: 8192, ...config }; this.calls = []; this.native = []; }
  async compactNow(agent, signal) { this.calls.push({ agent, hasSignal: !!(signal && typeof signal.aborted === "boolean") }); return { shadowedSeqs: ["s1", "s2"], shadowedTokenCount: 36_500 }; }
  async compactIfNeeded(agent, trigger) { this.native.push(trigger); return { shadowedSeqs: ["n1"], shadowedTokenCount: 1_000 }; }
  async summarize() { this.native.push("summarize"); return { summary: [{ type: "text", text: "NATIVE SUMMARY" }], provider: "qwen", model: "native" }; }
}
`);

write(TEMPLATE, "## ok\n\n写一份交接文档，供下一轮继续。\n");
write(TWO_SECTION_TEMPLATE, "## 用户目标与原始要求\n\n## 当前任务状态\n\nWrite both sections.\n");
process.env.DSH_HANDOFF_SETTINGS_FILE = path.join(SANDBOX, "settings-missing.json");
process.env.DSH_HANDOFF_TEMPLATE = TEMPLATE;
process.env.DSH_HANDOFF_STATUS_DIR = path.join(SANDBOX, "status");
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
  ctx.llm.stream = async function* (options) { seen = options; yield { text: "## ok\n- done" }; };
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
  ctx.llm.stream = async function* (options) { seen = options; yield { text: "## ok\n- done" }; };
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
  ctx.llm.stream = async function* (options) { seen = options; yield { text: "## ok\n- done" }; };
  const agent = makeAgent({ reasoningEffort: "xhigh" });
  await plugin.summarize({ messages: [{ role: "user", content: "OLD" }] }, agent);
  if ("reasoningEffort" in seen) throw new Error("foreign summary target should not inherit the routed effort");
  if (seen.provider !== "other" || seen.model !== "summary-model") throw new Error("wrong summary route");
});

test("a successful handoff writes a done status", async () => {
  const ctx = makeCtx({ totalTokens: 40_000 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000, reservedCompletionTokensOverride: 4_000, idleDelayMs: 5, dryRun: false });
  const agent = makeAgent();
  ctx.handlers["agent/status"][0]({ agent, status: "idle" });
  await delay(40);
  const file = path.join(SANDBOX, "status", "session-test.json");
  const status = JSON.parse(fs.readFileSync(file, "utf8"));
  if (status.phase !== "done") throw new Error("status not done: " + JSON.stringify(status));
  if (status.shadowedNodes !== 2 || status.shadowedTokens !== 36_500) throw new Error("wrong shadow counts: " + JSON.stringify(status));
});

test("incomplete summary continues from the partial document", async () => {
  const ctx = makeCtx({ totalTokens: 0 });
  const plugin = new HandoffCompaction(ctx, {
    contextWindowOverride: 40_000,
    dryRun: true,
    maxTokens: 12_288,
    templateFile: TWO_SECTION_TEMPLATE,
  });
  const calls = [];
  ctx.llm.stream = async function* (options) {
    calls.push(options);
    if (calls.length === 1) {
      yield { text: "## 用户目标与原始要求\n- a" };
      return;
    }
    yield { text: "## 当前任务状态\n- b" };
  };
  const agent = makeAgent();
  const result = await plugin.summarize({ messages: [{ role: "user", content: "OLD" }] }, agent);
  if (calls.length !== 2) throw new Error("expected one continuation, got " + calls.length);
  const second = calls[1].messages;
  const last = second.at(-1);
  const partial = second.at(-2);
  if (last.role !== "user" || !last.content[0].text.includes("继续")) throw new Error("continuation instruction missing");
  if (partial.role !== "assistant" || !partial.content[0].text.includes("用户目标")) throw new Error("partial assistant document missing");
  const text = result.summary.map((block) => block.text).join("");
  if (!text.includes("用户目标与原始要求") || !text.includes("当前任务状态")) throw new Error("merged summary incomplete: " + text);
});

test("an incomplete continuation rewrites from scratch", async () => {
  const ctx = makeCtx({ totalTokens: 0 });
  const plugin = new HandoffCompaction(ctx, {
    contextWindowOverride: 40_000,
    dryRun: true,
    maxTokens: 12_288,
    templateFile: TWO_SECTION_TEMPLATE,
  });
  const calls = [];
  ctx.llm.stream = async function* (options) {
    calls.push(options);
    if (calls.length === 1) yield { text: "## 用户目标与原始要求\n- a" };
    else if (calls.length === 2) yield { text: "- a2" };
    else yield { text: "## 用户目标与原始要求\n- a\n\n## 当前任务状态\n- b" };
  };
  const agent = makeAgent();
  const result = await plugin.summarize({ messages: [{ role: "user", content: "OLD" }] }, agent);
  if (calls.length !== 3) throw new Error("expected a rewrite, got " + calls.length + " calls");
  const rewriteTurn = calls[2].messages.at(-1);
  if (rewriteTurn.role !== "user" || !rewriteTurn.content[0].text.includes("重新")) throw new Error("rewrite instruction missing");
  const text = result.summary.map((block) => block.text).join("");
  if (!text.includes("当前任务状态") || text.includes("- a2")) throw new Error("rewrite did not replace the partial: " + text);
});

test("a persistently incomplete summary fails closed", async () => {
  const ctx = makeCtx({ totalTokens: 0 });
  const plugin = new HandoffCompaction(ctx, {
    contextWindowOverride: 40_000,
    dryRun: true,
    maxTokens: 12_288,
    templateFile: TWO_SECTION_TEMPLATE,
  });
  let calls = 0;
  ctx.llm.stream = async function* () {
    calls += 1;
    yield { text: "## 用户目标与原始要求\n- a" };
  };
  const agent = makeAgent();
  let code = "";
  try {
    await plugin.summarize({ messages: [{ role: "user", content: "OLD" }] }, agent);
  } catch (error) {
    code = error.code;
  }
  if (code !== "INCOMPLETE_SUMMARY") throw new Error("expected INCOMPLETE_SUMMARY, got " + JSON.stringify(code));
  if (calls !== 3) throw new Error("expected three attempts, got " + calls);
});

test("a truncation marker forces a continuation and is stripped", async () => {
  const ctx = makeCtx({ totalTokens: 0 });
  const plugin = new HandoffCompaction(ctx, {
    contextWindowOverride: 40_000,
    dryRun: true,
    maxTokens: 12_288,
    templateFile: TWO_SECTION_TEMPLATE,
  });
  const calls = [];
  ctx.llm.stream = async function* (options) {
    calls.push(options);
    if (calls.length === 1) {
      yield { text: "## 用户目标与原始要求\n- a\n…（截断）" };
      return;
    }
    yield { text: "## 当前任务状态\n- b" };
  };
  const agent = makeAgent();
  const result = await plugin.summarize({ messages: [{ role: "user", content: "OLD" }] }, agent);
  if (calls.length !== 2) throw new Error("expected a continuation, got " + calls.length);
  const text = result.summary.map((block) => block.text).join("");
  if (text.includes("（截断）")) throw new Error("marker leaked into the summary: " + text);
  if (!text.includes("当前任务状态")) throw new Error("missing continuation section: " + text);
});

/* The switch tests run last: they materialise the settings sidecar the other
 * cases expect to be absent. */
const SETTINGS = process.env.DSH_HANDOFF_SETTINGS_FILE;

test("plugin off: the idle gate never starts a handoff", async () => {
  const statusFile = path.join(SANDBOX, "status", "session-test.json");
  fs.rmSync(statusFile, { force: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ enabled: false }));
  const ctx = makeCtx({ totalTokens: 40_000 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000, reservedCompletionTokensOverride: 4_000, idleDelayMs: 5, dryRun: false });
  const agent = makeAgent();
  ctx.handlers["agent/status"][0]({ agent, status: "idle" });
  await delay(40);
  if (plugin.calls.length !== 0) throw new Error("handoff ran while the plugin was switched off");
  if (fs.existsSync(statusFile)) throw new Error("a status sidecar was written while switched off");
});

test("plugin off: pressure compaction delegates to the stock engine", async () => {
  const ctx = makeCtx({ totalTokens: 40_000 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000 });
  const agent = makeAgent();
  const result = await plugin.compactIfNeeded(agent, "pressure", undefined);
  if (!plugin.native.includes("pressure")) throw new Error("native engine did not receive the trigger");
  if (!result || result.shadowedTokenCount !== 1_000) throw new Error("native result not returned");
});

test("plugin off: summarize uses the stock prompt", async () => {
  const ctx = makeCtx({ totalTokens: 0 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000, dryRun: true, maxTokens: 12_288 });
  const agent = makeAgent();
  const result = await plugin.summarize({ messages: [{ role: "user", content: "OLD" }] }, agent);
  if (!plugin.native.includes("summarize")) throw new Error("stock summarize not called");
  if (result.summary[0].text !== "NATIVE SUMMARY") throw new Error("handoff prompt still used while switched off");
});

test("plugin on: the stock automatic trigger stays inert", async () => {
  fs.rmSync(SETTINGS, { force: true });
  const ctx = makeCtx({ totalTokens: 40_000 });
  const plugin = new HandoffCompaction(ctx, { contextWindowOverride: 40_000 });
  const agent = makeAgent();
  const result = await plugin.compactIfNeeded(agent, "pressure", undefined);
  if (result !== null) throw new Error("native trigger ran while the plugin was on");
  if (plugin.native.length !== 0) throw new Error("native engine consulted while the plugin was on");
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
