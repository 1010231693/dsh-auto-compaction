import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* The client bundle runs inside DSH's ModuleLoader with React provided by the
 * host. apply() only registers slot callbacks (it never renders), so a minimal
 * React/ReactDOM stub is enough to load the factory and exercise the wiring.
 * CompactionTabView is exposed by the bundle so its pure render structure can
 * be asserted with a fake React (state queue, no effects, no DOM). */
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
const ReactDOMStub = { createPortal: () => null };
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
  assert.deepEqual(api.inject, ["slots", "connection"]);
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

test("tab view renders the loading state before history arrives", () => {
  stateQueue = [[], -1, false];
  const tree = api.CompactionTabView({ connection: null, sessionId: "s1" });
  assert.equal(tree.props.className, "dsh-ct-empty");
  assert.match(textOf(tree), /读取压缩记录中/);
});

test("tab view renders the empty state with guidance", () => {
  stateQueue = [[], -1, true];
  const tree = api.CompactionTabView({ connection: null, sessionId: "s1" });
  assert.equal(tree.props.className, "dsh-ct-empty");
  const text = textOf(tree);
  assert.match(text, /还没有压缩记录/);
  assert.match(text, /\/compact/);
});

test("tab view renders the master-detail layout for a compaction event", () => {
  stateQueue = [[SAMPLE_EVENT], -1, true];
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
  stateQueue = [SAVED, draft, { loading: false, error: "", saving: false, saved: false },
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
    /压缩显示方式（保存后生效）/);
  assert.match(textOf(renderSection(Object.assign({}, SAVED, { summaryMaxTokens: 16000 }))),
    /摘要上限（保存后生效）/);
});

let failed = 0;
for (const { name, fn } of cases) {
  stateQueue = [];
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;