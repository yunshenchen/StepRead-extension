import { nowIso } from "../shared/defaults.js";
import { dbGetAllByIndex, dbPut, getDocumentWithBlocks } from "../shared/db.js";
import { getSettings } from "../shared/store.js";
import { generateKnowledgeReport } from "../shared/ai-client.js";
import { createKnowledgeReportSignature } from "../shared/knowledge-signature.js";

const KNOWLEDGE_REFRESH_KEY = "knowledgeRefreshSignal";
const KNOWLEDGE_REFRESH_DEBOUNCE_MS = 320;
const KNOWLEDGE_GENERATION_TIMEOUT_MS = 300_000;
const KNOWLEDGE_GENERATION_STAGES = [
  { minElapsedSeconds: 0, label: "整理划线与问答" },
  { minElapsedSeconds: 2, label: "生成结构化关系" },
  { minElapsedSeconds: 5, label: "等待模型返回" }
];
const params = new URLSearchParams(location.search);
const documentId = params.get("documentId") || "";

const state = {
  documentRecord: null,
  blocks: [],
  highlights: [],
  threads: [],
  messagesByThread: {},
  summaries: [],
  settings: null
};

const generationProgress = {
  timerId: 0,
  startedAtMs: 0,
  streamContent: "",
  streamRenderQueued: false,
  streamRenderedContent: ""
};

let knowledgeLoadSeq = 0;
let knowledgeRefreshTimer = 0;

const elements = {
  documentTitle: document.querySelector("#documentTitle"),
  reloadButton: document.querySelector("#reloadButton"),
  generateButton: document.querySelector("#generateButton"),
  userPrompt: document.querySelector("#userPrompt"),
  highlightCount: document.querySelector("#highlightCount"),
  threadCount: document.querySelector("#threadCount"),
  messageCount: document.querySelector("#messageCount"),
  summaryCount: document.querySelector("#summaryCount"),
  evidenceList: document.querySelector("#evidenceList"),
  status: document.querySelector("#status"),
  reportOutput: document.querySelector("#reportOutput")
};

init();

function init() {
  elements.reloadButton.addEventListener("click", loadKnowledgeData);
  elements.generateButton.addEventListener("click", handleGenerateReport);
  elements.userPrompt.addEventListener("input", handlePromptInput);
  bindExternalRefresh();
  loadKnowledgeData();
}

function bindExternalRefresh() {
  if (!globalThis.chrome?.storage?.onChanged) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const signal = changes[KNOWLEDGE_REFRESH_KEY]?.newValue;
    if (signal?.documentId !== documentId) {
      return;
    }

    scheduleKnowledgeRefresh();
  });
}

function scheduleKnowledgeRefresh() {
  globalThis.clearTimeout(knowledgeRefreshTimer);
  knowledgeRefreshTimer = globalThis.setTimeout(() => {
    knowledgeRefreshTimer = 0;
    void loadKnowledgeData({ external: true, preserveScroll: true });
  }, KNOWLEDGE_REFRESH_DEBOUNCE_MS);
}

