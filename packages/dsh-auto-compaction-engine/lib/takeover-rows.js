/**
 * Takeover rows for the presets DSH currently declares.
 *
 * A preset runs in its own realm, so handing compaction to this plugin can only
 * be expressed by replacing the preset's whole row: the patch language matches
 * rows by id and assigns `config` wholesale, and it cannot reach a row nested
 * inside an agent preset's plugin list. That makes generated rows the only
 * correct way to take over, and it means every other plugin of that preset has
 * to be carried along — which is why the input is the live definition read from
 * `agentPresets`, never a copy baked into this package. A baked copy would
 * silently delete tools DSH adds in a later release.
 *
 * The rows go into this plugin's own bundle patch, so uninstalling takes them
 * away with the package: the user's preset files are never touched, and native
 * compaction comes back on its own.
 */

import { createRequire } from "node:module";
import path from "node:path";

/* js-yaml is this package's own dependency; the development workspace installs
 * nothing, so fall back to the copy DSH keeps in the profile, same order as
 * scripts/preset-scope.mjs. */
function loadYaml() {
  const here = createRequire(import.meta.url);
  try {
    return here("js-yaml");
  } catch { /* fall through */ }
  const appData = process.env.APP_DATA
    ?? path.join(process.env.SystemDrive ?? "C:", "Users", process.env.USERNAME ?? process.env.USER ?? "", "AppData", "Roaming");
  return createRequire(path.join(appData, "dsh-desktop", "harness", "profiles", "web", "package.json"))("js-yaml");
}
const yaml = loadYaml();

const BEGIN = "# >>> handoff:takeover:begin  （dsh-auto-compaction 按当前预设组合生成，勿手改本块）";
const END = "# <<< handoff:takeover:end";

const COMPACTION_GROUP = "compaction";
const NATIVE_ROW = "compaction-basic";

/**
 * A `!!js` scalar carried through untouched.
 *
 * Presets use these for platform-conditional rows (`disabled: !!js
 * process.platform === 'win32'`). Replacing a preset's config means re-emitting
 * every one of its values, and writing such an expression as a plain string
 * would silently change the preset: the loader only evaluates tagged scalars, so
 * a string in `disabled` is just a truthy value. These rows must therefore
 * survive as the tag they were written as.
 */
export class JsExpression {
  constructor(text) {
    this.text = String(text ?? "");
  }
}

/**
 * Path of the first value that cannot be re-emitted, or "" when all can.
 *
 * A function or symbol reaching us means the composition parsed `!!js` into
 * something this writer cannot turn back into a tag; inventing a row from it
 * would alter the preset, so the caller leaves that preset alone instead.
 */
export function findUnsupported(value, trail = "") {
  if (value instanceof JsExpression) return "";
  if (typeof value === "function" || typeof value === "symbol") return trail || "根值";
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnsupported(value[index], `${trail}[${index}]`);
      if (found !== "") return found;
    }
    return "";
  }
  if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      const found = findUnsupported(inner, trail ? `${trail}.${key}` : key);
      if (found !== "") return found;
    }
  }
  return "";
}

/** Defaults this plugin needs; values already on the preset's own row win. */
const ENGINE_DEFAULTS = {
  thresholdRatio: 0.9,
  headroomTokens: 10000,
  maxTokens: 12288,
  idleDelayMs: 1500,
};

/**
 * Parse the plugin list `agentPresets.readDocument()` publishes.
 *
 * That method returns the composition **as a YAML string** ("read one
 * declaration's child plugin list as YAML"), not as data, so the takeover rows
 * have to parse it back with the same `!!js` type they write with. An array is
 * accepted too, in case a future host hands back the value directly.
 */
