const CHAPTER_TEXT_SCOPES = new Set(["none", "current-section", "current-chapter", "previous-chapters", "full-text"]);
const KNOWLEDGE_FULL_TEXT_SCOPES = new Set(["none", "full-text", "before-last-highlight"]);
const SECTION_SUMMARY_SCOPES = new Set([
  "none",
  "current-section",
  "current-chapter",
  "previous-sections",
  "current-and-previous",
  "all-sections"
]);

export function analyzeContextCapabilities({
  documentRecord,
  blocks = [],
  highlight,
  thread,
  messages = [],
  highlights = [],
  threads = [],
  messagesByThread = {},
  summaries = []
} = {}) {
  const orderedBlocks = normalizeBlocks(blocks);
  const selectedBlockIndexes = resolveSelectedBlockIndexes(orderedBlocks, highlight);
  const firstSelectedIndex = selectedBlockIndexes[0] ?? findBlockIndexByHighlight(orderedBlocks, highlight);
  const lastSelectedIndex = selectedBlockIndexes[selectedBlockIndexes.length - 1] ?? firstSelectedIndex;
  const selectedBlocks = selectedBlockIndexes.map((index) => orderedBlocks[index]).filter(Boolean);
  const previousBlocks = firstSelectedIndex >= 0 ? orderedBlocks.slice(Math.max(0, firstSelectedIndex - 1), firstSelectedIndex) : [];
  const nextBlocks = lastSelectedIndex >= 0 ? orderedBlocks.slice(lastSelectedIndex + 1, lastSelectedIndex + 2) : [];
  const documentOutline = buildDocumentOutline(orderedBlocks, documentRecord);
  const hasHeadingBoundary = orderedBlocks.some((block) => isHeadingBlock(block));
  const chapterTitle = firstSelectedIndex >= 0 ? getCurrentChapterTitle(orderedBlocks, firstSelectedIndex) : "";
  const currentSectionRange = firstSelectedIndex >= 0
    ? getCurrentSectionRange(orderedBlocks, firstSelectedIndex)
    : { startIndex: -1, endIndex: -1, blocks: [] };
  const currentChapterRange = firstSelectedIndex >= 0
    ? getCurrentChapterRange(orderedBlocks, firstSelectedIndex)
    : { startIndex: -1, endIndex: -1, blocks: [] };
  const previousChapterRange = firstSelectedIndex >= 0
    ? getPreviousChapterRange(orderedBlocks, firstSelectedIndex)
    : { startIndex: -1, endIndex: -1, blocks: [] };
  const sectionSummaries = getDocumentSectionSummaries(documentRecord, orderedBlocks);
  const currentThreadMessages = prepareHistoryMessages(messages).messages;
  const allThreadMessages = collectThreadMessages({ messages, threads, messagesByThread });
  const qaSummaries = (summaries || []).filter((summary) => isQaSummary(summary));
  const selectedText = getSelectedText(highlight, selectedBlocks);
  const textBlocks = orderedBlocks.filter((block) => getBlockText(block));
  const beforeLastHighlightBlocks = getBeforeLastHighlightBlocks(orderedBlocks, highlights);

  return {
    documentId: documentRecord?.id || highlight?.documentId || thread?.documentId || "",
    hasDocumentRecord: Boolean(documentRecord && typeof documentRecord === "object"),
    hasSelection: Boolean(highlight || selectedText || selectedBlocks.length),
    structure: {
      hasHeadingBoundary,
      hasDocumentOutline: documentOutline.length > 0,
      documentOutline,
      chapterTitle,
      sectionSummaries,
      currentSectionRange,
      currentChapterRange,
      previousChapterRange
    },
    counts: {
      blocks: orderedBlocks.length,
      textBlocks: textBlocks.length,
      outlineItems: documentOutline.length,
      sectionSummaries: sectionSummaries.length,
      highlights: (highlights || []).length,
      threads: (threads || []).length,
      currentThreadMessages: currentThreadMessages.length,
      allThreadMessages: allThreadMessages.length,
      qaSummaries: qaSummaries.length
    },
    sources: {
      selectedText: Boolean(selectedText),
      selectedBlock: selectedBlocks.some((block) => getBlockText(block)),
      adjacentBlocks: [...previousBlocks, ...nextBlocks].some((block) => getBlockText(block)),
      fullText: textBlocks.length > 0,
      outline: documentOutline.length > 0,
      chapterTitle: firstSelectedIndex >= 0 ? Boolean(chapterTitle) : hasHeadingBoundary,
      currentSectionBlocks: firstSelectedIndex >= 0 ? currentSectionRange.blocks.length > 0 : hasHeadingBoundary,
      currentChapterBlocks: firstSelectedIndex >= 0 ? currentChapterRange.blocks.length > 0 : hasHeadingBoundary,
      previousChapterBlocks: firstSelectedIndex >= 0 ? previousChapterRange.blocks.length > 0 : hasHeadingBoundary,
      beforeLastHighlightBlocks: beforeLastHighlightBlocks.length > 0,
      sectionSummaries: sectionSummaries.length > 0,
      threadHistory: currentThreadMessages.length > 0 || allThreadMessages.length > 0 || qaSummaries.length > 0,
      knowledgeHighlights: (highlights || []).some((entry) => Boolean(entry?.id || normalizeContextText(entry?.text)))
    },
    details: {
      orderedBlocks,
      selectedBlocks,
      previousBlocks,
      nextBlocks,
      previousChapterBlocks: previousChapterRange.blocks,
      beforeLastHighlightBlocks,
      selectedText,
      currentThreadMessages,
      allThreadMessages,
      qaSummaries,
      blockOrder: getBlockOrder(selectedBlocks[0], highlight),
      startOffset: getHighlightStartOffset(highlight, selectedBlocks[0])
    }
  };
}

