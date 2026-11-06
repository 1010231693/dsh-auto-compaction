import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import {
  BLOCK_MARKERS,
  JsExpression,
  engineRow,
  findUnsupported,
  mergeBlock,
  needsRewrite,
  renderBlock,
  takeoverRow,
  takeoverRows,
} from "../lib/takeover-rows.js";

/* Same resolution order as scripts/preset-scope.mjs: the engine's own
 * dependency first, the profile-installed copy as the fallback, because the
 * dev workspace installs nothing and runs through junctions. */
function loadYaml() {
  const here = createRequire(import.meta.url);
  try { return here("js-yaml"); } catch { /* fall through */ }
  const profileRoot = path.join(
    process.env.APP_DATA ?? path.join(process.env.SystemDrive ?? "C:", "Users", process.env.USERNAME ?? process.env.USER ?? "", "AppData", "Roaming"),
    "dsh-desktop", "harness", "profiles", "web",
  );
  return createRequire(path.join(profileRoot, "package.json"))("js-yaml");
}
const yaml = loadYaml();

/** Parse back the way DSH's own scripts do, so `!!js` round-trips in tests. */
function jsSchema() {
  return yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (data) => new JsExpression(data) }),
  ]);
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/* A preset shaped like DSH's own standard.patch.yml: a compaction group holding
 * the stock provider, a command row and a pruner row, beside unrelated groups. */
function standardPreset() {
  return {
    id: "standard",
    name: "@deepseek-ai/dsh-agent-preset",
    config: {
      id: "standard",
      order: 1,
      name: "标准",
      description: "完整能力集",
      plugins: [
        { id: "provider", name: "@deepseek-ai/dsh-provider-openai", config: { models: ["a", "b"] } },
        {
          id: "compaction",
          name: "cordis:group",
          group: true,
          isolate: { compaction: true, toolResultPruner: true },
          config: [
            { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
            { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
            {
              id: "tool-result-pruner",
              name: "@deepseek-ai/dsh-compaction-tool-result-pruner",
              config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
            },
          ],
        },
        {
          id: "delegation",
          name: "cordis:group",
          group: true,
          isolate: { workflowEngine: true },
          config: [{ id: "tool-subagent-control", name: "@deepseek-ai/dsh-tool-subagent-control" }],
        },
      ],
    },
  };
}

test("the takeover row swaps only the stock provider inside the compaction group", () => {
  const row = takeoverRow(standardPreset(), {});
  assert.equal(row.id, "preset-standard");
  assert.equal(row.name, "@deepseek-ai/dsh-agent-preset");
  assert.equal(row.config.order, 1);
  assert.equal(row.config.description, "完整能力集");

  const group = row.config.plugins.find((entry) => entry.id === "compaction");
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true });
  assert.equal(group.config.length, 3);
  assert.equal(group.config[0].name, "dsh-auto-compaction-engine");
  assert.equal(group.config[0].config.presetId, "standard");
  assert.equal(group.config[1].name, "@deepseek-ai/dsh-command-compact");
  assert.equal(group.config[2].config.tailChars, 1024);
});

test("every other plugin of the preset survives the replacement", () => {
  const before = JSON.stringify(standardPreset().config.plugins);
  const row = takeoverRow(standardPreset(), {});
  const after = JSON.stringify(row.config.plugins);
  assert.equal(row.config.plugins.length, JSON.parse(before).length);
  assert.equal(after.length < before.length, false, "the replacement shrank the plugin list");
  assert.ok(after.includes("@deepseek-ai/dsh-provider-openai"));
  assert.ok(after.includes("tool-subagent-control"));
});

test("the user's own tuning on the stock row is carried over", () => {
  const preset = standardPreset();
  preset.config.plugins[1].config[0].config = { thresholdRatio: 0.75, headroomTokens: 4096 };
  const row = takeoverRow(preset, {});
  const engine = row.config.plugins[1].config[0];
  assert.equal(engine.config.thresholdRatio, 0.75);
  assert.equal(engine.config.headroomTokens, 4096);
  assert.equal(engine.config.maxTokens, 12288, "defaults this plugin needs still apply");
});

test("a preset without a compaction group is left alone", () => {
  const preset = standardPreset();
  preset.config.plugins = preset.config.plugins.filter((entry) => entry.id !== "compaction");
  assert.equal(takeoverRow(preset, {}), null);
});

test("a preset whose stock row is disabled is not re-enabled", () => {
  const preset = standardPreset();
  preset.config.plugins[1].config[0].disabled = true;
  assert.equal(takeoverRow(preset, {}), null);
});

test("the engine row name is configurable for the resolution base in use", () => {
  const row = takeoverRow(standardPreset(), { engineName: "dsh-auto-compaction/engine" });
  assert.equal(row.config.plugins[1].config[0].name, "dsh-auto-compaction/engine");
});

