#!/usr/bin/env node
/**
 * Ship takeover rows for the presets DSH itself declares.
 *
 * At activation the plugin regenerates these rows from the live composition,
 * which is what keeps a preset's newer tools. That costs one boot: rows written
 * during activation are read by the next composition. Shipping the built-in
 * presets' rows in the package instead means a fresh install takes over
 * compaction immediately, with no save and no restart, which is what the
 * settings page promises.
 *
 * The block is produced by the same generator the runtime uses, so activation
 * does not rewrite the file on the first boot.
 *
 * Usage:
 *   node scripts/ship-takeover-rows.mjs --presets <dir-of-*.patch.yml> [--out <file>] [--check]
 *
 * `--presets` points at the installed DSH's `dsh-web-app/presets` directory.
 * `--check` exits 1 when the shipped file is not what the generator produces,
 * for use in CI before a release.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.join(HERE, "..");
const argv = process.argv.slice(2);

function arg(flag, fallback) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : fallback;
}

const PRESETS_DIR = arg("--presets", process.env.DSH_PRESETS_DIR);
const OUT = path.resolve(arg("--out", path.join(PACKAGE_DIR, "cordis.patch.yml")));
const CHECK = argv.includes("--check");
const ENGINE_NAME = process.env.DSH_HANDOFF_ENGINE_NAME ?? "dsh-auto-compaction-engine";

if (!PRESETS_DIR || !fs.existsSync(PRESETS_DIR)) {
  console.error(`usage: node scripts/ship-takeover-rows.mjs --presets <dir> [--out <file>] [--check]`);
  console.error(`(missing preset directory: ${PRESETS_DIR ?? "none given"})`);
  process.exit(2);
}

/* js-yaml is a dependency of this package; the development workspace installs
 * nothing, so fall back to the copy DSH keeps in the profile. Same order as
 * the engine's preset-scope script. */
function loadYaml() {
  const here = createRequire(import.meta.url);
  try { return here("js-yaml"); } catch { /* fall through */ }
  const appData = process.env.APP_DATA
    ?? path.join(process.env.SystemDrive ?? "C:", "Users", process.env.USERNAME ?? process.env.USER ?? "", "AppData", "Roaming");
  return createRequire(path.join(appData, "dsh-desktop", "harness", "profiles", "web", "package.json"))("js-yaml");
}
const yaml = loadYaml();
const { JsExpression, mergeBlock, needsRewrite, renderBlock, takeoverRows } = await import(
  pathToFileURL(path.join(PACKAGE_DIR, "..", "dsh-auto-compaction-engine", "lib", "takeover-rows.js")).href
);

/* `!!js` scalars are kept as values the generator can write back as the same
 * tag; a preset's platform-conditional rows depend on that surviving. */
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (data) => new JsExpression(data) }),
]);

/** The preset rows declared by one `presets/<name>.patch.yml` file. */
function presetsFromFile(file) {
  const document = yaml.load(fs.readFileSync(file, "utf8"), { schema });
  const rows = [];
  for (const entry of Array.isArray(document) ? document : []) {
    const list = Array.isArray(entry?.insert) ? entry.insert : [];
    for (const row of list) {
      const id = typeof row?.id === "string" ? row.id : "";
      if (!id.startsWith("preset-")) continue;
      if (!row.config || !Array.isArray(row.config.plugins)) continue;
      rows.push({ id: id.slice("preset-".length), config: row.config });
    }
  }
  return rows;
}

const presets = [];
for (const name of fs.readdirSync(PRESETS_DIR).filter((file) => file.endsWith(".patch.yml")).sort()) {
  presets.push(...presetsFromFile(path.join(PRESETS_DIR, name)));
}

const rows = takeoverRows(presets, { engineName: ENGINE_NAME });
const block = renderBlock(rows);
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
const next = mergeBlock(current, block);

if (CHECK) {
  if (needsRewrite(current, block)) {
    console.error(`cordis.patch.yml is not in sync with ${PRESETS_DIR} — run without --check before release`);
    process.exit(1);
  }
  console.log(`cordis.patch.yml matches the installed presets (${rows.length} preset(s))`);
  process.exit(0);
}

fs.writeFileSync(OUT, next, "utf8");
console.log(`${OUT}\n  -> ${rows.map((row) => row.id).join(", ") || "(none)"}  [${rows.length} takeover row(s)]`);
