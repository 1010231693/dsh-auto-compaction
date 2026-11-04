/**
 * Per-session compaction status sidecar.
 *
 * The engine writes one small JSON file while it prepares, summarizes and
 * commits a handoff; the UI dock polls it through the companion package's RPC
 * channel. Kept free of DSH imports so the UI's node half can reuse it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_DIR = process.env.DSH_HANDOFF_STATUS_DIR || join(homedir(), ".dsh-handoff-compaction", "status");
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Absolute status file for a session id, or undefined when the id is unsafe. */
export function statusFileFor(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return undefined;
  return join(STATUS_DIR, `${sessionId}.json`);
}

/** Latest status for a session, or undefined when absent/unreadable. */
export function readStatus(sessionId) {
  const file = statusFileFor(sessionId);
  if (file === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge one patch into the session status and replace the file atomically.
 * Returns false when the session id is unsafe or the write failed; status
 * writes must never break a compaction.
 */
export function writeStatus(sessionId, patch) {
  const file = statusFileFor(sessionId);
  if (file === undefined || patch === undefined || patch === null) return false;
  try {
    mkdirSync(STATUS_DIR, { recursive: true });
    const previous = readStatus(sessionId) ?? {};
    const next = { ...previous, ...patch, sessionId, updatedAt: Date.now() };
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, JSON.stringify(next), "utf8");
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}
