/**
 * dsh-handoff-compaction
 *
 * Idle-time handoff compaction for deepseek-harness.
 *
 * At a configurable share of the model window (default 90%) this backend waits
 * for the agent to go idle, then asks the routed model — replaying the current
 * conversation as the prompt prefix so the provider's cache is reused — for a
 * handoff checkpoint, and replaces the oldest compactable span with that one
 * message. Selection comes from the stock backend, so a recent tail is kept
 * verbatim (retainRatio 0.16 of the window by default) and the cut never splits
 * a tool-call from its result; only the head of the history becomes the
 * checkpoint.
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
import { toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { decideTrigger, shouldAttempt } from "./plan.js";
import { appendHistory, countWords } from "./history.js";
import { writeStatus } from "./status.js";
import {
  continuationInstruction,
  expectedSections,
  looksTruncated,
  mergeSummary,
  rewriteInstruction,
  stripTruncationMarkers,
  validateSummary,
} from "./summary.js";

const LOG = "[handoff]";
const MAX_SUMMARY_ATTEMPTS = 3;
const MIN_SUMMARY_TOKENS = 8_192;
// A mid-turn compaction needs room for thinking, the summary output and the
// tools envelope. 20k is the floor the settings page allows; the ceiling is
// half the model window.
const MIN_MID_TASK_TRIGGER = 20_000;
const DEFAULT_MID_TASK_TRIGGER = 20_000;
// The timeline shows the handoff document; a pathological one must not bloat
// the append-only history. 20k chars is ~7k Chinese tokens.
const MAX_STORED_SUMMARY_CHARS = 20_000;

const SETTINGS_DIR = join(homedir(), ".dsh-handoff-compaction");
// Test harnesses point this at a missing file so the live sidecar cannot leak
// into a case that expects the configured ratio.
const SETTINGS_FILE = process.env.DSH_HANDOFF_SETTINGS_FILE ?? join(SETTINGS_DIR, "settings.json");
const DEFAULT_TEMPLATE_FILE = join(SETTINGS_DIR, "template.md");
/**
 * Trace goes to the standard sidecar unless a row says otherwise. Generated
 * takeover rows carry no path of their own, so defaulting here is what keeps
 * the diagnostic channel alive; an explicit `traceFile: ""` still turns it off.
 */
const DEFAULT_TRACE_FILE = process.env.DSH_HANDOFF_TRACE_FILE ?? join(SETTINGS_DIR, "trace.log");

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
  "你现在充当这个 AI 编程助手的压缩引擎。请把上面的对话压缩成一份结构化检查点，让另一个模型能在不丢失关键上下文的前提下接手继续这项工作。",
  "",
  "严格按下面给出的 Markdown 结构输出：每个小节都要保留，顺序不要变。用简短的要点，不要写成成段的散文。空的小节写「（无）」——绝不允许删掉某个小节。",
  "",
  "## 用户主要请求与意图",
  "- [用户的原始目标以及后来的演变；措辞要紧之处逐字引用]",
  "",
  "## 关键技术概念",
  "- [当前涉及的技术、框架、模式与约定]",
  "",
  "## 文件与代码",
  "- [精确路径：为什么重要，关键改动或代码片段]",
  "",
  "## 报错与修复",
  "- [错误：是怎么解决的，以及与之相关的用户反馈]",
  "",
  "## 未完成的任务",
  "- [明确要求过但尚未完成的工作]",
  "",
  "## 当前工作",
  "- [在这个检查点上具体正在做什么]",
  "",
  "## 下一步",
  "- [紧接的单个动作，须与最近一次请求直接对齐；没有则写「（无）」]",
  "",
  "## 关键上下文",
  "- [决策及其理由、约束条件、用户偏好、尚未解决的问题、继续所需的资料]",
  "",
  "规则：",
  "- 用简洁的中文工程表述书写。精确保留文件路径、命令、报错串、标识符、数值、函数签名与语法片段。",
  "- 忠实保留用户的反馈与明确指令，尤其是纠正。",
  "- 不要提到本摘要请求，也不要说上下文被压缩过。",
  "- 只输出检查点正文：不要调用任何工具，也不要执行任何其他动作。",
  "- 如果对话里已经含有 <compacted-summary> 块，那是一份 PRIOR 检查点。不要把它逐字抄到新的摘要里：保留仍然成立的事实，删掉过时的，并把更新的信息按同样的结构合并进这一份摘要。",
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