export function parsePlugins(content) {
  if (Array.isArray(content)) return { plugins: content };
  if (typeof content !== "string" || content.trim().length === 0) {
    return { plugins: undefined, reason: "预设没有给出 plugins" };
  }
  try {
    const parsed = yaml.load(content, { schema: jsSchema() });
    if (!Array.isArray(parsed)) return { plugins: undefined, reason: "plugins 不是列表" };
    return { plugins: parsed };
  } catch (error) {
    return { plugins: undefined, reason: `plugins 解析失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * The row that replaces a preset's stock compaction provider.
 *
 * `presetId` is what lets one mounted engine serve several presets while the
 * user's scope selection decides which ones it actually takes over.
 *
 * `inherit` is the config already sitting on the preset's stock row: a user who
 * tuned `thresholdRatio` or `headroomTokens` there keeps that tuning, and this
 * plugin only fills in what is missing.
 */
export function engineRow(presetId, options = {}) {
  return {
    id: NATIVE_ROW,
    name: options.engineName ?? "dsh-auto-compaction-engine",
    config: { ...ENGINE_DEFAULTS, ...(options.inherit ?? {}), ...(options.config ?? {}), presetId },
  };
}

/**
 * The compaction provider a preset's live definition actually names.
 *
 * This is what tells "the rows were written" apart from "the rows are in
 * effect": the definition DSH registers comes from the composition, so if the
 * takeover row was applied and resolved, the provider here is this plugin's
 * engine rather than the stock one.
 */
export function compactionProvider(config) {
  const group = compactionGroup(config?.plugins);
  if (group === undefined) return undefined;
  const row = group.config.find((entry) => entry?.id === NATIVE_ROW);
  if (row === undefined) return undefined;
  return { name: typeof row.name === "string" ? row.name : "", disabled: row.disabled === true };
}

/** The compaction group inside a preset's plugin list, or undefined. */
function compactionGroup(plugins) {
  if (!Array.isArray(plugins)) return undefined;
  return plugins.find(
    (entry) => entry !== null && typeof entry === "object"
      && entry.id === COMPACTION_GROUP && entry.group === true && Array.isArray(entry.config),
  );
}

/**
 * One preset's replacement row, or null when that preset cannot be taken over.
 *
 * @param preset the live row as DSH declares it: { id, name?, config: { plugins } }
 */
export function takeoverRow(preset, options = {}) {
  const id = typeof preset?.id === "string" && preset.id.length > 0 ? preset.id : undefined;
  if (id === undefined) return null;
  const plugins = Array.isArray(preset?.config?.plugins) ? preset.config.plugins : undefined;
  if (plugins === undefined) return null;
  // Replacing a preset's config re-emits everything in it; a value this writer
  // cannot express faithfully is a reason to leave the preset alone.
  if (findUnsupported(preset.config) !== "") return null;

  const group = compactionGroup(plugins);
  if (group === undefined) return null;
  const index = group.config.findIndex((entry) => entry?.id === NATIVE_ROW);
  if (index < 0) return null;
  const current = group.config[index];
  // A row the user switched off is their decision; taking it over would quietly
  // turn compaction back on, so leave that preset alone.
  if (current.disabled === true) return null;

  const nextGroupRows = group.config.slice();
  nextGroupRows[index] = engineRow(id, { ...options, inherit: current.config });

  const nextPlugins = plugins.map((entry) => (entry === group ? { ...group, config: nextGroupRows } : entry));
  const row = {
    id: `preset-${id}`,
    config: { ...preset.config, plugins: nextPlugins },
  };
  // `name` is an assertion, not a value to write: DSH skips the whole patch when
  // it disagrees with the target, so carry it only when the composition has one.
  if (typeof preset.name === "string" && preset.name.length > 0) row.name = preset.name;
  return row;
}

/** Rows for every takeable preset, in the order given. */
export function takeoverRows(presets, options = {}) {
  const rows = [];
  for (const preset of presets ?? []) {
    const row = takeoverRow(preset, options);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** The managed block, empty markers included, for the given rows. */
export function renderBlock(rows) {
  const lines = [BEGIN];
  if (rows.length > 0) lines.push(stringifyRows(rows));
  lines.push(END);
  return lines.join("\n");
}

/**
 * Put the block into a patch file, leaving hand-written content untouched.
 * A file without the block yet gets it appended.
 */
export function mergeBlock(text, block) {
  const source = typeof text === "string" ? text : "";
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (begin < 0 || end < 0 || end < begin) {
    const trimmed = source.replace(/\s+$/, "");
    return trimmed.length === 0 ? block + "\n" : `${trimmed}\n${block}\n`;
  }
  return source.slice(0, begin) + block + source.slice(end + END.length);
}

/** True when the file does not already carry this block. */
export function needsRewrite(text, block) {
  return mergeBlock(text, block) !== text;
}

/* A dedicated writer is tempting but wrong here: presets carry long multi-line
 * prompt strings, and hand-rolled quoting folds their line breaks differently
 * from the source, which would silently rewrite the agent's instructions.
 * js-yaml with a registered `!!js` type round-trips both, and the options pin
 * the layout so the block stays byte-identical between boots. */
function stringifyRows(rows) {
  return yaml.dump(rows, {
    schema: jsSchema(),
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
    skipInvalid: false,
  }).replace(/\n+$/, "");
}

function jsSchema() {
  return yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type("tag:yaml.org,2002:js", {
      kind: "scalar",
      construct: (data) => new JsExpression(data),
      instanceOf: JsExpression,
      represent: (value) => value.text,
    }),
  ]);
}

export const BLOCK_MARKERS = { BEGIN, END };
