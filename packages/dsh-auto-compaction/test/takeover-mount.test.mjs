import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureBundleLayer, mountTakeover, presetInventory, profileManifest, readTakenPresets } from "../lib/takeover-mount.js";

/* The host's registry publishes a preset's plugin list as a YAML string, so the
 * stub has to hand back the same shape or the test proves nothing. */
function loadYaml() {
  const here = createRequire(import.meta.url);
  try { return here("js-yaml"); } catch { /* fall through */ }
  const appData = process.env.APP_DATA
    ?? join(process.env.SystemDrive ?? "C:", "Users", process.env.USERNAME ?? process.env.USER ?? "", "AppData", "Roaming");
  return createRequire(join(appData, "dsh-desktop", "harness", "profiles", "web", "package.json"))("js-yaml");
}
const yaml = loadYaml();

const SANDBOX = mkdtempSync(join(tmpdir(), "dsh-ac-mount-"));
const PATCH = join(SANDBOX, "cordis.patch.yml");
const MANIFEST = join(SANDBOX, "profile-package.json");
process.env.DSH_HANDOFF_TAKEOVER_FILE = PATCH;
/* Mounting normally keeps this package's bundle entry last in the profile
 * manifest; a test must never write the real one. */
process.env.DSH_PROFILE_MANIFEST = MANIFEST;

const MANIFEST_TEXT = JSON.stringify({
  name: "web",
  dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-preset-pack"] } },
}, null, 2) + "\n";

/* The row this package ships by hand; the managed block is appended beside it. */
const SHIPPED = [
  "# dsh-auto-compaction bundle patch.",
  "- insert:",
  "    - id: dsh-auto-compaction",
  "      name: dsh-auto-compaction",
  "",
].join("\n");

const compactionGroup = (providerName) => ({
  id: "compaction",
  name: "cordis:group",
  group: true,
  isolate: { compaction: true, toolResultPruner: true },
  config: [
    { id: providerName === null ? "other-row" : "compaction-basic", name: providerName ?? "@deepseek-ai/dsh-something" },
    { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
  ],
});

const PRESETS = [
  { id: "standard", order: 1, label: "标准", plugins: [{ id: "provider", name: "@deepseek-ai/dsh-provider-openai" }, compactionGroup("@deepseek-ai/dsh-compaction-basic")] },
  { id: "minimal", order: 3, label: "极简", plugins: [compactionGroup("@deepseek-ai/dsh-compaction-basic")] },
  // A preset that declares no compaction group cannot be taken over.
  { id: "no-group", order: 9, label: "无压缩组", plugins: [{ id: "provider", name: "@deepseek-ai/dsh-provider-openai" }] },
];

function stubCtx(presets = PRESETS, { failGet = false } = {}) {
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      if (failGet || name !== "agentPresets") throw new Error(`unknown service ${name}`);
      return {
        // list(): display metadata only.
        list: async () => presets.map((preset) => ({
          id: preset.id,
          name: preset.label,
          order: preset.order,
          description: `预设 ${preset.id}`,
        })),
        // readDocument(): the plugin list published as YAML, beside metadata.
        readDocument: async (id) => {
          const preset = byId.get(id);
          return {
            agentPreset: preset.id,
            content: yaml.dump(preset.plugins, { noRefs: true, lineWidth: -1 }),
            name: preset.label,
            description: `预设 ${preset.id}`,
          };
        },
      };
    },
  };
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("mounting writes one takeover row per takeable preset", async () => {
  writeFileSync(PATCH, SHIPPED, "utf8");
  const result = await mountTakeover(stubCtx());
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.taken, ["standard", "minimal"]);
  assert.deepEqual(result.skipped, ["no-group"]);
  const text = readFileSync(PATCH, "utf8");
  assert.ok(text.includes("- id: preset-standard"));
  assert.ok(text.includes("- id: preset-minimal"));
  assert.ok(!text.includes("preset-no-group"));
});

test("the hand-written row survives and the engine row carries its preset id", async () => {
  const text = readFileSync(PATCH, "utf8");
  assert.ok(text.startsWith("# dsh-auto-compaction bundle patch."), "the file header moved");
  assert.ok(text.includes("    - id: dsh-auto-compaction"), "the shipped insert row was lost");
  assert.ok(text.includes("presetId: standard"));
  assert.ok(text.includes("presetId: minimal"));
  assert.equal(text.split("# >>> handoff:takeover:begin").length, 2, "the managed block appears twice");
});