function mergeUsage(left, right) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const merged = { ...left };
  for (const key of Object.keys(right)) {
    const value = right[key];
    if (typeof value === "number" && typeof merged[key] === "number") merged[key] += value;
    else if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}

function errorCodeOf(error) {
  return error !== null && typeof error === "object" && typeof error.code === "string" ? error.code : "";
}

/**
 * Clamp the configured remaining-token trigger to what this model can honour.
 * The floor is the space the summary call itself needs; the ceiling is half
 * the window, so a forced compaction can never run when the history is already
 * larger than the retained tail plus the trigger.
 */
function midTaskTriggerTokens(live, contextWindow) {
  const raw = Number(live?.midTaskTriggerTokens);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MID_TASK_TRIGGER;
  const ceiling = Math.max(MIN_MID_TASK_TRIGGER, Math.floor(contextWindow / 2));
  return Math.max(MIN_MID_TASK_TRIGGER, Math.min(configured, ceiling));
}

/**
 * True when a failed compaction most likely ran out of room for its own
 * request. Those are the only failures worth interrupting the user for: the
 * fix is a mid-task trigger, not a different template or provider.
 */
function isHeadroomFailure(error) {
  if (errorCodeOf(error) === "CONTEXT_WINDOW_EXCEEDED") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /smaller summary|context window|context length|too many tokens|exceeds? (the )?(model )?context/i.test(message);
}

/**
 * Numbers the dialog shows. Everything comes from the live measurement and
 * the routed model's window — the UI never hard-codes a window size.
 */
function buildFailureHint({ kind, totalTokens, contextWindow, triggerTokens }) {
  const windowTokens = Math.floor(contextWindow);
  const usedTokens = Math.max(0, Math.floor(totalTokens));
  const remainingTokens = Math.max(0, windowTokens - usedTokens);
  const trigger = Math.max(MIN_MID_TASK_TRIGGER, Math.floor(triggerTokens || DEFAULT_MID_TASK_TRIGGER));
  const neededTokens = kind === "raise-trigger" ? trigger + 8_000 : MIN_MID_TASK_TRIGGER;
  const suggestTokens = kind === "raise-trigger"
    ? Math.min(Math.ceil((neededTokens + 12_000) / 5_000) * 5_000, Math.max(MIN_MID_TASK_TRIGGER, Math.floor(windowTokens / 2)))
    : MIN_MID_TASK_TRIGGER;
  return {
    kind,
    usedTokens,
    windowTokens,
    remainingTokens,
    neededTokens,
    triggerTokens: trigger,
    suggestTokens,
    at: Date.now(),
  };
}

function isSystemHead(session, seq) {
  try {
    return session.eventAt(seq)?.type === "system/message";
  } catch {
    return false;
  }
}

/**
 * Same selection rule as the stock pressure path: keep a priced recent tail,
 * never split a tool-call/result pair, and start after the system head. The
 * range is handed to the stock transaction, so retention and commit semantics
 * stay identical to the idle path.
 */
