/**
 * dsh-handoff-compaction
 *
 * Idle-time handoff compaction for deepseek-harness.
 *
 * At a configurable share of the model window (default 90%) this backend waits
 * for the agent to go idle, then asks the routed model — replaying the current
 * conversation as the prompt prefix so the provider's cache is reused — for a
 * handoff checkpoint, and replaces the whole compactable surface with that one
 * message. The next user turn therefore starts from system prompt + tools +
 * handoff text, and nothing else.
 *
 * It subclasses the stock basic backend so selection, tool-pair balance,
 * durable compaction markers, flushes and the idle admission reservation are
 * the proven implementation; only the trigger point, the summarization
 * template and the idle gate differ.
 */
import z from "@deepseek-ai/schemastery";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BlockAssembler, LlmError, contentHasImage } from "@deepseek-ai/dsh-llm";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import { decideTrigger, shouldAttempt } from "./plan.js";

const LOG = "[handoff]";

const SETTINGS_DIR = join(homedir(), ".dsh-handoff-compaction");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const DEFAULT_TEMPLATE_FILE = join(SETTINGS_DIR, "template.md");

/**
 * Live settings written by the companion UI package (dsh-handoff-compaction-ui).
 * Read fresh on every decision, cached by mtime so a turn never blocks on disk.
 */
let settingsCache = { mtimeMs: -1, value: undefined };
function readSettings() {
  try {
    const stat = statSync(SETTINGS_FILE);
    if (stat.mtimeMs === settingsCache.mtimeMs) return settingsCache.value;
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    settingsCache = { mtimeMs: stat.mtimeMs, value: parsed && typeof parsed === "object" ? parsed : undefined };
    return settingsCache.value;
  } catch {
    return undefined;
  }
}

function templatePathFrom(configured) {
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
  const env = process.env.DSH_HANDOFF_TEMPLATE;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return DEFAULT_TEMPLATE_FILE;
}

/** Read the handoff template, falling back to the built-in text. */
function readTemplate(filePath, autoCreate) {
  try {
    if (!existsSync(filePath)) {
      if (!autoCreate) return { text: undefined, source: "builtin (file missing)" };
      mkdirSync(join(filePath, ".."), { recursive: true });
      writeFileSync(filePath, BUILTIN_INSTRUCTION + "\n", "utf8");
      return { text: BUILTIN_INSTRUCTION, source: "builtin (written to " + filePath + ")" };
    }
    const text = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    if (text.trim().length < 20) return { text: undefined, source: "builtin (file empty)" };
    return { text, source: filePath };
  } catch (error) {
    return { text: undefined, source: `builtin (read failed: ${error instanceof Error ? error.message : String(error)})` };
  }
}


const BUILTIN_INSTRUCTION = [
  "你现在要为本会话写一份交接文档：我会用它替换掉上面的全部对话记录，然后由你在一个空白的上下文里继续同一件事。写漏的东西将永久丢失。",
  "",
  "只输出 Markdown，严格按下面小节顺序，每节用短横线要点，不许省略任何小节；没有内容写「（无）」。",
  "",
  "## 用户目标与原始要求",
  "- 用户最初想做什么、之后怎么改过口；关键原话逐字引用",
  "",
  "## 当前任务状态",
  "- 在做什么、进行到哪一步、哪些已完成、哪些没完成",
  "",
  "## 涉及的文件与代码",
  "- 精确路径：为什么重要、改了什么、还有哪里没改",
  "",
  "## 已验证的事实与命令",
  "- 跑过的命令、测试结果、报错原文、环境约束（版本、端口、路径）",
  "",
  "## 关键决策与被放弃的方案",
  "- 选了什么、为什么；试过但放弃的方案及放弃原因",
  "",
  "## 待办与下一步",
  "- 用户明确要求但尚未完成的项；紧接着要执行的第一步",
  "",
  "## 风险与注意事项",
  "- 容易踩的坑、用户的偏好与禁忌",
  "",
  "规则：",
  "- 保留精确的路径、命令、错误串、标识符、数值、函数签名；不要概括成\"修改了相关文件\"这类废话。",
  "- 如果对话里有用户粘贴的长文档或上一轮交接文档（例如包在 <compacted-summary> 标记里的那份），不要原样照抄：保留仍然生效的硬约束（路径、命令、版本、验收标准）并逐字引用其关键句，其余概括；过时的内容删掉，最终只输出一份同样结构的文档。",
  "- 如果用户的早期消息给出了一份磁盘上的工程交接文档的绝对路径，必须逐字保留该路径并注明\"需要时重新读取该文件\"；不要把它的内容当成必须在本文档里复述的东西。",
  "- 不要提到这份交接文档本身，也不要说上下文被压缩或摘要。",
  "- 只输出文档正文，不要调用任何工具。",
  "",
  "写入时还要记住下面两条，它们会被交给后续的你执行：",
  "- 更早的对话消息不会留在你的上下文里，也没有任何工具或磁盘检索能把它们找回来。不要去搜索会话文件、日志或历史记录还原旧对话；文档里没写的，就当作不知道，直接说不知道。",
  "- 用户问起\"之前说过什么\"时，以本文档为准；文档没有逐字保留的内容（例如旧回答的原文），直接说明已经被压缩掉，不要编造，也不要为了找它去翻文件。",
].join("\n");

