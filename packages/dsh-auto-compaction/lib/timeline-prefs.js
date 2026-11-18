/**
 * Timeline display preferences (UI-only; the engine keeps recording history
 * regardless). The node half sanitizes with these helpers; the client bundle
 * inlines the same normalization because the ModuleLoader wrapper cannot
 * import local modules — keep the two in sync.
 */
export const TIMELINE_POSITIONS = ["chat", "tab"];
export const TIMELINE_STYLES = ["ember", "capsule", "ring", "quiet", "bars"];

export function normalizeTimelinePosition(value) {
  return value === "tab" ? "tab" : "chat";
}

export function normalizeTimelineStyle(value) {
  return TIMELINE_STYLES.includes(value) ? value : "ember";
}

export function normalizeTimelinePrefs(value) {
  return {
    enabled: value?.timelineEnabled !== false,
    position: normalizeTimelinePosition(value?.timelinePosition),
    style: normalizeTimelineStyle(value?.timelineStyle),
  };
}