function selectCompactableRange(session, measurement, retainTokens) {
  const priced = measurement?.nodes;
  if (!Array.isArray(priced) || priced.length === 0) return null;
  const surface = session?.surface?.nodes;
  if (!Array.isArray(surface) || surface.length !== priced.length) return null;
  for (let index = 0; index < surface.length; index += 1) {
    if (surface[index] !== priced[index]?.seq) return null;
  }
  const firstIdx = isSystemHead(session, surface[0]) ? 1 : 0;
  let accumulated = 0;
  let keepFromIdx = priced.length;
  for (let index = priced.length - 1; index >= 0; index -= 1) {
    accumulated += priced[index].tokens;
    keepFromIdx = index;
    if (accumulated >= retainTokens) break;
  }
  if (keepFromIdx <= firstIdx) return null;
  while (keepFromIdx > firstIdx) {
    if (toolPairingBalancedBefore(session, surface[keepFromIdx])) break;
    keepFromIdx -= 1;
  }
  if (keepFromIdx <= firstIdx) return null;
  return { start: surface[firstIdx], end: surface[keepFromIdx - 1] };
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
    // The stock trigger is registered so the plugin switch can hand compaction
    // back to the native engine live; compactIfNeeded() suppresses it while the
    // handoff path is enabled.
    super(ctx, { ...base, auto: true });
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
    this.handoff.traceFile = typeof traceFile === "string" ? traceFile : DEFAULT_TRACE_FILE;
    this.handoff.traceConsole = traceConsole === true;
    // Materialise the template so the settings card can point at a real file.
    try { readTemplate(this.handoff.templateFile, this.handoff.autoCreateTemplate); } catch { /* never block construction */ }
    this.attempts = new WeakMap();
    this.running = new WeakSet();
    this.timers = new WeakMap();
    this.agents = new WeakMap();
    // Latest trigger decision and summary payload per agent, consumed once the
    // stock transaction commits. WeakMaps keep a finished conversation from
    // pinning the engine's memory.
    this.decisions = new WeakMap();
    this.summaries = new WeakMap();
    // Forced mid-turn compactions keep their own retry gate: a failed attempt
    // must not be retried on every step of the same turn.
    this.midAttempts = new WeakMap();
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
    // Forced mid-turn compaction runs at the step boundary, exactly where the
    // stock pressure trigger would run: the turn keeps going afterwards, so no
    // cancel/resume is involved and the summary request still reuses the cached
    // prefix. Inert unless the user turned the switch on.
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
      try {
        await this.midTaskCompaction(agent, signal);
      } catch (error) {
        this.log(`midtask check failed: ${error instanceof Error ? error.message : String(error)}`, "warn");
      }
      return next();
    });
    this.log(`ready (threshold ${this.describeThreshold()}, dryRun=${this.handoff.dryRun}, trace=${this.handoff.traceFile || (this.handoff.traceConsole ? "console" : "off")})`);
  }

  describeThreshold() {
    return `${Math.round((this.config.thresholdRatio ?? 0.9) * 100)}%`;
  }

  /**
   * Per-summary output cap: the settings override wins, then the row's
   * maxTokens, then 20000. A hand-edited sidecar below the floor is clamped
   * instead of trusted; each retry call gets this budget independently.
   */
  summaryMaxTokens() {
    const raw = Number(readSettings()?.summaryMaxTokens);
    if (Number.isFinite(raw) && raw >= 1) return Math.max(MIN_SUMMARY_TOKENS, Math.floor(raw));
    const configured = Number(this.config.maxTokens);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 20_000;
  }

  /**
   * Settings switch. Missing settings or a missing field keeps the plugin on;
   * only an explicit `enabled: false` hands compaction back to the stock engine.
   *
   * Scope is decided here rather than at the idle gate because the takeover row
   * is mounted in every preset: a preset the user did not select must behave
   * exactly like the stock engine on every entry point, not just skip its own
   * idle check. `presetId` empty means the row carried no identity, which keeps
   * the plugin on rather than silently disabling it.
   */
  handoffEnabled() {
    const live = readSettings();
    if (live !== undefined && live.enabled === false) return false;
    return !this.excludedByScope(live);
  }

  /** True when `scope: "preset"` leaves this preset out of the takeover. */
  excludedByScope(live = readSettings()) {
    if (live?.scope !== "preset") return false;
    const id = this.handoff?.presetId;
    if (typeof id !== "string" || id === "") return false;
    const selected = Array.isArray(live.presets) ? live.presets : [];
    return !selected.includes(id);
  }

  /**
   * The base registers its between-step pressure / overflow triggers whenever
   * `auto` is on. While the handoff path is enabled they must stay inert, so
   * the plugin still only compacts from its idle gate. Disabled: delegate, and
   * DSH's native compaction behaves exactly as without the plugin.
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (this.handoffEnabled()) return null;
    return super.compactIfNeeded(agent, trigger, signal);
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
    if (this.excludedByScope()) {
      return this.log(`${why}: skipped by scope (preset "${this.handoff.presetId}" not selected)`);
    }
    if (!this.handoffEnabled()) return;
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
      this.decisions.set(agent, {
        at: Date.now(),
        thresholdTokens: decision.thresholdTokens,
        contextWindow,
        ratio: liveRatio ?? this.config.thresholdRatio ?? 0.9,
      });

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
      writeStatus(session.id, {
        phase: "running",
        step: "prepare",
        startedAt: Date.now(),
        totalTokens: measurement.totalTokens,
        thresholdTokens: decision.thresholdTokens,
        contextWindow,
        timeoutMs: this.handoff.timeoutMs,
        provider: target.provider,
        model: target.model,
        failureHint: null,
      });
      try {
        const result = await this.compactNow(agent, AbortSignal.timeout(this.handoff.timeoutMs));
        if (result === null || result === undefined) {
          writeStatus(session.id, {
            phase: "done",
            step: "done",
            completedAt: Date.now(),
            shadowedNodes: 0,
            shadowedTokens: 0,
            note: "no compactable range",
          });
          this.log("idle: no compactable range; nothing replaced", "warn");
          return;
        }
        writeStatus(session.id, {
          phase: "done",
          step: "done",
          completedAt: Date.now(),
          shadowedNodes: result.shadowedSeqs.length,
          shadowedTokens: result.shadowedTokenCount,
          missingSections: [],
          retrying: false,
        });
        this.log(`committed: replaced ${result.shadowedSeqs.length} node(s) (~${result.shadowedTokenCount} tokens) with the handoff checkpoint`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeStatus(agent.session?.id, {
          phase: "failed",
          step: "failed",
          failedAt: Date.now(),
          error: message,
          errorCode: errorCodeOf(error),
        });
        // The idle path reached the end of the turn too late for its own
        // summary request: the dialog offers the mid-task switch.
        await this.writeFailureHint(agent, error, measurement.totalTokens, contextWindow);
        throw error;
      } finally {
        this.running.delete(agent);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStatus(agent.session?.id, {
        phase: "failed",
        step: "failed",
        failedAt: Date.now(),
        error: message,
        errorCode: errorCodeOf(error),
      });
      this.log(`failed: ${message}`, "warn");
    }
  }

  /**
   * Forced compaction at a step boundary.
   *
   * The trigger is expressed as remaining headroom: when `window - used` falls
   * to or below the configured value, the oldest span is folded into one
   * handoff checkpoint *before* the next model request. The stock transaction
   * owns the surface lock and the commit, and the agent loop then builds its
   * next request from the compacted surface — the turn continues by itself, so
   * "stop and resume" never happens and no full prefill is required.
   */
  async midTaskCompaction(agent, signal) {
    if (!this.handoffEnabled() || signal?.aborted === true) return;
    if (this.running.has(agent)) return;
    const live = readSettings();
    if (live?.midTaskEnabled !== true) return;
    const session = agent?.session;
    if (!session) return;
    const target = this.routedTarget(agent);
    if (target === undefined) return;

    let measurement;
    try {
      measurement = this.ctx.tokenMeter.measure(session);
    } catch {
      return;
    }
    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model);
    const headerMaxTokens = session.requestHeader?.()?.config?.maxTokens;
    const reserved = this.handoff.reservedOverride >= 0
      ? this.handoff.reservedOverride
      : (headerMaxTokens ?? info.defaultMaxTokens ?? 0);
    const contextWindow = this.handoff.contextWindowOverride > 0
      ? this.handoff.contextWindowOverride
      : info.context?.contextWindow;
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) return;

    const trigger = midTaskTriggerTokens(live, contextWindow);
    const remaining = contextWindow - measurement.totalTokens;
    if (remaining > trigger) {
      return this.log(`midtask: ${measurement.totalTokens}/${contextWindow} (remaining ${remaining} > trigger ${trigger})`);
    }
    const last = this.midAttempts.get(agent);
    if (!shouldAttempt({
      now: Date.now(),
      last,
      tokens: measurement.totalTokens,
      thresholdTokens: contextWindow - trigger,
      minIntervalMs: this.handoff.minIntervalMs,
      minTokenGrowth: this.handoff.minTokenGrowth,
    })) {
      return this.log(`midtask: at trigger (remaining ${remaining}) but holding: retry gate`);
    }

    const retained = this.config.retainTokens !== undefined
      ? Math.floor(this.config.retainTokens)
      : Math.floor(Math.max(0, contextWindow - reserved) * (this.config.retainRatio ?? 0.16));
    const range = selectCompactableRange(session, measurement, retained);
    if (range === null) return this.log("midtask: no compactable range; nothing replaced");

    this.midAttempts.set(agent, { at: Date.now(), tokens: measurement.totalTokens });
    this.running.add(agent);
    const startedAt = Date.now();
    writeStatus(session.id, {
      phase: "running",
      step: "prepare",
      startedAt,
      totalTokens: measurement.totalTokens,
      thresholdTokens: contextWindow - trigger,
      contextWindow,
      midTask: true,
      midTaskTriggerTokens: trigger,
      timeoutMs: this.handoff.timeoutMs,
      retrying: false,
      writing: false,
      missingSections: [],
      error: "",
      errorCode: "",
      failureHint: null,
    });
    this.decisions.set(agent, {
      at: startedAt,
      thresholdTokens: contextWindow - trigger,
      contextWindow,
      ratio: undefined,
    });
    try {
      const timeout = AbortSignal.timeout(this.handoff.timeoutMs);
      const operationSignal = signal === undefined || typeof AbortSignal.any !== "function"
        ? (signal ?? timeout)
        : AbortSignal.any([signal, timeout]);
      const result = await this.compactRegion(range.start, range.end, agent, operationSignal);
      const shadowedNodes = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : 0;
      const shadowedTokens = typeof result?.shadowedTokenCount === "number" ? result.shadowedTokenCount : 0;
      writeStatus(session.id, {
        phase: "done",
        step: "done",
        completedAt: Date.now(),
        shadowedNodes,
        shadowedTokens,
        missingSections: [],
        retrying: false,
        writing: false,
        midTask: true,
      });
      if (result !== null && result !== undefined) this.recordHistory(agent, startedAt, "auto", measurement.totalTokens, result);
      this.log(`midtask committed: replaced ${shadowedNodes} node(s) (~${shadowedTokens} tokens); the turn continues`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStatus(session.id, {
        phase: "failed",
        step: "failed",
        failedAt: Date.now(),
        error: message,
        errorCode: errorCodeOf(error),
        midTask: true,
      });
      this.log(`midtask failed: ${message}`, "warn");
      // Forced compaction also ran out of room: the trigger itself is too
      // small for this model, so the dialog asks for a larger one.
      await this.writeFailureHint(agent, error, measurement.totalTokens, contextWindow, "raise-trigger");
    } finally {
      this.running.delete(agent);
    }
  }

  /**
   * Record why a compaction could not fit so the UI can explain it with the
   * user's real window and usage. Silently skipped when the failure is
   * unrelated to headroom or the routed model has no known capacity.
   */
  async writeFailureHint(agent, error, totalTokens, contextWindow, forcedKind) {
    if (!isHeadroomFailure(error)) return;
    const session = agent?.session;
    if (!session || !Number.isFinite(totalTokens)) return;
    let window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
    if (window === undefined) {
      const target = this.routedTarget(agent);
      if (target === undefined) return;
      try {
        const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model);
        window = info.context?.contextWindow;
      } catch {
        return;
      }
    }
    if (!Number.isFinite(window) || window <= 0) return;
    const live = readSettings();
    const kind = forcedKind ?? (live?.midTaskEnabled === true ? "raise-trigger" : "enable-midtask");
    // Only a genuinely tight window deserves the dialog: a "summary is not
    // smaller" failure on a short history must stay quiet.
    const remaining = window - totalTokens;
    const trigger = midTaskTriggerTokens(live, window);
    if (kind === "enable-midtask" && remaining > MIN_MID_TASK_TRIGGER) return;
    if (kind === "raise-trigger" && remaining > trigger + 8_000) return;
    const hint = buildFailureHint({
      kind,
      totalTokens,
      contextWindow: window,
      triggerTokens: midTaskTriggerTokens(live, window),
    });
    writeStatus(session.id, { failureHint: hint, midTask: forcedKind !== undefined });
    this.log(`failure hint: ${kind} used=${hint.usedTokens}/${hint.windowTokens} needed=${hint.neededTokens} suggest=${hint.suggestTokens}`);
  }

  /**
   * Wrap the stock transaction so manual /compact and automatic idle
   * compaction share the same status sidecar. The base method still owns the
   * surface lock, summarization and commit.
   */
  async compactNow(agent, signal, sourceCommandId) {
    // Manual /compact while the plugin is off stays a stock native compaction:
    // no handoff template, no plugin status sidecar.
    if (!this.handoffEnabled()) return super.compactNow(agent, signal, sourceCommandId);
    const sessionId = agent?.session?.id;
    const startedAt = Date.now();
    const trigger = typeof sourceCommandId === "string" && sourceCommandId.length > 0 ? "manual" : "auto";
    // A previous attempt's payload must not leak into this record.
    this.summaries.delete(agent);
    let totalTokens;
    try { totalTokens = this.ctx.tokenMeter.measure(agent.session).totalTokens; } catch { totalTokens = undefined; }
    // Manual /compact carries no trigger decision of its own; derive the same
    // numbers the idle gate would use so the timeline can show the ratio. This
    // is arithmetic plus a cached model lookup — no model call.
    if (typeof totalTokens === "number") {
      try {
        const target = this.routedTarget(agent);
        if (target !== undefined) {
          const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model);
          const headerMaxTokens = agent.session?.requestHeader?.()?.config?.maxTokens;
          const reserved = this.handoff.reservedOverride >= 0
            ? this.handoff.reservedOverride
            : (headerMaxTokens ?? info.defaultMaxTokens ?? 0);
          const contextWindow = this.handoff.contextWindowOverride > 0
            ? this.handoff.contextWindowOverride
            : info.context?.contextWindow;
          const live = readSettings();
          const ratio = typeof live?.thresholdRatio === "number" && live.thresholdRatio > 0 && live.thresholdRatio <= 1
            ? live.thresholdRatio
            : (this.config.thresholdRatio ?? 0.9);
          const decision = decideTrigger({
            totalTokens,
            contextWindow,
            reservedCompletionTokens: reserved,
            headroomTokens: this.config.headroomTokens ?? 0,
            thresholdRatio: ratio,
          });
          this.decisions.set(agent, {
            at: Date.now(),
            thresholdTokens: decision.thresholdTokens,
            contextWindow,
            ratio,
          });
        }
      } catch (error) { /* statistics only; the transaction still proceeds */ }
    }
    writeStatus(sessionId, {
      phase: "running",
      step: "prepare",
      startedAt: Date.now(),
      timeoutMs: this.handoff.timeoutMs,
      ...(typeof totalTokens === "number" ? { totalTokens } : {}),
      retrying: false,
      writing: false,
      missingSections: [],
      error: "",
      errorCode: "",
      failureHint: null,
    });
    try {
      const result = await super.compactNow(agent, signal, sourceCommandId);
      writeStatus(sessionId, {
        phase: "done",
        step: "done",
        completedAt: Date.now(),
        shadowedNodes: Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : 0,
        shadowedTokens: typeof result?.shadowedTokenCount === "number" ? result.shadowedTokenCount : 0,
        missingSections: [],
        retrying: false,
        writing: false,
        ...(result === null || result === undefined ? { note: "no compactable range" } : {}),
      });
      if (result !== null && result !== undefined) this.recordHistory(agent, startedAt, trigger, totalTokens, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeStatus(sessionId, {
        phase: "failed",
        step: "failed",
        failedAt: Date.now(),
        error: message,
        errorCode: errorCodeOf(error),
      });
      // Manual /compact at the very end of a window fails the same way; the
      // hint lets the user enable the mid-task switch instead of guessing.
      await this.writeFailureHint(agent, error, totalTokens, undefined);
      throw error;
    }
  }

  /**
   * Append one timeline record after a committed compaction. Everything here
   * is arithmetic over values the engine already has — the document, the token
   * counts and the clocks — so the timeline costs no model calls.
   */
  recordHistory(agent, startedAt, trigger, beforeTokens, result) {
    try {
      const sessionId = agent?.session?.id;
      const summary = this.summaries.get(agent);
      if (sessionId === undefined || summary === undefined) return;
      const decision = this.decisions.get(agent);
      const usage = summary.usage !== null && typeof summary.usage === "object" ? summary.usage : {};
      const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : undefined;
      const shadowedNodes = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : 0;
      const shadowedTokens = typeof result?.shadowedTokenCount === "number" ? result.shadowedTokenCount : 0;
      const counts = countWords(summary.text);
      const stored = summary.text.length > MAX_STORED_SUMMARY_CHARS
        ? summary.text.slice(0, MAX_STORED_SUMMARY_CHARS)
        : summary.text;
      const completedAt = Date.now();
      const afterTokens = typeof beforeTokens === "number"
        ? Math.max(0, beforeTokens - shadowedTokens + (outputTokens ?? 0))
        : undefined;
      appendHistory(sessionId, {
        v: 1,
        startedAt,
        completedAt,
        durationMs: completedAt - startedAt,
        summaryMs: summary.completedAt - summary.startedAt,
        trigger,
        beforeTokens,
        afterTokens,
        thresholdTokens: decision?.thresholdTokens,
        contextWindow: decision?.contextWindow,
        triggerRatio: decision?.ratio,
        shadowedNodes,
        shadowedTokens,
        summaryChars: summary.text.length,
        cjk: counts.cjk,
        words: counts.words,
        summaryTokens: outputTokens,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        },
        attempts: summary.attempts,
        truncated: stored.length < summary.text.length || undefined,
        summary: stored,
        provider: summary.provider,
        model: summary.model,
        presetId: this.handoff.presetId || undefined,
      });
    } catch (error) {
      // A committed compaction must stay committed even when the timeline
      // cannot be written.
      this.log(`history write skipped: ${error instanceof Error ? error.message : String(error)}`, "warn");
    }
  }

  /** Handoff template instead of the stock compaction instruction. */
  async summarize(input, agent, signal) {
    // Native pressure/overflow compaction runs through this same hook, so the
    // stock prompt must come back the moment the plugin is switched off.
    if (!this.handoffEnabled()) return super.summarize(input, agent, signal);
    const summaryStartedAt = Date.now();
    const latest = agent.session.requestHeader?.()?.config;
    const configured = this.config.summarizationProvider && this.config.summarizationModel
      ? { provider: this.config.summarizationProvider, model: this.config.summarizationModel }
      : undefined;
    const agentTarget = agent.options?.provider && agent.options?.model
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined;
    const target = configured ?? latest ?? agentTarget;
    if (target === undefined) throw new Error("no provider/model available for the handoff summary");
    // Replaying the prefix only reuses the provider cache when the auxiliary
    // request carries the same routing knobs as the routed one. Strata writes
    // the reasoning directive into the prefix, so a missing effort breaks the
    // cache a few thousand tokens in. Only inherit it when the summary target
    // is the same model that produced the latest request.
    const sameTarget = latest !== undefined && target.provider === latest.provider && target.model === latest.model;
    const reasoningEffort = sameTarget ? latest.reasoningEffort : undefined;

    const resolved = this.handoff.instruction === undefined
      ? readTemplate(this.handoff.templateFile, this.handoff.autoCreateTemplate)
      : { text: this.handoff.instruction, source: "config handoffInstruction" };
    const instruction = typeof resolved.text === "string" && resolved.text.trim().length > 0
      ? resolved.text
      : BUILTIN_INSTRUCTION;
    this.log(`template: ${resolved.source}${resolved.text === undefined ? " (fallback)" : ""}`);
    const maxTokens = this.summaryMaxTokens();
    this.log(`summary cap ${maxTokens} tokens`);

    const expected = expectedSections(instruction);
    const baseMessages = [
      ...input.messages,
      Object.freeze({ role: "user", content: [{ type: "text", text: instruction }] }),
    ];
    const baseOptions = {
      provider: target.provider,
      model: target.model,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      sessionId: agent.session.id,
      purpose: "compaction",
      ...(signal === undefined ? {} : { signal }),
    };
    const sessionId = agent.session?.id;

    let combined = "";
    let rawOutput = [];
    let usage;
    let validation = {
      ok: expected.length === 0,
      missing: [...expected],
      truncated: false,
      endsWithHeading: false,
      reason: "not attempted",
    };
    const attempts = [];

    let liveTotalTokens;
    try { liveTotalTokens = this.ctx.tokenMeter.measure(agent.session).totalTokens; } catch { liveTotalTokens = undefined; }
    writeStatus(sessionId, {
      phase: "running",
      step: "summary",
      summaryAttempt: 1,
      retrying: false,
      writing: false,
      missingSections: [],
      ...(typeof liveTotalTokens === "number" ? { totalTokens: liveTotalTokens } : {}),
    });

    for (let attempt = 1; attempt <= MAX_SUMMARY_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted?.();
      const messages = attempt === 1
        ? baseMessages
        : attempt === 2
          ? [
            ...baseMessages,
            Object.freeze({ role: "assistant", content: [{ type: "text", text: combined }] }),
            Object.freeze({ role: "user", content: [{ type: "text", text: continuationInstruction(validation) }] }),
          ]
          : [
            ...baseMessages,
            Object.freeze({
              role: "user",
              content: [{ type: "text", text: rewriteInstruction(validation, maxTokens) }],
            }),
          ];

      const result = await this.runSummaryRequest(baseOptions, messages);
      const truncatedNow = looksTruncated(result.text);
      const clean = stripTruncationMarkers(result.text);
      combined = attempt === 1
        ? clean
        : attempt === 2
          ? mergeSummary(combined, clean)
          : clean;
      rawOutput = result.rawOutput;
      usage = mergeUsage(usage, result.usage);
      validation = validateSummary(combined, expected);
      if (truncatedNow) {
        validation = {
          ...validation,
          ok: false,
          truncated: true,
          reason: validation.reason.length > 0 ? `${validation.reason}; truncation marker` : "truncation marker",
        };
      }
      attempts.push({
        attempt,
        finish: result.finishKind,
        chars: result.text.length,
        ok: validation.ok,
      });
      if (validation.ok) break;
      if (attempt < MAX_SUMMARY_ATTEMPTS) {
        const next = attempt + 1;
        this.log(`summary incomplete after attempt ${attempt}: ${validation.reason}; ${attempt === 1 ? "continuing" : "rewriting"}`);
        writeStatus(sessionId, {
          phase: "running",
          step: "summary",
          summaryAttempt: next,
          retrying: true,
          writing: next === MAX_SUMMARY_ATTEMPTS,
          missingSections: validation.missing,
          summaryChars: combined.length,
          summaryAttempts: attempts,
        });
      }
    }

    if (!validation.ok) {
      const error = new Error(`handoff summary incomplete after ${attempts.length} attempt(s): ${validation.reason}`);
      error.code = "INCOMPLETE_SUMMARY";
      error.attempts = attempts;
      throw error;
    }

    const finalText = combined.trim();
    if (finalText.length === 0) throw new Error("handoff summary produced no text content");
    writeStatus(sessionId, {
      phase: "running",
      step: "commit",
      summaryAttempt: attempts.length,
      retrying: false,
      writing: false,
      missingSections: [],
      summaryChars: finalText.length,
      summaryAttempts: attempts,
    });

    // Consumed by compactNow once the stock transaction commits; a failed or
    // abandoned transaction simply leaves the entry unread.
    this.summaries.set(agent, {
      text: finalText,
      usage,
      attempts,
      provider: target.provider,
      model: target.model,
      startedAt: summaryStartedAt,
      completedAt: Date.now(),
    });

    return {
      summary: [{ type: "text", text: finalText }],
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  /** One summary LLM call; max-tokens is returned as a partial, not thrown. */
  async runSummaryRequest(baseOptions, messages) {
    const assembler = new BlockAssembler();
    for await (const chunk of this.ctx.llm.stream({ ...baseOptions, messages })) assembler.push(chunk);
    const finish = assembler.finish ?? { kind: "stop" };
    if (finish.kind === "error" || finish.kind === "aborted") {
      const error = finishError(finish);
      if (error !== undefined) throw error;
    }
    const rawOutput = assembler.blocks();
    if (contentHasImage(rawOutput)) throw new LlmError("handoff summary cannot contain image output", "UNSUPPORTED_CONTENT");
    const text = rawOutput.filter((block) => block.type === "text").map((block) => block.text).join("");
    if (text.trim().length === 0) throw new Error("handoff summary produced no text content");
    return {
      rawOutput,
      text,
      finishKind: finish.kind,
      usage: assembler.usage,
    };
  }
}