test("remounting does not touch the file again", async () => {
  const before = readFileSync(PATCH, "utf8");
  await mountTakeover(stubCtx());
  assert.equal(readFileSync(PATCH, "utf8"), before, "a second mount rewrote identical content");
});

test("a preset that gains a plugin in a later release keeps it", async () => {
  const grown = PRESETS.map((preset) => preset.id !== "standard" ? preset : {
    ...preset,
    plugins: [...preset.plugins, { id: "tool-new-in-release", name: "@deepseek-ai/dsh-tool-new" }],
  });
  await mountTakeover(stubCtx(grown));
  const text = readFileSync(PATCH, "utf8");
  assert.ok(text.includes("tool-new-in-release"), "the generated row dropped a plugin the preset gained");
  assert.ok(text.includes("presetId: standard"));
});

test("uninstalling leaves nothing behind: removing the block restores native rows", async () => {
  const text = readFileSync(PATCH, "utf8");
  const { BEGIN, END } = { BEGIN: "# >>> handoff:takeover:begin", END: "# <<< handoff:takeover:end" };
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(begin > 0 && end > begin);
  // Uninstall deletes the whole package, so the only residue that could point
  // at the engine is inside this block.
  const withoutBlock = text.slice(0, begin) + text.slice(end + END.length);
  assert.ok(!withoutBlock.includes("dsh-auto-compaction-engine"), "the engine is referenced outside the managed block");
  assert.ok(withoutBlock.includes("- id: dsh-auto-compaction"), "the package's own mount row should remain for the live session");
});

test("readTakenPresets reports the covered ids", async () => {
  assert.deepEqual(await readTakenPresets(), ["standard", "minimal"]);
});

test("inventory: global scope makes every covered preset effective", async () => {
  const inventory = await presetInventory(stubCtx(), { scope: "global", presets: [], enabled: true });
  assert.equal(inventory.total, 3);
  assert.equal(inventory.covered, 2);
  assert.equal(inventory.effective, 2);
  const noGroup = inventory.presets.find((row) => row.id === "no-group");
  assert.equal(noGroup.covered, false);
  assert.equal(noGroup.effective, false);
});

test("inventory: preset scope with nothing selected leaves everything native", async () => {
  const inventory = await presetInventory(stubCtx(), { scope: "preset", presets: [], enabled: true });
  assert.equal(inventory.effective, 0);
  assert.equal(inventory.covered, 2);
});

test("inventory: preset scope selects only the checked presets", async () => {
  const inventory = await presetInventory(stubCtx(), { scope: "preset", presets: ["minimal"], enabled: true });
  assert.deepEqual(inventory.presets.filter((row) => row.effective).map((row) => row.id), ["minimal"]);
});

test("inventory: the switch off makes the takeover ineffective everywhere", async () => {
  const inventory = await presetInventory(stubCtx(), { scope: "global", presets: [], enabled: false });
  assert.equal(inventory.effective, 0);
  assert.equal(inventory.covered, 2);
});