export function getAvailabilityNotesForContext({
  capabilities,
  options = {},
  mode = "selection",
  sectionSummariesAvailable = null
} = {}) {
  if (!capabilities) {
    return [];
  }

  return mode === "knowledge"
    ? getKnowledgeAvailabilityNotes(capabilities, options)
    : getSelectionAvailabilityNotes(capabilities, options, sectionSummariesAvailable);
}

export function getAvailableContextSourceNames({ capabilities, options = {}, mode = "selection" } = {}) {
  if (!capabilities) {
    return [];
  }
  return mode === "knowledge"
    ? getAvailableKnowledgeSourceNames(capabilities, options)
    : getAvailableSelectionSourceNames(capabilities, options);
}

export function sanitizeAiContextForCapabilities(context = {}, capabilities, { hasDocumentId = true } = {}) {
  if (!hasDocumentId || !capabilities || !isPlainObject(context)) {
    return context;
  }

  const hasSplitContext = isPlainObject(context.selection) || isPlainObject(context.knowledge);
  if (!hasSplitContext) {
    return sanitizeSelectionContextSettings(context, capabilities);
  }

  return {
    ...context,
    selection: sanitizeSelectionContextSettings(context.selection || {}, capabilities),
    knowledge: sanitizeKnowledgeContextSettings(context.knowledge || {}, capabilities)
  };
}

