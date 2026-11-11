import assert from "node:assert/strict";
import { TIMELINE_POSITIONS, normalizeTimelinePosition, normalizeTimelinePrefs } from "../lib/timeline-prefs.js";

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test("positions are exactly chat and tab", () => {
  assert.deepEqual(TIMELINE_POSITIONS, ["chat", "tab"]);
});

test("position passes through the two known values", () => {
  assert.equal(normalizeTimelinePosition("chat"), "chat");
  assert.equal(normalizeTimelinePosition("tab"), "tab");
});

test("unknown / missing position falls back to chat", () => {
  for (const value of [undefined, null, "", "sidebar", "TAB", "Chat", 0, 123, {}, []]) {
    assert.equal(normalizeTimelinePosition(value), "chat", JSON.stringify(value));
  }
});

test("empty prefs default to enabled chat", () => {
  assert.deepEqual(normalizeTimelinePrefs({}), { enabled: true, position: "chat" });
  assert.deepEqual(normalizeTimelinePrefs(undefined), { enabled: true, position: "chat" });
  assert.deepEqual(normalizeTimelinePrefs(null), { enabled: true, position: "chat" });
});

test("only a literal false disables the timeline", () => {
  assert.equal(normalizeTimelinePrefs({ timelineEnabled: false }).enabled, false);
  assert.equal(normalizeTimelinePrefs({ timelineEnabled: true }).enabled, true);
  // Hand-edited non-boolean values keep the default-on behaviour (same rule as
  // the plugin's master `enabled` switch: `!== false`).
  assert.equal(normalizeTimelinePrefs({ timelineEnabled: "false" }).enabled, true);
  assert.equal(normalizeTimelinePrefs({ timelineEnabled: 0 }).enabled, true);
});

test("position is read independently of the enabled flag", () => {
  assert.deepEqual(normalizeTimelinePrefs({ timelinePosition: "tab" }), { enabled: true, position: "tab" });
  assert.deepEqual(normalizeTimelinePrefs({ timelineEnabled: false, timelinePosition: "tab" }), { enabled: false, position: "tab" });
});

test("a bogus position never produces a non-chat/tab value", () => {
  assert.deepEqual(normalizeTimelinePrefs({ timelinePosition: "bogus" }), { enabled: true, position: "chat" });
  assert.deepEqual(normalizeTimelinePrefs({ timelineEnabled: false, timelinePosition: "bogus" }), { enabled: false, position: "chat" });
});

test("unrelated settings keys are ignored", () => {
  assert.deepEqual(
    normalizeTimelinePrefs({ enabled: false, displayStyle: "ring", thresholdRatio: 0.9 }),
    { enabled: true, position: "chat" }
  );
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;