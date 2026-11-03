/**
 * Pure decision helpers for idle-time handoff compaction.
 * Kept free of cordis/DSH imports so they can be unit-tested directly.
 */

/**
 * Threshold in tokens for a routed model.
 *
 * The ratio is applied to the *usable input budget* (window minus the output
 * tokens the routed request reserves), then clamped by the headroom safety
 * margin. That makes the whole 0-100% range monotonic: on a 250K window with a
 * 20K reservation and 10K headroom the budget is 230K and the ceiling 220K, so
 * 90% means 207K and 100% means 220K.
 *
 * @param {object} input
 * @param {number} input.contextWindow  model window in tokens
 * @param {number} [input.reservedCompletionTokens]  output tokens the routed request reserves
 * @param {number} [input.headroomTokens]  safety margin below the budget
 * @param {number} [input.thresholdRatio]  fraction of the usable budget, default 0.9
 */
export function resolveThreshold({ contextWindow, reservedCompletionTokens = 0, headroomTokens = 0, thresholdRatio = 0.9 }) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return { ok: false, reason: `contextWindow (${contextWindow}) must be a positive number` };
  }
  if (!Number.isFinite(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    return { ok: false, reason: `reservedCompletionTokens (${reservedCompletionTokens}) must be >= 0` };
  }
  if (!Number.isFinite(headroomTokens) || headroomTokens < 0) {
    return { ok: false, reason: `headroomTokens (${headroomTokens}) must be >= 0` };
  }
  if (!(thresholdRatio > 0 && thresholdRatio <= 1)) {
    return { ok: false, reason: `thresholdRatio (${thresholdRatio}) must be in (0, 1]` };
  }
  const budgetTokens = contextWindow - reservedCompletionTokens;
  if (budgetTokens <= 0) {
    return { ok: false, reason: `no input budget: window ${contextWindow} - reserved ${reservedCompletionTokens}` };
  }
  const ceilingTokens = budgetTokens - headroomTokens;
  if (ceilingTokens <= 0) {
    return { ok: false, reason: `headroom ${headroomTokens} consumes the input budget ${budgetTokens}` };
  }
  return {
    ok: true,
    thresholdTokens: Math.floor(Math.min(Math.round(budgetTokens * thresholdRatio), ceilingTokens)),
    budgetTokens,
    ceilingTokens,
  };
}

/** Whether the measured session is at or above the handoff threshold. */
export function decideTrigger(input) {
  const spec = resolveThreshold(input);
  if (!spec.ok) return { trigger: false, ...spec };
  return {
    trigger: input.totalTokens >= spec.thresholdTokens,
    totalTokens: input.totalTokens,
    thresholdTokens: spec.thresholdTokens,
  };
}

/**
 * Retry gate: avoids hammering a session whose handoff keeps failing, or that
 * shrank but is still reported above the threshold.
 *
 * @param {object} input
 * @param {number} input.now  epoch ms
 * @param {{at:number,tokens:number}|undefined} input.last  previous attempt record
 * @param {number} input.tokens  current measured tokens
 * @param {number} input.thresholdTokens  current threshold
 * @param {number} [input.minIntervalMs]  minimum wall-clock gap between attempts
 * @param {number} [input.minTokenGrowth]  minimum growth since the last attempt
 */
export function shouldAttempt({ now, last, tokens, thresholdTokens, minIntervalMs = 60_000, minTokenGrowth = 2_048 }) {
  if (tokens < thresholdTokens) return false;
  if (last === undefined) return true;
  if (now - last.at < minIntervalMs) return false;
  if (tokens - last.tokens < minTokenGrowth) return false;
  return true;
}