export function buildDocumentOutline(blocks = [], documentRecord) {
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

export function getDocumentSectionSummaries(documentRecord, blocks = []) {
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

export function selectSectionSummariesForScope({ documentRecord, blocks = [], blockOrder, chapterTitle = "", scope = "none" } = {}) {
  const normalizedScope = SECTION_SUMMARY_SCOPES.has(scope) ? scope : "none";
  if (normalizedScope === "none") {
    return [];
  }
  const summaries = getDocumentSectionSummaries(documentRecord, blocks);
  if (!summaries.length) {
    return [];
  }
  if (normalizedScope === "all-sections") {
    return summaries;
  }

  const current = findCurrentSectionSummary(summaries, blockOrder);
  if (normalizedScope === "current-section") {
    return current ? [current] : [];
  }

  if (normalizedScope === "previous-sections") {
    return summaries.filter((summary) => summaryEndsBefore(summary, blockOrder));
  }

  if (normalizedScope === "current-and-previous") {
    const previous = summaries.filter((summary) => summaryEndsBefore(summary, blockOrder));
    return current && !previous.some((summary) => summary.id === current.id)
      ? [...previous, current]
      : previous;
  }

  if (normalizedScope === "current-chapter") {
    const chapterKey =
      getTopLevelChapterTitle(chapterTitle) ||
      (current ? getSummaryChapterKey(current) : "");
    if (!chapterKey) {
      return current ? [current] : [];
    }
    return summaries.filter((summary) => getSummaryChapterKey(summary) === chapterKey);
  }

  return [];
}

export function normalizeBlocks(blocks = []) {
  return (blocks || [])
    .map((block, index) => ({
      ...block,
      _contextIndex: index,
      _contextOrder: Number.isFinite(block?.order) ? block.order : index
    }))
    .sort((a, b) => a._contextOrder - b._contextOrder || a._contextIndex - b._contextIndex);
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

function getSelectionAvailabilityNotes(capabilities, options, sectionSummariesAvailable) {
  const notes = [];
  const chapterTextScope = normalizeChapterTextScope(options.chapterTextScope, options.includeCurrentChapterBlocks);

  if (options.includeDocumentOutline && !capabilities.sources.outline) {
    notes.push("document.outline unavailable: no heading or outline data was provided; do not infer a table of contents.");
  }
  if (options.includeChapterTitle && !capabilities.sources.chapterTitle) {
    notes.push("current chapter title unavailable: no heading stack was found for this selection.");
  }
  if (chapterTextScope === "current-section" && !capabilities.sources.currentSectionBlocks) {
    notes.push("document.current_section_blocks unavailable: no section heading boundary was found; expanded section text is omitted.");
  }
  if (chapterTextScope === "current-chapter" && !capabilities.sources.currentChapterBlocks) {
    notes.push("document.current_chapter_blocks unavailable: no chapter heading boundary was found; expanded chapter text is omitted.");
  }
  if (chapterTextScope === "previous-chapters" && !capabilities.sources.previousChapterBlocks) {
    notes.push("document.previous_chapter_blocks unavailable: no earlier chapter blocks were found for this selection.");
  }
  if (chapterTextScope === "full-text" && !capabilities.sources.fullText) {
    notes.push("document.full_text_blocks unavailable: no readable text blocks are available for this document.");
  }
  if (options.includeThreadHistory && options.qaHistoryScope !== "none" && !capabilities.sources.threadHistory) {
    notes.push("thread history unavailable: no saved user or assistant messages are available for this document.");
  }

  if (notes.length) {
    notes.push(`available_sources: ${getAvailableSelectionSourceNames(capabilities, options).join(", ")}.`);
  }
  return notes;
}

function getKnowledgeAvailabilityNotes(capabilities, options) {
  const notes = [];
  const fullTextScope = normalizeKnowledgeFullTextScope(options.fullTextScope, options.includeFullText);
  if (options.includeDocumentOutline && !capabilities.sources.outline) {
    notes.push("document.outline unavailable: no heading or outline data was provided; do not infer a table of contents.");
  }
  if (options.includeThreadHistory && !capabilities.sources.threadHistory) {
    notes.push("thread Q&A history unavailable: no saved user or assistant messages are available for this document.");
  }
  if (options.includeKnowledgeHighlights && !capabilities.sources.knowledgeHighlights) {
    notes.push("highlight evidence clusters unavailable: no saved highlights are available for this document.");
  }
  if (fullTextScope === "full-text" && !capabilities.sources.fullText) {
    notes.push("document.full_text_blocks unavailable: no readable text blocks are available for this document.");
  }
  if (fullTextScope === "before-last-highlight" && !capabilities.sources.knowledgeHighlights) {
    notes.push("document.before_last_highlight_blocks unavailable: no saved highlights can define the last highlight position.");
  } else if (fullTextScope === "before-last-highlight" && !capabilities.sources.beforeLastHighlightBlocks) {
    notes.push("document.before_last_highlight_blocks unavailable: no readable blocks exist before the last highlight.");
  }

  if (notes.length) {
    notes.push(`available_sources: ${getAvailableKnowledgeSourceNames(capabilities, options).join(", ")}.`);
  }
  return notes;
}

function getAvailableSelectionSourceNames(capabilities, options = {}) {
  const sources = [];
  const chapterTextScope = normalizeChapterTextScope(options.chapterTextScope, options.includeCurrentChapterBlocks);
  if (capabilities.sources.selectedText) {
    sources.push("highlight.selected_text");
  }
  if (options.includeDocumentOutline && capabilities.sources.outline) {
    sources.push("document.outline");
  }
  if (options.includeChapterTitle && capabilities.sources.chapterTitle) {
    sources.push("current chapter title");
  }
  if (options.includeSelectedBlock && capabilities.sources.selectedBlock) {
    sources.push("highlight.selected_blocks");
  }
  if (options.includeAdjacentBlocks && capabilities.sources.adjacentBlocks) {
    sources.push("highlight.adjacent_blocks");
  }
  if (chapterTextScope === "current-section" && capabilities.sources.currentSectionBlocks) {
    sources.push("document.current_section_blocks");
  }
  if (chapterTextScope === "current-chapter" && capabilities.sources.currentChapterBlocks) {
    sources.push("document.current_chapter_blocks");
  }
  if (chapterTextScope === "previous-chapters" && capabilities.sources.previousChapterBlocks) {
    sources.push("document.previous_chapter_blocks");
  }
  if (chapterTextScope === "full-text" && capabilities.sources.fullText) {
    sources.push("document.full_text_blocks");
  }
  if (options.includeThreadHistory && capabilities.counts.currentThreadMessages > 0) {
    sources.push("thread.current_messages");
  }
  if (
    options.includeThreadHistory &&
    options.qaHistoryScope === "all-highlights" &&
    capabilities.counts.allThreadMessages > capabilities.counts.currentThreadMessages
  ) {
    sources.push("document.linear_qa_history");
  }
  if (!sources.length) {
    sources.push("no optional evidence sources are currently available");
  }
  return sources;
}

function getAvailableKnowledgeSourceNames(capabilities, options = {}) {
  const sources = [];
  const fullTextScope = normalizeKnowledgeFullTextScope(options.fullTextScope, options.includeFullText);
  if (options.includeDocumentOutline && capabilities.sources.outline) {
    sources.push("document.outline");
  }
  if (options.includeKnowledgeHighlights && capabilities.sources.knowledgeHighlights) {
    sources.push("highlight evidence clusters");
  }
  if (options.includeThreadHistory && capabilities.sources.threadHistory) {
    sources.push("thread Q&A history");
  }
  if (capabilities.counts.qaSummaries > 0) {
    sources.push("saved Q&A summaries");
  }
  if (fullTextScope === "full-text" && capabilities.sources.fullText) {
    sources.push("document.full_text_blocks");
  }
  if (fullTextScope === "before-last-highlight" && capabilities.sources.beforeLastHighlightBlocks) {
    sources.push("document.before_last_highlight_blocks");
  }
  if (!sources.length) {
    sources.push("no optional evidence sources are currently available");
  }
  return sources;
}

function sanitizeSelectionContextSettings(selection = {}, capabilities) {
  const next = { ...selection };
  const hasHeadingBoundary = capabilities.structure.hasHeadingBoundary;
  const chapterTextScope = normalizeChapterTextScope(next.chapterTextScope, next.includeCurrentChapterBlocks);
  let resolvedChapterTextScope = chapterTextScope;

  if (!capabilities.sources.fullText) {
    next.includeSelectedBlock = false;
    next.includeAdjacentBlocks = false;
    next.neighborBlockCount = 0;
    resolvedChapterTextScope = "none";
  }
  if (!capabilities.sources.outline) {
    next.includeDocumentOutline = false;
  }
  if (!hasHeadingBoundary) {
    next.includeChapterTitle = false;
    next.includeCurrentChapterBlocks = false;
    if (resolvedChapterTextScope !== "full-text") {
      resolvedChapterTextScope = "none";
    }
  } else {
    next.includeChapterTitle = next.includeChapterTitle !== false;
  }
  if (resolvedChapterTextScope === "current-section" && !capabilities.sources.currentSectionBlocks) {
    resolvedChapterTextScope = "none";
  }
  if (resolvedChapterTextScope === "current-chapter" && !capabilities.sources.currentChapterBlocks) {
    resolvedChapterTextScope = "none";
  }
  if (resolvedChapterTextScope === "previous-chapters" && !capabilities.sources.previousChapterBlocks) {
    resolvedChapterTextScope = "none";
  }
  next.chapterTextScope = resolvedChapterTextScope;
  next.includeCurrentChapterBlocks = resolvedChapterTextScope === "current-chapter";
  next.sectionSummaryScope = "none";
  if (!capabilities.sources.threadHistory && next.qaHistoryScope === "all-highlights") {
    next.qaHistoryScope = "current-thread";
  }
  return next;
}

function sanitizeKnowledgeContextSettings(knowledge = {}, capabilities) {
  const next = { ...knowledge };
  let fullTextScope = normalizeKnowledgeFullTextScope(next.fullTextScope, next.includeFullText);
  if (!capabilities.sources.fullText) {
    next.includeSelectedBlock = false;
    next.includeAdjacentBlocks = false;
    fullTextScope = "none";
    next.neighborBlockCount = 0;
  }
  if (fullTextScope === "before-last-highlight" && !capabilities.sources.knowledgeHighlights) {
    fullTextScope = "none";
  }
  if (fullTextScope === "before-last-highlight" && !capabilities.sources.beforeLastHighlightBlocks) {
    fullTextScope = "none";
  }
  next.fullTextScope = fullTextScope;
  next.includeFullText = fullTextScope === "full-text";
  if (!capabilities.sources.outline) {
    next.includeDocumentOutline = false;
  }
  if (!capabilities.structure.hasHeadingBoundary) {
    next.includeChapterTitle = false;
    next.includeCurrentChapterBlocks = false;
  } else {
    next.includeChapterTitle = next.includeChapterTitle !== false;
  }
  next.includeCurrentChapterBlocks = false;
  next.sectionSummaryScope = "none";
  if (!capabilities.sources.threadHistory) {
    next.includeThreadHistory = false;
    next.qaHistoryScope = "current-thread";
  }
  if (!capabilities.sources.knowledgeHighlights) {
    next.includeKnowledgeHighlights = false;
  }
  return next;
}

function collectThreadMessages({ messages = [], threads = [], messagesByThread = {} } = {}) {
  const collected = [];
  const seen = new Set();
  for (const message of messages || []) {
    pushUniqueMessage(collected, seen, message);
  }

  const buckets = messagesByThread instanceof Map
    ? [...messagesByThread.values()]
    : Object.values(messagesByThread || {});
  for (const bucket of buckets) {
    for (const message of bucket || []) {
      pushUniqueMessage(collected, seen, message);
    }
  }

  if (!collected.length && (threads || []).some((entry) => entry?.messageCount > 0 || entry?.lastMessageAt)) {
    return [{}];
  }
  return prepareHistoryMessages(collected).messages;
}

function pushUniqueMessage(collected, seen, message) {
  if (!message || !isHistoryMessage(message)) {
    return;
  }
  const key = message.id || `${message.threadId || ""}:${message.role || ""}:${message.createdAt || ""}:${message.content || ""}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  collected.push(message);
}

function prepareHistoryMessages(messages = []) {
  return {
    messages: (messages || [])
      .filter((message) => isHistoryMessage(message))
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
  };
}

function isHistoryMessage(message) {
  return message?.role === "user" || message?.role === "assistant";
}

function isQaSummary(summary) {
  if (!summary || typeof summary !== "object") {
    return false;
  }
  return summary.summaryType === "qa-turn" || Boolean(summary.threadId || summary.messageId || summary.highlightId);
}

function normalizeChapterTextScope(value, includeCurrentChapterBlocks = false) {
  if (CHAPTER_TEXT_SCOPES.has(value)) {
    return value;
  }
  return includeCurrentChapterBlocks ? "current-chapter" : "none";
}

function normalizeSectionSummaryScope(value) {
  return SECTION_SUMMARY_SCOPES.has(value) ? value : "none";
}

function normalizeKnowledgeFullTextScope(value, includeFullText = false) {
  if (KNOWLEDGE_FULL_TEXT_SCOPES.has(value)) {
    return value;
  }
  return includeFullText ? "full-text" : "none";
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
  return selectedBlocks.map((block) => getBlockText(block)).filter(Boolean).join("\n");
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

function getBeforeLastHighlightBlocks(orderedBlocks, highlights = []) {
  const lastPosition = getLastHighlightPosition(highlights, orderedBlocks);
  if (!Number.isFinite(lastPosition.blockOrder) || lastPosition.blockOrder === Number.MAX_SAFE_INTEGER) {
    return [];
  }
  const previousBlocks = orderedBlocks.filter((block) => getBlockOrder(block) < lastPosition.blockOrder);
  const anchorBlock = findHighlightBlock(orderedBlocks, lastPosition.highlight, lastPosition.blockOrder);
  const prefixBlock = createBlockPrefixBeforeHighlight(anchorBlock, lastPosition.highlight);
  return prefixBlock ? [...previousBlocks, prefixBlock] : previousBlocks;
}

function getLastHighlightPosition(highlights = [], orderedBlocks = []) {
  const blocksById = new Map((orderedBlocks || []).map((block) => [block.id, block]));
  return (highlights || [])
    .map((highlight) => ({
      highlight,
      blockOrder: getBlockOrder(blocksById.get(highlight?.blockId), highlight),
      startOffset: getHighlightStartOffset(highlight, blocksById.get(highlight?.blockId))
    }))
    .filter((position) => Number.isFinite(position.blockOrder) && position.blockOrder !== Number.MAX_SAFE_INTEGER)
    .sort((a, b) => b.blockOrder - a.blockOrder || b.startOffset - a.startOffset)[0] || {
      blockOrder: Number.MAX_SAFE_INTEGER,
      startOffset: Number.MAX_SAFE_INTEGER
    };
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

function clampHeadingLevel(value) {
  const level = Number(value);
  if (!Number.isFinite(level)) {
    return 2;
  }
  return Math.min(Math.max(Math.floor(level), 1), 6);
}

function getBlockType(block) {
  return normalizeContextText(block?.type || block?.kind || block?.role || "unknown").toLowerCase();
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
