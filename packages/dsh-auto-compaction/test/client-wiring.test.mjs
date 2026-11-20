import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* The client bundle runs inside DSH's ModuleLoader with React provided by the
 * host. apply() only registers slot callbacks (it never renders), so a minimal
 * React/ReactDOM stub is enough to load the factory and exercise the wiring.
 * CompactionTabView is exposed by the bundle so its pure render structure can
 * be asserted with a fake React (state queue, no effects, no DOM). */
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: "", textContent: "" }),
  head: { appendChild: () => {} },
  querySelector: () => null,
  body: {},
};

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let stateQueue = [];
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (init) => [
    stateQueue.length > 0 ? stateQueue.shift() : (typeof init === "function" ? init() : init),
    () => {},
  ],
  useEffect: () => {},
  Fragment: "Fragment",
};
const ReactDOMStub = { createPortal: (node) => node };
const requireStub = (id) => {
  if (id === "react") return ReactStub;
  if (id === "react-dom") return ReactDOMStub;
  throw new Error("unexpected require: " + id);
};

let definition;
const windowStub = { __ModuleLoader__: { load: (def) => { definition = def; } } };
new Function("window", source)(windowStub);
const api = definition.factory(requireStub);

function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node.children) return node.children.map(textOf).join("");
  return "";
}
function findByClass(node, className) {
  if (node === null || typeof node !== "object") return null;
  if (node.props && node.props.className === className) return node;
  for (const child of node.children || []) {
    const hit = findByClass(child, className);
    if (hit) return hit;
  }
  return null;
}

const SAMPLE_EVENT = {
  startedAt: 1794301932136,
  durationMs: 93000,
  summaryMs: 81000,
  cjk: 1312,
  words: 52,
  provider: "qwen",
  model: "strata-60K",
  beforeTokens: 30210,
  contextWindow: 60000,
  afterTokens: 13600,
  thresholdTokens: 30000,
  summaryTokens: 1905,
  shadowedNodes: 27,
  shadowedTokens: 4200,
  attempts: [{ missing: [] }],
  trigger: "manual",
  summary: "## 用户主要请求与意图\n测试摘要正文",
};

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("bundle loads through the ModuleLoader wrapper", () => {
  assert.equal(definition.id, "dsh-auto-compaction");
  assert.equal(typeof api.apply, "function");
});

test("exports the name and inject list the host expects", () => {
  assert.equal(api.name, "dsh-auto-compaction");
  // `locale` is what makes the page follow the DSH language switch.
  assert.deepEqual(api.inject, ["slots", "connection", "locale"]);
});

test("apply registers the settings, dock and conversation-view slots", () => {
  const registered = [];
  api.apply({ connection: undefined, slots: { inject: (name) => { registered.push(name); } } });
  assert.deepEqual(registered, ["settings.section", "conversation.input.dock", "conversation.view"]);
});

test("apply survives a missing connection service", () => {
  assert.doesNotThrow(() => api.apply({ slots: { inject: () => {} } }));
});

test("the conversation-view callback registers no tab by default and cleans up", () => {
  let viewCb;
  const registrations = [];
  api.apply({
    connection: undefined,
    slots: {
      inject: (name, cb) => { if (name === "conversation.view") viewCb = cb; },
      register: (opts) => { registrations.push(opts); return () => {}; },
    },
  });
  assert.equal(typeof viewCb, "function");
  const dispose = viewCb();
  assert.equal(typeof dispose, "function");
  // Default position is "chat", so the tab must not be registered.
  assert.equal(registrations.length, 0);
  assert.doesNotThrow(() => dispose());
});

/* Every component calls useLocaleRevision() first, so its useState slot leads
 * the queue: state values below start at index 1. */

test("tab view renders the loading state before history arrives", () => {
  stateQueue = [0, [], -1, false];
  const tree = api.CompactionTabView({ connection: null, sessionId: "s1" });
  assert.equal(tree.props.className, "dsh-ct-empty");
  assert.match(textOf(tree), /读取压缩记录中/);
});

test("tab view renders the empty state with guidance", () => {
  stateQueue = [0, [], -1, true];
  const tree = api.CompactionTabView({ connection: null, sessionId: "s1" });
  assert.equal(tree.props.className, "dsh-ct-empty");
  const text = textOf(tree);
  assert.match(text, /还没有压缩记录/);
  assert.match(text, /\/compact/);
});

