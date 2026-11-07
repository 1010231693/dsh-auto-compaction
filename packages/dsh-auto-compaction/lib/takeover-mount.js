/**
 * Mount the takeover, in this package's own patch file.
 *
 * The rows that hand compaction over to this plugin live in the bundle patch
 * shipped inside the package, because that is the only place uninstalling
 * removes them automatically: DSH's uninstall neither clears nor refuses
 * config-replacement rows in a user's own patch, so writing them there would
 * leave a preset pointing at a package that no longer exists — a broken
 * compaction setup the user cannot see. Writing here costs nothing on removal.
 *
 * Rows are generated from the live preset definitions rather than baked in, so
 * a preset that gains a tool in a later DSH release keeps it. The generator
 * lives in the engine package and is loaded lazily: DSH's host module fallback
 * cannot resolve a linked package's subpath from here, and a top-level import
 * blocks startup.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const requireFromHere = createRequire(import.meta.url);

/** The patch file this package is mounted from. */
function patchFile() {
  const override = process.env.DSH_HANDOFF_TAKEOVER_FILE;
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  return join(dirname(requireFromHere.resolve("../package.json")), "cordis.patch.yml");
}

/**
 * Load the row generator without importing the engine package statically.
 * @returns the module, or undefined when it cannot be resolved.
 */
async function loadGenerator() {
  // Dynamic import rather than createRequire: the generator is ESM. Installed,
  // the engine sits beside this package in the same node_modules and publishes
  // ./lib/*; in development it is the monorepo sibling, since the workspace
  // installs nothing and everything runs through junctions.
  for (const attempt of [
    () => import("dsh-auto-compaction-engine/lib/takeover-rows.js"),
    () => import("../../dsh-auto-compaction-engine/lib/takeover-rows.js"),
  ]) {
    try {
      return await attempt();
    } catch { /* try the next location */ }
  }
  return undefined;
}

/** The profile manifest DSH composes its layers from. */
export function profileManifest() {
  const override = process.env.DSH_PROFILE_MANIFEST;
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  const appData = process.env.APP_DATA
    ?? join(process.env.SystemDrive ?? "C:", "Users", process.env.USERNAME ?? process.env.USER ?? "", "AppData", "Roaming");
  return join(appData, "dsh-desktop", "harness", "profiles", "web", "package.json");
}

/**
 * Keep this package's patch layer behind every preset declaration.
 *
 * Layer order is the order of `dsh.profile.bundles`, and a takeover row is an
 * update of a preset row that has to exist by the time our layer applies:
 * presets declared by a later layer would leave our row with nothing to point
 * at, silently. DSH's own presets come early, but a preset installed from the
 * market or written by the user can come after us, so the entry belongs last.
 *
 * The desktop market appends newly installed bundles to the end, so this is a
 * no-op for a fresh install; it matters when another plugin is installed after
 * us. Verified on this machine: without the entry 4 of 6 presets mounted, with
 * it at the end all 6 did.
 *
 * Text surgery rather than a JSON rewrite, because this file is the user's and
 * the market rewrites it too.
 */
export function ensureBundleLayer(text, name = "dsh-auto-compaction") {
  if (typeof text !== "string" || text.length === 0) return { text, changed: false, reason: "manifest unreadable" };
  const start = text.indexOf("\"bundles\"");
  const open = start < 0 ? -1 : text.indexOf("[", start);
  const close = open < 0 ? -1 : text.indexOf("]", open);
  if (close < 0) return { text, changed: false, reason: "no dsh.profile.bundles array" };
  const body = text.slice(open + 1, close);
  const entries = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (entries.length > 0 && entries[entries.length - 1] === name) return { text, changed: false, reason: "" };

  const kept = entries.filter((entry) => entry !== name);
  const rebuilt = kept.length === 0 ? `["${name}"]` : `[\n${kept.concat([name]).map((entry) => `      "${entry}"`).join(",\n")}\n    ]`;
  return { text: text.slice(0, open) + rebuilt + text.slice(close + 1), changed: true, reason: "" };
}