async function loadKnowledgeData(options = {}) {
  if (!documentId) {
    setStatus("URL 中缺少 documentId，无法读取阅读记录。");
    elements.generateButton.disabled = true;
    elements.reloadButton.disabled = true;
    return;
  }

  const loadSeq = ++knowledgeLoadSeq;
  const scrollState = options.preserveScroll ? captureKnowledgeScrollState() : null;
  const generating = isKnowledgeGenerating();
  setBusy(true, generating ? "" : options.external ? "阅读记录已更新，正在刷新..." : "正在读取阅读记录...");
  try {
    const [{ document, blocks }, highlights, threads, summaries, settings] = await Promise.all([
      getDocumentWithBlocks(documentId),
      dbGetAllByIndex("highlights", "by_documentId", documentId),
      dbGetAllByIndex("threads", "by_documentId", documentId),
      dbGetAllByIndex("summaries", "by_documentId", documentId),
      getSettings()
    ]);

    if (!document) {
      throw new Error("IndexedDB 中没有找到这个 documentId 对应的文档。");
    }

    if (loadSeq !== knowledgeLoadSeq) {
      return;
    }

    const sortedHighlights = sortHighlightsByPosition(highlights, blocks);
    const sortedThreads = sortThreadsByHighlightPosition(threads, sortedHighlights, blocks);

    state.documentRecord = document;
    state.blocks = blocks;
    state.highlights = sortedHighlights;
    state.threads = sortedThreads;
    state.messagesByThread = await loadMessagesByThread(sortedThreads);
    state.summaries = sortSummaries(summaries);
    state.settings = settings;

    renderDocumentState();
    if (isKnowledgeGenerating()) {
      restoreKnowledgeScrollState(scrollState);
    } else {
      await renderCachedReportState();
      restoreKnowledgeScrollState(scrollState);
    }
  } catch (error) {
    if (loadSeq !== knowledgeLoadSeq) {
      return;
    }
    setStatus(error instanceof Error ? error.message : String(error));
    elements.reportOutput.textContent = "读取失败。";
  } finally {
    if (loadSeq === knowledgeLoadSeq) {
      setBusy(false);
    }
  }
}

async function loadMessagesByThread(threads) {
  const entries = await Promise.all(
    threads.map(async (thread) => {
      const messages = await dbGetAllByIndex("messages", "by_threadId", thread.id);
      return [thread.id, sortMessages(messages)];
    })
  );
  return Object.fromEntries(entries);
}

async function renderCachedReportState() {
  const report = state.documentRecord?.knowledgeReport;
  if (!report?.content) {
    elements.reportOutput.textContent = "暂无知识图谱。请点击“生成知识图谱”。";
    setStatus("已读取阅读记录，尚未生成知识图谱。");
    return;
  }

  if (!elements.userPrompt.value && report.userPrompt) {
    elements.userPrompt.value = report.userPrompt;
  }
  elements.reportOutput.textContent = report.content;

  const currentSignature = await createCurrentSignature();
  if (report.signature === currentSignature) {
    setStatus(`当前数据未变化，已显示缓存知识图谱，生成时间：${formatDateTime(report.generatedAt)}。`);
    return;
  }

  setStatus("已显示上次知识图谱；当前划线、问答、摘要或 prompt 已变化，请点击生成知识图谱。");
}

