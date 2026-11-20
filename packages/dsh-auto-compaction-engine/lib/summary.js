/**
 * Pure completeness checks for the generated handoff document.
 *
 * The local models used with DSH sometimes stop early and append a literal
 * "（截断）" marker (or stop right after a heading) instead of failing the
 * request. These helpers let the engine treat such output as incomplete,
 * continue it, or rewrite it before the checkpoint is committed.
 */

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s*(#{2,3})\s+(.+?)\s*$/;

function normalizeHeading(text) {
  return String(text ?? "")
    .replace(/^#{2,3}\s*/, "")
    .replace(/^\s*\d+[.、)]\s*/, "")
    .replace(/[*_`]/g, "")
    .replace(/[\s：:]+$/g, "")
    .trim();
}

function headingsIn(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = HEADING.exec(line);
    if (match === null) continue;
    const heading = normalizeHeading(match[2]);
    if (heading.length > 0 && !out.includes(heading)) out.push(heading);
  }
  return out;
}

/** Section headings the template asks the model to produce. */
export function expectedSections(templateText) {
  return headingsIn(templateText);
}

/** Section headings actually present in a generated summary. */
export function summarySections(summaryText) {
  return headingsIn(summaryText);
}

/**
 * Whether the text ends with a model-generated truncation marker. Both
 * languages are checked whatever the UI locale is: a model running an English
 * template may still emit the Chinese marker and vice versa.
 */
export function looksTruncated(text) {
  const tail = String(text ?? "").trimEnd();
  if (tail.length === 0) return false;
  if (/[（(]\s*截断\s*[)）]\s*$/.test(tail)) return true;
  if (/[\[【]\s*截断\s*[\]】]\s*$/.test(tail)) return true;
  if (/[（(]\s*truncated\s*[)）]\s*$/i.test(tail)) return true;
  if (/[\[【]\s*truncated\s*[\]】]\s*$/i.test(tail)) return true;
  const last = tail.slice(-48);
  if (/(?:输出|回答|摘要|文档|内容|响应)\s*(?:已|被)?\s*截断\s*$/.test(last)) return true;
  return /\b(?:output|answer|summary|document|response)\s+(?:was\s+|is\s+)?truncated\b\W*$/i.test(last)
    || /\btruncated\b\W*$/i.test(last);
}

/** Remove literal truncation markers the model wrote about its own output. */
export function stripTruncationMarkers(text) {
  return String(text ?? "")
    .replace(/[…\.]{0,3}\s*[（(]\s*截断\s*[)）]/g, "")
    .replace(/[…\.]{0,3}\s*[\[【]\s*截断\s*[\]】]/g, "")
    .replace(/[…\.]{0,3}\s*[（(]\s*truncated\s*[)）]/gi, "")
    .replace(/[…\.]{0,3}\s*[\[【]\s*truncated\s*[\]】]/gi, "")
    .trimEnd();
}

/**
 * Validate one generated handoff document against the template sections.
 * `ok` is false when a section is missing, the text ends on a bare heading,
 * or the model marked its own output as truncated.
 */
export function validateSummary(text, expected = []) {
  const headings = headingsIn(text);
  const missing = expected.filter(
    (section) => !headings.some((heading) => heading.includes(section) || section.includes(heading)),
  );
  const truncated = looksTruncated(text);
  const endsWithHeading = /(?:^|\n)\s*#{2,3}\s+[^\n]*\s*$/.test(String(text ?? "").trimEnd());
  const reasons = [];
  if (missing.length > 0) reasons.push(`missing sections: ${missing.join(", ")}`);
  if (truncated) reasons.push("truncation marker");
  if (endsWithHeading) reasons.push("ends on a heading");
  return {
    ok: missing.length === 0 && !truncated && !endsWithHeading,
    missing,
    truncated,
    endsWithHeading,
    reason: reasons.join("; "),
  };
}

function lastHeading(text) {
  const headings = headingsIn(text);
  return headings.length === 0 ? undefined : headings[headings.length - 1];
}

function startsWithHeading(text) {
  const first = String(text ?? "").trimStart().split(/\r?\n/, 1)[0] ?? "";
  const match = HEADING.exec(first);
  return match === null ? undefined : normalizeHeading(match[2]);
}

/** Join a partial summary and a continuation without duplicating its heading. */
export function mergeSummary(partial, tail) {
  const head = String(partial ?? "").trimEnd();
  const rest = String(tail ?? "").trim();
  if (head.length === 0) return rest;
  if (rest.length === 0) return head;
  const repeated = lastHeading(head);
  const first = startsWithHeading(rest);
  if (repeated !== undefined && first !== undefined && repeated === first) {
    const newline = rest.indexOf("\n");
    const body = newline === -1 ? "" : rest.slice(newline + 1).trim();
    return body.length === 0 ? head : `${head}\n${body}`;
  }
  if (first !== undefined) return `${head}\n\n${rest}`;
  const safeBreak = /[。！？.!?；;：:)\]）】]$/.test(head);
  return safeBreak ? `${head}\n\n${rest}` : `${head}${rest}`;
}

/**
 * Retry instructions follow the language of the template that was used, not of
 * the UI shell: a model half-way through a document must be answered in the
 * language it is already writing, or the continuation switches language and the
 * section check fails for the wrong reason.
 */
const INSTRUCTION_TEXT = {
  zh: {
    continueHead: "你刚才写到一半中断了。请从断点继续这份交接文档：",
    continueBridge: "- 先补完断点处的句子，不要重复已经写过的内容或标题；",
    continueMissing: (missing) => `- 然后按模板顺序补完这些缺失小节：${missing.join("、")}；`,
    continueRest: "- 并完成文档剩余部分；",
    continueTail: "- 只输出 Markdown 正文，不要解释，不要写「（截断）」。",
    rewriteMissing: (missing) => `缺少这些小节：${missing.join("、")}`,
    rewriteTruncated: "输出在末尾被截断",
    rewriteHead: (why) => `上一次的交接文档不完整（${why}）。`,
    rewriteBody: "请重新完整输出整份交接文档，必须包含模板要求的全部小节；",
    rewriteCap: (maxTokens) => `不要因为长度自行截断，不要写「（截断）」；本任务允许输出到 ${String(maxTokens)} tokens。`,
    rewriteTail: "只输出 Markdown 正文。",
  },
  en: {
    continueHead: "You stopped part-way through the handoff document. Continue it from the exact break point:",
    continueBridge: "- finish the sentence you were in the middle of; do not repeat text or headings you already wrote;",
    continueMissing: (missing) => `- then complete the missing sections in template order: ${missing.join(", ")};`,
    continueRest: "- then finish the rest of the document;",
    continueTail: '- output the Markdown body only — no explanation, no "(truncated)".',
    rewriteMissing: (missing) => `missing sections: ${missing.join(", ")}`,
    rewriteTruncated: "the output was truncated at the end",
    rewriteHead: (why) => `The previous handoff document was incomplete (${why}).`,
    rewriteBody: "Write the whole handoff document again from the start and include every section the template asks for;",
    rewriteCap: (maxTokens) => `do not cut it short for length and do not write "(truncated)" — this task may output up to ${String(maxTokens)} tokens.`,
    rewriteTail: "Output the Markdown body only.",
  },
};

function instructionText(locale) {
  return INSTRUCTION_TEXT[locale === "en" ? "en" : "zh"];
}

/** User turn appended after the partial assistant document. */
export function continuationInstruction(validation, locale) {
  const text = instructionText(locale);
  const missing = validation?.missing ?? [];
  const lines = [text.continueHead, text.continueBridge];
  if (missing.length > 0) lines.push(text.continueMissing(missing));
  else lines.push(text.continueRest);
  lines.push(text.continueTail);
  return lines.join("\n");
}

/** User turn appended when a continuation still does not pass validation. */
export function rewriteInstruction(validation, maxTokens, locale) {
  const text = instructionText(locale);
  const missing = validation?.missing ?? [];
  const why = missing.length > 0 ? text.rewriteMissing(missing) : text.rewriteTruncated;
  return [
    text.rewriteHead(why),
    text.rewriteBody,
    text.rewriteCap(maxTokens),
    text.rewriteTail,
  ].join("\n");
}
