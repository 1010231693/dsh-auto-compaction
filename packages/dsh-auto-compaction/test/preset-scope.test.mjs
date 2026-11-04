/**
 * preset-scope guard tests: the enable switch must turn off BOTH the preset slot
 * and the profile-level native engine, and disable must restore both. The
 * settings-driven selection must touch only the presets listed in settings.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "scripts", "preset-scope.mjs");

function presetFixture(id) {
  return `- insert:
    - id: preset-${id}
      name: "@deepseek-ai/dsh-agent-preset"
      config:
        id: ${id}
        plugins:
          - id: compaction
            name: cordis:group
            group: true
            config:
              # >>> handoff:slot:begin
              - id: compaction-basic
                name: "@deepseek-ai/dsh-compaction-basic"
                config:
                  auto: true
              # <<< handoff:slot:end
`;
}

const PROFILE_FIXTURE = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers: {}
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  config:
    thresholdRatio: 0.9
    headroomTokens: 20000
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config: {}
- id: compaction-basic
  disabled: false
`;

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function run(mode, dir, { preset, env } = {}) {
  const args = [SCRIPT, mode, "--profile-patch", path.join(dir, "profile.yml")];
  if (preset !== undefined) args.push("--preset", preset);
  return execFileSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, ...(env ?? {}) },
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "handoff-scope-"));
}

test("enable swaps the slot and guards the profile native engine", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "preset.yml"), presetFixture("preset-fixture"));
    fs.writeFileSync(path.join(dir, "profile.yml"), PROFILE_FIXTURE);
    run("enable", dir, { preset: path.join(dir, "preset.yml") });
    const preset = fs.readFileSync(path.join(dir, "preset.yml"), "utf8");
    const profile = fs.readFileSync(path.join(dir, "profile.yml"), "utf8");
    if (!preset.includes('name: "dsh-auto-compaction"')) throw new Error("slot was not switched to the plugin");
    if (!preset.includes("presetId: preset-fixture")) throw new Error("plugin row did not inherit the preset id");
    if (!profile.includes("handoff:native-guard:begin")) throw new Error("native guard marker missing");
    if (!/auto:\s*false/.test(profile)) throw new Error("native auto was not disabled");
    if (!profile.includes("thresholdRatio: 0.9")) throw new Error("unrelated profile config was lost");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("disable restores the native slot and removes the guard", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "preset.yml"), presetFixture("preset-fixture"));
    fs.writeFileSync(path.join(dir, "profile.yml"), PROFILE_FIXTURE);
    run("enable", dir, { preset: path.join(dir, "preset.yml") });
    run("disable", dir, { preset: path.join(dir, "preset.yml") });
    const preset = fs.readFileSync(path.join(dir, "preset.yml"), "utf8");
    const profile = fs.readFileSync(path.join(dir, "profile.yml"), "utf8");
    if (!preset.includes('name: "@deepseek-ai/dsh-compaction-basic"')) throw new Error("slot was not restored");
    if (profile.includes("handoff:native-guard")) throw new Error("native guard left behind");
    if (/auto:\s*false/.test(profile)) throw new Error("native auto stayed disabled");
    if (!profile.includes("thresholdRatio: 0.9")) throw new Error("unrelated profile config was lost");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("enable is idempotent", () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "preset.yml"), presetFixture("preset-fixture"));
    fs.writeFileSync(path.join(dir, "profile.yml"), PROFILE_FIXTURE);
    run("enable", dir, { preset: path.join(dir, "preset.yml") });
    const once = fs.readFileSync(path.join(dir, "profile.yml"), "utf8");
    run("enable", dir, { preset: path.join(dir, "preset.yml") });
    const twice = fs.readFileSync(path.join(dir, "profile.yml"), "utf8");
    if (once !== twice) throw new Error("second enable changed the file");
    if ((twice.match(/handoff:native-guard:begin/g) ?? []).length !== 1) throw new Error("duplicate guard markers");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("settings preset list switches only the selected presets", () => {
  const dir = tempDir();
  try {
    const presets = path.join(dir, "presets");
    fs.mkdirSync(path.join(presets, "local"), { recursive: true });
    fs.mkdirSync(path.join(presets, "standard"), { recursive: true });
    const localFile = path.join(presets, "local", "cordis.patch.yml");
    const standardFile = path.join(presets, "standard", "cordis.patch.yml");
    fs.writeFileSync(localFile, presetFixture("lightweight-local"));
    fs.writeFileSync(standardFile, presetFixture("lightweight-standard"));
    fs.writeFileSync(path.join(dir, "profile.yml"), PROFILE_FIXTURE);
    const settingsFile = path.join(dir, "settings.json");
    const env = { DSH_LOCAL_PKGS: presets, DSH_HANDOFF_SETTINGS_FILE: settingsFile };

    fs.writeFileSync(settingsFile, JSON.stringify({ scope: "preset", presets: ["lightweight-local"] }));
    run("enable", dir, { env });
    let local = fs.readFileSync(localFile, "utf8");
    let standard = fs.readFileSync(standardFile, "utf8");
    if (!local.includes('name: "dsh-auto-compaction"')) throw new Error("selected preset did not switch to the plugin");
    if (!local.includes("presetId: lightweight-local")) throw new Error("selected preset id not applied");
    if (!standard.includes('name: "@deepseek-ai/dsh-compaction-basic"')) throw new Error("unselected preset did not stay native");
    if (!standard.includes("auto: true")) throw new Error("unselected preset lost native auto");
    if (!/auto:\s*false/.test(fs.readFileSync(path.join(dir, "profile.yml"), "utf8"))) throw new Error("root guard missing");

    fs.writeFileSync(settingsFile, JSON.stringify({ scope: "preset", presets: ["lightweight-standard"] }));
    run("enable", dir, { env });
    local = fs.readFileSync(localFile, "utf8");
    standard = fs.readFileSync(standardFile, "utf8");
    if (!standard.includes('name: "dsh-auto-compaction"')) throw new Error("newly selected preset did not switch");
    if (!standard.includes("presetId: lightweight-standard")) throw new Error("newly selected preset id not applied");
    if (!local.includes('name: "@deepseek-ai/dsh-compaction-basic"')) throw new Error("previously selected preset was not reset to native");

    fs.writeFileSync(settingsFile, JSON.stringify({ scope: "preset", presets: [] }));
    run("enable", dir, { env });
    local = fs.readFileSync(localFile, "utf8");
    standard = fs.readFileSync(standardFile, "utf8");
    if (!local.includes('name: "@deepseek-ai/dsh-compaction-basic"') || !standard.includes('name: "@deepseek-ai/dsh-compaction-basic"')) {
      throw new Error("an empty selection did not restore every preset to native");
    }
    if (fs.readFileSync(path.join(dir, "profile.yml"), "utf8").includes("handoff:native-guard")) {
      throw new Error("an empty selection left the root guard behind");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of cases) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