test("an unreachable presets service leaves the patch file untouched", async () => {
  writeFileSync(PATCH, SHIPPED, "utf8");
  const result = await mountTakeover(stubCtx([], { failGet: true }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /agentPresets/);
  assert.equal(readFileSync(PATCH, "utf8"), SHIPPED, "a failed mount rewrote the patch file");
});

test("a skipped preset is explained instead of silently dropped", async () => {
  writeFileSync(PATCH, SHIPPED, "utf8");
  const result = await mountTakeover(stubCtx());
  assert.match(result.reason, /no-group: 没有可接管的 compaction 组/);
});

test("a failed document read keeps the shipped rows instead of wiping them", async () => {
  writeFileSync(PATCH, SHIPPED, "utf8");
  await mountTakeover(stubCtx());
  const good = readFileSync(PATCH, "utf8");
  assert.ok(good.includes("preset-standard"), "the block was not written in the first place");

  const broken = {
    logger: { info() {}, warn() {} },
    get: () => ({
      list: async () => [{ id: "standard", name: "标准", order: 1 }],
      readDocument: async () => { throw new Error("agent-preset/not-found"); },
    }),
  };
  const result = await mountTakeover(broken);
  assert.equal(result.ok, false);
  assert.match(result.reason, /standard: agent-preset\/not-found/);
  assert.equal(readFileSync(PATCH, "utf8"), good, "a transient host failure rewrote the shipped rows");
});

/* Layer order decides coverage: a takeover row is an update of a preset row
 * that must already exist, so this package's bundle entry belongs last. */
test("the bundle entry is appended when it is missing", () => {
  const result = ensureBundleLayer(MANIFEST_TEXT);
  assert.equal(result.changed, true);
  const bundles = JSON.parse(result.text).dsh.profile.bundles;
  assert.deepEqual(bundles, ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-preset-pack", "dsh-auto-compaction"]);
});

test("an entry that sits before another preset's is moved to the end", () => {
  const text = JSON.stringify({ dsh: { profile: { bundles: ["dsh-auto-compaction", "dsh-preset-pack"] } } }, null, 2);
  const bundles = JSON.parse(ensureBundleLayer(text).text).dsh.profile.bundles;
  assert.deepEqual(bundles, ["dsh-preset-pack", "dsh-auto-compaction"]);
});

test("an entry already last changes nothing", () => {
  const text = JSON.stringify({ dsh: { profile: { bundles: ["dsh-preset-pack", "dsh-auto-compaction"] } } }, null, 2);
  const result = ensureBundleLayer(text);
  assert.equal(result.changed, false);
  assert.equal(result.text, text);
});

test("a manifest without the array is left alone with a reason", () => {
  const result = ensureBundleLayer('{"name":"web"}\n');
  assert.equal(result.changed, false);
  assert.match(result.reason, /no dsh\.profile\.bundles/);
});

/* Every test above pins DSH_PROFILE_MANIFEST, so the fallback path shipped
 * untested and 0.2.4 crashed its first activation with `path is not defined`.
 * This case must stay free of env overrides. */
test("the manifest path resolves without env overrides", () => {
  const savedManifest = process.env.DSH_PROFILE_MANIFEST;
  const savedAppData = process.env.APP_DATA;
  delete process.env.DSH_PROFILE_MANIFEST;
  delete process.env.APP_DATA;
  try {
    assert.match(profileManifest(), /dsh-desktop[\\/]harness[\\/]profiles[\\/]web[\\/]package\.json$/);
  } finally {
    process.env.DSH_PROFILE_MANIFEST = savedManifest;
    if (savedAppData === undefined) delete process.env.APP_DATA;
    else process.env.APP_DATA = savedAppData;
  }
});

test("mounting keeps the bundle entry last without touching other fields", async () => {
  writeFileSync(MANIFEST, MANIFEST_TEXT, "utf8");
  writeFileSync(PATCH, SHIPPED, "utf8");
  await mountTakeover(stubCtx());
  const before = JSON.parse(MANIFEST_TEXT);
  const after = JSON.parse(readFileSync(MANIFEST, "utf8"));
  assert.deepEqual(after.dsh.profile.bundles.slice(0, -1), before.dsh.profile.bundles, "existing bundle order changed");
  assert.equal(after.dsh.profile.bundles.at(-1), "dsh-auto-compaction");
});

test("readRowMaxTokens reads the cap from the shipped block only", async () => {
  const { readRowMaxTokens } = await import("../lib/takeover-mount.js");
  const { BLOCK_MARKERS } = await import("../../dsh-auto-compaction-engine/lib/takeover-rows.js");
  writeFileSync(PATCH, SHIPPED + [
    BLOCK_MARKERS.BEGIN,
    "- id: preset-standard",
    "  config:",
    "    plugins:",
    "      - id: compaction-basic",
    "        name: dsh-auto-compaction-engine",
    "        config: { thresholdRatio: 0.9, maxTokens: 12288 }",
    BLOCK_MARKERS.END,
    "",
  ].join("\n"), "utf8");
  assert.equal(await readRowMaxTokens(), 12288);
  writeFileSync(PATCH, SHIPPED, "utf8");
  assert.equal(await readRowMaxTokens(), undefined);
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
