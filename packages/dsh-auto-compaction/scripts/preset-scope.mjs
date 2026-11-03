/**
 * preset-scope.mjs — switch an editable DSH preset between the handoff plugin and
 * DSH's native compaction, reversibly.
 *
 * A preset context can only have ONE provider of `ctx.compaction`, so "native off"
 * means "which row is active". The script replaces a marker-delimited slot in the
 * preset's cordis.patch.yml with either row file, validates the resulting YAML, and
 * keeps a .bak-scope copy. Disabling restores the stock row (`auto: true`), so a
 * preset goes back to DSH native compaction the moment the plugin is switched off.
 *
 * Usage:
 *   node scripts/preset-scope.mjs status  [--preset <cordis.patch.yml>] [--all-local]
 *   node scripts/preset-scope.mjs enable  [--preset <cordis.patch.yml>] [--all-local]
 *   node scripts/preset-scope.mjs disable [--preset <cordis.patch.yml>] [--all-local]
 * Restart DSH afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRESET = "C:/Users/Me/.dsh-local-pkgs/dsh-preset-lightweight-local/cordis.patch.yml";
const LOCAL_PKGS = "C:/Users/Me/.dsh-local-pkgs";
const SLOT_BEGIN = "# >>> handoff:slot:begin";
const SLOT_END = "# <<< handoff:slot:end";
const ROW_INDENT = 14;

const argv = process.argv.slice(2);
const mode = (argv.find((a) => !a.startsWith("--")) ?? "status").toLowerCase();
const presetArg = argv.indexOf("--preset");
const allLocal = argv.includes("--all-local");

function targets() {
  if (allLocal) {
    return fs.readdirSync(LOCAL_PKGS)
      .map((name) => path.join(LOCAL_PKGS, name, "cordis.patch.yml"))
      .filter((file) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(SLOT_BEGIN));
  }
  return [presetArg >= 0 ? argv[presetArg + 1] : DEFAULT_PRESET];
}

function indentRow(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
    .map((line) => (line.trim() === "" ? "" : " ".repeat(ROW_INDENT) + line));
}

function loadYaml() {
  try {
    return createRequire("C:/Users/Me/AppData/Roaming/dsh-desktop/harness/profiles/web/")("js-yaml");
  } catch {
    return undefined;
  }
}

function validate(text) {
  const yaml = loadYaml();
  if (yaml === undefined) return "skipped (js-yaml unavailable)";
  const jsTag = new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (d) => d });
  const doc = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([jsTag]) });
  const group = doc[0].insert[0].config.plugins.find((entry) => entry.id === "compaction");
  const rows = group.config.filter((entry) => entry.id === "compaction-basic");
  if (rows.length !== 1) throw new Error(`expected exactly one compaction-basic row, found ${rows.length}`);
  return `ok -> ${rows[0].name}`;
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

for (const file of targets()) {
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
    const kind = current === "dsh-handoff-compaction" ? "插件接管（原生关闭）"
      : current === "@deepseek-ai/dsh-compaction-basic" ? "DSH 原生压缩"
      : "未知";
    console.log(`${file}\n  当前: ${current}\n  含义: ${kind}\n  YAML: ${validate(original)}`);
    continue;
  }

  if (mode !== "enable" && mode !== "disable") {
    console.error("usage: preset-scope.mjs <status|enable|disable> [--preset <file>] [--all-local]");
    process.exit(2);
  }

  const rowFile = path.join(HERE, mode === "enable" ? "row-plugin.yml" : "row-native.yml");
  const row = indentRow(fs.readFileSync(rowFile, "utf8"));
  const next = [
    ...lines.slice(0, bounds.begin + 1),
    ...row,
    ...lines.slice(bounds.end),
  ].join("\n");

  const verdict = validate(next);
  if (!verdict.startsWith("ok")) {
    console.error(`aborted (validation): ${verdict}`);
    process.exit(1);
  }
  fs.copyFileSync(file, `${file}.bak-scope`);
  fs.writeFileSync(file, next);
  console.log(`${file}\n  -> ${activeName(next.split(/\r?\n/))}  [${verdict}]`);
}

if (mode === "enable" || mode === "disable") console.log("重启 DSH 后生效。");