async function handleGenerateReport() {
  if (!state.documentRecord) {
    setStatus("还没有可生成知识图谱的阅读记录。");
    return;
  }

  const signature = await createCurrentSignature();
  const cachedReport = state.documentRecord.knowledgeReport;
  if (cachedReport?.signature === signature && cachedReport?.content) {
    elements.reportOutput.textContent = cachedReport.content;
    setStatus(`当前数据未变化，已显示缓存知识图谱，生成时间：${formatDateTime(cachedReport.generatedAt)}。`);
    return;
  }

  setBusy(true);
  startKnowledgeGenerationTimer();
  resetKnowledgeStreamPreview();
  try {
    const result = await generateKnowledgeReport({
      documentRecord: state.documentRecord,
      blocks: state.blocks,
      highlights: state.highlights,
      threads: state.threads,
      messagesByThread: state.messagesByThread,
      summaries: state.summaries,
      userPrompt: elements.userPrompt.value,
      timeoutMs: KNOWLEDGE_GENERATION_TIMEOUT_MS,
      onDelta: appendKnowledgeReportDelta
    });
    if (!result.ok) {
      const elapsedSeconds = stopKnowledgeGenerationTimer();
      restoreKnowledgeReportAfterFailedStream(cachedReport);
      if (result.cancelled) {
        setStatus(`知识图谱生成已取消，最终耗时：${formatElapsedSeconds(elapsedSeconds)}。未覆盖上次缓存结果。`);
        return;
      }
      const reason = result.error || "模型请求没有成功";
      setStatus(`知识图谱生成失败，最终耗时：${formatElapsedSeconds(elapsedSeconds)}。${reason}。未覆盖上次缓存结果。`);
      return;
    }

    const savedAt = nowIso();
    const nextDocument = {
      ...state.documentRecord,
      knowledgeReport: {
        signature,
        userPrompt: elements.userPrompt.value,
        content: result.content,
        ai: {
          runId: result.runId || "",
          model: result.model || "",
          demo: Boolean(result.demo)
        },
        generatedAt: savedAt
      }
    };
    await dbPut("documents", nextDocument);
    state.documentRecord = nextDocument;
    finishKnowledgeStreamPreview();
    elements.reportOutput.textContent = result.content;
    const elapsedSeconds = stopKnowledgeGenerationTimer();
    setStatus(`知识图谱已生成，时间：${formatDateTime(savedAt)}，最终耗时：${formatElapsedSeconds(elapsedSeconds)}。`);
  } catch (error) {
    const elapsedSeconds = stopKnowledgeGenerationTimer();
    restoreKnowledgeReportAfterFailedStream(cachedReport);
    const reason = error instanceof Error ? error.message : String(error);
    setStatus(`知识图谱生成失败，最终耗时：${formatElapsedSeconds(elapsedSeconds)}。${reason}。未覆盖上次缓存结果。`);
  } finally {
    stopKnowledgeGenerationTimer();
    setBusy(false);
  }
}

async function handlePromptInput() {
  const cachedReport = state.documentRecord?.knowledgeReport;
  if (!cachedReport?.content) {
    return;
  }

  const signature = await createCurrentSignature();
  if (cachedReport.signature === signature) {
    setStatus(`当前数据未变化，已显示缓存知识图谱，生成时间：${formatDateTime(cachedReport.generatedAt)}。`);
    return;
  }

  setStatus("知识图谱 prompt 已变化，请点击生成知识图谱。");
}

function renderDocumentState() {
  elements.documentTitle.textContent = state.documentRecord?.title || "未命名文档";
  elements.highlightCount.textContent = String(state.highlights.length);
  elements.threadCount.textContent = String(state.threads.length);
  elements.messageCount.textContent = String(getMessageCount());
  elements.summaryCount.textContent = String(state.summaries.length);
  renderEvidenceList();
}

function renderEvidenceList() {
  elements.evidenceList.replaceChildren();
  const items = createEvidenceItems();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "evidence-empty";
    empty.textContent = "暂无阅读证据。先在 PDF 中划线并提问，知识图谱会读取这些记录。";
    elements.evidenceList.append(empty);
    return;
  }

  for (const item of items.slice(0, 60)) {
    const article = document.createElement("article");
    article.className = "evidence-item";

    const title = document.createElement("h3");
    title.className = "evidence-item-title";
    title.textContent = item.thread?.title || createEvidenceTitle(item.highlight?.text);

    const text = document.createElement("p");
    text.className = "evidence-item-text";
    text.textContent = createEvidenceSnippet(item.highlight?.text || item.thread?.title || "");

    const meta = document.createElement("div");
    meta.className = "evidence-item-meta";
    meta.textContent = createEvidenceMeta(item);

    article.append(title, text, meta);

    const latestSummary = item.summaries.at(-1);
    if (latestSummary?.text) {
      const summaryPreview = document.createElement("p");
      summaryPreview.className = "evidence-item-summary";
      summaryPreview.textContent = `摘要：${createEvidenceSnippet(latestSummary.text, 140)}`;
      article.append(summaryPreview);
    }

    elements.evidenceList.append(article);
  }
}