function finishError(finish) {
  switch (finish.kind) {
    case "error":
    case "aborted":
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure);
    case "max-tokens": {
      const error = new Error("handoff summary truncated at the token cap (incomplete checkpoint)");
      error.code = "MAX_TOKENS";
      return error;
    }
    default:
      return undefined;
  }
}

export default class HandoffCompaction extends BasicCompactionEngine {
  static inject = ["llm", "tokenMeter", "sessions"];

  static Config = z.object({
    thresholdRatio: z.number(),
    headroomTokens: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number(),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number(),
    compactionRetries: z.number(),
    maxOverflowRetries: z.number(),
    contextWindowOverride: z.number(),
    reservedCompletionTokensOverride: z.number(),
    idleDelayMs: z.number(),
    minIntervalMs: z.number(),
    minTokenGrowth: z.number(),
    timeoutMs: z.number(),
    dryRun: z.boolean(),
    handoffInstruction: z.string(),
    traceFile: z.string(),
    traceConsole: z.boolean(),
    templateFile: z.string(),
    presetId: z.string(),
    autoCreateTemplate: z.boolean(),
  });

  constructor(ctx, config = {}) {
    const {
      contextWindowOverride,
      reservedCompletionTokensOverride,
      idleDelayMs,
      minIntervalMs,
      minTokenGrowth,
      timeoutMs,
      dryRun,
      handoffInstruction,
      traceFile,
      traceConsole,
      templateFile,
      presetId,
      autoCreateTemplate,
      ...base
    } = config;
    // auto:false keeps the stock between-step pressure trigger out of the way;
    // this backend decides on idle instead.
    super(ctx, { ...base, auto: false });
    this.handoff = {
      instruction: typeof handoffInstruction === "string" && handoffInstruction.trim().length > 0 ? handoffInstruction : undefined,
      contextWindowOverride: contextWindowOverride ?? 0,
      reservedOverride: reservedCompletionTokensOverride ?? -1,
      idleDelayMs: idleDelayMs ?? 1_500,
      minIntervalMs: minIntervalMs ?? 60_000,
      minTokenGrowth: minTokenGrowth ?? 2_048,
      timeoutMs: timeoutMs ?? 600_000,
      dryRun: dryRun ?? false,
      templateFile: templatePathFrom(templateFile ?? readSettings()?.templateFile),
      presetId: typeof presetId === "string" ? presetId : "",
      autoCreateTemplate: autoCreateTemplate !== false,
    };
    this.handoff.traceFile = typeof traceFile === "string" ? traceFile : "";
    this.handoff.traceConsole = traceConsole === true;
    // Materialise the template so the settings card can point at a real file.
    try { readTemplate(this.handoff.templateFile, this.handoff.autoCreateTemplate); } catch { /* never block construction */ }
    this.attempts = new WeakMap();
    this.running = new WeakSet();
    this.timers = new WeakMap();
    this.agents = new WeakMap();
    ctx.on("agent/status", ({ agent, status }) => {
      if (agent?.session) this.agents.set(agent.session, agent);
      if (status === "idle") this.scheduleCheck(agent, "agent/status idle");
    });
    // A finished turn is the gap the user described; agent/status is not the only
    // place DSH reports it, so both paths are wired.
    ctx.on("session/event", (session, event) => {
      if (event?.type !== "turn/end") return;
      const owner = this.agents.get(session);
      if (owner !== undefined) this.scheduleCheck(owner, "turn/end");
    });
    this.log(`ready (threshold ${this.describeThreshold()}, dryRun=${this.handoff.dryRun}, trace=${this.handoff.traceFile || (this.handoff.traceConsole ? "console" : "off")})`);
  }

  describeThreshold() {
    return `${Math.round((this.config.thresholdRatio ?? 0.9) * 100)}%`;
  }

  log(message, level = "info") {
    const line = `${new Date().toISOString()} ${LOG} ${message}`;
    if (this.handoff?.traceConsole === true) {
      try { console.error(line); } catch { /* trace must never break the turn */ }
    }
    const file = this.handoff?.traceFile;
    if (typeof file === "string" && file.length > 0) {
      try { appendFileSync(file, line + "\n"); } catch { /* trace must never break the turn */ }
    }
    const write = this.ctx.logger?.[level] ?? this.ctx.logger?.info;
    if (typeof write === "function") write.call(this.ctx.logger, `${LOG} ${message}`);
  }

