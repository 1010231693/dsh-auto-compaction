/**
 * Append-only compaction history.
 *
 * The status sidecar holds only the latest attempt; the session timeline needs
 * every one of them, plus the handoff document itself. One JSON object per line
 * keeps appends cheap and lets the UI read a tail without parsing the world.
 *
 * Kept free of DSH imports so tests and the bundle's node half can reuse it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HISTORY_DIR = process.env.DSH_HANDOFF_HISTORY_DIR || join(homedir(), ".dsh-handoff-compaction", "history");
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LINES = 500;

/** Absolute history file for a session id, or undefined when the id is unsafe. */
export function historyFileFor(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return undefined;
  return join(HISTORY_DIR, `${sessionId}.jsonl`);
}

/** Append one record. Returns false (never throws) when the write fails. */
export function appendHistory(sessionId, record) {
  if (record === null || typeof record !== "object") return false;
  const file = historyFileFor(sessionId);
  if (file === undefined) return false;
  try {
    mkdirSync(HISTORY_DIR, { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Most recent `limit` records, oldest first. Unreadable lines are skipped one
 * by one: a half-written line must not hide the rest of the timeline.
 */
export function readHistory(sessionId, limit = 100) {
  const file = historyFileFor(sessionId);
  if (file === undefined || !existsSync(file)) return [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_LINES) : 100;
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
    const out = [];
    for (const line of lines.slice(-cap)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object") out.push(parsed);
      } catch { /* skip a torn line, keep the rest */ }
    }
    out.sort((a, b) => Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0));
    return out;
  } catch {
    return [];
  }
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const WORD = /[A-Za-z][A-Za-z0-9'’._-]*/g;

/**
 * Deterministic word count: CJK ideographs count as characters, everything
 * Latin counts as words. No model call — the timeline must not cost tokens.
 */
export function countWords(text) {
  const value = String(text ?? "");
  const cjkMatches = value.match(CJK);
  const cjk = cjkMatches === null ? 0 : cjkMatches.length;
  const latin = value.replace(CJK, " ");
  const wordMatches = latin.match(WORD);
  const words = wordMatches === null ? 0 : wordMatches.length;
  return { cjk, words };
}