function createEvidenceItems() {
  const highlightsById = new Map(state.highlights.map((highlight) => [highlight.id, highlight]));
  const threadIds = new Set();
  const summariesByThreadId = groupSummariesByThreadId(state.summaries);
  const items = [];

  for (const thread of state.threads) {
    threadIds.add(thread.id);
    items.push({
      type: "thread",
      highlight: highlightsById.get(thread.highlightId) || null,
      thread,
      messages: state.messagesByThread[thread.id] || [],
      summaries: summariesByThreadId.get(thread.id) || []
    });
  }

  for (const highlight of state.highlights) {
    if (highlight.threadId && threadIds.has(highlight.threadId)) {
      continue;
    }
    const linkedThread = state.threads.find((thread) => thread.highlightId === highlight.id);
    if (linkedThread && threadIds.has(linkedThread.id)) {
      continue;
    }
    items.push({
      type: "highlight",
      highlight,
      thread: null,
      messages: [],
      summaries: []
    });
  }

  const blocksById = new Map(state.blocks.map((block) => [block.id, block]));
  return items.sort((a, b) => compareEvidenceItems(a, b, blocksById));
}

async function createCurrentSignature() {
  const settings = await getLatestSettings();
  return createKnowledgeReportSignature({
    documentRecord: state.documentRecord,
    highlights: state.highlights,
    threads: state.threads,
    messagesByThread: state.messagesByThread,
    summaries: state.summaries,
    userPrompt: elements.userPrompt.value,
    settings
  });
}

function getMessageCount() {
  return Object.values(state.messagesByThread).reduce((total, messages) => total + messages.length, 0);
}

function createEvidenceTitle(text) {
  const normalized = normalizeWhitespace(text);
  return normalized ? createEvidenceSnippet(normalized, 34) : "未命名划线";
}

function createEvidenceSnippet(text, limit = 180) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return "没有文本。";
  }
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function createEvidenceMeta({ highlight, thread, messages, summaries }) {
  const messageCount = (messages || []).length;
  const qaMessages = (messages || []).filter((message) => message.role !== "selection");
  const qaTurns = Math.floor(qaMessages.length / 2);
  const parts = [
    messageCount ? `${messageCount} 条问答对话消息` : "暂无问答对话消息",
    qaTurns ? `${qaTurns} 轮用户/AI 问答` : "尚未提问",
    summaries?.length ? `${summaries.length} 条摘要` : "暂无摘要",
    formatDateTime(thread?.updatedAt || highlight?.updatedAt || highlight?.createdAt)
  ];
  return parts.filter(Boolean).join(" · ");
}

async function getLatestSettings() {
  try {
    state.settings = await getSettings();
  } catch {
    // Keep the last loaded settings if storage is temporarily unavailable.
  }
  return state.settings || {};
}

