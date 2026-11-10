/**
 * dsh-auto-compaction — node half (bundle).
 *
 * Registers no service (so it can be mounted alongside the engine without any
 * risk of a duplicate `ctx.compaction`). Its only job is to mirror its own
 * configuration into the sidecar file the engine reads on every decision:
 *
 *   %USERPROFILE%\.dsh-handoff-compaction\settings.json
 *
 * Writing on every (re)load is what makes a settings save take effect live:
 * DSH reloads this plugin, this function runs, the engine picks the file up at
 * its next idle check.
 */
import z from "@deepseek-ai/schemastery";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { mountTakeover, presetInventory, readRowMaxTokens } from "./takeover-mount.js";
import { installRootAutoGuard } from "./root-auto-guard.js";

export const name = "dsh-auto-compaction";
export const inject = [];

export const Config = z.object({
  enabled: z.boolean().default(true),
  thresholdRatio: z.number().default(90),
  scopePreset: z.boolean().default(false),
  presets: z.string().default(""),
  templateFile: z.string().default(""),
  openTemplate: z.string().default(""),
  displayStyle: z.string().default("orbit"),
});

const DIR = join(homedir(), ".dsh-handoff-compaction");
const SETTINGS_FILE = join(DIR, "settings.json");
const TEMPLATE_FILE = join(DIR, "template.md");
const UI_LOG = join(DIR, "ui.log");
const STATUS_DIR = process.env.DSH_HANDOFF_STATUS_DIR || join(DIR, "status");
const HISTORY_DIR = process.env.DSH_HANDOFF_HISTORY_DIR || join(DIR, "history");
const STATUS_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Read the engine's per-session status sidecar without importing the engine
 * package: DSH's host module fallback cannot resolve a linked package from the
 * UI package's real path, and a top-level import here blocks startup.
 */
