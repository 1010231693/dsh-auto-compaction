import assert from "node:assert/strict";
import { decideTrigger, resolveThreshold, shouldAttempt } from "../lib/plan.js";

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test("40K assumed window: 90% of the usable input budget (36K)", () => {
  const spec = resolveThreshold({ contextWindow: 40_000, reservedCompletionTokens: 4_000, thresholdRatio: 0.9 });
  assert.equal(spec.ok, true);
  assert.equal(spec.budgetTokens, 36_000);
  assert.equal(spec.thresholdTokens, 32_400);
});

test("40K: just below vs at the threshold", () => {
  const base = { contextWindow: 40_000, reservedCompletionTokens: 4_000, thresholdRatio: 0.9 };
  assert.equal(decideTrigger({ ...base, totalTokens: 32_399 }).trigger, false);
  assert.equal(decideTrigger({ ...base, totalTokens: 32_400 }).trigger, true);
});

test("real 250K window: budget 230K, 90% -> 207000, ceiling 220K", () => {
  const spec = resolveThreshold({ contextWindow: 250_000, reservedCompletionTokens: 20_000, headroomTokens: 10_000, thresholdRatio: 0.9 });
  assert.equal(spec.budgetTokens, 230_000);
  assert.equal(spec.ceilingTokens, 220_000);
  assert.equal(spec.thresholdTokens, 207_000);
});

test("100% never exceeds the headroom ceiling", () => {
  const spec = resolveThreshold({ contextWindow: 250_000, reservedCompletionTokens: 20_000, headroomTokens: 10_000, thresholdRatio: 1 });
  assert.equal(spec.thresholdTokens, 220_000);
});

test("a huge output reservation shrinks the budget instead of the ratio", () => {
  const spec = resolveThreshold({ contextWindow: 40_000, reservedCompletionTokens: 20_000, thresholdRatio: 0.9 });
  assert.equal(spec.ok, true);
  assert.equal(spec.budgetTokens, 20_000);
  assert.equal(spec.thresholdTokens, 18_000);
});

test("window fully consumed by the reservation is rejected", () => {
  const spec = resolveThreshold({ contextWindow: 40_000, reservedCompletionTokens: 40_000 });
  assert.equal(spec.ok, false);
});

test("headroom larger than the budget is rejected", () => {
  const spec = resolveThreshold({ contextWindow: 40_000, reservedCompletionTokens: 4_000, headroomTokens: 40_000 });
  assert.equal(spec.ok, false);
});

test("retry gate: first attempt allowed, then throttled by interval", () => {
  const args = { tokens: 37_000, thresholdTokens: 36_000, minIntervalMs: 60_000, minTokenGrowth: 2_000 };
  assert.equal(shouldAttempt({ ...args, now: 1_000_000, last: undefined }), true);
  assert.equal(shouldAttempt({ ...args, now: 1_030_000, last: { at: 1_000_000, tokens: 36_500 } }), false);
});

test("retry gate: allows a retry after enough growth and time", () => {
  const args = { tokens: 40_000, thresholdTokens: 36_000, minIntervalMs: 60_000, minTokenGrowth: 2_000 };
  assert.equal(shouldAttempt({ ...args, now: 1_100_000, last: { at: 1_000_000, tokens: 36_000 } }), true);
  assert.equal(shouldAttempt({ ...args, now: 1_100_000, last: { at: 1_000_000, tokens: 39_000 } }), false);
});

test("retry gate: below threshold never attempts", () => {
  assert.equal(shouldAttempt({ now: 1, last: undefined, tokens: 1_000, thresholdTokens: 36_000 }), false);
});

let failed = 0;
for (const { name, fn } of cases) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