test("tab view renders the master-detail layout for a compaction event", () => {
  stateQueue = [0, [SAMPLE_EVENT], -1, true];
  const tree = api.CompactionTabView({ connection: null, sessionId: "s1" });
  assert.equal(tree.props.className, "dsh-ct");
  assert.equal(tree.children.length, 2);
  const rail = tree.children[0];
  const detail = tree.children[1];
  assert.equal(rail.props.className, "dsh-ct-rail");
  assert.equal(detail.props.className, "dsh-ct-detail");
  // Rail: one selectable event row, marked active by default (latest).
  assert.equal(rail.children[1].children.length, 1);
  assert.equal(rail.children[1].children[0].props.className, "dsh-ct-ev on");
  // Detail: ring and metric rows sit side by side, the doc fills the rest.
  const split = findByClass(detail, "dsh-ct-top");
  assert.ok(split, "split top section");
  assert.ok(findByClass(detail, "dsh-tl-ring"), "ring figure");
  assert.ok(findByClass(detail, "dsh-tl-rows"), "metric rows");
  const doc = findByClass(detail, "dsh-tl-doc");
  assert.ok(doc, "summary document");
  assert.match(textOf(doc), /测试摘要正文/);
  const text = textOf(detail);
  assert.match(text, /第 1 次压缩/);
  assert.match(text, /30,210 tokens/);
  assert.match(text, /手动 \/compact/);
  // Timeline word count = CJK characters + English words.
  assert.match(textOf(rail), /1,364 字/);
  // The gate row is gone, and the duration no longer repeats the summary time.
  assert.doesNotMatch(text, /闸门/);
  assert.doesNotMatch(text, /（摘要/);
});

test("mid-task compaction is labelled as mid-turn, not idle", () => {
  stateQueue = [0, [Object.assign({}, SAMPLE_EVENT, { trigger: "midtask" })], -1, true];
  const tree = api.CompactionTabView({ connection: null, sessionId: "s1" });
  const text = textOf(tree);
  assert.match(text, /自动（任务中途）/);
  assert.doesNotMatch(text, /自动（空闲时）/);
  // The document header carries the two font-size controls.
  const zoom = findByClass(tree, "dsh-tl-zoom");
  assert.ok(zoom, "font size controls");
  assert.equal(zoom.children.length, 2);
  assert.match(textOf(zoom), /[−+]/);
});

const SAVED = {
  enabled: true,
  thresholdRatio: 0.9,
  scope: "preset",
  presets: ["local"],
  templateFile: "",
  displayStyle: "orbit",
  timelineEnabled: true,
  timelinePosition: "chat",
  timelineStyle: "ember",
  defaultSummaryMaxTokens: 12288,
};
const INVENTORY = {
  enabled: true,
  scope: "preset",
  source: "bundle-patch",
  presets: [
    { id: "standard", covered: true, effective: true },
    { id: "local", covered: true, effective: true },
    { id: "ptc", covered: true, effective: false },
  ],
  total: 3,
  covered: 3,
  mounted: 3,
  effective: 1,
  reason: "",
};

function renderSection(draft) {
  stateQueue = [0, SAVED, draft, { loading: false, error: "", saving: false, saved: false },
    { loading: false, error: "", value: INVENTORY }, 0, null];
  return api.Section({ connection: {}, sessionId: "s1" });
}

test("settings section keeps the preset chips and drops the scope report", () => {
  const text = textOf(renderSection(SAVED));
  assert.match(text, /生效范围/);
  assert.match(text, /standard/, "chips still come from the scope inventory");
  assert.doesNotMatch(text, /当前生效情况|已由插件压缩|重新读取/);
  assert.doesNotMatch(text, /保存后生效/, "a saved page shows no pending hint");
});

test("each unsaved field marks its own title as pending", () => {
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { presets: ["local", "ptc"] }))),
    /生效范围（保存后生效）/);
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { scope: "global" }))),
    /生效范围（保存后生效）/);
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { thresholdRatio: 0.75 }))),
    /压缩触发点（保存后生效）/);
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { displayStyle: "strip" }))),
    /压缩中样式（保存后生效）/);
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { summaryMaxTokens: 16000 }))),
    /摘要上限（保存后生效）/);
});

test("settings section adds the mid-task water-level block", () => {
  const text = textOf(renderSection(Object.assign({}, SAVED, {
    midTaskEnabled: true, midTaskTriggerTokens: 40000, suppressFailureHint: false,
  })));
  assert.match(text, /任务中途压缩/);
  assert.match(text, /触发线 · 已用 210,000/);
  assert.match(text, /40,000/);
  assert.match(text, /逐字保留尾部 ≈ 36,800/);
  assert.match(text, /压缩失败提示/);
});