test("generated rows parse back as YAML and match the input shape", () => {
  const rows = takeoverRows([standardPreset(), { id: "minimal", config: { id: "minimal", order: 3, plugins: [
    { id: "compaction", group: true, name: "cordis:group", config: [{ id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" }] },
  ] } }], {});
  assert.equal(rows.length, 2);
  const block = renderBlock(rows);
  const parsed = yaml.load(block);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "preset-standard");
  assert.equal(parsed[0].config.plugins[1].config[0].name, "dsh-auto-compaction-engine");
  assert.equal(parsed[1].config.id, "minimal");
  assert.equal(parsed[1].config.plugins[0].config[0].config.presetId, "minimal");
});

test("the block is byte-stable, so activation does not rewrite the file every start", () => {
  const rows = takeoverRows([standardPreset()], {});
  const a = renderBlock(rows);
  const b = renderBlock(takeoverRows([standardPreset()], {}));
  assert.equal(a, b);
});

test("merging keeps hand-written rows and replaces only the managed block", () => {
  const original = [
    "# dsh-auto-compaction bundle patch.",
    "- insert:",
    "    - id: dsh-auto-compaction",
    "      name: dsh-auto-compaction",
    "",
    BLOCK_MARKERS.BEGIN,
    "- id: preset-old",
    "  config:",
    "    id: old",
    BLOCK_MARKERS.END,
    "",
  ].join("\n");
  const block = renderBlock(takeoverRows([standardPreset()], {}));
  const next = mergeBlock(original, block);
  assert.ok(next.includes("- id: dsh-auto-compaction"), "the hand-written insert row was lost");
  assert.ok(!next.includes("preset-old"), "the stale managed block survived");
  assert.equal(needsRewrite(next, block), false, "merging twice is not idempotent");
  assert.equal(mergeBlock(next, block), next);
  const doc = yaml.load(next);
  assert.equal(doc.length, 2, "the file should hold the hand-written row plus the managed row");
  assert.deepEqual(doc[0].insert, [{ id: "dsh-auto-compaction", name: "dsh-auto-compaction" }]);
  assert.equal(doc[1].id, "preset-standard");
});

test("a file without the block gets it appended once", () => {
  const original = "- insert:\n    - id: dsh-auto-compaction\n      name: dsh-auto-compaction\n";
  const block = renderBlock([]);
  const next = mergeBlock(original, block);
  assert.ok(next.startsWith("- insert:"));
  assert.equal(needsRewrite(next, block), false);
  assert.equal(next.split(BLOCK_MARKERS.BEGIN).length, 2);
});

test("an empty row list still yields a valid file with an empty block", () => {
  const block = renderBlock([]);
  const next = mergeBlock("- insert: []\n", block);
  const doc = yaml.load(next);
  assert.deepEqual(doc, [{ insert: [] }], "an empty managed block must not invent a row");
});

test("engineRow keeps this plugin's own defaults when the preset row has none", () => {
  assert.deepEqual(engineRow("ptc", {}).config, {
    thresholdRatio: 0.9,
    headroomTokens: 10000,
    maxTokens: 12288,
    idleDelayMs: 1500,
    presetId: "ptc",
  });
});

/* Presets gate rows per platform with `disabled: !!js process.platform ===
 * 'win32'`. Replacing the preset's config re-emits those values, and a plain
 * string in `disabled` is merely truthy to the loader — so the tag has to come
 * back out as the tag it went in as. */
test("platform-conditional !!js rows are re-emitted as tags", () => {
  const preset = standardPreset();
  preset.config.plugins[0].disabled = new JsExpression("process.platform === 'win32'");
  preset.config.plugins.unshift({ id: "win-only", name: "@deepseek-ai/dsh-tool-win", disabled: new JsExpression("process.platform !== 'win32'") });
  const text = renderBlock(takeoverRows([preset], {}));
  assert.ok(text.includes("disabled: !!js process.platform === 'win32'"), text);
  assert.ok(text.includes("disabled: !!js process.platform !== 'win32'"));
  const parsed = yaml.load(text, { schema: jsSchema() });
  const row = parsed.find((entry) => entry.id === "preset-standard");
  assert.equal(typeof row.config.plugins[0].disabled.text, "string");
  assert.equal(row.config.plugins[0].disabled.text, "process.platform !== 'win32'");
});

test("!!js list items survive too", () => {
  const preset = standardPreset();
  preset.config.plugins[0].config = { skills: [new JsExpression("process.getBuiltinModule('node:path').join(base)")] };
  const text = renderBlock(takeoverRows([preset], {}));
  assert.ok(text.includes("- !!js process.getBuiltinModule('node:path').join(base)"), text);
});

test("a value that cannot be written back leaves the preset untouched", () => {
  const preset = standardPreset();
  preset.config.plugins[0].config = { skills: [() => "constructed by the parser"] };
  assert.equal(takeoverRow(preset, {}), null);
});

test("findUnsupported names the path so the reason is actionable", () => {
  const preset = standardPreset();
  preset.config.plugins[2].isolate = { workflowEngine: () => true };
  const path = findUnsupported(preset.config);
  assert.match(path, /^plugins\[2\]\.isolate\.workflowEngine$/);
  assert.equal(findUnsupported({ ok: new JsExpression("x"), list: [1, "a"] }), "");
});

/* `disabled: !!js !ctx.get('profileContext')` is a real row in DSH's cordis
 * preset; unquoted, the leading `!` reads as a second tag and the whole file
 * fails to parse. */
test("an expression starting with an indicator is quoted so the file parses", () => {
  const preset = standardPreset();
  preset.config.plugins[0].disabled = new JsExpression("!ctx.get('profileContext')");
  const text = renderBlock(takeoverRows([preset], {}));
  assert.ok(text.includes("disabled: !!js '!ctx.get(''profileContext'')'"), text);
  const parsed = yaml.load(text, { schema: jsSchema() });
  const row = parsed.find((entry) => entry.id === "preset-standard");
  assert.equal(row.config.plugins[0].disabled.text, "!ctx.get('profileContext')");
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