function sortHighlightsByPosition(highlights, blocks) {
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  return [...highlights].sort((a, b) => {
    const blockA = blocksById.get(a.blockId);
    const blockB = blocksById.get(b.blockId);
    const blockOrderA = Number.isFinite(a.blockOrder) ? a.blockOrder : blockA?.order ?? Number.MAX_SAFE_INTEGER;
    const blockOrderB = Number.isFinite(b.blockOrder) ? b.blockOrder : blockB?.order ?? Number.MAX_SAFE_INTEGER;
    const startA = getHighlightStartOffset(a, blockA);
    const startB = getHighlightStartOffset(b, blockB);
    return blockOrderA - blockOrderB || startA - startB || String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

function sortThreadsByHighlightPosition(threads, highlights, blocks) {
  const highlightsById = new Map(highlights.map((highlight) => [highlight.id, highlight]));
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  return [...threads].sort((a, b) => {
    const highlightA = highlightsById.get(a.highlightId);
    const highlightB = highlightsById.get(b.highlightId);
    return (
      compareHighlightPositions(highlightA, highlightB, blocksById) ||
      String(a.updatedAt || a.createdAt || "").localeCompare(String(b.updatedAt || b.createdAt || "")) ||
      String(a.id || "").localeCompare(String(b.id || ""))
    );
  });
}

function compareHighlightPositions(a, b, blocksById) {
  if (!a && !b) {
    return 0;
  }
  if (!a) {
    return 1;
  }
  if (!b) {
    return -1;
  }
  const blockA = blocksById.get(a.blockId);
  const blockB = blocksById.get(b.blockId);
  const blockOrderA = Number.isFinite(a.blockOrder) ? a.blockOrder : blockA?.order ?? Number.MAX_SAFE_INTEGER;
  const blockOrderB = Number.isFinite(b.blockOrder) ? b.blockOrder : blockB?.order ?? Number.MAX_SAFE_INTEGER;
  return blockOrderA - blockOrderB || getHighlightStartOffset(a, blockA) - getHighlightStartOffset(b, blockB);
}

function compareEvidenceItems(a, b, blocksById) {
  const highlightCompare = compareHighlightPositions(a.highlight, b.highlight, blocksById);
  if (highlightCompare) {
    return highlightCompare;
  }
  return String(a.thread?.createdAt || a.highlight?.createdAt || "").localeCompare(
    String(b.thread?.createdAt || b.highlight?.createdAt || "")
  );
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
  const text = getBlockText(block);
  const selected = String(highlight?.text || "").trim();
  const index = selected ? text.indexOf(selected) : -1;
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function sortMessages(messages) {
  return [...messages].sort((a, b) =>
    String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
    String(a.id || "").localeCompare(String(b.id || ""))
  );
}

function sortSummaries(summaries) {
  return [...summaries].sort((a, b) =>
    String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
    String(a.id || "").localeCompare(String(b.id || ""))
  );
}

function groupSummariesByThreadId(summaries) {
  const grouped = new Map();
  for (const summary of sortSummaries(summaries)) {
    if (!summary?.threadId) {
      continue;
    }
    const list = grouped.get(summary.threadId) || [];
    list.push(summary);
    grouped.set(summary.threadId, list);
  }
  return grouped;
}

function getBlockText(block) {
  if (!block) {
    return "";
  }
  if (block.type === "list" && Array.isArray(block.items)) {
    return block.items.join("\n");
  }
  if (block.type === "image") {
    return String(block.caption || block.alt || "");
  }
  if (block.type === "table_html") {
    return String(block.text || block.caption || tableHtmlToPlainText(block.table_html || block.tableHtml || ""));
  }
  return String(block.text || block.content || block.title || block.caption || block.table_html || block.tableHtml || "");
}

function tableHtmlToPlainText(value) {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(String(value || ""), "text/html");
  const table = parsed.querySelector("table");
  if (!table) {
    return parsed.body.textContent || "";
  }

  const parts = [];
  const caption = table.querySelector("caption")?.textContent?.trim();
  if (caption) {
    parts.push(caption);
  }

  for (const row of table.querySelectorAll("tr")) {
    const cells = [...row.querySelectorAll("th,td")]
      .map((cell) => cell.textContent?.trim() || "")
      .filter(Boolean);
    if (cells.length) {
      parts.push(cells.join(" "));
    }
  }
  return parts.join("\n");
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function resetKnowledgeStreamPreview() {
  generationProgress.streamContent = "";
  generationProgress.streamRenderedContent = "";
  generationProgress.streamRenderQueued = false;
  elements.reportOutput.classList.add("report-output-streaming");
  elements.reportOutput.classList.remove("report-output-incomplete");
  elements.reportOutput.textContent = "正在等待模型开始输出知识图谱...";
}

function appendKnowledgeReportDelta(delta) {
  const chunk = String(delta || "");
  if (!chunk) {
    return;
  }
  generationProgress.streamContent = `${generationProgress.streamContent || ""}${chunk}`;
  queueKnowledgeStreamPreviewRender();
}

function queueKnowledgeStreamPreviewRender() {
  if (generationProgress.streamRenderQueued) {
    return;
  }
  generationProgress.streamRenderQueued = true;
  requestAnimationFrame(() => {
    generationProgress.streamRenderQueued = false;
    renderKnowledgeStreamPreview();
  });
}

function renderKnowledgeStreamPreview() {
  const content = String(generationProgress.streamContent || "");
  if (content === generationProgress.streamRenderedContent) {
    return;
  }
  generationProgress.streamRenderedContent = content;
  elements.reportOutput.textContent = content || "正在等待模型开始输出知识图谱...";
}

function finishKnowledgeStreamPreview(options = {}) {
  generationProgress.streamRenderQueued = false;
  renderKnowledgeStreamPreview();
  elements.reportOutput.classList.remove("report-output-streaming");
  elements.reportOutput.classList.toggle("report-output-incomplete", Boolean(options.incomplete));
}

function restoreKnowledgeReportAfterFailedStream(cachedReport) {
  generationProgress.streamContent = "";
  generationProgress.streamRenderedContent = "";
  generationProgress.streamRenderQueued = false;
  elements.reportOutput.classList.remove("report-output-streaming", "report-output-incomplete");
  elements.reportOutput.textContent =
    cachedReport?.content ||
    "暂无可用的最终知识图谱。生成中断后已丢弃临时流式内容，请再次生成。";
}

function setBusy(isBusy, message = "") {
  const locked = isBusy || isKnowledgeGenerating() || !documentId;
  elements.generateButton.disabled = locked;
  elements.reloadButton.disabled = locked;
  if (message) {
    setStatus(message);
  }
}

function setStatus(message) {
  elements.status.textContent = message;
}

function isKnowledgeGenerating() {
  return Boolean(generationProgress.timerId || generationProgress.startedAtMs);
}

function captureKnowledgeScrollState() {
  return {
    x: window.scrollX,
    y: window.scrollY
  };
}

function restoreKnowledgeScrollState(scrollState) {
  if (!scrollState) {
    return;
  }
  requestAnimationFrame(() => {
    window.scrollTo(scrollState.x, scrollState.y);
  });
}

function startKnowledgeGenerationTimer() {
  stopKnowledgeGenerationTimer();
  generationProgress.startedAtMs = Date.now();
  updateKnowledgeGenerationStatus();
  generationProgress.timerId = globalThis.setInterval(updateKnowledgeGenerationStatus, 1000);
}

function stopKnowledgeGenerationTimer() {
  const elapsedSeconds = getKnowledgeGenerationElapsedSeconds();
  if (generationProgress.timerId) {
    globalThis.clearInterval(generationProgress.timerId);
    generationProgress.timerId = 0;
  }
  generationProgress.startedAtMs = 0;
  return elapsedSeconds;
}

function updateKnowledgeGenerationStatus() {
  const elapsedSeconds = getKnowledgeGenerationElapsedSeconds();
  const startedAt = formatRunStartTime(generationProgress.startedAtMs);
  const stage = getKnowledgeGenerationStage(elapsedSeconds);
  setStatus(`正在生成知识图谱。开始时间：${startedAt}；已用：${formatElapsedSeconds(elapsedSeconds)}；阶段：${stage}。`);
}

function getKnowledgeGenerationElapsedSeconds() {
  if (!generationProgress.startedAtMs) {
    return 0;
  }
  return Math.max(0, Math.floor((Date.now() - generationProgress.startedAtMs) / 1000));
}

function getKnowledgeGenerationStage(elapsedSeconds) {
  return KNOWLEDGE_GENERATION_STAGES.reduce((current, stage) => {
    return elapsedSeconds >= stage.minElapsedSeconds ? stage.label : current;
  }, KNOWLEDGE_GENERATION_STAGES[0].label);
}

function formatElapsedSeconds(seconds) {
  return `${Math.max(0, Number(seconds) || 0)} 秒`;
}

function formatRunStartTime(value) {
  if (!value) {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function formatDateTime(value) {
  if (!value) {
    return "未知";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
