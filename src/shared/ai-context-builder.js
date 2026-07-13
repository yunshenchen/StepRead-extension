import { normalizeFormulaSelection } from "./formula-text-normalizer.js";
import {
  analyzeContextCapabilities,
  getAvailabilityNotesForContext
} from "./context-capabilities.js";

const DEFAULT_THREAD_CONTEXT_OPTIONS = {
  neighborBlockCount: 1,
  includeDocumentOutline: true,
  includeChapterTitle: true,
  includeSelectedBlock: true,
  includeAdjacentBlocks: true,
  includeCurrentChapterBlocks: false,
  includeThreadHistory: true,
  includeKnowledgeHighlights: true,
  chapterTextScope: "none",
  sectionSummaryScope: "none",
  qaHistoryScope: "current-thread"
};

const DEFAULT_KNOWLEDGE_CONTEXT_OPTIONS = {
  neighborBlockCount: 0,
  includeDocumentOutline: true,
  includeChapterTitle: true,
  includeSelectedBlock: true,
  includeAdjacentBlocks: false,
  includeCurrentChapterBlocks: false,
  includeThreadHistory: true,
  includeKnowledgeHighlights: true,
  includeFullText: false,
  fullTextScope: "none",
  sectionSummaryScope: "none",
  qaHistoryScope: "all-highlights"
};

const CONTEXT_SCHEMA_VERSION = "stepread-context-v2";

const CHAPTER_TEXT_SCOPES = new Set([
  "none",
  "current-section",
  "current-chapter",
  "previous-chapters",
  "full-text"
]);

const KNOWLEDGE_FULL_TEXT_SCOPES = new Set([
  "none",
  "full-text",
  "before-last-highlight"
]);

const SECTION_SUMMARY_SCOPES = new Set([
  "none",
  "current-section",
  "current-chapter",
  "previous-sections",
  "current-and-previous",
  "all-sections"
]);

const QA_HISTORY_SCOPES = new Set([
  "none",
  "current-thread",
  "all-highlights"
]);

export function buildThreadContext({
  documentRecord,
  documentTitle,
  blocks = [],
  highlight,
  thread,
  messages = [],
  highlights = [],
  threads = [],
  messagesByThread = {},
  summaries = [],
  question = "",
  options = {}
} = {}) {
  const contextOptions = resolveContextOptions(options, DEFAULT_THREAD_CONTEXT_OPTIONS);
  const parts = buildHighlightContextParts({
    documentRecord,
    blocks,
    highlight,
    thread,
    messages,
    highlights,
    threads,
    messagesByThread,
    summaries,
    options: contextOptions
  });
  const title = getDocumentTitle(documentRecord, documentTitle);
  const metadata = [
    "AI context package",
    `schema: ${CONTEXT_SCHEMA_VERSION}`,
    "mode: question_answer",
    `document.title: ${title}`,
    `highlight.id: ${highlight?.id || ""}`,
    `thread.id: ${thread?.id || highlight?.threadId || ""}`,
    contextOptions.includeChapterTitle && parts.chapterTitle ? `current chapter title: ${parts.chapterTitle}` : "",
    `highlight position: blockOrder=${parts.blockOrder}; start=${parts.startOffset}`,
    `question: ${normalizeContextText(question) || "No question provided."}`
  ].filter(Boolean).join("\n");

  let text = appendSection("", "context.metadata", metadata, { role: "package_metadata" });
  text = appendSection(text, "context.organization", getThreadContextOrganization(), { role: "source_map" });
  text = appendOptionalSection(text, "context.availability_notes", formatAvailabilityNotes(parts.availabilityNotes), {
    role: "source_availability"
  });
  if (contextOptions.includeDocumentOutline) {
    text = appendOptionalSection(text, "document.outline", formatDocumentOutline(parts.documentOutline), {
      role: "structural_map"
    });
  }
  text = appendSection(text, "highlight.selected_text", parts.selectedText, {
    role: "primary_evidence",
    priority: "1"
  });
  text = appendOptionalSection(text, "highlight.formula_text", formatFormulaContext(parts.formulaContext), {
    role: "formula_text_normalization",
    priority: "1"
  });
  if (contextOptions.includeSelectedBlock) {
    text = appendOptionalSection(text, "highlight.selected_blocks", formatBlocks(parts.selectedBlocks), {
      role: "primary_source_blocks",
      priority: "1"
    });
  }
  if (contextOptions.includeAdjacentBlocks) {
    text = appendOptionalSection(text, "highlight.adjacent_blocks", formatAdjacentBlocks(parts.previousBlocks, parts.nextBlocks), {
      role: "local_context",
      priority: "2"
    });
  }
  if (contextOptions.chapterTextScope === "current-section") {
    text = appendOptionalSection(text, "document.current_section_blocks", formatBlocks(parts.currentSectionBlocks), {
      role: "expanded_section_context",
      priority: "3"
    });
  }
  if (contextOptions.chapterTextScope === "current-chapter") {
    text = appendOptionalSection(text, "document.current_chapter_blocks", formatBlocks(parts.currentChapterBlocks), {
      role: "expanded_chapter_context",
      priority: "3"
    });
  }
  if (contextOptions.chapterTextScope === "previous-chapters") {
    text = appendOptionalSection(text, "document.previous_chapter_blocks", formatBlocks(parts.previousChapterBlocks), {
      role: "expanded_previous_chapter_context",
      priority: "3"
    });
  }
  if (contextOptions.chapterTextScope === "full-text") {
    text = appendOptionalSection(text, "document.full_text_blocks", formatBlocks(parts.fullTextBlocks), {
      role: "expanded_full_document_context",
      priority: "3"
    });
  }
  if (parts.messages.length) {
    text = appendOptionalSection(text, "thread.current_messages", formatMessages(parts.messages), {
      role: "current_interaction_history",
      priority: "4"
    });
  }
  if (parts.linearQaHistory.length) {
    text = appendOptionalSection(text, "document.linear_qa_history", formatLinearQaHistory(parts.linearQaHistory), {
      role: "related_interaction_history",
      priority: "5"
    });
  }
  text = appendSection(text, "context.answer_contract", getThreadAnswerContract(), { role: "output_contract" });
  text = wrapContextPackage("question_answer", text);

  return {
    text,
    charBudget: Number.POSITIVE_INFINITY,
    length: text.length,
    truncated: false,
    parts
  };
}

