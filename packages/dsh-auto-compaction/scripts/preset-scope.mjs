/**
 * preset-scope.mjs — switch an editable DSH preset between the handoff plugin and
 * DSH's native compaction, reversibly.
 *
 * Two layers must agree for "native off" to be real:
 *   1. the preset's marker-delimited compaction slot (the row that supplies
 *      `ctx.compaction` inside the preset group), and
 *   2. the profile-level root `compaction-basic` node (DSH's default engine,
 *      which also listens on `agent/pre-step` and can compact before the
 *      preset's isolated plugin is consulted).
 *
 * Layer 1 is replaced wholesale between row-plugin.yml and row-native.yml.
 * Layer 2 is guarded by a marker comment that sets `auto: false` while the
 * plugin is enabled and is removed on disable, restoring the stock default.
 *
 * Without --preset/--all-local, `enable` reads the plugin settings sidecar:
 * `scope: "preset"` switches exactly the listed preset ids to the plugin and
 * resets every other editable preset to native; `scope: "global"` switches all.
 * `disable` restores native everywhere. The root guard is on only while at
 * least one preset uses the plugin.
 *
 * Usage:
 *   node scripts/preset-scope.mjs status  [--preset <cordis.patch.yml>] [--profile-patch <cordis.patch.yml>] [--all-local] [--skip-profile]
 *   node scripts/preset-scope.mjs enable  [--preset <cordis.patch.yml>] [--profile-patch <cordis.patch.yml>] [--all-local] [--skip-profile]
 *   node scripts/preset-scope.mjs disable [--preset <cordis.patch.yml>] [--profile-patch <cordis.patch.yml>] [--all-local] [--skip-profile]
 * Restart DSH afterwards.
 */
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DATA = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
const DEFAULT_PROFILE_PATCH = process.env.DSH_PROFILE_PATCH
  ?? path.join(APP_DATA, "dsh-desktop", "harness", "profiles", "web", "cordis.patch.yml");
const DEFAULT_SETTINGS = path.join(homedir(), ".dsh-handoff-compaction", "settings.json");
const LOCAL_PKGS = process.env.DSH_LOCAL_PKGS ?? path.join(homedir(), ".dsh-local-pkgs");
const SETTINGS_FILE = process.env.DSH_HANDOFF_SETTINGS_FILE ?? DEFAULT_SETTINGS;
const SLOT_BEGIN = "# >>> handoff:slot:begin";
const SLOT_END = "# <<< handoff:slot:end";
const GUARD_BEGIN = "# >>> handoff:native-guard:begin";
const GUARD_END = "# <<< handoff:native-guard:end";
const ROW_INDENT = 14;

const argv = process.argv.slice(2);
const mode = (argv.find((a) => !a.startsWith("--")) ?? "status").toLowerCase();
const presetArg = argv.indexOf("--preset");
const profileArg = argv.indexOf("--profile-patch");
const allLocal = argv.includes("--all-local");
const skipProfile = argv.includes("--skip-profile");
const profilePatch = profileArg >= 0
  ? argv[profileArg + 1]
  : (process.env.DSH_PROFILE_PATCH ?? DEFAULT_PROFILE_PATCH);

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function presetIdOf(text) {
  const yaml = loadYaml();
  if (yaml === undefined) return undefined;
  try {
    const doc = yaml.load(text, { schema: yamlSchema(yaml) });
    return doc?.[0]?.insert?.[0]?.config?.id;
  } catch {
    return undefined;
  }
}

/** Every editable local preset that carries the handoff slot markers. */
function discoverPresetFiles() {
  if (!fs.existsSync(LOCAL_PKGS)) return [];
  return fs.readdirSync(LOCAL_PKGS)
    .map((name) => path.join(LOCAL_PKGS, name, "cordis.patch.yml"))
    .filter((file) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(SLOT_BEGIN));
}

function defaultPresetFile() {
  return discoverPresetFiles()[0]
    ?? path.join(LOCAL_PKGS, "dsh-preset-lightweight-local", "cordis.patch.yml");
}

/**
 * Rows to apply. `enable: true` means the plugin takes this preset; `false`
 * restores its own native row. Non-selected presets are reset to native so a
 * previous switch cannot leak into a preset the user did not select.
 */