test("mid-task fields mark their own titles as pending", () => {
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { midTaskEnabled: true }))),
    /任务中途压缩（保存后生效）/);
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { midTaskTriggerTokens: 40000 }))),
    /任务中途压缩（保存后生效）/);
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { suppressFailureHint: true }))),
    /压缩失败提示（保存后生效）/);
});


test("display section nests two parallel sub-titles and all five timeline styles", () => {
  const text = textOf(renderSection(SAVED));
  assert.match(text, /压缩显示方式/);
  assert.match(text, /压缩中样式/);
  assert.match(text, /压缩时间线/);
  assert.match(text, /时间线样式/);
  for (const label of ["火种刻度", "胶囊流", "环相", "静默刻度", "比例柱"]) {
    assert.ok(text.includes(label), label);
  }
  // The two explanatory blurbs were removed on purpose.
  assert.doesNotMatch(text, /选择压缩进行时在会话里的提示样式/);
  assert.doesNotMatch(text, /把每次压缩的时间、用时和字数显示在会话里/);
});

test("timeline position and style pending markers sit on the timeline title", () => {
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { timelineStyle: "capsule" }))),
    /压缩时间线（保存后生效）/);
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { timelinePosition: "tab" }))),
    /压缩时间线（保存后生效）/);
  assert.doesNotMatch(textOf(renderSection(Object.assign({}, SAVED, { timelineStyle: "capsule" }))),
    /时间线样式（保存后生效）/);
});

const CHAIN_EVENTS = [
  { startedAt: 1794301000000, durationMs: 13900, cjk: 1204, words: 0, beforeTokens: 230000, contextWindow: 250000, trigger: "auto" },
  { startedAt: 1794301500000, durationMs: 10200, cjk: 987, words: 0, beforeTokens: 225000, contextWindow: 250000, trigger: "auto" },
  { startedAt: 1794302000000, durationMs: 61000, cjk: 2049, words: 0, beforeTokens: 240000, contextWindow: 250000, trigger: "manual" },
];
function renderChain(style, regionH) {
  stateQueue = [0];
  return api.TimelineChain({ events: CHAIN_EVENTS, style, regionH: regionH || 300, onOpen: () => {} });
}
function chainRows(tree) {
  return tree.children.filter((c) => c && c.type === "button");
}

test("chain: ember rows carry time, bead and metrics, latest marked on", () => {
  const rows = chainRows(renderChain("ember"));
  assert.equal(rows.length, 3);
  assert.ok(findByClass(rows[2], "dsh-tl-tm"), "time column");
  assert.ok(findByClass(rows[2], "dsh-tl-dot"), "bead");
  assert.ok(findByClass(rows[2], "dsh-tl-meta"), "metrics");
  assert.match(rows[2].props.className, /\bon\b/);
});

test("chain: capsule rows wrap time and metrics in a cap", () => {
  const rows = chainRows(renderChain("capsule"));
  assert.equal(rows.length, 3);
  assert.ok(findByClass(rows[0], "dsh-tl-cap"), "capsule body");
  assert.ok(findByClass(rows[2], "dsh-tl-metrics"), "metrics");
});

test("chain: ring rows draw an svg progress ring", () => {
  const rows = chainRows(renderChain("ring"));
  const ring = findByClass(rows[1], "dsh-tl-ringmini");
  assert.ok(ring, "mini ring");
  assert.equal(ring.type, "svg");
  assert.equal(ring.children.length, 3);
});

test("chain: quiet rows are ticks with a hover card", () => {
  const rows = chainRows(renderChain("quiet"));
  assert.ok(findByClass(rows[0], "dsh-tl-tick"), "tick");
  assert.ok(findByClass(rows[0], "dsh-tl-tm"), "clock visible without hover");
  assert.ok(findByClass(rows[2], "dsh-tl-hover"), "hover card");
  assert.match(textOf(findByClass(rows[2], "dsh-tl-hover")), /2,049 字/);
});