  /** Debounce the idle signal so a turn that immediately resumes does not trigger work. */
  scheduleCheck(agent, why = "idle") {
    const previous = this.timers.get(agent);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(agent);
      void this.checkAndHandoff(agent, why);
    }, this.handoff.idleDelayMs);
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(agent, timer);
  }

  routedTarget(agent) {
    const routed = agent.session?.requestHeader?.()?.config;
    if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model };
    const options = agent.options ?? {};
    if (options.provider && options.model) return { provider: options.provider, model: options.model };
    return undefined;
  }

  async checkAndHandoff(agent, why = "idle") {
    if (this.running.has(agent)) return;
    try {
      const session = agent.session;
      if (!session) return;
      const measurement = this.ctx.tokenMeter.measure(session);
      const target = this.routedTarget(agent);
      if (target === undefined) return this.log(`${why}: no routed provider/model yet; skipping`);

      const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model);
      const headerMaxTokens = session.requestHeader?.()?.config?.maxTokens;
      const reserved = this.handoff.reservedOverride >= 0
        ? this.handoff.reservedOverride
        : (headerMaxTokens ?? info.defaultMaxTokens ?? 0);
      const contextWindow = this.handoff.contextWindowOverride > 0
        ? this.handoff.contextWindowOverride
        : info.context?.contextWindow;

      const live = readSettings();
      const scope = live?.scope === "preset" ? "preset" : "global";
      const selectedPresets = Array.isArray(live?.presets) ? live.presets : [];
      if (scope === "preset" && this.handoff.presetId !== "" && !selectedPresets.includes(this.handoff.presetId)) {
        return this.log(`${why}: skipped by scope (preset "${this.handoff.presetId}" not selected)`);
      }
      const liveRatio = typeof live?.thresholdRatio === "number" && live.thresholdRatio > 0 && live.thresholdRatio <= 1
        ? live.thresholdRatio
        : undefined;

      const decision = decideTrigger({
        totalTokens: measurement.totalTokens,
        contextWindow,
        reservedCompletionTokens: reserved,
        headroomTokens: this.config.headroomTokens ?? 0,
        thresholdRatio: liveRatio ?? this.config.thresholdRatio ?? 0.9,
      });
      if (!decision.trigger) {
        return this.log(`${why}: ${measurement.totalTokens}/${decision.thresholdTokens ?? "?"} tokens${decision.ok === false ? ` (${decision.reason})` : ""}`);
      }

      const last = this.attempts.get(agent);
      if (!shouldAttempt({
        now: Date.now(),
        last,
        tokens: measurement.totalTokens,
        thresholdTokens: decision.thresholdTokens,
        minIntervalMs: this.handoff.minIntervalMs,
        minTokenGrowth: this.handoff.minTokenGrowth,
      })) {
        return this.log(`over threshold (${measurement.totalTokens} >= ${decision.thresholdTokens}) but holding: retry gate`);
      }

      this.attempts.set(agent, { at: Date.now(), tokens: measurement.totalTokens });
      if (this.handoff.dryRun) {
        return this.log(`DRY-RUN: would hand off now (${measurement.totalTokens} >= ${decision.thresholdTokens} of an assumed ${contextWindow}-token window)`);
      }

      this.running.add(agent);
      try {
        const result = await this.compactNow(agent, AbortSignal.timeout(this.handoff.timeoutMs));
        if (result === null || result === undefined) {
          this.log("idle: no compactable range; nothing replaced", "warn");
          return;
        }
        this.log(`committed: replaced ${result.shadowedSeqs.length} node(s) (~${result.shadowedTokenCount} tokens) with the handoff checkpoint`);
      } finally {
        this.running.delete(agent);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed: ${message}`, "warn");
    }
  }

  /** Handoff template instead of the stock compaction instruction. */
  async summarize(input, agent, signal) {
    const latest = agent.session.requestHeader?.()?.config;
    const configured = this.config.summarizationProvider && this.config.summarizationModel
      ? { provider: this.config.summarizationProvider, model: this.config.summarizationModel }
      : undefined;
    const agentTarget = agent.options?.provider && agent.options?.model
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined;
    const target = configured ?? latest ?? agentTarget;
    if (target === undefined) throw new Error("no provider/model available for the handoff summary");

    const resolved = this.handoff.instruction === undefined
      ? readTemplate(this.handoff.templateFile, this.handoff.autoCreateTemplate)
      : { text: this.handoff.instruction, source: "config handoffInstruction" };
    const instruction = typeof resolved.text === "string" && resolved.text.trim().length > 0
      ? resolved.text
      : BUILTIN_INSTRUCTION;
    this.log(`template: ${resolved.source}${resolved.text === undefined ? " (fallback)" : ""}`);

    const assembler = new BlockAssembler();
    const messages = [
      ...input.messages,
      Object.freeze({ role: "user", content: [{ type: "text", text: instruction }] }),
    ];
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
      purpose: "compaction",
      ...(signal === undefined ? {} : { signal }),
    };

    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
    const error = finishError(assembler.finish);
    if (error !== undefined) throw error;

    const rawOutput = assembler.blocks();
    if (contentHasImage(rawOutput)) throw new LlmError("handoff summary cannot contain image output", "UNSUPPORTED_CONTENT");
    const summary = rawOutput.filter((block) => block.type === "text");
    if (!summary.some((block) => block.text.trim().length > 0)) throw new Error("handoff summary produced no text content");

    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens: this.config.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    };
  }
}