function selection(action) {
  if (presetArg >= 0) {
    return [{ file: argv[presetArg + 1], enable: action === "enable" }];
  }
  const files = discoverPresetFiles();
  if (action === "disable") return files.map((file) => ({ file, enable: false }));
  if (allLocal) return files.map((file) => ({ file, enable: true }));
  const settings = readSettings();
  if (settings?.scope === "global") return files.map((file) => ({ file, enable: true }));
  if (settings?.scope === "preset") {
    const selected = new Set(Array.isArray(settings.presets) ? settings.presets : []);
    const planned = files.map((file) => {
      const id = presetIdOf(fs.readFileSync(file, "utf8"));
      return { file, id, enable: id !== undefined && selected.has(id) };
    });
    for (const id of selected) {
      if (!planned.some((entry) => entry.id === id)) {
        console.error(`warn: selected preset "${id}" has no editable handoff slot; left native`);
      }
    }
    return planned;
  }
  return [{ file: defaultPresetFile(), enable: action === "enable" }];
}

function statusPlan() {
  if (presetArg >= 0) return [{ file: argv[presetArg + 1] }];
  const settings = readSettings();
  const files = discoverPresetFiles();
  if (settings?.scope === "global") return files.map((file) => ({ file, selected: true }));
  if (settings?.scope === "preset") {
    const selected = new Set(Array.isArray(settings.presets) ? settings.presets : []);
    return files.map((file) => ({ file, selected: selected.has(presetIdOf(fs.readFileSync(file, "utf8"))) }));
  }
  return [{ file: defaultPresetFile() }];
}

function pluginRow(presetId) {
  const text = fs.readFileSync(path.join(HERE, "row-plugin.yml"), "utf8");
  const trace = path.join(homedir(), ".dsh-handoff-compaction", "trace.log").replace(/\\/g, "/");
  const withId = (presetId === undefined
    ? text
    : text.replace(/^(\s*presetId:\s*).*$/m, `$1${presetId}`))
    .replace(/^(\s*traceFile:\s*).*$/m, `$1"${trace}"`);
  return indentRow(withId);
}

function indentRow(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
    .map((line) => (line.trim() === "" ? "" : " ".repeat(ROW_INDENT) + line));
}

function loadYaml() {
  try {
    return createRequire(import.meta.url)("js-yaml");
  } catch {
    // The engine's own dependency is preferred; a profile-installed copy is the fallback.
  }
  try {
    const profileRoot = path.join(APP_DATA, "dsh-desktop", "harness", "profiles", "web");
    return createRequire(path.join(profileRoot, "package.json"))("js-yaml");
  } catch {
    return undefined;
  }
}

function yamlSchema(yaml) {
  const jsTag = new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (d) => d });
  return yaml.DEFAULT_SCHEMA.extend([jsTag]);
}

function validatePreset(text) {
  const yaml = loadYaml();
  if (yaml === undefined) return "skipped (js-yaml unavailable)";
  const doc = yaml.load(text, { schema: yamlSchema(yaml) });
  const group = doc[0].insert[0].config.plugins.find((entry) => entry.id === "compaction");
  const rows = group.config.filter((entry) => entry.id === "compaction-basic");
  if (rows.length !== 1) throw new Error(`expected exactly one compaction-basic row, found ${rows.length}`);
  return `ok -> ${rows[0].name}`;
}

function validateProfile(text) {
  const yaml = loadYaml();
  if (yaml === undefined) return "skipped (js-yaml unavailable)";
  const doc = yaml.load(text, { schema: yamlSchema(yaml) });
  if (!Array.isArray(doc)) throw new Error("profile patch: expected a top-level array");
  const row = doc.find((entry) => entry?.id === "compaction-basic" && entry?.name === "@deepseek-ai/dsh-compaction-basic");
  if (row === undefined) throw new Error("profile patch: native compaction-basic entry not found");
  return `ok -> ${row.name}, auto=${row.config?.auto === undefined ? "default" : String(row.config.auto)}`;
}

function slotBounds(lines) {
  const begin = lines.findIndex((line) => line.includes(SLOT_BEGIN));
  const end = lines.findIndex((line) => line.includes(SLOT_END));
  if (begin < 0 || end < 0 || end <= begin) return undefined;
  return { begin, end };
}