test("chain: bars rows use the real context share and keep the word count", () => {
  const rows = chainRows(renderChain("bars"));
  const track = findByClass(rows[2], "dsh-tl-track");
  assert.ok(track, "track");
  // 240,000 / 250,000 = 96% — the same number the detail dialog shows.
  assert.equal(track.children[0].props.style.width, "96.0%");
  assert.equal(textOf(findByClass(rows[2], "dsh-tl-num")), "2,049 字");
  assert.equal(findByClass(rows[0], "dsh-tl-track").children[0].props.style.width, "92.0%");
  assert.match(track.props.title, /触发时占窗口 96\.0%/);
});

test("chain: dense packing degrades capsule to beads and bars to tracks", () => {
  const caps = chainRows(renderChain("capsule", 36));
  assert.equal(findByClass(caps[0], "dsh-tl-cap"), null);
  assert.ok(findByClass(caps[0], "dsh-tl-dot"));
  const bars = chainRows(renderChain("bars", 36));
  assert.equal(findByClass(bars[0], "dsh-tl-tm"), null);
  assert.equal(findByClass(bars[0], "dsh-tl-num"), null);
  assert.ok(findByClass(bars[0], "dsh-tl-track"));
});

test("chain: unknown style falls back to ember", () => {
  const rows = chainRows(renderChain("bogus"));
  assert.ok(findByClass(rows[0], "dsh-tl-meta"), "ember metrics");
});

const ENABLE_HINT = {
  kind: "enable-midtask",
  usedTokens: 245000, windowTokens: 250000, remainingTokens: 5000,
  neededTokens: 20000, triggerTokens: 20000, suggestTokens: 20000, at: 1000,
};
const RAISE_HINT = {
  kind: "raise-trigger",
  usedTokens: 230000, windowTokens: 250000, remainingTokens: 20000,
  neededTokens: 28000, triggerTokens: 20000, suggestTokens: 40000, at: 2000,
};

function renderHint(hint, prefs) {
  stateQueue = [0, hint, prefs, 0, false, false];
  return api.FailureHint({ connection: {}, sessionId: "s1" });
}

test("failure hint explains an idle failure with the live numbers", () => {
  const text = textOf(renderHint(ENABLE_HINT, { midTaskEnabled: false, suppressFailureHint: false }));
  assert.match(text, /摘要生成失败/);
  assert.match(text, /245,000 \/ 250,000/);
  assert.match(text, /5,000/);
  assert.match(text, /启用任务中途压缩/);
  assert.match(text, /不再提示这类失败/);
});

test("failure hint explains a too-small trigger and offers the raise", () => {
  const text = textOf(renderHint(RAISE_HINT, { midTaskEnabled: true, suppressFailureHint: false }));
  assert.match(text, /中途压缩也失败了/);
  assert.match(text, /28,000/);
  assert.match(text, /把触发余量提高到 40,000/);
});

test("failure hint stays hidden when notices are off or already cleared", () => {
  assert.equal(renderHint(ENABLE_HINT, { suppressFailureHint: true }), null);
  assert.equal(renderHint(Object.assign({}, RAISE_HINT, { at: 500 }), { hintClearedAt: 1000 }), null);
});

/* ---- UI language ---- */

/* Runs apply() with a fake ctx.locale, the same seam the host uses. Returns the
 * RPC calls the bundle made, so the mirror to the node half is observable. */
function enableLocale(active) {
  const calls = [];
  const locale = {
    getSnapshot: () => ({ active, revision: 1 }),
    subscribe: () => () => {},
    register: () => () => {},
  };
  const connection = {
    rpc: { call: (channel, endpoint, payload) => { calls.push({ channel, endpoint, payload }); return Promise.resolve({ ok: true, value: {} }); } },
  };
  api.apply({
    connection,
    slots: { inject: () => {}, register: () => () => {} },
    locale,
    effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
  });
  return calls;
}

test("an English UI renders the settings page in English", () => {
  enableLocale("en");
  try {
    const text = textOf(renderSection(SAVED));
    assert.match(text, /Enable plugin/);
    assert.match(text, /Mid-task compaction/);
    assert.doesNotMatch(text, /启用插件/);
    assert.doesNotMatch(text, /任务中途压缩/);
  } finally {
    enableLocale("zh");
  }
  assert.match(textOf(renderSection(SAVED)), /启用插件/);
});

test("an English timeline counts English words only", () => {
  const event = Object.assign({}, CHAIN_EVENTS[2], { cjk: 100, words: 1204 });
  enableLocale("en");
  try {
    stateQueue = [0];
    const en = textOf(api.TimelineChain({ events: [event], style: "ember", regionH: 300 }));
    assert.match(en, /1,204 words/);
    assert.doesNotMatch(en, /字/);
  } finally {
    enableLocale("zh");
  }
  stateQueue = [0];
  const zh = textOf(api.TimelineChain({ events: [event], style: "ember", regionH: 300 }));
  assert.match(zh, /1,304 字/);
});

