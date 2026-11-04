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

export const name = "dsh-auto-compaction";
export const inject = [];

export const Config = z.object({
  enabled: z.boolean().default(true),
  thresholdRatio: z.number().default(90),
  scopePreset: z.boolean().default(false),
  presets: z.string().default("lightweight-local"),
  templateFile: z.string().default(""),
  openTemplate: z.string().default(""),
  displayStyle: z.string().default("orbit"),
});

const DIR = join(homedir(), ".dsh-handoff-compaction");
const SETTINGS_FILE = join(DIR, "settings.json");
const TEMPLATE_FILE = join(DIR, "template.md");
const UI_LOG = join(DIR, "ui.log");
const STATUS_DIR = process.env.DSH_HANDOFF_STATUS_DIR || join(DIR, "status");
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

function trace(message) {
  try { mkdirSync(DIR, { recursive: true }); appendFileSync(UI_LOG, new Date().toISOString() + " " + message + String.fromCharCode(10), "utf8"); } catch { /* ignore */ }
}

let lastOpenRequest = "";

const DISPLAY_STYLES = new Set(["orbit", "strip", "ring", "topbar", "corner"]);

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

function execSwitchOnce(command, env, script) {
  return new Promise((resolve, reject) => {
    execFile(command, [script, "enable"], { timeout: 6000, windowsHide: true, env }, (error, stdout, stderr) => {
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
 * Apply the current settings sidecar to the preset/profile YAML. `node` is the
 * normal path; the Electron binary with ELECTRON_RUN_AS_NODE is the fallback
 * when the host has no node on PATH.
 */
async function applyScopeSwitch() {
  const script = scopeScriptPath();
  if (!existsSync(script)) {
    const message = "preset-scope.mjs not found: " + script;
    trace("scope switch failed: " + message);
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
      const result = await execSwitchOnce(attempt.command, attempt.env, script);
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      trace("scope switch ok" + (output ? " | " + output : ""));
      return { ok: true, output };
    } catch (error) {
      lastError = error;
      if (error?.code !== "ENOENT") break;
    }
  }
  const output = `${lastError?.stdout ?? ""}${lastError?.stderr ?? ""}`.trim();
  const message = (lastError?.message ?? String(lastError)) + (output ? "\n" + output : "");
  trace("scope switch failed: " + message);
  return { ok: false, message };
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
  return {
    enabled: payload?.enabled !== false,
    thresholdRatio: ratio / 100,
    scope: payload?.scope === "preset" ? "preset" : "global",
    presets,
    templateFile: String(payload?.templateFile ?? "").trim(),
    displayStyle: normalizeDisplayStyle(payload?.displayStyle),
  };
}

export function apply(ctx, config = {}) {
  const seeded = normalize(config);
  if (readSettings() === undefined) writeSettings(ctx, seeded);
  void handleOpen(ctx, config.openTemplate, seeded.templateFile || TEMPLATE_FILE).catch((error) => {
    ctx.logger?.warn?.(`[handoff-ui] openTemplate failed: ${error instanceof Error ? error.message : String(error)}`);
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
          if (endpoint === "get") {
            const stored = readSettings() ?? seeded;
            return {
              ok: true,
              value: {
                ...stored,
                enabled: stored.enabled !== false,
                displayStyle: normalizeDisplayStyle(stored.displayStyle),
                defaultTemplate: TEMPLATE_FILE,
              },
            };
          }
          if (endpoint === "set") {
            const next = sanitize(payload);
            trace("set " + JSON.stringify(next));
            writeSettings(ctx, next);
            const applied = await applyScopeSwitch();
            if (!applied.ok) {
              return { ok: false, error: { code: "auto-compaction/switch-failed", message: applied.message }, value: next };
            }
            return { ok: true, value: { ...next, switchApplied: true, defaultTemplate: TEMPLATE_FILE } };
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