export function buildKnowledgeContext({
  documentRecord,
  blocks = [],
  highlights = [],
  threads = [],
  messagesByThread = {},
  summaries = [],
  userPrompt = "",
  options = {}
} = {}) {
  const contextOptions = resolveContextOptions(options, DEFAULT_KNOWLEDGE_CONTEXT_OPTIONS);
  const items = buildKnowledgeItems({ documentRecord, blocks, highlights, threads, messagesByThread, summaries, options: contextOptions });
  const title = getDocumentTitle(documentRecord);
  const orderedBlocks = normalizeBlocks(blocks);
  const documentOutline = buildDocumentOutline(orderedBlocks, documentRecord);
  const beforeLastHighlightBlocks = getBeforeLastHighlightBlocks(orderedBlocks, highlights);
  const capabilities = analyzeContextCapabilities({
    documentRecord,
    blocks: orderedBlocks,
    highlights,
    threads,
    messagesByThread,
    summaries
  });
  const availabilityNotes = getAvailabilityNotesForContext({
    capabilities,
    options: contextOptions,
    mode: "knowledge"
  });
  const header = [
    "Generate a text knowledge graph from the following reading records.",
    "",
    `schema: ${CONTEXT_SCHEMA_VERSION}`,
    "mode: knowledge_graph",
    `document.title: ${title}`,
    `evidence.counts: highlights=${highlights.length}; threads=${threads.length}; summaries=${summaries.length}`,
    `knowledge_graph_prompt: ${normalizeContextText(userPrompt) || "None"}`,
    "",
    "Output requirements:",
    "1. Answer in Chinese.",
    "2. Use headings, numbered lists, and short paragraphs instead of visual graph drawing.",
    "3. Link important claims to the user's highlights, earlier Q&A, or quoted document evidence in natural language. Do not expose internal highlight/thread/message/block ids.",
    "4. End with the next learning path."
  ].join("\n");

  let text = appendSection("", "knowledge.context.metadata", header, { role: "package_metadata" });
  text = appendSection(text, "knowledge.context.organization", getKnowledgeContextOrganization(), {
    role: "source_map"
  });
  text = appendOptionalSection(text, "knowledge.context.availability_notes", formatAvailabilityNotes(availabilityNotes), {
    role: "source_availability"
  });
  if (contextOptions.includeDocumentOutline) {
    text = appendOptionalSection(text, "document.outline", formatDocumentOutline(documentOutline), {
      role: "global_structural_map"
    });
  }
  if (contextOptions.fullTextScope === "full-text") {
    text = appendOptionalSection(text, "document.full_text_blocks", formatBlocks(orderedBlocks), {
      role: "optional_full_text"
    });
  }
  if (contextOptions.fullTextScope === "before-last-highlight") {
    text = appendOptionalSection(text, "document.before_last_highlight_blocks", formatBlocks(beforeLastHighlightBlocks), {
      role: "optional_pre_highlight_text"
    });
  }
  text = appendSection(text, "knowledge.output_contract", getKnowledgeOutputContract(), {
    role: "output_contract"
  });

  if (!contextOptions.includeKnowledgeHighlights) {
    text = appendOptionalSection(text, "knowledge.highlights", "History highlights are disabled in settings.", {
      role: "disabled_source"
    });
    return wrapContextPackage("knowledge_graph", text);
  }

  if (!items.length) {
    text = appendSection(text, "knowledge.empty", "No highlight or question history is available yet.", {
      role: "empty_source"
    });
    return wrapContextPackage("knowledge_graph", text);
  }

  for (const [index, item] of items.entries()) {
    text = appendOptionalSection(
      text,
      `knowledge.evidence_cluster.${index + 1}`,
      formatKnowledgeItem(item, index + 1, contextOptions),
      {
        role: "evidence_cluster",
        priority: String(index + 1)
      }
    );
  }

  return wrapContextPackage("knowledge_graph", text);
}

export function buildHighlightContextParts({
  documentRecord,
  blocks = [],
  highlight,
  thread,
  messages = [],
  highlights = [],
  threads = [],
  messagesByThread = {},
  summaries = [],
  options = {}
} = {}) {
  const contextOptions = resolveContextOptions(options, DEFAULT_THREAD_CONTEXT_OPTIONS);
  const orderedBlocks = normalizeBlocks(blocks);
  const selectedBlockIndexes = resolveSelectedBlockIndexes(orderedBlocks, highlight);
  const firstSelectedIndex = selectedBlockIndexes[0] ?? findBlockIndexByHighlight(orderedBlocks, highlight);
  const lastSelectedIndex = selectedBlockIndexes[selectedBlockIndexes.length - 1] ?? firstSelectedIndex;
  const selectedBlocks = selectedBlockIndexes.map((index) => orderedBlocks[index]).filter(Boolean);
  const currentSectionRange = getCurrentSectionRange(orderedBlocks, firstSelectedIndex);
  const currentChapterRange = getCurrentChapterRange(orderedBlocks, firstSelectedIndex);
  const previousChapterRange = getPreviousChapterRange(orderedBlocks, firstSelectedIndex);
  const previousBlocks = firstSelectedIndex >= 0
    ? orderedBlocks.slice(Math.max(0, firstSelectedIndex - contextOptions.neighborBlockCount), firstSelectedIndex)
    : [];
  const nextBlocks = lastSelectedIndex >= 0
    ? orderedBlocks.slice(lastSelectedIndex + 1, lastSelectedIndex + 1 + contextOptions.neighborBlockCount)
    : [];
  const history = prepareHistoryMessages(messages, contextOptions);
  const baseParts = {
    selectedText: getSelectedText(highlight, selectedBlocks),
    selectedBlocks,
    previousBlocks,
    nextBlocks,
    currentSectionBlocks: currentSectionRange.blocks,
    currentChapterBlocks: currentChapterRange.blocks,
    previousChapterBlocks: previousChapterRange.blocks,
    fullTextBlocks: orderedBlocks,
    documentOutline: buildDocumentOutline(orderedBlocks, documentRecord),
    chapterTitle: getCurrentChapterTitle(orderedBlocks, firstSelectedIndex),
    blockOrder: getBlockOrder(selectedBlocks[0], highlight),
    startOffset: getHighlightStartOffset(highlight, selectedBlocks[0]),
    currentSectionRange,
    currentChapterRange,
    previousChapterRange,
    formulaContext: normalizeHighlightFormulaContext(highlight),
    thread,
    messages: history.messages,
    droppedMessageCount: history.droppedMessageCount
  };
  const linearQaHistory = buildLinearQaHistory({
    blocks: orderedBlocks,
    currentHighlight: highlight,
    currentThread: thread,
    highlights,
    threads,
    messagesByThread,
    options: contextOptions
  });
  const parts = {
    ...baseParts,
    sectionSummaries: [],
    linearQaHistory
  };
  const capabilities = analyzeContextCapabilities({
    documentRecord,
    blocks: orderedBlocks,
    highlight,
    thread,
    messages,
    highlights,
    threads,
    messagesByThread,
    summaries
  });

  return {
    ...parts,
    capabilities,
    availabilityNotes: getAvailabilityNotesForContext({
      capabilities,
      options: contextOptions,
      mode: "selection",
      sectionSummariesAvailable: false
    })
  };
}

export function buildKnowledgeItems({
  documentRecord,
  blocks = [],
  highlights = [],
  threads = [],
  messagesByThread = {},
  summaries = [],
  options = {}
} = {}) {
  const orderedBlocks = normalizeBlocks(blocks);
  const blocksById = new Map(orderedBlocks.map((block) => [block.id, block]));
  const threadsByHighlightId = new Map((threads || []).map((thread) => [thread.highlightId, thread]));
  const summariesByThreadId = groupSummariesByThreadId(summaries);
  const resolvedOptions = resolveContextOptions(options, DEFAULT_KNOWLEDGE_CONTEXT_OPTIONS);
  const knowledgeOptions = {
    ...resolvedOptions,
    chapterTextScope: "none",
    fullTextScope: "none",
    includeCurrentChapterBlocks: false,
    sectionSummaryScope: "none",
    qaHistoryScope: "current-thread"
  };

  return (highlights || [])
    .map((highlight) => {
      const thread = threadsByHighlightId.get(highlight.id);
      const messages = thread ? messagesByThread?.[thread.id] || [] : [];
      const selectedBlock = blocksById.get(highlight?.blockId);
      const parts = buildHighlightContextParts({
        documentRecord,
        blocks: orderedBlocks,
        highlight,
        thread,
        messages,
        highlights,
        threads,
        messagesByThread,
        summaries,
        options: knowledgeOptions
      });
      return {
        highlight,
        thread,
        parts,
        summaries: thread ? summariesByThreadId.get(thread.id) || [] : [],
        blockOrder: getBlockOrder(selectedBlock, highlight),
        startOffset: getHighlightStartOffset(highlight, selectedBlock)
      };
    })
    .sort(
      (a, b) =>
        a.blockOrder - b.blockOrder ||
        a.startOffset - b.startOffset ||
        String(a.highlight?.createdAt || "").localeCompare(String(b.highlight?.createdAt || ""))
    );
}