test("English rows use 12-hour time, Chinese keeps 24-hour", () => {
  enableLocale("en");
  try {
    stateQueue = [0];
    const en = textOf(api.TimelineChain({ events: [CHAIN_EVENTS[2]], style: "ember", regionH: 300 }));
    assert.match(en, /\d{1,2}:\d{2} (AM|PM)/);
    assert.doesNotMatch(en, /\d{2}:\d{2}:\d{2}/);
  } finally {
    enableLocale("zh");
  }
  stateQueue = [0];
  const zh = textOf(api.TimelineChain({ events: [CHAIN_EVENTS[2]], style: "ember", regionH: 300 }));
  assert.match(zh, /\d{2}:\d{2}:\d{2}/);
});

test("the UI language is mirrored to the node half", () => {
  const calls = enableLocale("en");
  try {
    const pref = calls.filter((c) => c.endpoint === "pref").pop();
    assert.ok(pref, "pref RPC called");
    assert.equal(pref.payload.uiLocale, "en");
  } finally {
    enableLocale("zh");
  }
});

test("slot labels follow the language", () => {
  function captureLabel(active) {
    let label;
    const locale = {
      getSnapshot: () => ({ active, revision: 1 }),
      subscribe: () => () => {},
      register: () => () => {},
    };
    api.apply({
      connection: undefined,
      slots: {
        inject: (name, cb) => { if (name === "settings.section") cb(); },
        register: (opts) => { if (opts.name === "settings.section") label = opts.label; return () => {}; },
      },
      locale,
      effect: (fn) => { fn(); },
    });
    return label;
  }
  assert.equal(captureLabel("en")(), "Session Compaction");
  assert.equal(captureLabel("zh")(), "会话压缩");
});

/* Static guard: the 0.4.x page hardcoded every string, which is exactly how it
 * ended up with no English at all. These two checks keep that from creeping
 * back: no bare Chinese literal outside the dictionary, and every msgid the
 * page asks for actually has an English entry. */
const EN_BLOCK_START = source.indexOf("var EN = {");
const EN_BLOCK_END = source.indexOf("\n    };", EN_BLOCK_START);
const EN_BLOCK = EN_BLOCK_START >= 0 && EN_BLOCK_END > EN_BLOCK_START
  ? source.slice(EN_BLOCK_START, EN_BLOCK_END)
  : "";
/* Preset names come from the user's own DSH presets and the settings preview
 * shows one verbatim, so it is deliberately untranslated. */
const UNTRANSLATED = new Set(["轻量本地"]);

test("the English dictionary is complete for every msgid the page uses", () => {
  assert.ok(EN_BLOCK.length > 0, "dictionary block found");
  const keys = new Set();
  for (const match of EN_BLOCK.matchAll(/^\s{6}"((?:[^"\\]|\\.)*)":/gm)) keys.add(match[1]);
  assert.ok(keys.size > 150, `dictionary has ${keys.size} keys`);
  const msgids = new Set();
  for (const match of source.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) msgids.add(match[1]);
  for (const match of source.matchAll(/\btn\(\s*[^,]+,\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\.)*)"/g)) {
    msgids.add(match[1]);
    msgids.add(match[2]);
  }
  const missing = [...msgids].filter((id) => !keys.has(id) && !UNTRANSLATED.has(id));
  assert.deepEqual(missing, [], "msgids without an English translation");
});

test("no bare Chinese literal is left outside the dictionary", () => {
  const lines = source.split(/\r?\n/);
  const tableLine = /^\s+\{ id: "[a-z]+", (label|desc): "/;
  const offenders = [];
  let inDictionary = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!inDictionary && line.includes("var EN = {")) { inDictionary = true; continue; }
    if (inDictionary) {
      if (/^\s{4}\};$/.test(line)) inDictionary = false;
      continue;
    }
    if (!/[\u4e00-\u9fff]/.test(line)) continue;
    if (tableLine.test(line)) continue;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (/\bt\(|tn\(/.test(line)) continue;
    offenders.push(`${i + 1}: ${line.trim()}`);
  }
  assert.deepEqual(offenders, [], "hardcoded Chinese outside t()/tn()");
});

let failed = 0;
for (const { name, fn } of cases) {
  stateQueue = [0];
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;