function activeName(lines) {
  const bounds = slotBounds(lines);
  if (bounds === undefined) return "no slot";
  for (let i = bounds.begin + 1; i < bounds.end; i += 1) {
    const match = lines[i].match(/^\s*name:\s*"([^"]+)"/);
    if (match) return match[1];
  }
  return "unknown";
}

/** Locate the top-level native compaction-basic entry that carries a name + config. */
function nativeBounds(lines) {
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^-\s+id:\s*compaction-basic\s*$/.test(lines[i])) starts.push(i);
  }
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length;
    const block = lines.slice(start, end).join("\n");
    if (/name:\s*["']?@deepseek-ai\/dsh-compaction-basic["']?/.test(block) && /^\s{2}config:\s*$/m.test(block)) {
      return { start, end };
    }
  }
  return undefined;
}

function configLine(lines, bounds) {
  for (let i = bounds.start + 1; i < bounds.end; i += 1) {
    if (/^\s{2}config:\s*$/.test(lines[i])) return i;
  }
  return -1;
}

function guardBounds(lines, bounds) {
  let begin = -1;
  let end = -1;
  for (let i = bounds.start; i < bounds.end; i += 1) {
    if (lines[i].includes(GUARD_BEGIN)) begin = i;
    if (lines[i].includes(GUARD_END)) end = i;
  }
  return begin >= 0 && end > begin ? { begin, end } : undefined;
}

function autoLine(lines, configIdx, bounds) {
  for (let i = configIdx + 1; i < bounds.end; i += 1) {
    if (/^- /.test(lines[i])) break;
    if (/^\s{2}[A-Za-z]/.test(lines[i])) break;
    if (/^\s{4}auto:\s*/.test(lines[i])) return i;
  }
  return -1;
}

function guardState(lines, bounds) {
  const cfg = configLine(lines, bounds);
  if (cfg < 0) return "no config";
  const guard = guardBounds(lines, bounds);
  if (guard !== undefined) {
    const hasFalse = lines.slice(guard.begin + 1, guard.end).some((line) => /^\s*auto:\s*false\s*$/.test(line));
    return hasFalse ? "auto:false (plugin guard)" : "guarded (auto missing!)";
  }
  const auto = autoLine(lines, cfg, bounds);
  return auto < 0 ? "absent (default true)" : `auto:${lines[auto].split(":")[1].trim()}`;
}

function editProfilePatch(file, action) {
  if (!fs.existsSync(file)) {
    console.error(`skip (missing profile patch): ${file}`);
    return;
  }
  const original = fs.readFileSync(file, "utf8");
  const lines = original.split(/\r?\n/);
  const bounds = nativeBounds(lines);
  if (bounds === undefined) {
    console.error(`skip (no native compaction-basic entry): ${file}`);
    return;
  }
  const cfg = configLine(lines, bounds);
  if (cfg < 0) {
    console.error(`skip (native entry has no config block): ${file}`);
    return;
  }
  const guard = guardBounds(lines, bounds);
  let nextLines = [...lines];

  if (action === "enable") {
    if (guard !== undefined) {
      const hasAuto = nextLines.slice(guard.begin + 1, guard.end).some((line) => /^\s*auto:\s*/.test(line));
      nextLines = nextLines.map((line, index) => (index > guard.begin && index < guard.end && /^\s*auto:\s*/.test(line)
        ? line.replace(/^(\s*)auto:\s*.*$/, "$1auto: false")
        : line));
      if (!hasAuto) nextLines.splice(guard.begin + 1, 0, "    auto: false");
    } else {
      const auto = autoLine(nextLines, cfg, bounds);
      if (auto >= 0) {
        nextLines[auto] = nextLines[auto].replace(/^(\s*)auto:\s*.*$/, "$1auto: false");
      } else {
        nextLines.splice(cfg + 1, 0,
          "    " + GUARD_BEGIN,
          "    auto: false",
          "    " + GUARD_END);
      }
    }
  } else {
    if (guard !== undefined) {
      nextLines.splice(guard.begin, guard.end - guard.begin + 1);
    } else {
      const auto = autoLine(nextLines, cfg, bounds);
      if (auto >= 0) nextLines[auto] = nextLines[auto].replace(/^(\s*)auto:\s*.*$/, "$1auto: true");
    }
  }

  const next = nextLines.join("\n");
  if (next === original) {
    console.log(`${file}\n  -> native ${action === "enable" ? "auto:false" : "auto:true"}  [no change]`);
    return;
  }
  const verdict = validateProfile(next);
  if (!verdict.startsWith("ok")) {
    console.error(`aborted (validation): ${verdict}`);
    process.exitCode = 1;
    return;
  }
  fs.copyFileSync(file, `${file}.bak-scope`);
  fs.writeFileSync(file, next);
  console.log(`${file}\n  -> native ${action === "enable" ? "auto:false" : "auto:true"}  [${verdict}]`);
}