/** Apply the layer rule to the profile manifest, writing only on change. */
export function ensureBundleLayerFile() {
  const file = profileManifest();
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, file, reason: `manifest missing: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = ensureBundleLayer(text);
  if (!result.changed) return { ok: true, file, changed: false, reason: result.reason };
  try {
    JSON.parse(result.text);
  } catch (error) {
    return { ok: false, file, reason: `refusing to write invalid JSON: ${error.message}` };
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, result.text, "utf8");
  renameSync(tmp, file);
  return { ok: true, file, changed: true };
}

/**
 * Ask DSH which agent presets exist and what each one currently declares.
 *
 * `list()` publishes the display metadata ({id, name, description, order,
 * broken?}) and `readDocument()` the plugin list as a YAML string; a preset's
 * config is exactly `{id, name, description, order, plugins}`, so the two
 * together are the whole definition and nothing here is guessed.
 */
async function readPresets(ctx, generator) {
  let service;
  try {
    service = ctx.get?.("agentPresets");
  } catch {
    return { presets: [], failures: [], reason: "agentPresets service unavailable" };
  }
  if (service === undefined || typeof service.list !== "function") {
    return { presets: [], failures: [], reason: "agentPresets service has no list()" };
  }
  if (generator === undefined) {
    return { presets: [], failures: [], reason: "row generator not resolvable" };
  }
  let listed;
  try {
    listed = await service.list();
  } catch (error) {
    return { presets: [], failures: [], reason: `list() failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const entries = Array.isArray(listed) ? listed : Array.isArray(listed?.presets) ? listed.presets : [];
  const presets = [];
  const failures = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" && entry.id.length > 0 ? entry.id : undefined;
    if (id === undefined) continue;
    let document;
    try {
      document = typeof service.readDocument === "function" ? await service.readDocument(id) : undefined;
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = generator.parsePlugins(document?.content);
    if (parsed.plugins === undefined) {
      failures.push(`${id}: ${parsed.reason}`);
      continue;
    }
    const config = { id };
    for (const key of ["name", "description", "order"]) {
      if (entry[key] !== undefined) config[key] = entry[key];
    }
    config.plugins = parsed.plugins;
    presets.push({
      id,
      config,
      label: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : id,
      // What the composition actually registers, and whether it failed to.
      provider: generator.compactionProvider?.(config)?.name ?? "",
      broken: typeof entry.broken === "string" ? entry.broken : "",
    });
  }
  return { presets, failures };
}

/** Write the managed block, atomically, only when it actually changed. */
function writeBlock(text, file) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/**
 * Regenerate the takeover rows at activation.
 *
 * @returns {ok, file, taken, skipped, reason} for the log and the settings page.
 */