function readStatus(sessionId) {
  if (typeof sessionId !== "string" || !STATUS_SESSION_ID.test(sessionId)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(STATUS_DIR, sessionId + ".json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
const requireFromUi = createRequire(import.meta.url);

/**
 * Read the append-only compaction history. Same shape the engine writes, read
 * here rather than imported: a top-level engine import blocks DSH startup.
 * Torn or unreadable lines are skipped individually.
 */
function readHistory(sessionId, limit) {
  if (typeof sessionId !== "string" || !STATUS_SESSION_ID.test(sessionId)) return [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 100;
  try {
    const lines = readFileSync(join(HISTORY_DIR, sessionId + ".jsonl"), "utf8")
      .split(/\r?\n/).filter((line) => line.trim().length > 0);
    const events = [];
    for (const line of lines.slice(-cap)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object") events.push(parsed);
      } catch { /* skip torn line */ }
    }
    events.sort((a, b) => Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0));
    return events;
  } catch {
    return [];
  }
}

function trace(message) {
  try { mkdirSync(DIR, { recursive: true }); appendFileSync(UI_LOG, new Date().toISOString() + " " + message + String.fromCharCode(10), "utf8"); } catch { /* ignore */ }
}

let lastOpenRequest = "";

const DISPLAY_STYLES = new Set(["orbit", "strip", "ring", "topbar", "corner"]);
const MIN_SUMMARY_TOKENS = 8192;
const FALLBACK_SUMMARY_TOKENS = 20000;

function normalizeDisplayStyle(value) {
  return typeof value === "string" && DISPLAY_STYLES.has(value) ? value : "orbit";
}

function normalize(config) {
  const raw = Number(config.thresholdRatio ?? 90);
  const pct = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 90;
  return {
    enabled: config.enabled !== false,
    thresholdRatio: pct / 100,
    scope: config.scopePreset === true ? "preset" : "global",
    presets: String(config.presets ?? "")
      .split(/[,，\s]+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
    templateFile: String(config.templateFile ?? "").trim(),
    displayStyle: normalizeDisplayStyle(config.displayStyle),
  };
}

function writeSettings(ctx, settings) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n", "utf8");
    ctx.logger?.info?.(`[handoff-ui] settings -> ${SETTINGS_FILE} (${JSON.stringify(settings)})`);
  } catch (error) {
    ctx.logger?.warn?.(`[handoff-ui] settings write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function launch(ctx, label, command, args) {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (error) => {
      trace("spawn error " + label + " (" + command + "): " + (error instanceof Error ? error.message : String(error)));
      ctx.logger?.warn?.(`[handoff-ui] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.on("spawn", () => trace("spawned " + label + " (" + command + ")"));
    child.unref();
    return true;
  } catch (error) {
    trace("spawn threw " + label + ": " + (error instanceof Error ? error.message : String(error)));
    return false;
  }
}

async function handleOpen(ctx, request, target) {
  const trimmed = String(request ?? "").trim();
  if (trimmed === "" || trimmed === lastOpenRequest) return { ok: true, value: { skipped: true } };
  lastOpenRequest = trimmed;
  const mode = trimmed.startsWith("folder") ? "folder" : "file";
  const root = process.env.SystemRoot || "C:\\Windows";
  const explorerPath = join(root, "explorer.exe");
  const explorer = existsSync(explorerPath) ? explorerPath : "explorer.exe";

  trace("open requested mode=" + mode + " target=" + target + " explorer=" + explorer);
  if (!existsSync(target)) {
    const message = "file not found: " + target;
    trace("open failed: " + message);
    return { ok: false, error: { code: "auto-compaction/open-missing", message } };
  }

  // Launch through the existing Explorer shell. DSH's host runs plugin
  // children in a job object; cmd/PowerShell descendants are killed with the
  // request, while Explorer hands the file to the shell and exits.
  const args = mode === "folder" ? ["/select," + target] : [target];
  const ok = launch(ctx, mode + "/explorer", explorer, args);
  return ok
    ? { ok: true, value: { mode, target, opener: "explorer" } }
    : { ok: false, error: { code: "auto-compaction/open-failed", message: "explorer failed to start" } };
}

function scopeScriptPath() {
  try {
    const entry = requireFromUi.resolve("dsh-auto-compaction-engine");
    return join(dirname(entry), "..", "scripts", "preset-scope.mjs");
  } catch {
    return join(homedir(), ".dsh-local-pkgs", "dsh-auto-compaction-engine", "scripts", "preset-scope.mjs");
  }
}

function execSwitchOnce(command, env, script, action) {
  return new Promise((resolve, reject) => {
    execFile(command, [script, action], { timeout: 6000, windowsHide: true, env }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Run one preset-scope action. `node` is the normal path; the Electron binary
 * with ELECTRON_RUN_AS_NODE is the fallback when the host has no node on PATH.
 */
async function runScope(action) {
  const script = scopeScriptPath();
  if (!existsSync(script)) {
    const message = "preset-scope.mjs not found: " + script;
    trace("scope " + action + " failed: " + message);
    return { ok: false, message };
  }
  const explicit = process.env.DSH_NODE;
  const attempts = typeof explicit === "string" && explicit.trim().length > 0
    ? [{ command: explicit.trim(), env: process.env }]
    : [
      { command: "node", env: process.env },
      { command: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    ];
  let lastError;
  for (const attempt of attempts) {
    try {
      const result = await execSwitchOnce(attempt.command, attempt.env, script, action);
      const output = `${result.stdout ?? ""}`.trim();
      const noise = `${result.stderr ?? ""}`.trim();
      trace("scope " + action + " ok" + (output ? " | " + output : "") + (noise ? " | " + noise : ""));
      return { ok: true, output, noise };
    } catch (error) {
      lastError = error;
      if (error?.code !== "ENOENT") break;
    }
  }
  const output = `${lastError?.stdout ?? ""}${lastError?.stderr ?? ""}`.trim();
  const message = (lastError?.message ?? String(lastError)) + (output ? "\n" + output : "");
  trace("scope " + action + " failed: " + message);
  return { ok: false, message };
}

/**
 * Hand compaction back where the old mechanism left it.
 *
 * Up to 0.2.x the takeover was written into the user's own preset files plus a
 * root-level guard in the profile patch. Those rows now live inside this
 * package, so a leftover switch would mount two providers in the same realm and
 * DSH would refuse to start. Detection goes through the script's own read-only
 * report rather than a second YAML parser; the revert runs once and is recorded
 * so later boots skip the subprocess entirely.
 */
async function revertLegacyTakeover(ctx) {
  const settings = readSettings();
  if (settings?.legacyRevertedAt !== undefined) return { reverted: false, skipped: "already" };
  const state = await runScope("state");
  if (!state.ok) return { reverted: false, reason: state.message };
  const line = String(state.output ?? "").split(/\r?\n/).filter(Boolean).pop() ?? "";
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { reverted: false, reason: "unreadable legacy state" };
  }
  const legacy = Number(value?.taken) > 0 || value?.rootGuard === "off";
  if (!legacy) return { reverted: false, legacy: false };

  const disabled = await runScope("disable");
  if (!disabled.ok) return { reverted: false, reason: disabled.message };

  writeSettings(ctx, { ...settings, legacyRevertedAt: new Date().toISOString() });
  trace(`legacy takeover reverted: taken=${value?.taken}/${value?.total} rootGuard=${value?.rootGuard}`);
  ctx.logger?.info?.("[handoff-ui] 旧版接管残留已恢复为原生压缩（预设文件与根级守卫）");
  return { reverted: true, taken: value?.taken, total: value?.total };
}

const CHANNEL = "/dsh-auto-compaction";

function readSettings() {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sanitize(payload) {
  const pct = Number(payload?.thresholdRatio);
  const ratio = Number.isFinite(pct) ? Math.max(1, Math.min(100, pct)) : 90;
  const presets = Array.isArray(payload?.presets)
    ? payload.presets.filter((v) => typeof v === "string" && v.trim().length > 0)
    : String(payload?.presets ?? "").split(/[,，s]+/).filter((v) => v.trim().length > 0);
  const cap = Number(payload?.summaryMaxTokens);
  const next = {
    enabled: payload?.enabled !== false,
    thresholdRatio: ratio / 100,
    scope: payload?.scope === "preset" ? "preset" : "global",
    presets,
    templateFile: String(payload?.templateFile ?? "").trim(),
    displayStyle: normalizeDisplayStyle(payload?.displayStyle),
  };
  // Absent/blank means "follow the row default", so the key is dropped rather
  // than pinning a number that would outlive a future row change.
  if (Number.isInteger(cap) && cap >= MIN_SUMMARY_TOKENS) next.summaryMaxTokens = cap;
  return next;
}

export function apply(ctx, config = {}) {
  const seeded = normalize(config);
  if (readSettings() === undefined) writeSettings(ctx, seeded);
  // Takeover rows are regenerated from the live preset definitions on every
  // load, into this package's own patch file. Nothing here depends on the
  // user's scope selection: an unselected preset is handled by the engine
  // delegating to the stock one, so installing is enough to take over and
  // uninstalling is enough to hand compaction back.
  void (async () => {
    const legacy = await revertLegacyTakeover(ctx);
    if (legacy.reverted) trace("legacy takeover reverted before mounting");
    else if (legacy.reason) trace("legacy takeover check skipped: " + legacy.reason);
    return mountTakeover(ctx);
  })().then((result) => {
    trace(`takeover mount ${result.ok ? "ok" : "failed"} taken=${result.taken?.join(",") ?? "-"} mounted=${result.mounted?.join(",") ?? "-"} skipped=${result.skipped?.join(",") ?? "-"} ${result.reason ?? ""}`);
  }).catch((error) => {
    trace("takeover mount threw: " + (error instanceof Error ? error.message : String(error)));
    ctx.logger?.warn?.(`[handoff-ui] takeover mount failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  void handleOpen(ctx, config.openTemplate, seeded.templateFile || TEMPLATE_FILE).catch((error) => {
    ctx.logger?.warn?.(`[handoff-ui] openTemplate failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  // The profile root may keep its own stock compaction row, whose automatic
  // triggers hear every session and compact mid-turn before our idle gate.
  // Silencing that instance while the plugin is enabled is what makes the
  // takeover hold for sessions of every preset; the settings switch restores
  // it live, and dispose (disable/uninstall) unwraps it.
  ctx.inject(["compaction"], (scope) => {
    try {
      const service = scope.compaction ?? scope.root?.compaction;
      const guard = installRootAutoGuard(service, () => readSettings()?.enabled !== false, (message) => trace(message));
      if (guard.guarded) trace("root auto compaction guard installed");
      scope.effect(() => guard.dispose, "auto-compaction root guard");
    } catch (error) {
      trace("root auto guard failed: " + (error instanceof Error ? error.message : String(error)));
    }
  });

  ctx.inject(["connection"], (scope) => {
    try {
      const connection = scope.root?.connection ?? scope.connection;
      if (connection === undefined) {
        ctx.logger?.warn?.("[handoff-ui] no connection service; settings RPC unavailable");
        return;
      }
      const dispose = connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
        try {
          if (endpoint === "status") {
            // A switched-off plugin leaves no live status behind; hide any
            // sidecar left over from a compaction that ran before the switch.
            if (readSettings()?.enabled === false) return { ok: true, value: null };
            return { ok: true, value: readStatus(String(payload?.sessionId ?? "")) ?? null };
          }
          if (endpoint === "history") {
            const sessionId = String(payload?.sessionId ?? "");
            return {
              ok: true,
              value: { sessionId, events: readHistory(sessionId, Number(payload?.limit)) },
            };
          }
          if (endpoint === "get") {
            const stored = readSettings() ?? seeded;
            return {
              ok: true,
              value: {
                ...stored,
                enabled: stored.enabled !== false,
                displayStyle: normalizeDisplayStyle(stored.displayStyle),
                defaultTemplate: TEMPLATE_FILE,
                defaultSummaryMaxTokens: (await readRowMaxTokens()) ?? FALLBACK_SUMMARY_TOKENS,
              },
            };
          }
          if (endpoint === "set") {
            const next = sanitize(payload);
            trace("set " + JSON.stringify(next));
            writeSettings(ctx, next);
            // No rewriting of preset files: the engine applies the switch and
            // the scope per preset at decision time, so a save is live at the
            // next idle check and uninstalling still leaves nothing behind.
            return { ok: true, value: { ...next, defaultTemplate: TEMPLATE_FILE, defaultSummaryMaxTokens: (await readRowMaxTokens()) ?? FALLBACK_SUMMARY_TOKENS } };
          }
          if (endpoint === "scope") {
            const stored = readSettings() ?? seeded;
            try {
              const inventory = await presetInventory(ctx, stored);
              return {
                ok: true,
                value: {
                  enabled: stored.enabled !== false,
                  scope: stored.scope === "preset" ? "preset" : "global",
                  source: "bundle-patch",
                  ...inventory,
                },
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              trace("scope inventory failed: " + message);
              return { ok: false, error: { code: "auto-compaction/scope-unknown", message } };
            }
          }
          if (endpoint === "open") {
            trace("open " + JSON.stringify(payload));
            return await handleOpen(ctx, String(payload?.kind ?? "file") + ":" + Date.now(), String(payload?.path ?? "") || TEMPLATE_FILE);
          }
          return { ok: false, error: { code: "auto-compaction/bad-request", message: "unknown endpoint: " + String(endpoint) } };
        } catch (error) {
          return { ok: false, error: { code: "auto-compaction/failed", message: error instanceof Error ? error.message : String(error) } };
        }
      });
      scope.effect(() => dispose, "auto-compaction settings rpc");
      trace("rpc ready on " + CHANNEL);
      ctx.logger?.info?.("[handoff-ui] settings RPC ready on " + CHANNEL);
    } catch (error) {
      ctx.logger?.warn?.("[handoff-ui] RPC registration failed: " + (error instanceof Error ? error.message : String(error)));
    }
  });
}
