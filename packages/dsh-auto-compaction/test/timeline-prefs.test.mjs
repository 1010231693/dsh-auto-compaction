import assert from "node:assert/strict";
import { TIMELINE_POSITIONS, TIMELINE_STYLES, normalizeTimelinePosition, normalizeTimelineStyle, normalizeTimelinePrefs } from "../lib/timeline-prefs.js";

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
  assert.deepEqual(normalizeTimelinePrefs({}), { enabled: true, position: "chat", style: "ember" });
  assert.deepEqual(normalizeTimelinePrefs(undefined), { enabled: true, position: "chat", style: "ember" });
  assert.deepEqual(normalizeTimelinePrefs(null), { enabled: true, position: "chat", style: "ember" });
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
  assert.deepEqual(normalizeTimelinePrefs({ timelinePosition: "tab" }), { enabled: true, position: "tab", style: "ember" });
  assert.deepEqual(normalizeTimelinePrefs({ timelineEnabled: false, timelinePosition: "tab" }), { enabled: false, position: "tab", style: "ember" });
});

test("a bogus position never produces a non-chat/tab value", () => {
  assert.deepEqual(normalizeTimelinePrefs({ timelinePosition: "bogus" }), { enabled: true, position: "chat", style: "ember" });
  assert.deepEqual(normalizeTimelinePrefs({ timelineEnabled: false, timelinePosition: "bogus" }), { enabled: false, position: "chat", style: "ember" });
});

test("styles are exactly the five shipped variants", () => {
  assert.deepEqual(TIMELINE_STYLES, ["ember", "capsule", "ring", "quiet", "bars"]);
});

test("style passes through the five known values and falls back to ember", () => {
  for (const id of TIMELINE_STYLES) assert.equal(normalizeTimelineStyle(id), id);
  for (const value of [undefined, null, "", "orbit", "beads", "EMBER", 0, {}, []]) {
    assert.equal(normalizeTimelineStyle(value), "ember", JSON.stringify(value));
  }
});

test("style is read independently of enabled and position", () => {
  assert.deepEqual(normalizeTimelinePrefs({ timelineStyle: "capsule" }), { enabled: true, position: "chat", style: "capsule" });
  assert.deepEqual(normalizeTimelinePrefs({ timelineEnabled: false, timelinePosition: "tab", timelineStyle: "bars" }),
    { enabled: false, position: "tab", style: "bars" });
});

test("unrelated settings keys are ignored", () => {
  assert.deepEqual(
    normalizeTimelinePrefs({ enabled: false, displayStyle: "ring", thresholdRatio: 0.9 }),
    { enabled: true, position: "chat", style: "ember" }
  );
});

let failed = 0;
for (const { name, fn } of cases) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}\n     ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;