export async function mountTakeover(ctx) {
  const generator = await loadGenerator();
  if (generator === undefined) {
    return { ok: false, reason: "row generator not resolvable", taken: [], skipped: [] };
  }
  const file = patchFile();
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = "";
  }

  const { presets, failures = [], reason = "" } = await readPresets(ctx, generator);
  if (presets.length === 0) {
    // Nothing could be read: leave the file as it is rather than wiping the
    // shipped rows on a transient host failure.
    return { ok: false, file, taken: [], skipped: [], reason: reason || failures[0] || "no presets declared" };
  }

  const engineName = process.env.DSH_HANDOFF_ENGINE_NAME ?? "dsh-auto-compaction-engine";
  const layer = ensureBundleLayerFile();
  if (layer.changed) ctx.logger?.info?.(`[handoff-ui] bundle layer moved to the end of dsh.profile.bundles`);
  else if (layer.reason) ctx.logger?.warn?.(`[handoff-ui] bundle layer left as is: ${layer.reason}`);
  const rows = generator.takeoverRows(presets, { engineName });
  const taken = rows.map((row) => String(row.id).replace(/^preset-/, ""));
  const skipped = presets.map((preset) => preset.id).filter((id) => !taken.includes(id));
  /* Written rows and effective rows are different facts: the composition reads
   * the patch at startup, so rows first written by this activation only take
   * effect next boot. Reporting both is what keeps the settings page honest. */
  const mounted = presets.filter((preset) => preset.provider === engineName).map((preset) => preset.id);
  const broken = presets.filter((preset) => preset.broken).map((preset) => `${preset.id}: ${preset.broken}`);
  /* Saying which presets were left out and why is the difference between an
   * honest "not taken over" and a silent one. */
  const skippedReasons = presets
    .filter((preset) => !taken.includes(preset.id))
    .map((preset) => {
      const unsupported = generator.findUnsupported?.(preset.config ?? {});
      return `${preset.id}: ${unsupported ? `含无法原样重写的值（${unsupported}）` : "没有可接管的 compaction 组"}`;
    });
  const notes = [];
  if (failures.length > 0) notes.push(`unreadable: ${failures.join("; ")}`);
  if (skippedReasons.length > 0) notes.push(`skipped: ${skippedReasons.join("; ")}`);
  if (broken.length > 0) notes.push(`broken: ${broken.join("; ")}`);
  const block = generator.renderBlock(rows);

  // Nothing to take over and nothing recorded before: leave the shipped file
  // alone rather than appending an empty block.
  if (rows.length === 0 && !current.includes(generator.BLOCK_MARKERS.BEGIN)) {
    return { ok: true, file, taken: [], skipped, mounted, broken, reason: notes.join(" | ") };
  }
  if (generator.needsRewrite(current, block)) {
    try {
      writeBlock(generator.mergeBlock(current, block), file);
      ctx.logger?.info?.(`[handoff-ui] takeover rows written to ${file} (${taken.length} preset(s))`);
    } catch (error) {
      return {
        ok: false, file, taken, skipped,
        reason: `patch write failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true, file, taken, skipped, mounted, broken, reason: notes.join(" | ") };
}

/** Which presets the shipped block currently covers. */
export async function readTakenPresets() {
  const generator = await loadGenerator();
  const file = patchFile();
  if (generator === undefined) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const { BEGIN, END } = generator.BLOCK_MARKERS;
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin < 0 || end < 0 || end < begin) return [];
  return [...text.slice(begin + BEGIN.length, end).matchAll(/^-\s+id:\s*preset-(\S+)/gm)].map((m) => m[1]);
}

/**
 * Everything the settings page needs to answer "who compacts each preset".
 *
 * `covered` is what the block in this package's patch reaches; `effective` adds
 * the runtime gates the engine applies per preset (the switch and the scope).
 */
export async function presetInventory(ctx, settings = {}) {
  const generator = await loadGenerator();
  const covered = new Set(await readTakenPresets());
  const { presets, failures = [], reason = "" } = await readPresets(ctx, generator);
  const selected = new Set(Array.isArray(settings.presets) ? settings.presets : []);
  const global = settings.scope !== "preset";
  const enabled = settings.enabled !== false;
  const rows = presets.map((preset) => {
    const isCovered = covered.has(preset.id);
    const isSelected = global ? isCovered : isCovered && selected.has(preset.id);
    return {
      id: preset.id,
      label: typeof preset.label === "string" ? preset.label : undefined,
      covered: isCovered,
      selected: isSelected,
      effective: isSelected && enabled,
      // Whether this boot's composition already registers our provider; a row
      // written during this activation only shows up here after a restart.
      mounted: preset.provider === (process.env.DSH_HANDOFF_ENGINE_NAME ?? "dsh-auto-compaction-engine"),
      broken: preset.broken || undefined,
    };
  });
  return {
    presets: rows,
    total: rows.length,
    covered: rows.filter((row) => row.covered).length,
    mounted: rows.filter((row) => row.mounted).length,
    effective: rows.filter((row) => row.effective).length,
    reason: reason || (failures.length > 0 ? `unreadable: ${failures.join("; ")}` : ""),
  };
}
