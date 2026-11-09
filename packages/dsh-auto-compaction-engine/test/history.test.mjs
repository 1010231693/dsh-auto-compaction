/**
 * History sidecar: deterministic word counting, append/read ordering, a torn
 * line must not hide the rest, and unsafe session ids never touch disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-handoff-history-"));
process.env.DSH_HANDOFF_HISTORY_DIR = DIR;

const { appendHistory, readHistory, historyFileFor, countWords } =
  await import(pathToFileURL(path.join(HERE, "..", "lib", "history.js")).href);

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("counts CJK characters and Latin words separately", () => {
  const counts = countWords("压缩完成：5 条历史，用了 12.4 s。OK done.");
  if (counts.cjk !== 9) throw new Error("cjk " + counts.cjk + " !== 9");
  if (counts.words !== 3) throw new Error("words " + counts.words + " !== 3: " + JSON.stringify(counts));
});

test("empty and undefined text count as zero", () => {
  for (const value of ["", undefined, null]) {
    const counts = countWords(value);
    if (counts.cjk !== 0 || counts.words !== 0) throw new Error("non-zero for " + String(value));
  }
});

test("append keeps order and read returns the tail oldest-first", () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  for (let i = 1; i <= 5; i += 1) {
    if (!appendHistory("session-a", { startedAt: i * 1000, cjk: i })) throw new Error("append failed at " + i);
  }
  const all = readHistory("session-a");
  if (all.length !== 5) throw new Error("read " + all.length + " of 5");
  if (all[0].startedAt !== 1000 || all[4].startedAt !== 5000) throw new Error("bad order");
  const tail = readHistory("session-a", 2);
  if (tail.length !== 2 || tail[0].startedAt !== 4000) throw new Error("bad tail: " + JSON.stringify(tail));
});

test("a torn line is skipped without losing the rest", () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  appendHistory("session-b", { startedAt: 1 });
  fs.appendFileSync(historyFileFor("session-b"), "{not json\n");
  appendHistory("session-b", { startedAt: 2 });
  const events = readHistory("session-b");
  if (events.length !== 2) throw new Error("expected 2 readable records, got " + events.length);
});

test("unsafe session ids never resolve to a file", () => {
  for (const id of ["", "../escape", "a/b", "a b", undefined, null, 42]) {
    if (historyFileFor(id) !== undefined) throw new Error("id accepted: " + String(id));
    if (appendHistory(id, { startedAt: 1 })) throw new Error("append accepted: " + String(id));
    if (readHistory(id).length !== 0) throw new Error("read accepted: " + String(id));
  }
});

test("missing session file reads as empty", () => {
  if (readHistory("session-none").length !== 0) throw new Error("phantom history");
});

let failed = 0;
for (const { name, fn } of cases) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
