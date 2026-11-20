import assert from "node:assert/strict";
import {
  continuationInstruction,
  expectedSections,
  looksTruncated,
  mergeSummary,
  rewriteInstruction,
  stripTruncationMarkers,
  validateSummary,
} from "../lib/summary.js";

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test("expectedSections reads ## and ### outside code fences", () => {
  const template = "## A\n```\n## not a section\n```\n### B\n";
  assert.deepEqual(expectedSections(template), ["A", "B"]);
});

test("validateSummary accepts all sections", () => {
  const result = validateSummary("## A\n- x\n\n## B\n- y", ["A", "B"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("validateSummary reports missing sections", () => {
  const result = validateSummary("## A\n- x", ["A", "B"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["B"]);
});

test("validateSummary rejects a trailing truncation marker", () => {
  const result = validateSummary("## A\n- x\n…（截断）", ["A"]);
  assert.equal(result.ok, false);
  assert.equal(result.truncated, true);
});

test("validateSummary rejects a document ending on a heading", () => {
  const result = validateSummary("## A\n- x\n\n## B\n", ["A", "B"]);
  assert.equal(result.ok, false);
  assert.equal(result.endsWithHeading, true);
});

test("stripTruncationMarkers removes the marker only", () => {
  assert.equal(stripTruncationMarkers("## A\n- x\n…（截断）"), "## A\n- x");
  assert.equal(looksTruncated("## A\n- x\n…（截断）"), true);
});

test("mergeSummary drops a repeated heading at the seam", () => {
  assert.equal(mergeSummary("## A\n- x", "## A\n- y"), "## A\n- x\n- y");
});

test("mergeSummary keeps a new section with a blank line", () => {
  assert.equal(mergeSummary("## A\n- x", "## B\n- y"), "## A\n- x\n\n## B\n- y");
});

test("mergeSummary continues a mid-sentence cut without a paragraph break", () => {
  assert.equal(mergeSummary("- 官方：10/29 Ams", "terdam"), "- 官方：10/29 Amsterdam");
});

test("retry instructions name the missing sections", () => {
  const validation = { missing: ["B", "C"] };
  assert.match(continuationInstruction(validation), /B、C/);
  assert.match(rewriteInstruction(validation, 12_288), /12288/);
});

test("retry instructions follow the English template when asked", () => {
  const validation = { missing: ["Key Technical Concepts", "Files and Code"] };
  const continued = continuationInstruction(validation, "en");
  assert.match(continued, /Continue it from the exact break point/);
  assert.match(continued, /Key Technical Concepts, Files and Code/);
  const rewrite = rewriteInstruction(validation, 12_288, "en");
  assert.match(rewrite, /incomplete/);
  assert.match(rewrite, /12288/);
  assert.doesNotMatch(rewrite, /交接文档/);
});

test("a Chinese template keeps Chinese retry instructions", () => {
  const continued = continuationInstruction({ missing: ["当前工作"] }, "zh");
  assert.match(continued, /交接文档/);
  assert.match(continued, /当前工作/);
});

test("truncation markers are detected in both languages", () => {
  assert.equal(looksTruncated("## A\n- x（截断）"), true);
  assert.equal(looksTruncated("## A\n- x (truncated)"), true);
  assert.equal(looksTruncated("## A\n- x [truncated]"), true);
  assert.equal(looksTruncated("## A\n- x"), false);
  assert.equal(stripTruncationMarkers("## A\n- x (truncated)"), "## A\n- x");
  assert.equal(stripTruncationMarkers("## A\n- x（截断）"), "## A\n- x");
});

let failed = 0;
for (const { name, fn } of cases) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