function profileStatus() {
  if (skipProfile) return;
  if (!fs.existsSync(profilePatch)) {
    console.log(`${profilePatch}\n  missing`);
    return;
  }
  const original = fs.readFileSync(profilePatch, "utf8");
  const lines = original.split(/\r?\n/);
  const bounds = nativeBounds(lines);
  if (bounds === undefined) {
    console.log(`${profilePatch}\n  native compaction-basic entry not found`);
    return;
  }
  console.log(`${profilePatch}\n  原生守卫: ${guardState(lines, bounds)}\n  YAML: ${validateProfile(original)}`);
}

if (mode !== "status" && mode !== "enable" && mode !== "disable") {
  console.error("usage: preset-scope.mjs <status|enable|disable> [--preset <file>] [--profile-patch <file>] [--all-local] [--skip-profile]");
  process.exit(2);
}

const plan = mode === "status" ? statusPlan() : selection(mode);
for (const entry of plan) {
  const file = entry.file;
  if (!fs.existsSync(file)) {
    console.error(`skip (missing): ${file}`);
    continue;
  }
  const original = fs.readFileSync(file, "utf8");
  const lines = original.split(/\r?\n/);
  const bounds = slotBounds(lines);
  if (bounds === undefined) {
    console.error(`skip (no slot markers): ${file}`);
    continue;
  }

  if (mode === "status") {
    const current = activeName(lines);
    const kind = current === "dsh-handoff-compaction" || current === "dsh-auto-compaction" ? "插件接管（原生关闭）"
      : current === "@deepseek-ai/dsh-compaction-basic" ? "DSH 原生压缩"
      : "未知";
    const selected = entry.selected === undefined ? "" : `\n  勾选: ${entry.selected ? "是（插件）" : "否（原生）"}`;
    console.log(`${file}\n  当前: ${current}\n  含义: ${kind}${selected}\n  YAML: ${validatePreset(original)}`);
    continue;
  }

  const id = presetIdOf(original);
  if (entry.enable && id === undefined) {
    console.error(`skip (cannot read preset id): ${file}`);
    continue;
  }
  const row = entry.enable
    ? pluginRow(id)
    : indentRow(fs.readFileSync(path.join(HERE, "row-native.yml"), "utf8"));
  const next = [
    ...lines.slice(0, bounds.begin + 1),
    ...row,
    ...lines.slice(bounds.end),
  ].join("\n");

  if (next === original) {
    console.log(`${file}\n  -> ${activeName(lines)}  [no change]`);
    continue;
  }

  const verdict = validatePreset(next);
  if (!verdict.startsWith("ok")) {
    console.error(`aborted (validation): ${verdict}`);
    process.exit(1);
  }
  fs.copyFileSync(file, `${file}.bak-scope`);
  fs.writeFileSync(file, next);
  console.log(`${file}\n  -> ${activeName(next.split(/\r?\n/))}  [${verdict}]`);
}

if (mode === "status") {
  profileStatus();
} else {
  // The root guard only disables DSH's profile-level duplicate engine. Each
  // preset's own compaction row stays native unless the plan selected it, so
  // this is not "native off for every preset".
  const anyPlugin = plan.some((entry) => entry.enable);
  if (!skipProfile) editProfilePatch(profilePatch, mode === "enable" && anyPlugin ? "enable" : "disable");
  if (mode === "enable" && !anyPlugin) console.error("warn: no selected preset uses the plugin; root native fallback left on");
  console.log("重启 DSH 后生效。");
}