export function getBlockText(block) {
  if (!block) {
    return "";
  }
  const blockType = getBlockType(block);
  if (blockType === "list" && Array.isArray(block.items)) {
    return normalizeContextText(block.items.join("\n"));
  }
  if (blockType === "image") {
    return normalizeContextText(block.caption || block.alt || "");
  }
  if (blockType === "table_html") {
    return normalizeContextText(block.text || block.caption || tableHtmlToPlainText(block.table_html || block.tableHtml || ""));
  }
  return normalizeContextText(
    block.text ||
    block.plainText ||
    block.contentText ||
    block.content ||
    block.title ||
    block.caption ||
    block.table_html ||
    block.tableHtml ||
    ""
  );
}

export function clipText(value, maxLength) {
  const text = normalizeContextText(value);
  const length = Math.max(0, Number(maxLength) || 0);
  if (!length || text.length <= length) {
    return text;
  }

  const marker = "\n[truncated]";
  if (length <= marker.length) {
    return text.slice(0, length);
  }
  return `${text.slice(0, length - marker.length)}${marker}`;
}

function formatKnowledgeItem(item, index, options) {
  const header = [
    `evidence_cluster.index: ${index}`,
    "evidence_cluster.role: one highlight plus its local source text and Q&A trail",
    `highlight.id: ${item.highlight?.id || ""}`,
    `thread.id: ${item.thread?.id || item.highlight?.threadId || ""}`,
    options.includeChapterTitle && item.parts.chapterTitle ? `current chapter title: ${item.parts.chapterTitle}` : "",
    `position: blockOrder=${item.blockOrder}; start=${item.startOffset}`
  ].filter(Boolean).join("\n");
  let text = appendSection("", "metadata", header, { role: "cluster_metadata" });
  text = appendSection(text, "highlight.selected_text", item.parts.selectedText, {
    role: "cluster_primary_evidence"
  });
  text = appendOptionalSection(text, "highlight.formula_text", formatFormulaContext(item.parts.formulaContext), {
    role: "cluster_formula_text_normalization"
  });
  if (options.includeSelectedBlock) {
    text = appendOptionalSection(text, "highlight.selected_blocks", formatBlocks(item.parts.selectedBlocks), {
      role: "cluster_source_blocks"
    });
  }
  if (options.includeAdjacentBlocks) {
    text = appendOptionalSection(text, "highlight.adjacent_blocks", formatAdjacentBlocks(item.parts.previousBlocks, item.parts.nextBlocks), {
      role: "cluster_local_context"
    });
  }
  if (options.includeCurrentChapterBlocks) {
    text = appendOptionalSection(text, "document.current_chapter_blocks", formatBlocks(item.parts.currentChapterBlocks), {
      role: "cluster_expanded_chapter_context"
    });
  }
  if (item.parts.messages.length) {
    text = appendOptionalSection(text, "thread.messages", formatMessages(item.parts.messages), {
      role: "cluster_interaction_history"
    });
  }
  if (item.summaries?.length) {
    text = appendOptionalSection(text, "thread.summaries", formatSummaries(item.summaries), {
      role: "cluster_turn_summaries"
    });
  }
  return `[highlight ${index}]\n${text}`;
}

function formatBlocks(blocks) {
  return (blocks || [])
    .map((block) => formatBlock(block))
    .filter(Boolean)
    .join("\n\n");
}

function formatAdjacentBlocks(previousBlocks, nextBlocks) {
  const lines = [];
  for (const block of previousBlocks || []) {
    lines.push(`previous ${formatBlock(block)}`);
  }
  for (const block of nextBlocks || []) {
    lines.push(`next ${formatBlock(block)}`);
  }
  return lines.filter(Boolean).join("\n\n");
}

function formatBlock(block) {
  if (!block) {
    return "";
  }
  const text = getBlockText(block);
  if (!text) {
    return "";
  }
  const lines = [
    `[source_block id="${escapeAttribute(block.id || "")}" order="${escapeAttribute(getBlockOrder(block))}" type="${escapeAttribute(getBlockType(block))}"]`,
    text
  ];
  const mathNotes = formatBlockMathNotes(block, text);
  if (mathNotes) {
    lines.push(mathNotes);
  }
  return lines.join("\n");
}

function formatMessages(messages) {
  const lines = [];
  for (const [index, message] of (messages || []).entries()) {
    lines.push(
      [
        `[message index="${index + 1}" id="${escapeAttribute(message.id || "")}" role="${escapeAttribute(message.role || "")}" createdAt="${escapeAttribute(message.createdAt || "")}"]`,
        normalizeContextText(message.content)
      ].join("\n")
    );
  }

  return lines.join("\n\n");
}

function formatFormulaContext(formulaContext) {
  if (!formulaContext?.hasFormulaSignals) {
    return "";
  }
  const fragments = (formulaContext.formulaFragments || [])
    .map((fragment, index) =>
      [
        `[formula_fragment index="${index + 1}" signals="${escapeAttribute((fragment.signals || []).join(","))}"]`,
        `raw: ${normalizeContextText(fragment.raw)}`,
        `normalized: ${normalizeContextText(fragment.normalized)}`
      ].join("\n")
    )
    .join("\n\n");

  return [
    "formula_boundary: browser selectable text layer only; no OCR; no image formula recognition; copied formulas may be incomplete.",
    "raw_text:",
    normalizeContextText(formulaContext.rawText),
    "",
    "normalized_text:",
    normalizeContextText(formulaContext.normalizedText),
    "",
    fragments ? `formula_fragments:\n${fragments}` : "",
    "",
    formulaContext.normalizationRules?.length
      ? `normalization_rules: ${formulaContext.normalizationRules.map((rule) => normalizeContextText(rule)).join(", ")}`
      : "",
    "",
    "formula_notes:",
    (formulaContext.notes || []).map((note) => `- ${normalizeContextText(note)}`).join("\n")
  ].filter(Boolean).join("\n");
}

