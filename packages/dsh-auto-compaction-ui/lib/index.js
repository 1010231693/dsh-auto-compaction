/**
 * dsh-handoff-compaction-ui — node half.
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
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const name = "dsh-auto-compaction-ui";
export const inject = [];

export const Config = z.object({
  thresholdRatio: z.number().default(90),
  scopePreset: z.boolean().default(false),
  presets: z.string().default("lightweight-local"),
  templateFile: z.string().default(""),
  openTemplate: z.string().default(""),
});

const DIR = join(homedir(), ".dsh-handoff-compaction");
const SETTINGS_FILE = join(DIR, "settings.json");
const TEMPLATE_FILE = join(DIR, "template.md");
const UI_LOG = join(DIR, "ui.log");

function trace(message) {
  try { mkdirSync(DIR, { recursive: true }); appendFileSync(UI_LOG, new Date().toISOString() + " " + message + String.fromCharCode(10), "utf8"); } catch { /* ignore */ }
}

let lastOpenRequest = "";

function normalize(config) {
  const raw = Number(config.thresholdRatio ?? 90);
  const pct = Number.isFinite(raw) ? Math.max(1, Math.min(100, raw)) : 90;
  return {
    thresholdRatio: pct / 100,
    scope: config.scopePreset === true ? "preset" : "global",
    presets: String(config.presets ?? "")
      .split(/[,，\s]+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
    templateFile: String(config.templateFile ?? "").trim(),
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

function handleOpen(ctx, request, target) {
  const trimmed = String(request ?? "").trim();
  if (trimmed === "" || trimmed === lastOpenRequest) return;
  lastOpenRequest = trimmed;
  const mode = trimmed.startsWith("folder") ? "folder" : "file";
  const root = process.env.SystemRoot || "C:\\Windows";
  const explorerPath = join(root, "explorer.exe");
  const cmdPath = join(root, "System32", "cmd.exe");
  const explorer = existsSync(explorerPath) ? explorerPath : "explorer.exe";
  const cmd = existsSync(cmdPath) ? cmdPath : "cmd.exe";

  trace("open requested mode=" + mode + " target=" + target + " explorer=" + explorer + " cmd=" + cmd);
  const candidates = mode === "folder"
    ? [[explorer, ["/select," + target]], [cmd, ["/c", "start", "", "/select," + target]]]
    : [[cmd, ["/c", "start", "", target]], [explorer, [target]]];

  for (let i = 0; i < candidates.length; i += 1) {
    const pair = candidates[i];
    const binary = pair[0];
    if (binary.includes("\\") === false || existsSync(binary)) {
      launch(ctx, mode + "/" + i, binary, pair[1]);
      return;
    }
  }
  trace("no launcher available for " + target);
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
    thresholdRatio: ratio / 100,
    scope: payload?.scope === "preset" ? "preset" : "global",
    presets,
    templateFile: String(payload?.templateFile ?? "").trim(),
  };
}

export function apply(ctx, config = {}) {
  const seeded = normalize(config);
  if (readSettings() === undefined) writeSettings(ctx, seeded);
  handleOpen(ctx, config.openTemplate, seeded.templateFile || TEMPLATE_FILE);

  ctx.inject(["connection"], (scope) => {
    try {
      const connection = scope.root?.connection ?? scope.connection;
      if (connection === undefined) {
        ctx.logger?.warn?.("[handoff-ui] no connection service; settings RPC unavailable");
        return;
      }
      const dispose = connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
        try {
          if (endpoint === "get") return { ok: true, value: readSettings() ?? seeded };
          if (endpoint === "set") {
            const next = sanitize(payload);
            trace("set " + JSON.stringify(next));
            writeSettings(ctx, next);
            return { ok: true, value: next };
          }
          if (endpoint === "open") {
            trace("open " + JSON.stringify(payload));
            handleOpen(ctx, String(payload?.kind ?? "file") + ":" + Date.now(), String(payload?.path ?? "") || TEMPLATE_FILE);
            return { ok: true, value: true };
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