function formatBlockMathNotes(block, visibleText = "") {
  const normalized = normalizeContextText(block?.mathNormalizedText || block?.normalizedText || "");
  if (!normalized || normalized === normalizeContextText(visibleText)) {
    return "";
  }
  const raw = normalizeContextText(block?.rawText || visibleText);
  const signals = Array.isArray(block?.mathNormalizationSignals) ? block.mathNormalizationSignals : [];
  const notes = Array.isArray(block?.mathNormalizationNotes) ? block.mathNormalizationNotes : [];
  return [
    "[block_math_normalization source=\"pdf-text-layer\"]",
    "raw_text:",
    raw,
    "",
    "normalized_text:",
    normalized,
    "",
    signals.length ? `detected_signals: ${signals.map((signal) => normalizeContextText(signal)).join(", ")}` : "",
    notes.length ? `notes:\n${notes.map((note) => `- ${normalizeContextText(note)}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");
}

function formatAvailabilityNotes(notes) {
  return (notes || [])
    .map((note) => normalizeContextText(note))
    .filter(Boolean)
    .map((note) => `- ${note}`)
    .join("\n");
}

function formatSummaries(summaries) {
  return (summaries || [])
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .map((summary, index) => {
      const evidence = summary.evidence || {};
      return [
        `[qa_summary index="${index + 1}" id="${escapeAttribute(summary.id || "")}" type="${escapeAttribute(summary.summaryType || "")}" highlight.id="${escapeAttribute(summary.highlightId || "")}" thread.id="${escapeAttribute(summary.threadId || "")}" message.id="${escapeAttribute(summary.messageId || "")}" createdAt="${escapeAttribute(summary.createdAt || "")}"]`,
        evidence.messageIds?.length ? `message_ids: ${evidence.messageIds.join(", ")}` : "",
        evidence.blockIds?.length ? `block_ids: ${evidence.blockIds.join(", ")}` : "",
        normalizeContextText(summary.text)
      ].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatSectionSummaries(summaries) {
  return (summaries || [])
    .map((summary, index) => {
      const title = summary.title || `section ${index + 1}`;
      const path = Array.isArray(summary.path) ? summary.path.join(" > ") : summary.path || "";
      const orderRange = Number.isFinite(summary.startOrder) || Number.isFinite(summary.endOrder)
        ? `startOrder=${summary.startOrder}; endOrder=${summary.endOrder}`
        : "";
      const body = summary.summary || summary.text || "";
      return [
        `[section_summary index="${index + 1}" id="${escapeAttribute(summary.id || "")}" title="${escapeAttribute(title)}"]`,
        path ? `path=${path}` : "",
        summary.chapterTitle ? `chapter=${summary.chapterTitle}` : "",
        orderRange,
        normalizeContextText(body)
      ].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function formatLinearQaHistory(items) {
  return (items || [])
    .map((item, index) => {
      const text = [
        `[qa_history index="${index + 1}" highlight.id="${escapeAttribute(item.highlight?.id || "")}" thread.id="${escapeAttribute(item.thread?.id || "")}"]`,
        `position: blockOrder=${item.blockOrder}; start=${item.startOffset}`,
        `selected_text: ${normalizeContextText(item.highlight?.text || "")}`,
        formatMessages(item.messages)
      ].filter(Boolean).join("\n");
      return text;
    })
    .join("\n\n");
}

function buildHighlightAvailabilityNotes(parts, options = {}) {
  const notes = [];

  if (options.includeDocumentOutline && !parts.documentOutline?.length) {
    notes.push("document.outline unavailable: no heading or outline data was provided; do not infer a table of contents.");
  }
  if (options.includeChapterTitle && !parts.chapterTitle) {
    notes.push("current chapter title unavailable: no heading stack was found for this selection.");
  }
  if (options.chapterTextScope === "current-section" && !parts.currentSectionBlocks?.length) {
    notes.push("document.current_section_blocks unavailable: no section heading boundary was found; expanded section text is omitted.");
  }
  if (options.chapterTextScope === "current-chapter" && !parts.currentChapterBlocks?.length) {
    notes.push("document.current_chapter_blocks unavailable: no chapter heading boundary was found; expanded chapter text is omitted.");
  }
  if (options.chapterTextScope === "previous-chapters" && !parts.previousChapterBlocks?.length) {
    notes.push("document.previous_chapter_blocks unavailable: no earlier chapter blocks were found for this selection.");
  }
  if (options.chapterTextScope === "full-text" && !parts.fullTextBlocks?.length) {
    notes.push("document.full_text_blocks unavailable: no readable text blocks are available for this document.");
  }

  if (notes.length) {
    notes.push(`available_sources: ${getAvailableHighlightSourceNames(parts, options).join(", ")}.`);
  }
  return notes;
}

function buildKnowledgeAvailabilityNotes({
  contextOptions,
  documentOutline,
  documentSectionSummaries,
  items,
  summaries
} = {}) {
  const notes = [];

  if (contextOptions?.includeDocumentOutline && !documentOutline?.length) {
    notes.push("document.outline unavailable: no heading or outline data was provided; do not infer a table of contents.");
  }
  if (contextOptions?.includeCurrentChapterBlocks && !(items || []).some((item) => item.parts?.currentChapterBlocks?.length)) {
    notes.push("document.current_chapter_blocks unavailable: no chapter heading boundaries were found for the highlight clusters.");
  }
  if (contextOptions?.fullTextScope === "before-last-highlight" && !(items || []).length) {
    notes.push("document.before_last_highlight_blocks unavailable: no saved highlights can define the last highlight position.");
  }

  if (notes.length) {
    const availableSources = [];
    if (documentOutline?.length) {
      availableSources.push("document.outline");
    }
    if (contextOptions?.includeKnowledgeHighlights && (items || []).length) {
      availableSources.push("highlight evidence clusters");
    }
    if (contextOptions?.includeKnowledgeHighlights && (items || []).some((item) => item.parts?.messages?.length)) {
      availableSources.push("thread Q&A history");
    }
    if ((summaries || []).length) {
      availableSources.push("saved Q&A summaries");
    }
    if (contextOptions?.fullTextScope === "full-text") {
      availableSources.push("document.full_text_blocks");
    }
    if (contextOptions?.fullTextScope === "before-last-highlight") {
      availableSources.push("document.before_last_highlight_blocks");
    }
    if (!availableSources.length) {
      availableSources.push("no optional evidence sources are currently available");
    }
    notes.push(`available_sources: ${availableSources.join(", ")}.`);
  }
  return notes;
}

function getAvailableHighlightSourceNames(parts, options = {}) {
  const sources = ["highlight.selected_text"];
  if (options.includeDocumentOutline && parts.documentOutline?.length) {
    sources.push("document.outline");
  }
  if (options.includeChapterTitle && parts.chapterTitle) {
    sources.push("current chapter title");
  }
  if (options.includeSelectedBlock && parts.selectedBlocks?.length) {
    sources.push("highlight.selected_blocks");
  }
  if (options.includeAdjacentBlocks && (parts.previousBlocks?.length || parts.nextBlocks?.length)) {
    sources.push("highlight.adjacent_blocks");
  }
  if (options.chapterTextScope === "current-section" && parts.currentSectionBlocks?.length) {
    sources.push("document.current_section_blocks");
  }
  if (options.chapterTextScope === "current-chapter" && parts.currentChapterBlocks?.length) {
    sources.push("document.current_chapter_blocks");
  }
  if (options.chapterTextScope === "previous-chapters" && parts.previousChapterBlocks?.length) {
    sources.push("document.previous_chapter_blocks");
  }
  if (options.chapterTextScope === "full-text" && parts.fullTextBlocks?.length) {
    sources.push("document.full_text_blocks");
  }
  if (parts.messages?.length) {
    sources.push("thread.current_messages");
  }
  if (parts.linearQaHistory?.length) {
    sources.push("document.linear_qa_history");
  }
  return sources;
}

function prepareHistoryMessages(messages, options) {
  const historyMessages = (messages || [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  if (!options.includeThreadHistory || options.qaHistoryScope === "none") {
    return {
      messages: [],
      droppedMessageCount: historyMessages.length
    };
  }
  return {
    messages: historyMessages,
    droppedMessageCount: 0
  };
}

function normalizeHighlightFormulaContext(highlight) {
  const existing = highlight?.formulaContext || highlight?.formulaText || null;
  if (existing?.hasFormulaSignals || existing?.normalizedText || existing?.formulaFragments?.length) {
    return {
      rawText: existing.rawText || highlight?.text || "",
      normalizedText: existing.normalizedText || existing.normalized || highlight?.normalizedText || "",
      formulaFragments: Array.isArray(existing.formulaFragments) ? existing.formulaFragments : [],
      notes: Array.isArray(existing.notes) ? existing.notes : [],
      signals: Array.isArray(existing.signals) ? existing.signals : [],
      normalizationRules: Array.isArray(existing.normalizationRules) ? existing.normalizationRules : [],
      hasFormulaSignals: Boolean(existing.hasFormulaSignals || existing.normalizedText || existing.normalized || existing.formulaFragments?.length)
    };
  }
  if (highlight?.mathNormalizedText || highlight?.normalizedText) {
    const rawText = highlight.rawText || highlight.text || "";
    const normalizedText = highlight.mathNormalizedText || highlight.normalizedText || "";
    return {
      rawText,
      normalizedText,
      formulaFragments: [
        {
          raw: rawText,
          normalized: normalizedText,
          signals: Array.isArray(highlight.mathNormalizationSignals) ? highlight.mathNormalizationSignals : []
        }
      ],
      notes: Array.isArray(highlight.mathNormalizationNotes) ? highlight.mathNormalizationNotes : [],
      signals: Array.isArray(highlight.mathNormalizationSignals) ? highlight.mathNormalizationSignals : [],
      normalizationRules: Array.isArray(highlight.mathNormalizationRules) ? highlight.mathNormalizationRules : [],
      hasFormulaSignals: Boolean(normalizedText)
    };
  }
  return normalizeFormulaSelection(highlight?.text || "");
}

function groupSummariesByThreadId(summaries) {
  const grouped = new Map();
  for (const summary of summaries || []) {
    if (!summary?.threadId) {
      continue;
    }
    const list = grouped.get(summary.threadId) || [];
    list.push(summary);
    grouped.set(summary.threadId, list);
  }
  return grouped;
}

function buildLinearQaHistory({
  blocks = [],
  currentHighlight,
  currentThread,
  highlights = [],
  threads = [],
  messagesByThread = {},
  options = {}
} = {}) {
  if (!options.includeThreadHistory || options.qaHistoryScope === "none" || options.qaHistoryScope === "current-thread") {
    return [];
  }

  const threadsByHighlightId = new Map((threads || []).map((thread) => [thread.highlightId, thread]));
  const currentPosition = getHighlightSortPosition(currentHighlight, blocks);
  return (highlights || [])
    .filter((highlight) => highlight?.id && highlight.id !== currentHighlight?.id)
    .map((highlight) => {
      const thread = threadsByHighlightId.get(highlight.id);
      const messages = thread ? prepareHistoryMessages(messagesByThread?.[thread.id] || [], options).messages : [];
      return {
        highlight,
        thread,
        messages,
        ...getHighlightSortPosition(highlight, blocks)
      };
    })
    .filter((item) => item.thread?.id && item.thread.id !== currentThread?.id)
    .filter((item) => item.messages.length)
    .filter((item) => options.qaHistoryScope === "all-highlights" || comparePositions(item, currentPosition) < 0)
    .sort(comparePositions);
}

function selectSectionSummaries(documentRecord, parts, scope, blocks = []) {
  if (scope === "none") {
    return [];
  }
  const summaries = getDocumentSectionSummaries(documentRecord, blocks);
  if (!summaries.length) {
    return [];
  }
  if (scope === "all-sections") {
    return summaries;
  }

  const current = findCurrentSectionSummary(summaries, parts.blockOrder);
  if (scope === "current-section") {
    return current ? [current] : [];
  }

  if (scope === "previous-sections") {
    return summaries.filter((summary) => summaryEndsBefore(summary, parts.blockOrder));
  }

  if (scope === "current-and-previous") {
    const previous = summaries.filter((summary) => summaryEndsBefore(summary, parts.blockOrder));
    return current && !previous.some((summary) => summary.id === current.id)
      ? [...previous, current]
      : previous;
  }

  if (scope === "current-chapter") {
    const chapterKey =
      getTopLevelChapterTitle(parts.chapterTitle) ||
      (current ? getSummaryChapterKey(current) : "");
    if (!chapterKey) {
      return current ? [current] : [];
    }
    return summaries.filter((summary) => getSummaryChapterKey(summary) === chapterKey);
  }

  return [];
}

function getDocumentSectionSummaries(documentRecord, blocks = []) {
  const candidates = [
    documentRecord?.sectionSummaries,
    documentRecord?.chapterSummaries,
    documentRecord?.summaries?.sections,
    documentRecord?.summaries?.chapters,
    documentRecord?.summary?.sections,
    documentRecord?.summary?.chapters,
    documentRecord?.reader?.sectionSummaries,
    documentRecord?.reader?.chapterSummaries,
    documentRecord?.structure?.sectionSummaries,
    documentRecord?.structure?.chapterSummaries,
    documentRecord?.pdf?.sectionSummaries,
    documentRecord?.pdf?.chapterSummaries,
    buildBlockSectionSummaries(blocks)
  ];
  const source = candidates.filter((value) => Array.isArray(value)).flat();
  const seen = new Set();
  const normalized = source
    .map((summary, index) => normalizeSectionSummary(summary, index))
    .filter((summary) => summary.summary || summary.text)
    .filter((summary) => {
      const key = summary.id || `${summary.title}-${summary.startOrder}-${summary.endOrder}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startOrder - b.startOrder || a.endOrder - b.endOrder || a.index - b.index);
  return inferMissingChapterTitles(normalized);
}

function buildBlockSectionSummaries(blocks = []) {
  const orderedBlocks = normalizeBlocks(blocks);
  return orderedBlocks
    .map((block, index) => {
      if (!isHeadingBlock(block)) {
        return null;
      }
      const summary = getBlockSummaryText(block);
      if (!summary) {
        return null;
      }
      const level = getHeadingLevel(block);
      const startOrder = getBlockOrder(block);
      let endOrder = startOrder;
      for (let nextIndex = index + 1; nextIndex < orderedBlocks.length; nextIndex += 1) {
        const nextBlock = orderedBlocks[nextIndex];
        if (isHeadingBlock(nextBlock) && getHeadingLevel(nextBlock) <= level) {
          break;
        }
        endOrder = getBlockOrder(nextBlock);
      }
      const path = getHeadingPathAtIndex(orderedBlocks, index);
      return {
        id: block.summaryId || block.sectionSummaryId || block.chapterSummaryId || `${block.id || `heading-${index}`}-summary`,
        blockId: block.id || "",
        headingId: block.id || "",
        title: getHeadingTitle(block) || path[path.length - 1] || "",
        path,
        chapterTitle: path[0] || "",
        level,
        startOrder,
        endOrder,
        summary,
        source: "block.summary"
      };
    })
    .filter(Boolean);
}

function getBlockSummaryText(block) {
  const summary = block?.summary;
  if (typeof summary === "string") {
    return normalizeContextText(summary);
  }
  if (summary && typeof summary === "object") {
    return normalizeContextText(summary.summary || summary.text || summary.content || summary.abstract || "");
  }
  return normalizeContextText(block?.summaryText || block?.sectionSummary || block?.chapterSummary || block?.abstract || block?.aiSummary || "");
}

function normalizeSectionSummary(summary, index) {
  const path = Array.isArray(summary?.path)
    ? summary.path.map((entry) => normalizeContextText(entry)).filter(Boolean)
    : normalizeContextText(summary?.path || "")
      .split(">")
      .map((entry) => normalizeContextText(entry))
      .filter(Boolean);
  const startOrder = firstFiniteNumber(
    summary?.startOrder,
    summary?.blockStartOrder,
    summary?.startBlockOrder,
    summary?.startBlock?.order,
    summary?.blockOrder,
    summary?.order,
    index
  );
  const endOrder = firstFiniteNumber(
    summary?.endOrder,
    summary?.blockEndOrder,
    summary?.endBlockOrder,
    summary?.endBlock?.order,
    startOrder
  );
  return {
    ...summary,
    id: summary?.id || summary?.sectionId || summary?.headingId || `section-summary-${index + 1}`,
    index,
    title: normalizeContextText(summary?.title || summary?.heading || summary?.name || path[path.length - 1] || ""),
    path,
    chapterTitle: normalizeContextText(summary?.chapterTitle || summary?.chapter || path[0] || ""),
    level: firstFiniteNumber(summary?.level, path.length || 1),
    startOrder,
    endOrder,
    summary: normalizeContextText(summary?.summary || summary?.abstract || summary?.content || ""),
    text: normalizeContextText(summary?.text || "")
  };
}

function inferMissingChapterTitles(summaries) {
  let currentChapterTitle = "";
  return summaries.map((summary) => {
    const level = Number.isFinite(summary.level) ? summary.level : 2;
    if (level <= 1 && summary.title) {
      currentChapterTitle = summary.title;
    }
    if (summary.chapterTitle || !currentChapterTitle) {
      return summary;
    }
    return {
      ...summary,
      chapterTitle: currentChapterTitle
    };
  });
}

function findCurrentSectionSummary(summaries, blockOrder) {
  const containing = summaries
    .filter((summary) => summaryContainsBlock(summary, blockOrder))
    .sort((a, b) =>
      b.startOrder - a.startOrder ||
      b.level - a.level ||
      a.endOrder - b.endOrder ||
      a.index - b.index
    )[0];
  if (containing) {
    return containing;
  }
  const previous = summaries
    .filter((summary) => Number.isFinite(summary.startOrder) && summary.startOrder <= blockOrder)
    .sort((a, b) => b.startOrder - a.startOrder || b.endOrder - a.endOrder)[0];
  return previous || null;
}

function summaryContainsBlock(summary, blockOrder) {
  return Number.isFinite(blockOrder) &&
    Number.isFinite(summary.startOrder) &&
    Number.isFinite(summary.endOrder) &&
    summary.startOrder <= blockOrder &&
    summary.endOrder >= blockOrder;
}

function summaryEndsBefore(summary, blockOrder) {
  const endOrder = Number.isFinite(summary.endOrder) ? summary.endOrder : summary.startOrder;
  return Number.isFinite(endOrder) && Number.isFinite(blockOrder) && endOrder < blockOrder;
}

function getSummaryChapterKey(summary) {
  if (summary?.chapterTitle) {
    return summary.chapterTitle;
  }
  if (Array.isArray(summary?.path) && summary.path.length) {
    return summary.path[0];
  }
  if (summary?.level === 1) {
    return summary.title;
  }
  return "";
}

function getTopLevelChapterTitle(chapterTitle) {
  return normalizeContextText(chapterTitle).split(">").map((part) => normalizeContextText(part)).find(Boolean) || "";
}

function getHighlightSortPosition(highlight, blocks) {
  const block = blocks.find((entry) => entry.id === highlight?.blockId);
  return {
    blockOrder: getBlockOrder(block, highlight),
    startOffset: getHighlightStartOffset(highlight, block)
  };
}

function getBeforeLastHighlightBlocks(orderedBlocks, highlights = []) {
  const lastPosition = (highlights || [])
    .map((highlight) => ({
      highlight,
      ...getHighlightSortPosition(highlight, orderedBlocks)
    }))
    .filter((position) => Number.isFinite(position.blockOrder) && position.blockOrder !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => b.blockOrder - a.blockOrder || b.startOffset - a.startOffset)[0];
  if (!lastPosition) {
    return [];
  }
  const previousBlocks = orderedBlocks.filter((block) => getBlockOrder(block) < lastPosition.blockOrder);
  const anchorBlock = findHighlightBlock(orderedBlocks, lastPosition.highlight, lastPosition.blockOrder);
  const prefixBlock = createBlockPrefixBeforeHighlight(anchorBlock, lastPosition.highlight);
  return prefixBlock ? [...previousBlocks, prefixBlock] : previousBlocks;
}

function findHighlightBlock(orderedBlocks, highlight, blockOrder) {
  if (highlight?.blockId) {
    const directBlock = orderedBlocks.find((block) => block.id === highlight.blockId);
    if (directBlock) {
      return directBlock;
    }
  }
  const ranges = Array.isArray(highlight?.blockRanges) ? highlight.blockRanges : [];
  for (const range of ranges) {
    if (!range?.blockId) {
      continue;
    }
    const rangeBlock = orderedBlocks.find((block) => block.id === range.blockId);
    if (rangeBlock) {
      return rangeBlock;
    }
  }
  return orderedBlocks.find((block) => getBlockOrder(block) === blockOrder) || null;
}

function createBlockPrefixBeforeHighlight(block, highlight) {
  if (!block) {
    return null;
  }
  const blockText = getBlockText(block);
  const startOffset = getHighlightLocalStartOffset(highlight, block, blockText);
  if (!blockText || !Number.isFinite(startOffset) || startOffset <= 0) {
    return null;
  }
  const prefixText = normalizeContextText(blockText.slice(0, Math.min(startOffset, blockText.length)));
  if (!prefixText) {
    return null;
  }
  return {
    ...block,
    text: prefixText
  };
}

function getHighlightLocalStartOffset(highlight, block, blockText = getBlockText(block)) {
  const ranges = Array.isArray(highlight?.blockRanges) ? highlight.blockRanges : [];
  const range = ranges.find((item) => item?.blockId && item.blockId === block?.id) || ranges[0];
  if (Number.isFinite(range?.localStartOffset)) {
    return range.localStartOffset;
  }
  if (Number.isFinite(highlight?.localStartOffset)) {
    return highlight.localStartOffset;
  }
  for (const value of [range?.startOffset, highlight?.startOffset]) {
    if (Number.isFinite(value) && value >= 0 && value <= blockText.length) {
      return value;
    }
  }
  const selectedText = normalizeContextText(range?.text || highlight?.text || "");
  const localIndex = selectedText ? blockText.indexOf(selectedText) : -1;
  return localIndex >= 0 ? localIndex : Number.MAX_SAFE_INTEGER;
}

function comparePositions(a, b) {
  return a.blockOrder - b.blockOrder || a.startOffset - b.startOffset;
}

function appendSection(current, title, body, attributes = {}) {
  const prefix = current ? "\n\n" : "";
  const cleanBody = normalizeContextText(body);
  if (!title) {
    return `${current}${prefix}${cleanBody}`;
  }
  const sectionAttributes = formatSectionAttributes({
    name: title,
    ...attributes
  });
  return `${current}${prefix}<section${sectionAttributes}>\n${cleanBody}\n</section>`;
}

function appendOptionalSection(current, title, body, attributes = {}) {
  const cleanBody = normalizeContextText(body);
  if (!cleanBody) {
    return current;
  }
  return appendSection(current, title, cleanBody, attributes);
}

function wrapContextPackage(kind, body) {
  return [
    `<stepread_context schema="${CONTEXT_SCHEMA_VERSION}" kind="${escapeAttribute(kind)}">`,
    body,
    "</stepread_context>"
  ].join("\n");
}

function getThreadContextOrganization() {
  return [
    "source_order:",
    "1. primary_evidence = highlight.selected_text and highlight.selected_blocks. Use this first.",
    "2. local_context = adjacent blocks around the selected text. Use it to resolve pronouns, terms, and immediate claims.",
    "3. structural_context = outline plus optional section, chapter, previous-chapter, or full-document text. Use it to place the selected text in the document argument.",
    "4. current_interaction_history = the user's current Q&A thread. Use it to preserve conversational continuity.",
    "5. related_interaction_history = other highlights and Q&A records. Use it only when it directly improves this answer.",
    "availability_rule: if context.availability_notes says a source is unavailable, do not invent that source.",
    "conflict_rule: if sources conflict, prefer primary_evidence over summaries and history.",
    "citation_rule: when possible, refer to source ids such as block ids, highlight ids, thread ids, or message ids."
  ].join("\n");
}

function getThreadAnswerContract() {
  return [
    "answer_target: answer the current question, not the whole document.",
    "must_use: primary_evidence when it is relevant.",
    "may_use: local_context, structural_context, and interaction history as supporting evidence.",
    "uncertainty_rule: if the provided context is insufficient, state what is missing instead of inventing evidence.",
    "language: Chinese unless the user asks otherwise."
  ].join("\n");
}

function getKnowledgeContextOrganization() {
  return [
    "source_order:",
    "1. global_map = document.outline. Use it to organize the whole knowledge graph when available.",
    "2. evidence_clusters = each highlight bundle. Treat each cluster as a traceable evidence unit.",
    "3. cluster_interaction_history = Q&A under a highlight. Use it to infer the user's current understanding and open questions.",
    "4. optional_full_text = full document blocks only when enabled. Use it for coverage, not as a replacement for highlight evidence.",
    "availability_rule: if availability notes say outline, full-text, or highlight-position text is unavailable, do not infer it.",
    "synthesis_rule: create concepts from repeated or central evidence, then connect concepts with definition, cause, contrast, prerequisite, example, or limitation relations.",
    "traceability_rule: attach important claims to highlight/thread/message/block ids when possible.",
    "gap_rule: separate stable conclusions from open questions and weakly supported interpretations."
  ].join("\n");
}

function getKnowledgeOutputContract() {
  return [
    "output_units:",
    "1. concept_nodes: core concepts, each with a short definition and supporting evidence phrased for the reader.",
    "2. relation_edges: relations between concepts, each with relation type and supporting evidence phrased for the reader.",
    "3. evidence_notes: important quotes or paraphrases from highlights and Q&A.",
    "4. uncertainty_gaps: claims that need more reading or questions.",
    "5. next_learning_path: the next questions or sections the user should investigate.",
    "language: Chinese unless the user asks otherwise."
  ].join("\n");
}

function formatSectionAttributes(attributes) {
  return Object.entries(attributes || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
    .join("");
}

function escapeAttribute(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function resolveContextOptions(options, defaults) {
  const source = options && typeof options === "object" ? options : {};
  const includeThreadHistory = booleanSetting(source.includeThreadHistory, defaults.includeThreadHistory);
  const chapterTextScope = enumSetting(
    source.chapterTextScope,
    source.includeCurrentChapterBlocks ? "current-chapter" : defaults.chapterTextScope,
    CHAPTER_TEXT_SCOPES
  );
  const fullTextScope = enumSetting(
    source.fullTextScope,
    source.includeFullText ? "full-text" : defaults.fullTextScope || "none",
    KNOWLEDGE_FULL_TEXT_SCOPES
  );
  return {
    ...defaults,
    ...source,
    neighborBlockCount: nonNegativeInteger(source.neighborBlockCount, defaults.neighborBlockCount),
    includeDocumentOutline: booleanSetting(source.includeDocumentOutline, defaults.includeDocumentOutline),
    includeChapterTitle: booleanSetting(source.includeChapterTitle, defaults.includeChapterTitle),
    includeSelectedBlock: booleanSetting(source.includeSelectedBlock, defaults.includeSelectedBlock),
    includeAdjacentBlocks: booleanSetting(source.includeAdjacentBlocks, defaults.includeAdjacentBlocks),
    includeCurrentChapterBlocks: chapterTextScope === "current-chapter",
    includeThreadHistory,
    includeKnowledgeHighlights: booleanSetting(source.includeKnowledgeHighlights, defaults.includeKnowledgeHighlights),
    includeFullText: fullTextScope === "full-text",
    fullTextScope,
    chapterTextScope,
    sectionSummaryScope: "none",
    qaHistoryScope: includeThreadHistory
      ? enumSetting(source.qaHistoryScope, defaults.qaHistoryScope, QA_HISTORY_SCOPES)
      : "none"
  };
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function booleanSetting(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function enumSetting(value, fallback, allowedValues) {
  const normalized = String(value || "");
  return allowedValues.has(normalized) ? normalized : fallback;
}

function getBlockType(block) {
  return normalizeContextText(block?.type || block?.kind || block?.role || "unknown").toLowerCase();
}

function normalizeBlocks(blocks) {
  return (blocks || [])
    .map((block, index) => ({
      ...block,
      _contextIndex: index,
      _contextOrder: Number.isFinite(block?.order) ? block.order : index
    }))
    .sort((a, b) => a._contextOrder - b._contextOrder || a._contextIndex - b._contextIndex);
}

function resolveSelectedBlockIndexes(orderedBlocks, highlight) {
  const indexes = [];
  const ranges = Array.isArray(highlight?.blockRanges) ? highlight.blockRanges : [];
  const selectedIds = ranges.length ? ranges.map((range) => range.blockId).filter(Boolean) : [highlight?.blockId].filter(Boolean);
  const seen = new Set();

  for (const id of selectedIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const index = orderedBlocks.findIndex((block) => block.id === id);
    if (index >= 0) {
      indexes.push(index);
    }
  }

  if (indexes.length) {
    return indexes.sort((a, b) => a - b);
  }

  const fallbackIndex = findBlockIndexByHighlight(orderedBlocks, highlight);
  return fallbackIndex >= 0 ? [fallbackIndex] : [];
}

function findBlockIndexByHighlight(orderedBlocks, highlight) {
  if (!highlight) {
    return -1;
  }
  if (highlight.blockId) {
    const index = orderedBlocks.findIndex((block) => block.id === highlight.blockId);
    if (index >= 0) {
      return index;
    }
  }
  const blockOrder = getBlockOrder(null, highlight);
  if (Number.isFinite(blockOrder)) {
    return orderedBlocks.findIndex((block) => getBlockOrder(block) === blockOrder);
  }
  return -1;
}

function getSelectedText(highlight, selectedBlocks) {
  const explicitText = normalizeContextText(highlight?.text || "");
  if (explicitText) {
    return explicitText;
  }
  const rangeText = (Array.isArray(highlight?.blockRanges) ? highlight.blockRanges : [])
    .map((range) => range.text)
    .filter(Boolean)
    .join("\n");
  if (normalizeContextText(rangeText)) {
    return normalizeContextText(rangeText);
  }
  return formatBlocks(selectedBlocks) || "No selected text was available.";
}

function getCurrentChapterTitle(orderedBlocks, selectedIndex) {
  if (selectedIndex < 0) {
    return "";
  }
  const headingStack = getHeadingStackAtIndex(orderedBlocks, selectedIndex);
  return headingStack.map((heading) => heading.title).join(" > ");
}

function getCurrentSectionRange(orderedBlocks, selectedIndex) {
  return getCurrentHeadingRange(orderedBlocks, selectedIndex, "section");
}

function getCurrentChapterRange(orderedBlocks, selectedIndex) {
  return getCurrentHeadingRange(orderedBlocks, selectedIndex, "chapter");
}

function getPreviousChapterRange(orderedBlocks, selectedIndex) {
  const currentChapterRange = getCurrentChapterRange(orderedBlocks, selectedIndex);
  if (currentChapterRange.startIndex <= 0) {
    return { startIndex: 0, endIndex: 0, blocks: [] };
  }
  return {
    startIndex: 0,
    endIndex: currentChapterRange.startIndex,
    blocks: orderedBlocks.slice(0, currentChapterRange.startIndex)
  };
}

function getCurrentHeadingRange(orderedBlocks, selectedIndex, mode) {
  if (selectedIndex < 0 || !orderedBlocks.length) {
    return { startIndex: -1, endIndex: -1, blocks: [] };
  }

  const headingStack = getHeadingStackAtIndex(orderedBlocks, selectedIndex);
  if (!headingStack.length) {
    return { startIndex: -1, endIndex: -1, blocks: [] };
  }
  const heading = mode === "chapter" ? headingStack[0] : headingStack[headingStack.length - 1];
  const headingIndex = Number.isFinite(heading?.index) ? heading.index : -1;
  const headingLevel = Number.isFinite(heading?.level) ? heading.level : 1;

  const startIndex = headingIndex >= 0 ? headingIndex : 0;
  let endIndex = orderedBlocks.length;
  for (let index = startIndex + 1; index < orderedBlocks.length; index += 1) {
    const block = orderedBlocks[index];
    if (isHeadingBlock(block) && getHeadingLevel(block) <= headingLevel) {
      endIndex = index;
      break;
    }
  }

  return {
    startIndex,
    endIndex,
    blocks: orderedBlocks.slice(startIndex, endIndex)
  };
}

function getHeadingStackAtIndex(orderedBlocks, selectedIndex) {
  const headingStack = [];
  for (let index = 0; index <= selectedIndex; index += 1) {
    const block = orderedBlocks[index];
    if (!isHeadingBlock(block)) {
      continue;
    }
    const level = getHeadingLevel(block);
    while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop();
    }
    const title = getHeadingTitle(block);
    if (title) {
      headingStack.push({ index, level, title });
    }
  }
  return headingStack;
}

function getHeadingPathAtIndex(orderedBlocks, selectedIndex) {
  return getHeadingStackAtIndex(orderedBlocks, selectedIndex).map((heading) => heading.title);
}

function buildDocumentOutline(blocks, documentRecord) {
  const recordOutline = getDocumentRecordOutline(documentRecord);
  if (recordOutline.length) {
    return recordOutline;
  }
  return normalizeBlocks(blocks)
    .filter((block) => isHeadingBlock(block))
    .map((block) => ({
      id: block.id || "",
      order: getBlockOrder(block),
      level: getHeadingLevel(block),
      title: getHeadingTitle(block)
    }))
    .filter((item) => item.title);
}

function getDocumentRecordOutline(documentRecord) {
  const candidates = [
    documentRecord?.outline,
    documentRecord?.toc,
    documentRecord?.tableOfContents,
    documentRecord?.headings,
    documentRecord?.reader?.outline,
    documentRecord?.reader?.toc,
    documentRecord?.reader?.headings,
    documentRecord?.structure?.outline,
    documentRecord?.structure?.toc,
    documentRecord?.metadata?.outline,
    documentRecord?.pdf?.outline,
    documentRecord?.pdf?.toc,
    documentRecord?.pdf?.tableOfContents
  ];
  const source = candidates.filter((value) => Array.isArray(value)).flat();
  const seen = new Set();
  return source
    .map((item, index) => normalizeOutlineItem(item, index))
    .filter((item) => item.title)
    .filter((item) => {
      const key = item.id || `${item.level}-${item.order}-${item.title}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.order - b.order || a.index - b.index);
}

function normalizeOutlineItem(item, index) {
  return {
    id: item?.id || item?.blockId || item?.headingId || "",
    index,
    order: firstFiniteNumber(item?.order, item?.blockOrder, item?.startOrder, item?.page, index),
    level: clampHeadingLevel(item?.level ?? item?.depth ?? item?.headingLevel ?? 1),
    title: normalizeContextText(item?.title || item?.text || item?.heading || item?.name || item?.label || "")
  };
}

function formatDocumentOutline(outline) {
  return (outline || [])
    .map((item) => {
      const indent = "  ".repeat(Math.max(0, item.level - 1));
      return `${indent}[outline_item level="${item.level}" order="${escapeAttribute(item.order)}" id="${escapeAttribute(item.id)}"]\n${indent}${item.title}`;
    })
    .join("\n");
}

function clampHeadingLevel(value) {
  const level = Number(value);
  if (!Number.isFinite(level)) {
    return 2;
  }
  return Math.min(Math.max(Math.floor(level), 1), 6);
}

function isHeadingBlock(block) {
  const type = String(block?.type || block?.kind || block?.role || "").toLowerCase();
  if (type === "heading" || type === "title" || type === "section-heading" || type === "section_title") {
    return true;
  }
  return Boolean(
    block?.isHeading ||
    block?.heading ||
    Number.isFinite(Number(block?.headingLevel)) ||
    Number.isFinite(Number(block?.outlineLevel))
  ) && getHeadingTitle(block);
}

function getHeadingLevel(block) {
  return clampHeadingLevel(block?.level ?? block?.headingLevel ?? block?.depth ?? block?.outlineLevel ?? 2);
}

function getHeadingTitle(block) {
  const heading = block?.heading;
  if (typeof heading === "string") {
    return normalizeContextText(heading);
  }
  if (heading && typeof heading === "object") {
    return normalizeContextText(heading.title || heading.text || heading.name || "");
  }
  return normalizeContextText(block?.title || block?.headingText || block?.text || block?.name || "");
}

function getDocumentTitle(documentRecord, documentTitle) {
  return normalizeContextText(documentRecord?.title || documentTitle || "Untitled document");
}

function getBlockOrder(block, highlight) {
  if (Number.isFinite(highlight?.blockOrder)) {
    return highlight.blockOrder;
  }
  const firstRange = Array.isArray(highlight?.blockRanges) ? highlight.blockRanges[0] : null;
  if (Number.isFinite(firstRange?.blockOrder)) {
    return firstRange.blockOrder;
  }
  if (Number.isFinite(block?.order)) {
    return block.order;
  }
  if (Number.isFinite(block?._contextOrder)) {
    return block._contextOrder;
  }
  return Number.MAX_SAFE_INTEGER;
}

function getHighlightStartOffset(highlight, block) {
  if (Number.isFinite(highlight?.globalStartOffset)) {
    return highlight.globalStartOffset;
  }
  if (Number.isFinite(highlight?.startOffset)) {
    return highlight.startOffset;
  }
  if (Number.isFinite(highlight?.localStartOffset)) {
    return highlight.localStartOffset;
  }
  const blockText = getBlockText(block);
  const selectedText = normalizeContextText(highlight?.text || "");
  const localIndex = selectedText ? blockText.indexOf(selectedText) : -1;
  return localIndex >= 0 ? localIndex : Number.MAX_SAFE_INTEGER;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

function normalizeContextText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tableHtmlToPlainText(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(caption|p|div|tr|li|h[1-6])\s*>/gi, "\n")
      .replace(/<\/\s*(td|th)\s*>/gi, " ")
      .replace(/<[^>]+>/g, "")
  );
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
