import { createId, nowIso } from "../shared/defaults.js";
import {
  dbGet,
  dbGetAll,
  dbGetAllByIndex,
  dbPut,
  clearReaderRecords,
  deletePendingPdfImport,
  deleteHighlightsCascade,
  getPendingPdfImport,
  getDocumentWithBlocks,
  replaceDocument
} from "../shared/db.js";
import { logTask } from "../shared/logger.js";
import { renderBlocks } from "../shared/block-renderer.js";
import { answerThread } from "../shared/ai-client.js";
import { normalizeFormulaSelection } from "../shared/formula-text-normalizer.js";
import { openOrFocusExtensionPage } from "../shared/navigation.js";
import { saveQaTurnSummary } from "../shared/qa-summary.js";
import {
  createStablePdfDocumentId,
  getReadablePdfSourceInfo,
  isLikelyPdfSourceUrl,
  normalizePdfSourceUrl
} from "../shared/paper-deepreport-adapter.js";
import { getSettings, saveSettings } from "../shared/store.js";

const KNOWLEDGE_REFRESH_KEY = "knowledgeRefreshSignal";
const PDFJS_VERSION = "1.10.100";
const PDF_WORKER_EXTENSION_PATH = "src/vendor/pdfjs/pdf.worker.min.js";
const PDF_WORKER_RELATIVE_PATH = "../vendor/pdfjs/pdf.worker.min.js";
const PDF_IMPORT_MIN_TEXT_LENGTH = 24;
const PDF_LOW_TEXT_LAYER_MIN_TEXT_LENGTH = PDF_IMPORT_MIN_TEXT_LENGTH * 8 + 8;
const PDF_LOW_TEXT_LAYER_MIN_ITEM_COUNT = 18;
const PDF_MAX_PARAGRAPH_CHARS = 1200;
const PDF_HYBRID_PERSIST_MAX_BYTES = 40 * 1024 * 1024;
const PDF_HYBRID_MIN_SCALE = 0.55;
const PDF_HYBRID_MAX_SCALE = 3;
const PDF_VIEWER_MIN_ZOOM = 0.55;
const PDF_VIEWER_MAX_ZOOM = 2.4;
const PDF_VIEWER_ZOOM_STEP = 0.1;
const PDF_CANVAS_MAX_OUTPUT_SCALE = 2;
const PDF_ZOOM_RERENDER_DEBOUNCE_MS = 180;
const PDF_RESIZE_RERENDER_DEBOUNCE_MS = 220;
const PDF_HYBRID_RENDER_BUFFER_PAGES = 3;
const PDF_HYBRID_INTERSECTION_ROOT_MARGIN = "1400px 0px";
const PDF_DESTINATION_SCROLL_PADDING = 24;
const READER_LOCATION_SCROLL_OFFSET = 72;
const TOC_MANUAL_TARGET_TIMEOUT_MS = 4000;
const TOC_MANUAL_TARGET_RETRY_DELAY_MS = 80;
const TOC_MANUAL_SCROLL_SETTLE_MS = 900;
const TOC_INSTANT_SCROLL_VIEWPORT_THRESHOLD = 3;
const TOC_SCROLL_STABLE_TOLERANCE_PX = 3;
const HIGHLIGHT_SCROLL_MAX_RETRIES = 40;
const HIGHLIGHT_SCROLL_RETRY_DELAY_MS = 120;
const MIN_SIDEBAR_WIDTH = 160;
const MIN_QA_WIDTH = 260;
const MIN_DOCUMENT_WIDTH = 220;
const MESSAGE_BOTTOM_FOLLOW_THRESHOLD = 96;

const state = {
  currentDocument: null,
  blocks: [],
  highlights: [],
  threads: [],
  activeThread: null,
  activeHighlight: null,
  activeAnswerRun: null,
  editingQuestion: null,
  selectedText: "",
  selectedBlockId: "",
  selectedBlockRanges: [],
  selectedLocalStartOffset: -1,
  selectedLocalEndOffset: -1,
  selectedGlobalStartOffset: -1,
  selectedGlobalEndOffset: -1,
  panelView: "detail",
  pdfViewerZoom: 1,
  pdfZoomMode: "fit-width",
  activeTocEntryId: "",
  activePdfPageNumber: 0,
  sourceUrl: new URLSearchParams(location.search).get("sourceUrl") || "",
  targetDocumentId: new URLSearchParams(location.search).get("documentId") || "",
  pendingImportId: new URLSearchParams(location.search).get("pendingImportId") || "",
  resetDataMode: new URLSearchParams(location.search).get("resetData") || "",
  shouldResetData: Boolean(new URLSearchParams(location.search).get("resetData"))
};

const elements = {
  readerApp: document.querySelector(".reader-app"),
  workspace: document.querySelector("#workspace"),
  documentTitle: document.querySelector("#documentTitle"),
  sourceUrl: document.querySelector("#sourceUrl"),
  importPdfButton: document.querySelector("#importPdfButton"),
  pdfZoomOutButton: document.querySelector("#pdfZoomOutButton"),
  pdfZoomResetButton: document.querySelector("#pdfZoomResetButton"),
  pdfZoomInButton: document.querySelector("#pdfZoomInButton"),
  pdfZoomValue: document.querySelector("#pdfZoomValue"),
  pdfFileInput: document.querySelector("#pdfFileInput"),
  openOptionsButton: document.querySelector("#openOptionsButton"),
  newFolderButton: document.querySelector("#newFolderButton"),
  folderCreateRow: document.querySelector("#folderCreateRow"),
  folderNameInput: document.querySelector("#folderNameInput"),
  confirmFolderButton: document.querySelector("#confirmFolderButton"),
  cancelFolderButton: document.querySelector("#cancelFolderButton"),
  documentList: document.querySelector("#documentList"),
  trashSection: document.querySelector("#trashSection"),
  trashToggle: document.querySelector("#trashToggle"),
  trashCount: document.querySelector("#trashCount"),
  trashList: document.querySelector("#trashList"),
  documentContextMenu: document.querySelector("#documentContextMenu"),
  tocList: document.querySelector("#tocList"),
  currentSectionBar: document.querySelector("#currentSectionBar"),
  currentSectionText: document.querySelector("#currentSectionText"),
  pdfPageIndicator: document.querySelector("#pdfPageIndicator"),
  documentContent: document.querySelector("#documentContent"),
  leftResizer: document.querySelector("#leftResizer"),
  rightResizer: document.querySelector("#rightResizer"),
  sidebarCollapseButton: document.querySelector("#sidebarCollapseButton"),
  qaPanelTitle: document.querySelector("#qaPanelTitle"),
  historyLayer: document.querySelector("#historyLayer"),
  detailLayer: document.querySelector("#detailLayer"),
  panelToggleButton: document.querySelector("#panelToggleButton"),
  knowledgeButton: document.querySelector("#knowledgeButton"),
  selectionAskButton: document.querySelector("#selectionAskButton"),
  selectionCard: document.querySelector(".selection-card"),
  documentSectionToggle: document.querySelector("#documentSectionToggle"),
  tocSectionToggle: document.querySelector("#tocSectionToggle"),
  selectionTitle: document.querySelector("#selectionTitle"),
  activeSelectionPreview: document.querySelector("#activeSelectionPreview"),
  threadList: document.querySelector("#threadList"),
  messageList: document.querySelector("#messageList"),
  composer: document.querySelector(".composer"),
  questionInput: document.querySelector("#questionInput"),
  sendQuestionButton: document.querySelector("#sendQuestionButton"),
  status: document.querySelector("#status")
};

let readerLocationUpdateFrame = 0;
let pdfZoomRerenderTimer = 0;
let pendingPdfZoomScrollAnchor = null;
let pdfViewportRefreshTimer = 0;
let pdfViewportAnchorRememberFrame = 0;
let pendingPdfViewportRefreshAnchor = null;
let pendingPdfVisibleRenderPruneStaleQueue = false;
let lastPdfHybridViewportAnchor = null;
let lastDocumentContentWidth = 0;
let documentContentResizeObserver = null;

let selectionFeedbackTimer = 0;
let highlightFocusTimer = 0;
let documentLoadClickTimer = 0;
let pendingManualTocTarget = null;
let pendingManualTocTargetTimer = 0;
let pendingManualTocTargetToken = 0;
let pendingHighlightScrollTarget = null;
let pendingHighlightScrollTimer = 0;
let pendingHighlightScrollToken = 0;
let selectionThreadCreationPromise = null;
let folderCreatePending = false;
let contextMenuTarget = null;
let pdfImportInProgress = false;
const pdfHybridBytesCache = new Map();
const pdfHybridRenderState = {
  token: 0,
  loadingTask: null,
  pdf: null,
  pdfjsLib: null,
  shell: null,
  observer: null,
  pageShells: new Map(),
  pageRecords: new Map(),
  renderQueue: [],
  queuedPages: new Set(),
  renderingPages: new Set(),
  visibleTextFallbackPages: new Set(),
  scheduleFrame: 0,
  processingQueue: false,
  defaultBaseViewport: null
};
const layoutState = {
  sidebarWidth: 238,
  qaWidth: 430,
  sidebarCollapsed: false,
  resizing: null
};

init();

async function init() {
  bindEvents();
  applyLayoutState();
  renderSourceUrl();
  if (state.shouldResetData) {
    await resetLocalReaderDataForManualVerification({
      resetSettings: state.resetDataMode === "all"
    });
    return;
  }
  const handledPendingImport = await importPendingPdfOnStartup();
  if (!handledPendingImport) {
    await ensureInitialDocument();
  }
  await refreshDocumentList();
}

async function resetLocalReaderDataForManualVerification({ resetSettings = false } = {}) {
  stopActiveAnswerRun({ reason: "reset" });
  hideSelectionAskButton();

  try {
    const summary = await clearReaderRecords();
    if (resetSettings) {
      await clearExtensionSettingsForManualVerification();
    } else {
      await resetReaderStoragePointers();
    }
    resetReaderRuntimeState();
    renderResetCompleteView(summary, { resetSettings });
    setStatus(
      resetSettings
        ? `已清空 StepRead 阅读记录、运行日志和设置页配置：${formatClearSummary(summary)}。可以重新导入 PDF 做全新验证。`
        : `已清空 StepRead 阅读记录和运行日志：${formatClearSummary(summary)}。设置页配置已保留，可以重新导入 PDF。`
    );
  } catch (error) {
    resetReaderRuntimeState();
    renderResetFailedView(error);
    setStatus(`清理失败：${getErrorMessage(error)}`);
  }
}

async function clearExtensionSettingsForManualVerification() {
  if (globalThis.chrome?.storage?.local?.clear) {
    await chrome.storage.local.clear();
  }
  try {
    globalThis.localStorage?.clear();
  } catch {
    // Manual verification cleanup should continue even when fallback storage is unavailable.
  }
}

async function resetReaderStoragePointers() {
  if (!globalThis.chrome?.storage?.local) {
    return;
  }
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    reader: {
      ...settings.reader,
      lastDocumentId: "",
      documentFolders: []
    }
  });
  await chrome.storage.local.remove(KNOWLEDGE_REFRESH_KEY);
}

function resetReaderRuntimeState() {
  state.currentDocument = null;
  state.blocks = [];
  state.highlights = [];
  state.threads = [];
  state.activeThread = null;
  state.activeHighlight = null;
  state.selectedText = "";
  state.selectedBlockId = "";
  state.selectedBlockRanges = [];
  state.selectedLocalStartOffset = -1;
  state.selectedLocalEndOffset = -1;
  state.selectedGlobalStartOffset = -1;
  state.selectedGlobalEndOffset = -1;
  state.panelView = "detail";
  clearDraftSelection();
}

function renderResetCompleteView(summary, { resetSettings = false } = {}) {
  elements.documentTitle.textContent = "StepRead 已清空";
  elements.sourceUrl.textContent = resetSettings
    ? "阅读记录、划线、问答、summary、AI 运行日志、任务日志、设置页配置和本地 fallback storage 已清空。"
    : "阅读记录、划线、问答、summary、AI 运行日志和任务日志已清空；AI 设置与界面参数已保留。";
  elements.documentList.innerHTML = "";
  elements.tocList.innerHTML = "";
  elements.threadList.innerHTML = "";
  elements.messageList.innerHTML = "";
  elements.activeSelectionPreview.textContent = "请重新导入 PDF 后开始新的人工验证。";
  elements.documentContent.innerHTML = "";
  const empty = document.createElement("section");
  empty.className = "empty-state";
  empty.textContent = resetSettings
    ? `本地阅读数据和设置已清空。清理明细：${formatClearSummary(summary)}。`
    : `本地阅读数据已清空。清理明细：${formatClearSummary(summary)}。`;
  elements.documentContent.append(empty);
  renderPanelView();
}

function renderResetFailedView(error) {
  elements.documentTitle.textContent = "StepRead 清理失败";
  elements.sourceUrl.textContent = getErrorMessage(error);
  elements.documentContent.innerHTML = "";
  const empty = document.createElement("section");
  empty.className = "empty-state";
  empty.textContent = "请关闭其他 StepRead 页面后重新打开 reader.html?resetData=1。";
  elements.documentContent.append(empty);
  renderPanelView();
}

function formatClearSummary(summary) {
  const labels = {
    documents: "文档",
    blocks: "正文块",
    highlights: "划线",
    threads: "线程",
    messages: "消息",
    summaries: "summary",
    aiRuns: "AI日志",
    taskLogs: "任务日志",
    pendingPdfImports: "待导入PDF"
  };
  return Object.entries(summary || {})
    .map(([storeName, count]) => `${labels[storeName] || storeName} ${count}`)
    .join("，") || "没有旧记录";
}

function bindEvents() {
  elements.importPdfButton?.addEventListener("click", async () => {
    await discardUnsubmittedDraft({ clearSelection: true, render: true });
    openPdfFilePicker();
  });
  elements.pdfFileInput?.addEventListener("change", async (event) => {
    await discardUnsubmittedDraft({ clearSelection: true, render: true });
    await handlePdfFileInputChange(event);
  });
  elements.pdfZoomOutButton?.addEventListener("click", () => changePdfViewerZoom(-PDF_VIEWER_ZOOM_STEP));
  elements.pdfZoomInButton?.addEventListener("click", () => changePdfViewerZoom(PDF_VIEWER_ZOOM_STEP));
  elements.pdfZoomResetButton?.addEventListener("click", () => setPdfViewerZoom(1, { mode: "fit-width" }));
  elements.openOptionsButton.addEventListener("click", async () => {
    await discardUnsubmittedDraft({ clearSelection: true, render: true });
    const optionsPath = state.currentDocument?.id
      ? `src/options/options.html?documentId=${encodeURIComponent(state.currentDocument.id)}`
      : "src/options/options.html";
    await openOrFocusExtensionPage(optionsPath);
  });
  elements.newFolderButton.addEventListener("click", showFolderCreator);
  elements.confirmFolderButton.addEventListener("click", createDocumentFolder);
  elements.cancelFolderButton.addEventListener("click", hideFolderCreator);
  elements.folderNameInput.addEventListener("keydown", handleFolderNameKeydown);
  elements.documentList.addEventListener("dragover", handleDocumentDragOver);
  elements.documentList.addEventListener("dragleave", handleDocumentDragLeave);
  elements.documentList.addEventListener("drop", (event) => handleDocumentDrop(event, ""));
  elements.trashToggle.addEventListener("click", toggleTrashSection);
  elements.documentContextMenu.addEventListener("click", handleContextMenuAction);
  elements.panelToggleButton.addEventListener("click", handlePanelToggle);
  elements.selectionAskButton.addEventListener("click", openDraftQuestion);
  elements.documentSectionToggle.addEventListener("click", () =>
    toggleSidebarSection(elements.documentSectionToggle)
  );
  elements.tocSectionToggle.addEventListener("click", () =>
    toggleSidebarSection(elements.tocSectionToggle)
  );
  elements.knowledgeButton.addEventListener("click", openKnowledgePage);
  elements.sendQuestionButton.addEventListener("click", handleQuestionButtonClick);
  elements.messageList.addEventListener("click", handleMessageListClick);
  elements.questionInput.addEventListener("input", updateSendState);
  elements.questionInput.addEventListener("keydown", handleQuestionKeydown);
  elements.documentContent.addEventListener("mouseup", captureSelection);
  elements.documentContent.addEventListener("keyup", captureSelection);
  elements.documentContent.addEventListener("click", handleDocumentClick);
  elements.documentContent.addEventListener("contextmenu", handleDocumentHighlightContextMenu);
  elements.documentContent.addEventListener("scroll", () => {
    hideSelectionAskButton();
    schedulePdfHybridViewportAnchorRemember();
    scheduleReaderLocationUpdate();
    schedulePdfHybridVisiblePageRender({ pruneStaleQueue: true });
  });
  elements.documentContent.addEventListener("wheel", handleDocumentContentWheel, { passive: false });
  elements.documentContent.addEventListener("touchstart", releasePendingManualTocTargetForUserScrollIntent, { passive: true });
  elements.documentContent.addEventListener("pointerdown", releasePendingManualTocTargetForUserScrollIntent);
  elements.sidebarCollapseButton.addEventListener("click", toggleWholeSidebar);
  elements.leftResizer.addEventListener("pointerdown", (event) => beginResize(event, "left"));
  elements.rightResizer.addEventListener("pointerdown", (event) => beginResize(event, "right"));
  elements.leftResizer.addEventListener("keydown", (event) => handleResizerKeydown(event, "left"));
  elements.rightResizer.addEventListener("keydown", (event) => handleResizerKeydown(event, "right"));
  setupDocumentContentResizeObserver();
  document.addEventListener("keydown", handleShortcut);
  document.addEventListener("click", hideDocumentContextMenu);
  document.addEventListener("scroll", hideDocumentContextMenu, true);
}

function setupDocumentContentResizeObserver() {
  if (!elements.documentContent) {
    return;
  }
  lastDocumentContentWidth = Math.round(elements.documentContent.clientWidth || 0);
  if (!("ResizeObserver" in window)) {
    window.addEventListener("resize", () => {
      handleDocumentContentWidthChange();
    });
    return;
  }
  documentContentResizeObserver?.disconnect?.();
  documentContentResizeObserver = new ResizeObserver(() => {
    handleDocumentContentWidthChange();
  });
  documentContentResizeObserver.observe(elements.documentContent);
}

function handleDocumentContentWidthChange(anchor = null, options = {}) {
  const nextWidth = Math.round(elements.documentContent?.clientWidth || 0);
  const force = Boolean(options.force);
  if (!nextWidth || (!force && Math.abs(nextWidth - lastDocumentContentWidth) < 1)) {
    return;
  }
  lastDocumentContentWidth = nextWidth;
  if (layoutState.resizing && !force) {
    pendingPdfViewportRefreshAnchor = anchor || pendingPdfViewportRefreshAnchor || getLastPdfHybridViewportAnchor();
    return;
  }
  schedulePdfHybridViewportRefresh(anchor || getLastPdfHybridViewportAnchor(), {
    deferMs: options.deferMs
  });
}

function handleDocumentContentWheel(event) {
  releasePendingManualTocTargetForUserScrollIntent();
  if (!event.shiftKey || !isPdfHybridViewRendered()) {
    return;
  }
  const horizontalDelta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
  if (!horizontalDelta) {
    return;
  }
  const scrollContainer = elements.documentContent;
  const maxScrollLeft = Math.max(0, scrollContainer.scrollWidth - scrollContainer.clientWidth);
  if (maxScrollLeft <= 0) {
    return;
  }
  event.preventDefault();
  scrollContainer.scrollLeft = clamp(scrollContainer.scrollLeft + horizontalDelta, 0, maxScrollLeft);
  schedulePdfHybridViewportAnchorRemember();
  hideSelectionAskButton();
  scheduleReaderLocationUpdate();
  schedulePdfHybridVisiblePageRender({ pruneStaleQueue: true });
}

function releasePendingManualTocTargetForUserScrollIntent() {
  if (!pendingManualTocTarget) {
    return;
  }
  clearPendingManualTocTarget();
  scheduleReaderLocationUpdate();
}

async function importPendingPdfOnStartup() {
  const pendingImportId = String(state.pendingImportId || "").trim();
  if (!pendingImportId) {
    return false;
  }

  let pendingImport = null;
  setPdfImportBusy(true);

  try {
    setStatus("正在读取 popup 暂存的本地 PDF...");
    pendingImport = await getPendingPdfImport(pendingImportId);
    if (!pendingImport) {
      await showPendingPdfImportView(
        { id: pendingImportId, fileName: "本地 PDF" },
        "没有找到 popup 暂存的 PDF。请在 popup 或当前 reader 里重新选择本地 PDF。"
      );
      return true;
    }

    await showPendingPdfImportView(pendingImport, "正在导入 popup 中选择的本地 PDF...");
    const bytes = getPendingPdfImportBytes(pendingImport);
    assertLikelyPdfBytes(bytes);

    const fileName = getPendingPdfImportFileName(pendingImport);
    const sourceUrl = String(pendingImport.sourceUrl || "").trim() || fileName;
    const sourceIdentity = pendingImport.sourceUrl
      ? sourceUrl
      : `local-pdf:${fileName}:${pendingImport.size || 0}:${pendingImport.lastModified || 0}`;

    await importPdfBytes({
      bytes,
      sourceUrl,
      sourceIdentity,
      title: deriveTitleFromFileName(fileName),
      fileName,
      importSource: pendingImport.sourceUrl ? "popup-local-file-for-source" : "popup-local-file",
      localFile: {
        name: fileName,
        size: pendingImport.size || bytes.byteLength || 0,
        lastModified: pendingImport.lastModified || 0,
        selectedFromUrl: pendingImport.selectedFromUrl || "",
        pendingImportId
      }
    });

    try {
      await deletePendingPdfImport(pendingImportId);
    } catch (deleteError) {
      await logTask("pdf.import.pending.delete_failed", {
        pendingImportId,
        fileName,
        message: getErrorMessage(deleteError)
      });
      setStatus("PDF 已导入，但暂存记录删除失败。请重新加载扩展后再检查本地数据。");
    }

    return true;
  } catch (error) {
    await logTask("pdf.import.pending.failed", {
      pendingImportId,
      fileName: pendingImport?.fileName || "",
      size: pendingImport?.size || 0,
      message: getErrorMessage(error)
    });
    await showPendingPdfImportView(
      pendingImport || { id: pendingImportId, fileName: "本地 PDF" },
      `popup 本地 PDF 导入失败：${getPendingImportFailureMessage(error)}。暂存文件仍保留，请重新选择 PDF 或刷新后重试。`
    );
    return true;
  } finally {
    setPdfImportBusy(false);
  }
}

async function ensureInitialDocument() {
  const settings = await getSettings();
  const documents = await dbGetAll("documents");
  const folders = normalizeDocumentFolders(settings.reader?.documentFolders);
  const activeDocuments = getActiveDocumentRecords(documents, folders);
  const queryDocument = state.targetDocumentId
    ? activeDocuments.find((document) => document.id === state.targetDocumentId)
    : null;
  const sourceDocument = findDocumentBySourceUrl(activeDocuments, state.sourceUrl);
  const lastDocumentId = settings.reader?.lastDocumentId;
  let targetDocument = queryDocument;

  if (!targetDocument && state.sourceUrl && isLikelyPdfSourceUrl(state.sourceUrl)) {
    if (sourceDocument) {
      targetDocument = sourceDocument;
    } else {
      await showPendingPdfSourceView();
      await importPdfFromSourceUrl(state.sourceUrl, { auto: true });
      return;
    }
  }

  targetDocument =
    targetDocument ||
    activeDocuments.find((document) => document.id === lastDocumentId) ||
    activeDocuments.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (!targetDocument) {
    await clearCurrentDocumentView();
    return;
  }

  if (targetDocument) {
    await loadDocument(targetDocument.id);
    return;
  }

  await clearCurrentDocumentView();
}

async function showPendingPdfSourceView() {
  const sourceInfo = getSourceDisplayInfo(state.sourceUrl);
  state.currentDocument = {
    id: getPendingPdfDocumentId(),
    kind: "pdf-pending",
    title: sourceInfo.title || "待转换 PDF",
    sourceUrl: sourceInfo.normalizedSourceUrl || state.sourceUrl,
    pendingPdf: true
  };
  state.blocks = [];
  state.highlights = [];
  state.threads = [];
  state.activeThread = null;
  state.activeHighlight = null;
  clearDraftSelection();
  state.panelView = "detail";
  hideSelectionAskButton();

  await persistLastDocument("");
  renderDocument();
  renderThreads();
  renderSelection();
  renderPanelView();
  await renderMessages();
  const canReadSource = canFetchPdfSource(sourceInfo.normalizedSourceUrl || sourceInfo.rawSourceUrl || state.sourceUrl);
  setStatus(
    canReadSource
      ? "这份 PDF 还没有转换成 StepRead 文档，StepRead 正在尝试读取来源。"
      : "浏览器扩展无法凭本地路径直接读取 PDF。请在 popup 或当前 reader 里选择本地 PDF 导入。"
  );
}

async function showPendingPdfImportView(pendingImport, statusMessage) {
  const fileName = getPendingPdfImportFileName(pendingImport);
  state.currentDocument = {
    id: pendingImport?.id || "pending-pdf-import",
    kind: "pdf-pending",
    title: deriveTitleFromFileName(fileName),
    sourceUrl: pendingImport?.sourceUrl || fileName,
    pendingPdf: true,
    pendingImportId: pendingImport?.id || state.pendingImportId,
    pendingImportFileName: fileName,
    pendingImportStatus: statusMessage || ""
  };
  state.blocks = [];
  state.highlights = [];
  state.threads = [];
  state.activeThread = null;
  state.activeHighlight = null;
  clearDraftSelection();
  state.panelView = "detail";
  hideSelectionAskButton();

  await persistLastDocument("");
  renderDocument();
  renderThreads();
  renderSelection();
  renderPanelView();
  await renderMessages();
  setStatus(statusMessage || "正在处理本地 PDF 导入。");
}

async function loadDocument(documentId) {
  const { document, blocks } = await getDocumentWithBlocks(documentId);
  if (!document) {
    setStatus("文档不存在。");
    return;
  }

  state.currentDocument = document;
  state.blocks = blocks;
  const unsubmittedCleanup = await cleanupUnsubmittedThreadRecords(documentId);
  state.highlights = await dbGetAllByIndex("highlights", "by_documentId", documentId);
  state.threads = await dbGetAllByIndex("threads", "by_documentId", documentId);
  const invalidCount = await auditInvalidReadingRecords(documentId, blocks, state.highlights, state.threads);
  if (unsubmittedCleanup.highlights) {
    setStatus(`已清理 ${unsubmittedCleanup.highlights} 条未提交问题的草稿划线。`);
  } else if (invalidCount) {
    setStatus(`发现 ${invalidCount} 条旧划线暂时无法定位，已保留记录。`);
  }
  state.activeThread = null;
  state.activeHighlight = null;
  clearDraftSelection();
  state.panelView = "detail";
  hideSelectionAskButton();

  await persistLastDocument(documentId);
  renderDocument();
  renderThreads();
  renderSelection();
  renderPanelView();
  await renderMessages();
}

async function cleanupUnsubmittedThreadRecords(documentId) {
  const threads = await dbGetAllByIndex("threads", "by_documentId", documentId);
  const staleHighlightIds = [];

  for (const thread of threads) {
    if (!thread?.highlightId) {
      continue;
    }
    const highlight = await dbGet("highlights", thread.highlightId);
    const isExplicitDraft =
      thread.status === "draft" ||
      thread.isDraft === true ||
      highlight?.status === "draft" ||
      highlight?.isDraft === true;
    if (!isExplicitDraft) {
      continue;
    }
    const messages = await getThreadMessages(thread.id);
    const hasUserQuestion = messages.some((message) => message.role === "user");
    if (!hasUserQuestion) {
      staleHighlightIds.push(thread.highlightId);
    }
  }

  const summary = await deleteHighlightsCascade(staleHighlightIds);
  if (summary.highlights || summary.threads) {
    await logTask("document.unsubmittedDrafts.cleaned", {
      documentId,
      deletedHighlights: summary.highlights,
      deletedThreads: summary.threads,
      deletedMessages: summary.messages,
      highlightIds: summary.highlightIds,
      threadIds: summary.threadIds
    });
    notifyKnowledgeDataChanged("draft-cleaned");
  }
  return summary;
}

async function clearCurrentDocumentView() {
  state.currentDocument = null;
  state.blocks = [];
  state.highlights = [];
  state.threads = [];
  state.activeThread = null;
  state.activeHighlight = null;
  clearDraftSelection();
  state.panelView = "detail";
  hideSelectionAskButton();

  await persistLastDocument("");
  renderDocument();
  renderThreads();
  renderSelection();
  renderPanelView();
  await renderMessages();
}

async function persistLastDocument(documentId) {
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    reader: {
      ...settings.reader,
      lastDocumentId: documentId
    }
  });
}

function renderSourceUrl() {
  renderSourceLabel(state.sourceUrl);
}

function renderDocument() {
  clearPendingPdfZoomRerender();
  stopPdfHybridRender();
  updatePdfZoomControls();
  const sourceUrl = state.currentDocument?.sourceUrl || state.sourceUrl || "";
  const sourceInfo = getSourceDisplayInfo(sourceUrl);
  elements.documentTitle.textContent =
    state.currentDocument?.title || sourceInfo.title || "未命名文档";
  renderSourceLabel(sourceUrl);

  if (state.currentDocument?.kind === "pdf-pending") {
    renderPendingPdfState(sourceInfo);
  } else if (shouldRenderPdfHybridDocument()) {
    renderPdfHybridDocument();
  } else {
    renderBlocks(elements.documentContent, state.blocks, {
      highlights: getRenderableHighlights()
    });
    renderPdfHybridFallbackNotice();
    renderPdfTextLayerWarning();
  }
  renderToc();
  updateCurrentSectionBar();
}

function getRenderableHighlights() {
  const threadByHighlightId = new Map(
    state.threads
      .filter((thread) => !isDraftThread(thread) && thread.highlightId)
      .map((thread) => [thread.highlightId, thread])
  );
  const highlights = state.highlights
    .filter((highlight) => !isDraftHighlight(highlight))
    .map((highlight) => {
      if (highlight.threadId) {
        return highlight;
      }
      const linkedThread = threadByHighlightId.get(highlight.id);
      return linkedThread ? { ...highlight, threadId: linkedThread.id } : highlight;
    });
  if (
    isDraftHighlight(state.activeHighlight) &&
    state.activeHighlight.documentId === state.currentDocument?.id &&
    !highlights.some((highlight) => highlight.id === state.activeHighlight.id)
  ) {
    highlights.push(state.activeHighlight);
  }
  return highlights;
}

function shouldRenderPdfHybridDocument() {
  return state.currentDocument?.kind === "pdf-text-layer" && Boolean(getPdfHybridBytes(state.currentDocument));
}

function renderPdfHybridFallbackNotice() {
  if (state.currentDocument?.kind !== "pdf-text-layer" || getPdfHybridBytes(state.currentDocument)) {
    return;
  }

  const notice = document.createElement("p");
  notice.className = "pdf-hybrid-fallback-warning";
  notice.textContent =
    "PDF 原始页面数据不在当前会话中，已降级为 StepRead 文字阅读视图；重新选择本地 PDF 后可使用原版页面混合模式。";
  elements.documentContent.prepend(notice);
}

async function renderPdfHybridDocument() {
  const documentRecord = state.currentDocument;
  const bytes = getPdfHybridBytes(documentRecord);
  if (!bytes) {
    renderBlocks(elements.documentContent, state.blocks, {
      highlights: getRenderableHighlights()
    });
    renderPdfHybridFallbackNotice();
    renderPdfTextLayerWarning();
    return;
  }

  const token = beginPdfHybridRender();
  elements.documentContent.replaceChildren();
  renderPdfTextLayerWarning();

  const shell = document.createElement("section");
  shell.className = "pdf-hybrid-document";
  shell.dataset.documentId = documentRecord.id || "";
  elements.documentContent.append(shell);

  const loading = document.createElement("p");
  loading.className = "pdf-hybrid-status";
  loading.textContent = "正在渲染 PDF 原版页面...";
  shell.append(loading);

  let loadingTask = null;
  let pdf = null;

  try {
    const pdfjsLib = getPdfJsLib();
    loadingTask = pdfjsLib.getDocument({
      data: clonePdfBytes(bytes),
      disableWorker: !getPdfWorkerSrc(),
      disableFontFace: false,
      isEvalSupported: false,
      useSystemFonts: true
    });
    pdfHybridRenderState.loadingTask = loadingTask;
    pdf = await loadingTask.promise;
    if (!isCurrentPdfHybridRender(token)) {
      await destroyPdfHybridResources(loadingTask, pdf);
      return;
    }

    pdfHybridRenderState.pdf = pdf;
    pdfHybridRenderState.pdfjsLib = pdfjsLib;
    pdfHybridRenderState.shell = shell;
    const defaultViewport = await getPdfHybridDefaultViewport(pdf, token);
    if (!defaultViewport || !isCurrentPdfHybridRender(token)) {
      await destroyPdfHybridResources(loadingTask, pdf);
      return;
    }
    loading.remove();
    createPdfHybridPageShells({ shell, pageCount: pdf.numPages, defaultViewport });
    setupPdfHybridPageObserver(token);
    scheduleReaderLocationUpdate();
    schedulePdfHybridVisiblePageRender({ immediate: true });
    setStatus(`PDF 混合模式已建立 ${pdf.numPages} 页占位；正在按可见区域渐进渲染原版页面。`);
  } catch (error) {
    if (!isCurrentPdfHybridRender(token)) {
      return;
    }
    await destroyPdfHybridResources(loadingTask, pdf);
    pdfHybridRenderState.loadingTask = null;
    pdfHybridRenderState.pdf = null;
    renderBlocks(elements.documentContent, state.blocks, {
      highlights: getRenderableHighlights()
    });
    renderPdfHybridFallbackNotice();
    renderPdfTextLayerWarning();
    scheduleReaderLocationUpdate();
    setStatus(`PDF 原版页面渲染失败，已降级为文字阅读视图：${getErrorMessage(error)}`);
  }
}

function beginPdfHybridRender() {
  const previousLoadingTask = pdfHybridRenderState.loadingTask;
  const previousPdf = pdfHybridRenderState.pdf;
  pdfHybridRenderState.token += 1;
  resetPdfHybridRuntimeState();
  void destroyPdfHybridResources(previousLoadingTask, previousPdf);
  return pdfHybridRenderState.token;
}

function stopPdfHybridRender() {
  const previousLoadingTask = pdfHybridRenderState.loadingTask;
  const previousPdf = pdfHybridRenderState.pdf;
  pdfHybridRenderState.token += 1;
  resetPdfHybridRuntimeState();
  void destroyPdfHybridResources(previousLoadingTask, previousPdf);
}

function resetPdfHybridRuntimeState() {
  clearPendingManualTocTarget();
  pdfHybridRenderState.observer?.disconnect?.();
  if (pdfHybridRenderState.scheduleFrame) {
    cancelAnimationFrame(pdfHybridRenderState.scheduleFrame);
  }
  if (pdfViewportRefreshTimer) {
    clearTimeout(pdfViewportRefreshTimer);
  }
  if (pdfViewportAnchorRememberFrame) {
    cancelAnimationFrame(pdfViewportAnchorRememberFrame);
  }
  pdfHybridRenderState.loadingTask = null;
  pdfHybridRenderState.pdf = null;
  pdfHybridRenderState.pdfjsLib = null;
  pdfHybridRenderState.shell = null;
  pdfHybridRenderState.observer = null;
  pdfHybridRenderState.pageShells = new Map();
  pdfHybridRenderState.pageRecords = new Map();
  pdfHybridRenderState.renderQueue = [];
  pdfHybridRenderState.queuedPages = new Set();
  pdfHybridRenderState.renderingPages = new Set();
  pdfHybridRenderState.visibleTextFallbackPages = new Set();
  pdfHybridRenderState.scheduleFrame = 0;
  pdfHybridRenderState.processingQueue = false;
  pdfHybridRenderState.defaultBaseViewport = null;
  pdfViewportRefreshTimer = 0;
  pdfViewportAnchorRememberFrame = 0;
  pendingPdfViewportRefreshAnchor = null;
  pendingPdfVisibleRenderPruneStaleQueue = false;
  lastPdfHybridViewportAnchor = null;
}

function isCurrentPdfHybridRender(token) {
  return token === pdfHybridRenderState.token && state.currentDocument?.kind === "pdf-text-layer";
}

async function destroyPdfHybridResources(loadingTask, pdf) {
  await Promise.resolve(loadingTask?.destroy?.()).catch(() => {});
  await Promise.resolve(pdf?.destroy?.()).catch(() => {});
}

function waitForNextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function getPdfHybridDefaultViewport(pdf, token) {
  const firstPage = await pdf.getPage(1);
  try {
    if (!isCurrentPdfHybridRender(token)) {
      return null;
    }
    const baseViewport = getPdfViewport(firstPage, 1);
    const scale = getPdfHybridScaleForBaseWidth(baseViewport.width);
    const viewport = getPdfViewport(firstPage, scale);
    pdfHybridRenderState.defaultBaseViewport = {
      width: baseViewport.width,
      height: baseViewport.height
    };
    return viewport;
  } finally {
    firstPage.cleanup?.();
  }
}

function createPdfHybridPageShells({ shell, pageCount, defaultViewport }) {
  const fragment = document.createDocumentFragment();
  const defaultBaseViewport = pdfHybridRenderState.defaultBaseViewport || {
    width: defaultViewport.width,
    height: defaultViewport.height
  };
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const pageElement = document.createElement("section");
    pageElement.className = "pdf-hybrid-page pdf-page-placeholder-state";
    pageElement.dataset.pageNumber = String(pageNumber);
    pageElement.dataset.renderState = "placeholder";
    pageElement.setAttribute("aria-busy", "true");
    setPdfHybridPageShellSize(pageElement, defaultViewport);
    setPdfHybridPagePlaceholder(pageElement, pageNumber);
    pdfHybridRenderState.pageShells.set(pageNumber, pageElement);
    pdfHybridRenderState.pageRecords.set(pageNumber, {
      pageNumber,
      baseWidth: defaultBaseViewport.width,
      baseHeight: defaultBaseViewport.height,
      scale: getPdfHybridScaleForBaseWidth(defaultBaseViewport.width)
    });
    fragment.append(pageElement);
  }
  shell.append(fragment);
}

function setPdfHybridPagePlaceholder(pageElement, pageNumber) {
  const placeholder = document.createElement("div");
  placeholder.className = "pdf-page-placeholder";
  placeholder.textContent = `第 ${pageNumber} 页正在等待渲染`;
  pageElement.replaceChildren(placeholder);
}

function setupPdfHybridPageObserver(token) {
  if (!("IntersectionObserver" in window)) {
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!isPdfHybridViewRendered() || !pdfHybridRenderState.pdf) {
        return;
      }
      const pageNumbers = entries
        .filter((entry) => entry.isIntersecting)
        .map((entry) => normalizePageNumber(entry.target?.dataset?.pageNumber))
        .filter(Boolean);
      if (pageNumbers.length) {
        queuePdfHybridPages(expandPdfHybridPageNumbers(pageNumbers), { priority: true });
      }
    },
    {
      root: elements.documentContent,
      rootMargin: PDF_HYBRID_INTERSECTION_ROOT_MARGIN,
      threshold: 0.01
    }
  );
  pdfHybridRenderState.observer = observer;
  for (const pageElement of pdfHybridRenderState.pageShells.values()) {
    observer.observe(pageElement);
  }
}

function schedulePdfHybridVisiblePageRender(options = {}) {
  if (!isPdfHybridViewRendered() || !pdfHybridRenderState.pdf) {
    return;
  }
  if (options.immediate) {
    const pageNumbers = getPdfHybridVisiblePageNumbers();
    if (options.pruneStaleQueue) {
      prunePdfHybridRenderQueue(pageNumbers);
    }
    queuePdfHybridPages(pageNumbers, { priority: true });
    return;
  }
  pendingPdfVisibleRenderPruneStaleQueue =
    pendingPdfVisibleRenderPruneStaleQueue || Boolean(options.pruneStaleQueue);
  if (pdfHybridRenderState.scheduleFrame) {
    return;
  }
  pdfHybridRenderState.scheduleFrame = requestAnimationFrame(() => {
    pdfHybridRenderState.scheduleFrame = 0;
    const shouldPruneStaleQueue = pendingPdfVisibleRenderPruneStaleQueue;
    pendingPdfVisibleRenderPruneStaleQueue = false;
    const pageNumbers = getPdfHybridVisiblePageNumbers();
    if (shouldPruneStaleQueue) {
      prunePdfHybridRenderQueue(pageNumbers);
    }
    queuePdfHybridPages(pageNumbers, { priority: true });
  });
}

function prunePdfHybridRenderQueue(nearPageNumbers) {
  if (!pdfHybridRenderState.renderQueue.length) {
    return;
  }
  const protectedPages = new Set((nearPageNumbers || []).map(normalizePageNumber).filter(Boolean));
  addProtectedPdfRenderPage(protectedPages, pendingManualTocTarget?.pageNumber);
  addProtectedPdfRenderPage(protectedPages, pendingHighlightScrollTarget?.pageNumber);
  pdfHybridRenderState.renderQueue = pdfHybridRenderState.renderQueue.filter((pageNumber) =>
    protectedPages.has(normalizePageNumber(pageNumber))
  );
  pdfHybridRenderState.queuedPages = new Set(pdfHybridRenderState.renderQueue);
}

function addProtectedPdfRenderPage(protectedPages, pageNumber) {
  const normalizedPageNumber = normalizePageNumber(pageNumber);
  if (!normalizedPageNumber) {
    return;
  }
  for (const expandedPageNumber of expandPdfHybridPageNumbers([normalizedPageNumber])) {
    protectedPages.add(expandedPageNumber);
  }
}

function getPdfHybridVisiblePageNumbers() {
  const pages = [...pdfHybridRenderState.pageShells.values()];
  if (!pages.length) {
    return [];
  }
  const top = elements.documentContent.scrollTop;
  const bottom = top + Math.max(1, elements.documentContent.clientHeight);
  const visiblePages = pages
    .filter((pageElement) => pageElement.offsetTop <= bottom && pageElement.offsetTop + pageElement.offsetHeight >= top)
    .map((pageElement) => normalizePageNumber(pageElement.dataset.pageNumber))
    .filter(Boolean);
  if (!visiblePages.length) {
    const currentPage = normalizePageNumber(getCurrentPdfHybridPageLocation()?.pageNumber) || 1;
    return expandPdfHybridPageNumbers([currentPage]);
  }
  return expandPdfHybridPageNumbers(visiblePages);
}

function expandPdfHybridPageNumbers(pageNumbers) {
  const pageCount = pdfHybridRenderState.pdf?.numPages || getPdfPageCount(pdfHybridRenderState.pageShells.size);
  const expanded = new Set();
  for (const pageNumber of pageNumbers) {
    const normalizedPageNumber = normalizePageNumber(pageNumber);
    if (!normalizedPageNumber) {
      continue;
    }
    const start = Math.max(1, normalizedPageNumber - PDF_HYBRID_RENDER_BUFFER_PAGES);
    const end = Math.min(pageCount, normalizedPageNumber + PDF_HYBRID_RENDER_BUFFER_PAGES);
    for (let current = start; current <= end; current += 1) {
      expanded.add(current);
    }
  }
  return [...expanded].sort((a, b) => a - b);
}

function queuePdfHybridPages(pageNumbers, options = {}) {
  const orderedPageNumbers = [...new Set(pageNumbers.map(normalizePageNumber).filter(Boolean))]
    .filter((pageNumber) => !isPdfHybridPageRenderedForCurrentZoom(pageNumber));
  if (!orderedPageNumbers.length) {
    return;
  }
  const insertionOrder = options.priority ? [...orderedPageNumbers].reverse() : orderedPageNumbers;
  for (const pageNumber of insertionOrder) {
    if (pdfHybridRenderState.renderingPages.has(pageNumber)) {
      continue;
    }
    if (pdfHybridRenderState.queuedPages.has(pageNumber)) {
      if (!options.priority) {
        continue;
      }
      pdfHybridRenderState.renderQueue = pdfHybridRenderState.renderQueue.filter((queuedPage) => queuedPage !== pageNumber);
    }
    pdfHybridRenderState.queuedPages.add(pageNumber);
    if (options.priority) {
      pdfHybridRenderState.renderQueue.unshift(pageNumber);
    } else {
      pdfHybridRenderState.renderQueue.push(pageNumber);
    }
  }
  void processPdfHybridRenderQueue();
}

function isPdfHybridPageRenderedForCurrentZoom(pageNumber) {
  const pageElement = pdfHybridRenderState.pageShells.get(pageNumber);
  if (!pageElement || pageElement.dataset.renderState !== "rendered") {
    return false;
  }
  const pageRecord = pdfHybridRenderState.pageRecords.get(pageNumber) || {};
  const renderedZoomMatches = Math.abs(Number(pageElement.dataset.renderZoom || 0) - state.pdfViewerZoom) < 0.001;
  const renderedScale = Number(pageElement.dataset.renderScale || 0);
  const currentScale = Number(pageRecord.scale || 0);
  const renderedScaleMatches =
    renderedScale > 0 && currentScale > 0 ? Math.abs(renderedScale - currentScale) < 0.001 : true;
  return renderedZoomMatches && renderedScaleMatches;
}

async function processPdfHybridRenderQueue() {
  if (pdfHybridRenderState.processingQueue) {
    return;
  }
  pdfHybridRenderState.processingQueue = true;
  const processorToken = pdfHybridRenderState.token;
  try {
    while (pdfHybridRenderState.renderQueue.length) {
      if (!isCurrentPdfHybridRender(processorToken) || !pdfHybridRenderState.pdf || !pdfHybridRenderState.pdfjsLib) {
        return;
      }
      const pageNumber = pdfHybridRenderState.renderQueue.shift();
      pdfHybridRenderState.queuedPages.delete(pageNumber);
      if (!pageNumber || isPdfHybridPageRenderedForCurrentZoom(pageNumber)) {
        continue;
      }
      pdfHybridRenderState.renderingPages.add(pageNumber);
      try {
        await renderPdfHybridPage({
          pdf: pdfHybridRenderState.pdf,
          pageNumber,
          pdfjsLib: pdfHybridRenderState.pdfjsLib,
          token: processorToken
        });
      } catch (error) {
        if (isCurrentPdfHybridRender(processorToken)) {
          markPdfHybridPageRenderError(pageNumber, error);
        }
      } finally {
        pdfHybridRenderState.renderingPages.delete(pageNumber);
      }
      await waitForNextAnimationFrame();
    }
  } finally {
    pdfHybridRenderState.processingQueue = false;
    if (pdfHybridRenderState.renderQueue.length && pdfHybridRenderState.pdf) {
      void processPdfHybridRenderQueue();
    }
  }
}

async function renderPdfHybridPage({ pdf, pageNumber, pdfjsLib, token }) {
  const pageElement = pdfHybridRenderState.pageShells.get(pageNumber);
  if (!pageElement || !isCurrentPdfHybridRender(token)) {
    return null;
  }
  pageElement.dataset.renderState = "rendering";
  pageElement.classList.remove("pdf-page-render-error");
  pageElement.classList.add("pdf-page-rendering");
  pageElement.setAttribute("aria-busy", "true");

  const page = await pdf.getPage(pageNumber);
  try {
    if (!isCurrentPdfHybridRender(token)) {
      return null;
    }

    const baseViewport = getPdfViewport(page, 1);
    const scale = getPdfHybridScaleForBaseWidth(baseViewport.width);
    const viewport = getPdfViewport(page, scale);
    const pageRecord = pdfHybridRenderState.pageRecords.get(pageNumber) || { pageNumber };
    pdfHybridRenderState.pageRecords.set(pageNumber, {
      ...pageRecord,
      baseWidth: baseViewport.width,
      baseHeight: baseViewport.height,
      scale
    });
    setPdfHybridPageShellSize(pageElement, viewport);

    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page-canvas";
    canvas.setAttribute("aria-hidden", "true");

    const textLayer = document.createElement("div");
    textLayer.className = "pdf-text-layer";
    textLayer.dataset.pageNumber = String(pageNumber);

    const canvasState = await renderPdfHybridCanvas(page, viewport, canvas).catch((error) => {
      return {
        rendered: false,
        blank: true,
        error
      };
    });
    if (!isCurrentPdfHybridRender(token)) {
      return null;
    }
    const textContent = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false
    });
    if (!isCurrentPdfHybridRender(token)) {
      return null;
    }
    await renderPdfHybridTextLayer({ pdfjsLib, textContent, viewport, textLayer, pageNumber });
    if (!isCurrentPdfHybridRender(token)) {
      return null;
    }
    const textItemCount = Array.isArray(textContent?.items)
      ? textContent.items.filter((item) => String(item?.str || "").trim()).length
      : 0;
    const mappedTextCount = textLayer.querySelectorAll(".pdf-text-fragment[data-block-id]").length;
    let visibleTextFallback = false;
    if (textItemCount && (!canvasState.rendered || canvasState.blank)) {
      visibleTextFallback = true;
      pdfHybridRenderState.visibleTextFallbackPages.add(pageNumber);
      reportPdfHybridVisibleTextFallbackPages();
    }
    pageElement.replaceChildren(canvas, textLayer);
    pageElement.classList.remove(
      "pdf-page-placeholder-state",
      "pdf-page-rendering",
      "pdf-page-render-error",
      "pdf-canvas-failed",
      "pdf-text-unmapped",
      "pdf-text-visible-fallback"
    );
    if (!canvasState.rendered) {
      pageElement.classList.add("pdf-canvas-failed");
      pageElement.dataset.canvasError = getErrorMessage(canvasState.error);
    } else {
      delete pageElement.dataset.canvasError;
    }
    if (visibleTextFallback) {
      enablePdfHybridVisibleTextFallback({
        pageElement,
        textLayer,
        reason: canvasState.rendered ? "canvas-blank" : "canvas-failed"
      });
    }
    if (textItemCount && !mappedTextCount) {
      pageElement.classList.add("pdf-text-unmapped");
    }
    pageElement.dataset.renderState = "rendered";
    pageElement.dataset.renderZoom = String(state.pdfViewerZoom);
    pageElement.dataset.renderScale = String(scale);
    pageElement.classList.add("pdf-page-rendered");
    pageElement.setAttribute("aria-busy", "false");
    scheduleReaderLocationUpdate();
    handlePdfHybridPageRendered(pageNumber);
    return { visibleTextFallback };
  } finally {
    page.cleanup?.();
  }
}

function markPdfHybridPageRenderError(pageNumber, error) {
  const pageElement = pdfHybridRenderState.pageShells.get(pageNumber);
  if (!pageElement) {
    return;
  }
  pageElement.dataset.renderState = "error";
  pageElement.dataset.renderError = getErrorMessage(error);
  pageElement.classList.remove("pdf-page-rendering", "pdf-page-rendered");
  pageElement.classList.add("pdf-page-render-error");
  pageElement.setAttribute("aria-busy", "false");
  setPdfHybridPagePlaceholder(pageElement, pageNumber);
}

function reportPdfHybridVisibleTextFallbackPages() {
  const count = pdfHybridRenderState.visibleTextFallbackPages.size;
  if (!count) {
    return;
  }
  setStatus(`PDF 混合模式正在渐进渲染；已有 ${count} 页原版画布为空或失败，已改用可见文字层降级以便继续划线。`);
}

function setPdfHybridPageShellSize(pageElement, viewport) {
  pageElement.style.width = `${viewport.width}px`;
  pageElement.style.height = `${viewport.height}px`;
}

async function renderPdfHybridCanvas(page, viewport, canvas) {
  const outputScale = Math.min(PDF_CANVAS_MAX_OUTPUT_SCALE, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.ceil(viewport.width * outputScale));
  const height = Math.max(1, Math.ceil(viewport.height * outputScale));
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    return { rendered: false, blank: true };
  }
  context.save();
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.restore();
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  await page.render({ canvasContext: context, viewport, transform }).promise;
  const blank = isPdfHybridCanvasBlank(canvas);
  canvas.dataset.renderState = blank ? "blank" : "painted";
  return { rendered: true, blank };
}

async function renderPdfHybridTextLayer({ pdfjsLib, textContent, viewport, textLayer, pageNumber }) {
  textLayer.style.width = `${viewport.width}px`;
  textLayer.style.height = `${viewport.height}px`;
  const textDivs = [];
  const renderTask = pdfjsLib.renderTextLayer({
    textContent,
    container: textLayer,
    viewport,
    textDivs
  });
  await Promise.resolve(renderTask?.promise);
  renderTask.expandTextDivs?.(true);
  applyPdfHybridTextLayerMappings({ textLayer, textContent, textDivs, pageNumber });
  applyPdfHybridHighlights(textLayer, getRenderableHighlights());
}

function enablePdfHybridVisibleTextFallback({ pageElement, textLayer, reason }) {
  pageElement.classList.add("pdf-text-visible-fallback");
  pageElement.dataset.visibleTextFallback = reason || "canvas-unavailable";
  textLayer.setAttribute(
    "aria-label",
    "PDF 原版页面画布不可见，当前显示 PDF.js 可复制文字层。"
  );
}

function isPdfHybridCanvasBlank(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !canvas.width || !canvas.height) {
    return true;
  }

  const sampleColumns = 12;
  const sampleRows = 16;
  try {
    for (let row = 0; row < sampleRows; row += 1) {
      for (let column = 0; column < sampleColumns; column += 1) {
        const x = Math.min(canvas.width - 1, Math.floor((column + 0.5) * canvas.width / sampleColumns));
        const y = Math.min(canvas.height - 1, Math.floor((row + 0.5) * canvas.height / sampleRows));
        const pixel = context.getImageData(x, y, 1, 1).data;
        if (isNonWhitePdfPixel(pixel)) {
          return false;
        }
      }
    }
  } catch {
    return false;
  }
  return true;
}

function isNonWhitePdfPixel(pixel) {
  const alpha = pixel[3] ?? 255;
  if (alpha < 12) {
    return false;
  }
  return pixel[0] < 245 || pixel[1] < 245 || pixel[2] < 245;
}

function getPdfHybridPageScale(page) {
  const baseViewport = getPdfViewport(page, 1);
  return getPdfHybridScaleForBaseWidth(baseViewport.width);
}

function getPdfHybridScaleForBaseWidth(baseWidth) {
  const availableWidth = Math.max(320, elements.documentContent.clientWidth - 16);
  const fitScale = availableWidth / Math.max(1, Number(baseWidth) || 1);
  return clamp(fitScale * state.pdfViewerZoom, PDF_HYBRID_MIN_SCALE, PDF_HYBRID_MAX_SCALE);
}

function changePdfViewerZoom(delta) {
  setPdfViewerZoom(state.pdfViewerZoom + delta, { mode: "custom" });
}

function setPdfViewerZoom(value, options = {}) {
  const nextZoom = roundZoom(clamp(Number(value) || 1, PDF_VIEWER_MIN_ZOOM, PDF_VIEWER_MAX_ZOOM));
  const nextMode = options.mode || (Math.abs(nextZoom - 1) < 0.001 ? "fit-width" : "custom");
  if (Math.abs(nextZoom - state.pdfViewerZoom) < 0.001 && nextMode === state.pdfZoomMode) {
    updatePdfZoomControls();
    return;
  }
  const scrollAnchor = getPdfHybridScrollAnchor();
  state.pdfViewerZoom = nextZoom;
  state.pdfZoomMode = nextMode;
  updatePdfZoomControls();
  if (shouldRenderPdfHybridDocument()) {
    schedulePdfHybridZoomRerender(scrollAnchor);
  }
}

function schedulePdfHybridZoomRerender(scrollAnchor) {
  pendingPdfZoomScrollAnchor = scrollAnchor || getPdfHybridScrollAnchor();
  if (pdfZoomRerenderTimer) {
    window.clearTimeout(pdfZoomRerenderTimer);
  }
  pdfZoomRerenderTimer = window.setTimeout(() => {
    const anchor = pendingPdfZoomScrollAnchor;
    pendingPdfZoomScrollAnchor = null;
    pdfZoomRerenderTimer = 0;
    void rerenderPdfHybridDocumentPreservingPosition(anchor);
  }, PDF_ZOOM_RERENDER_DEBOUNCE_MS);
}

function clearPendingPdfZoomRerender() {
  if (pdfZoomRerenderTimer) {
    window.clearTimeout(pdfZoomRerenderTimer);
    pdfZoomRerenderTimer = 0;
  }
  pendingPdfZoomScrollAnchor = null;
}

async function rerenderPdfHybridDocumentPreservingPosition(scrollAnchor) {
  if (isPdfHybridViewRendered() && pdfHybridRenderState.pdf) {
    rerenderVisiblePdfHybridPagesPreservingPosition(scrollAnchor);
    return;
  }
  await renderPdfHybridDocument();
  requestAnimationFrame(() => {
    restorePdfHybridScrollAnchor(scrollAnchor);
    schedulePdfHybridVisiblePageRender({ immediate: true });
  });
}

function updatePdfZoomControls() {
  const hasPdfDocument = shouldRenderPdfHybridDocument();
  const zoomPercent = Math.round(state.pdfViewerZoom * 100);
  if (elements.pdfZoomValue) {
    elements.pdfZoomValue.textContent = `${zoomPercent}%`;
  }
  if (elements.pdfZoomOutButton) {
    elements.pdfZoomOutButton.disabled = !hasPdfDocument || state.pdfViewerZoom <= PDF_VIEWER_MIN_ZOOM + 0.001;
  }
  if (elements.pdfZoomInButton) {
    elements.pdfZoomInButton.disabled = !hasPdfDocument || state.pdfViewerZoom >= PDF_VIEWER_MAX_ZOOM - 0.001;
  }
  if (elements.pdfZoomResetButton) {
    elements.pdfZoomResetButton.disabled = !hasPdfDocument;
  }
}

function roundZoom(value) {
  return Math.round(value * 100) / 100;
}

function rerenderVisiblePdfHybridPagesPreservingPosition(scrollAnchor) {
  const interruptedPages = new Set(pdfHybridRenderState.renderingPages);
  pdfHybridRenderState.token += 1;
  pdfHybridRenderState.renderQueue = [];
  pdfHybridRenderState.queuedPages = new Set();
  pdfHybridRenderState.renderingPages = new Set();
  for (const [pageNumber, pageElement] of pdfHybridRenderState.pageShells.entries()) {
    updatePdfHybridPageShellSizeForCurrentZoom(pageNumber, pageElement);
    if (interruptedPages.has(pageNumber)) {
      invalidatePdfHybridPage(pageNumber, pageElement);
    }
  }
  requestAnimationFrame(() => {
    restorePdfHybridScrollAnchor(scrollAnchor);
    invalidatePdfHybridPages(expandPdfHybridPageNumbers(getPdfHybridVisiblePageNumbers()));
    schedulePdfHybridVisiblePageRender({ immediate: true });
  });
}

function refreshPdfHybridViewportForLayoutChange(scrollAnchor) {
  if (!isPdfHybridViewRendered() || !pdfHybridRenderState.pdf) {
    return;
  }
  const interruptedPages = new Set(pdfHybridRenderState.renderingPages);
  pdfHybridRenderState.token += 1;
  pdfHybridRenderState.renderQueue = [];
  pdfHybridRenderState.queuedPages = new Set();
  pdfHybridRenderState.renderingPages = new Set();
  const anchor = scrollAnchor || getLastPdfHybridViewportAnchor();
  for (const [pageNumber, pageElement] of pdfHybridRenderState.pageShells.entries()) {
    updatePdfHybridPageShellSizeForCurrentZoom(pageNumber, pageElement);
    if (interruptedPages.has(pageNumber)) {
      invalidatePdfHybridPage(pageNumber, pageElement);
    }
  }
  requestAnimationFrame(() => {
    restorePdfHybridScrollAnchor(anchor);
    invalidatePdfHybridPages(expandPdfHybridPageNumbers(getPdfHybridVisiblePageNumbers()));
    schedulePdfHybridVisiblePageRender({ immediate: true });
  });
}

function schedulePdfHybridViewportRefresh(scrollAnchor, options = {}) {
  if (!isPdfHybridViewRendered() || !pdfHybridRenderState.pdf) {
    return;
  }
  pendingPdfViewportRefreshAnchor = scrollAnchor || pendingPdfViewportRefreshAnchor || getLastPdfHybridViewportAnchor();
  if (pdfViewportRefreshTimer) {
    window.clearTimeout(pdfViewportRefreshTimer);
  }
  pdfViewportRefreshTimer = window.setTimeout(() => {
    const anchor = pendingPdfViewportRefreshAnchor || getLastPdfHybridViewportAnchor();
    pendingPdfViewportRefreshAnchor = null;
    pdfViewportRefreshTimer = 0;
    refreshPdfHybridViewportForLayoutChange(anchor);
  }, Math.max(0, Number(options.deferMs) || 0));
}

function invalidatePdfHybridPages(pageNumbers) {
  const uniquePageNumbers = [...new Set((pageNumbers || []).map(normalizePageNumber).filter(Boolean))];
  for (const pageNumber of uniquePageNumbers) {
    const pageElement = pdfHybridRenderState.pageShells.get(pageNumber);
    if (pageElement) {
      invalidatePdfHybridPage(pageNumber, pageElement);
    }
  }
}

function invalidatePdfHybridPage(pageNumber, pageElement) {
  pageElement.dataset.renderState = "placeholder";
  delete pageElement.dataset.renderZoom;
  delete pageElement.dataset.renderScale;
  pageElement.classList.remove(
    "pdf-page-rendered",
    "pdf-page-rendering",
    "pdf-page-render-error",
    "pdf-canvas-failed",
    "pdf-text-unmapped",
    "pdf-text-visible-fallback"
  );
  pageElement.classList.add("pdf-page-placeholder-state");
  pageElement.setAttribute("aria-busy", "true");
  setPdfHybridPagePlaceholder(pageElement, pageNumber);
}

function updatePdfHybridPageShellSizeForCurrentZoom(pageNumber, pageElement) {
  const pageRecord = pdfHybridRenderState.pageRecords.get(pageNumber) || {};
  const baseViewport = {
    width: pageRecord.baseWidth || pdfHybridRenderState.defaultBaseViewport?.width || pageElement.offsetWidth || 612,
    height: pageRecord.baseHeight || pdfHybridRenderState.defaultBaseViewport?.height || pageElement.offsetHeight || 792
  };
  const scale = getPdfHybridScaleForBaseWidth(baseViewport.width);
  setPdfHybridPageShellSize(pageElement, {
    width: baseViewport.width * scale,
    height: baseViewport.height * scale
  });
  pdfHybridRenderState.pageRecords.set(pageNumber, {
    ...pageRecord,
    pageNumber,
    baseWidth: baseViewport.width,
    baseHeight: baseViewport.height,
    scale
  });
}

function getDocumentScrollRatio() {
  const maxScroll = Math.max(1, elements.documentContent.scrollHeight - elements.documentContent.clientHeight);
  return clamp(elements.documentContent.scrollTop / maxScroll, 0, 1);
}

function restoreDocumentScrollRatio(ratio) {
  const maxScroll = Math.max(0, elements.documentContent.scrollHeight - elements.documentContent.clientHeight);
  elements.documentContent.scrollTop = maxScroll * clamp(Number(ratio) || 0, 0, 1);
  scheduleReaderLocationUpdate();
}

function getPdfHybridScrollAnchor() {
  const location = getCurrentPdfHybridPageLocation();
  if (location?.pageNumber) {
    const horizontalAnchor = getPdfHybridHorizontalAnchor(location.pageNumber);
    return {
      kind: "pdf-page",
      pageNumber: location.pageNumber,
      pageOffsetRatio: location.pageOffsetRatio,
      ...horizontalAnchor
    };
  }

  return {
    kind: "scroll-ratio",
    scrollRatio: getDocumentScrollRatio(),
    ...getPdfHybridHorizontalAnchor()
  };
}

function restorePdfHybridScrollAnchor(anchor) {
  if (anchor?.kind === "pdf-page" && Number.isFinite(anchor.pageNumber)) {
    const pageElement = getRenderedPdfPageElement(anchor.pageNumber);
    if (pageElement) {
      const maxScroll = Math.max(0, elements.documentContent.scrollHeight - elements.documentContent.clientHeight);
      const pageHeight = Math.max(1, pageElement.offsetHeight);
      const pageOffsetRatio = clamp(Number(anchor.pageOffsetRatio) || 0, 0, 1);
      elements.documentContent.scrollTop = clamp(
        pageElement.offsetTop + pageHeight * pageOffsetRatio - READER_LOCATION_SCROLL_OFFSET,
        0,
        maxScroll
      );
      restorePdfHybridHorizontalAnchor(anchor, pageElement);
      scheduleReaderLocationUpdate();
      rememberPdfHybridViewportAnchor();
      return;
    }
  }

  restoreDocumentScrollRatio(anchor?.scrollRatio);
  restorePdfHybridHorizontalAnchor(anchor);
  rememberPdfHybridViewportAnchor();
}

function getPdfHybridHorizontalAnchor(pageNumber = 0) {
  const scrollContainer = elements.documentContent;
  const clientWidth = Math.max(1, scrollContainer.clientWidth || 1);
  const maxScrollLeft = Math.max(0, scrollContainer.scrollWidth - clientWidth);
  const scrollLeft = Math.max(0, scrollContainer.scrollLeft || 0);
  const pageElement = pageNumber ? getRenderedPdfPageElement(pageNumber) : null;
  const viewportCenterX = scrollLeft + clientWidth / 2;
  const pageWidth = Math.max(1, pageElement?.offsetWidth || 1);
  const pageCenterRatio = pageElement
    ? clamp((viewportCenterX - pageElement.offsetLeft) / pageWidth, 0, 1)
    : 0.5;

  return {
    pageCenterRatio,
    scrollLeft,
    scrollLeftRatio: maxScrollLeft > 0 ? clamp(scrollLeft / maxScrollLeft, 0, 1) : 0,
    viewportClientWidth: clientWidth
  };
}

function restorePdfHybridHorizontalAnchor(anchor, pageElement = null) {
  const scrollContainer = elements.documentContent;
  const clientWidth = Math.max(1, scrollContainer.clientWidth || 1);
  const maxScrollLeft = Math.max(0, scrollContainer.scrollWidth - clientWidth);
  if (maxScrollLeft <= 0) {
    scrollContainer.scrollLeft = 0;
    return;
  }

  let nextScrollLeft = Number.isFinite(anchor?.scrollLeft) ? anchor.scrollLeft : scrollContainer.scrollLeft;
  const activePageElement =
    pageElement ||
    (anchor?.pageNumber ? getRenderedPdfPageElement(anchor.pageNumber) : null);
  if (activePageElement) {
    const pageWidth = Math.max(1, activePageElement.offsetWidth || 1);
    const savedPageCenterRatio = Number(anchor?.pageCenterRatio);
    const pageCenterRatio =
      pageWidth <= clientWidth || !Number.isFinite(savedPageCenterRatio)
        ? 0.5
        : clamp(savedPageCenterRatio, 0, 1);
    nextScrollLeft = activePageElement.offsetLeft + pageWidth * pageCenterRatio - clientWidth / 2;
  } else if (Number.isFinite(anchor?.scrollLeftRatio)) {
    nextScrollLeft = maxScrollLeft * clamp(anchor.scrollLeftRatio, 0, 1);
  }
  scrollContainer.scrollLeft = clamp(nextScrollLeft, 0, maxScrollLeft);
}

function rememberPdfHybridViewportAnchor(anchor = null) {
  if (!isPdfHybridViewRendered()) {
    return;
  }
  const nextAnchor = anchor || getPdfHybridScrollAnchor();
  if (nextAnchor) {
    lastPdfHybridViewportAnchor = nextAnchor;
  }
}

function schedulePdfHybridViewportAnchorRemember() {
  if (!isPdfHybridViewRendered() || pdfViewportAnchorRememberFrame) {
    return;
  }
  pdfViewportAnchorRememberFrame = requestAnimationFrame(() => {
    pdfViewportAnchorRememberFrame = 0;
    rememberPdfHybridViewportAnchor();
  });
}

function getLastPdfHybridViewportAnchor() {
  return lastPdfHybridViewportAnchor || getPdfHybridScrollAnchor();
}

function getPdfViewport(page, scale) {
  try {
    const viewport = page.getViewport({ scale });
    if (isValidPdfViewport(viewport)) {
      return viewport;
    }
  } catch {
    // Older bundled PDF.js builds expect getViewport(scale).
  }
  return page.getViewport(scale);
}

function isValidPdfViewport(viewport) {
  return Boolean(
    viewport &&
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    viewport.width > 0 &&
    viewport.height > 0
  );
}

function applyPdfHybridTextLayerMappings({ textLayer, textContent, textDivs, pageNumber }) {
  const pageBlocks = state.blocks
    .filter((block) => Number(block.pageNumber) === Number(pageNumber))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const mapper = createPdfHybridTextItemMapper(pageBlocks);
  const items = Array.isArray(textContent?.items) ? textContent.items : [];

  textDivs.forEach((textDiv, index) => {
    const itemText = normalizeImportedText(items[index]?.str || textDiv.textContent || "");
    const mapping = mapper(itemText);
    if (!mapping) {
      return;
    }
    textDiv.classList.add("pdf-text-fragment");
    textDiv.dataset.blockId = mapping.block.id;
    textDiv.dataset.blockOrder = String(mapping.block.order ?? 0);
    textDiv.dataset.blockLocalStartOffset = String(mapping.localStartOffset);
    textDiv.dataset.blockLocalEndOffset = String(mapping.localEndOffset);
    textDiv.dataset.pageNumber = String(pageNumber);
  });

  textLayer.classList.toggle("pdf-text-layer-mapped", Boolean(textLayer.querySelector(".pdf-text-fragment")));
}

function createPdfHybridTextItemMapper(pageBlocks) {
  let blockIndex = 0;
  let blockOffset = 0;
  return (itemText) => {
    const text = normalizeImportedText(itemText);
    if (!text || !pageBlocks.length) {
      return null;
    }

    for (let index = blockIndex; index < pageBlocks.length; index += 1) {
      const block = pageBlocks[index];
      const blockText = getBlockPlainText(block);
      const searchOffset = index === blockIndex ? blockOffset : 0;
      const localStartOffset = findPdfHybridItemOffset(blockText, text, searchOffset);
      if (localStartOffset < 0) {
        continue;
      }
      blockIndex = index;
      blockOffset = Math.min(blockText.length, localStartOffset + text.length);
      return {
        block,
        localStartOffset,
        localEndOffset: blockOffset
      };
    }

    const fallbackBlock = pageBlocks[Math.min(blockIndex, pageBlocks.length - 1)];
    if (!fallbackBlock) {
      return null;
    }
    const blockText = getBlockPlainText(fallbackBlock);
    const localStartOffset = Math.min(blockOffset, blockText.length);
    const localEndOffset = Math.min(blockText.length, localStartOffset + text.length);
    blockOffset = localEndOffset;
    return {
      block: fallbackBlock,
      localStartOffset,
      localEndOffset
    };
  };
}

function findPdfHybridItemOffset(blockText, itemText, searchOffset) {
  const direct = blockText.indexOf(itemText, searchOffset);
  if (direct >= 0) {
    return direct;
  }
  const trimmed = itemText.trim();
  if (trimmed && trimmed !== itemText) {
    const trimmedMatch = blockText.indexOf(trimmed, searchOffset);
    if (trimmedMatch >= 0) {
      return trimmedMatch;
    }
  }
  const compactNeedle = normalizePlainText(itemText);
  const compactBlock = normalizePlainText(blockText.slice(searchOffset));
  if (compactNeedle && compactBlock.startsWith(compactNeedle)) {
    return searchOffset;
  }
  return -1;
}

function applyPdfHybridHighlights(textLayer, highlights) {
  const fragments = [...textLayer.querySelectorAll(".pdf-text-fragment[data-block-id]")];
  if (!fragments.length || !highlights?.length) {
    return;
  }

  const fragmentIndex = createPdfHybridFragmentIndex(fragments);
  const segmentsByFragment = new Map();
  for (const highlight of highlights) {
    for (const range of getHighlightBlockRanges(highlight)) {
      const rangeStart = Number(range.localStartOffset);
      const rangeEnd = Number(range.localEndOffset);
      if (!range.blockId || !Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) {
        continue;
      }
      for (const fragment of getPdfHybridFragmentsForRange(fragmentIndex, range)) {
        const fragmentStart = Number(fragment.dataset.blockLocalStartOffset);
        const fragmentEnd = Number(fragment.dataset.blockLocalEndOffset);
        if (!Number.isFinite(fragmentStart) || !Number.isFinite(fragmentEnd)) {
          continue;
        }
        const start = Math.max(rangeStart, fragmentStart);
        const end = Math.min(rangeEnd, fragmentEnd);
        if (end <= start) {
          continue;
        }
        const list = segmentsByFragment.get(fragment) || [];
        list.push({
          start: start - fragmentStart,
          end: end - fragmentStart,
          highlight,
          segmentIndex: range.segmentIndex || 0
        });
        segmentsByFragment.set(fragment, list);
      }
    }
  }

  for (const [fragment, segments] of segmentsByFragment.entries()) {
    wrapPdfHybridFragmentSegments(fragment, segments);
  }
}

function createPdfHybridFragmentIndex(fragments) {
  const byBlockId = new Map();
  const byPageAndBlockId = new Map();
  for (const fragment of fragments) {
    const blockId = fragment.dataset.blockId || "";
    if (!blockId) {
      continue;
    }
    appendMapList(byBlockId, blockId, fragment);
    const pageNumber = normalizePageNumber(fragment.dataset.pageNumber);
    if (pageNumber) {
      appendMapList(byPageAndBlockId, createPdfHybridFragmentIndexKey(pageNumber, blockId), fragment);
    }
  }
  return { byBlockId, byPageAndBlockId };
}

function getPdfHybridFragmentsForRange(fragmentIndex, range) {
  const pageNumber = normalizePageNumber(range.pageNumber || getBlockById(range.blockId)?.pageNumber);
  if (pageNumber) {
    const byPage = fragmentIndex.byPageAndBlockId.get(createPdfHybridFragmentIndexKey(pageNumber, range.blockId));
    if (byPage?.length) {
      return byPage;
    }
  }
  return fragmentIndex.byBlockId.get(range.blockId) || [];
}

function createPdfHybridFragmentIndexKey(pageNumber, blockId) {
  return `${pageNumber}:${blockId}`;
}

function getBlockById(blockId) {
  return state.blocks.find((block) => block.id === blockId) || null;
}

function appendMapList(map, key, value) {
  const list = map.get(key);
  if (list) {
    list.push(value);
    return;
  }
  map.set(key, [value]);
}

function refreshDocumentHighlights() {
  if (isPdfHybridViewRendered()) {
    refreshPdfHybridHighlights();
    return;
  }
  renderDocumentPreservingScroll();
}

function refreshPdfHybridHighlights() {
  const textLayers = [...elements.documentContent.querySelectorAll(".pdf-text-layer")];
  for (const textLayer of textLayers) {
    clearPdfHybridHighlights(textLayer);
    applyPdfHybridHighlights(textLayer, getRenderableHighlights());
  }
}

function clearPdfHybridHighlights(textLayer) {
  const marks = [...textLayer.querySelectorAll(".reader-highlight")];
  for (const mark of marks) {
    const parent = mark.parentNode;
    const text = document.createTextNode(mark.textContent || "");
    mark.replaceWith(text);
    parent?.normalize?.();
  }
}

function renderDocumentPreservingScroll() {
  const scrollTop = elements.documentContent.scrollTop;
  renderDocument();
  requestAnimationFrame(() => {
    elements.documentContent.scrollTop = scrollTop;
    updateCurrentSectionBar();
  });
}

function getHighlightBlockRanges(highlight) {
  const ranges = Array.isArray(highlight?.blockRanges) && highlight.blockRanges.length
    ? highlight.blockRanges
    : [
        {
          blockId: highlight?.blockId,
          text: highlight?.text,
          localStartOffset: highlight?.localStartOffset,
          localEndOffset: highlight?.localEndOffset
        }
      ];
  return ranges.map((range, index) => ({
    ...range,
    segmentIndex: index,
    blockId: range.blockId || highlight?.blockId || "",
    text: range.text || highlight?.text || "",
    localStartOffset: range.localStartOffset,
    localEndOffset: range.localEndOffset
  }));
}

function wrapPdfHybridFragmentSegments(fragment, segments) {
  const textNode = [...fragment.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  if (!textNode) {
    return;
  }
  const safeSegments = segments
    .map((segment) => ({
      ...segment,
      start: clamp(Number(segment.start), 0, textNode.textContent.length),
      end: clamp(Number(segment.end), 0, textNode.textContent.length)
    }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => b.start - a.start);

  for (const segment of safeSegments) {
    const selectedNode = textNode.splitText(segment.start);
    selectedNode.splitText(segment.end - segment.start);
    const mark = createHighlightMark({
      ...segment.highlight,
      segmentIndex: segment.segmentIndex
    });
    selectedNode.parentNode.insertBefore(mark, selectedNode);
    mark.append(selectedNode);
  }
}

function createHighlightMark(highlight) {
  const mark = document.createElement("mark");
  mark.className = "reader-highlight";
  if (highlight.isDraft || highlight.status === "draft") {
    mark.classList.add("reader-highlight-draft");
  }
  mark.dataset.highlightId = highlight.id || "";
  mark.dataset.threadId = highlight.isDraft || highlight.status === "draft" ? "" : highlight.threadId || "";
  mark.dataset.segmentIndex = String(highlight.segmentIndex || 0);
  return mark;
}

function renderPdfTextLayerWarning() {
  const warning = state.currentDocument?.pdf?.textLayerWarning || "";
  if (!warning) {
    return;
  }

  const notice = document.createElement("p");
  notice.className = "pdf-text-layer-warning";
  notice.textContent = warning;
  elements.documentContent.prepend(notice);
}

function renderSourceLabel(sourceUrl) {
  const sourceInfo = getSourceDisplayInfo(sourceUrl);
  elements.sourceUrl.textContent = sourceInfo.displaySource
    ? `来源：${sourceInfo.displaySource}`
    : "";
  elements.sourceUrl.title = sourceInfo.displayPath || sourceInfo.rawSourceUrl || "";
}

function renderPendingPdfState(sourceInfo) {
  elements.documentContent.replaceChildren();
  const sourceForRead = sourceInfo.normalizedSourceUrl || sourceInfo.rawSourceUrl || state.sourceUrl || "";
  const canRetrySource = canFetchPdfSource(sourceForRead);

  const shell = document.createElement("section");
  shell.className = "pending-pdf-state";

  const title = document.createElement("h2");
  title.textContent = sourceInfo.title || "待转换 PDF";

  const description = document.createElement("p");
  description.textContent = canRetrySource
    ? "StepRead 会先尝试读取这份 PDF 的可复制文字层，并导入为可划线、可提问的阅读文档。如果浏览器无法读取来源文件，请选择本地 PDF 导入。"
    : "浏览器扩展无法凭 file:// 或普通本地路径直接读取 PDF。请在 popup 或当前 reader 里点击“选择本地 PDF”，通过文件选择器授权导入。";

  const source = document.createElement("p");
  source.className = "pending-pdf-source";
  source.textContent = sourceInfo.displayPath
    ? `本地路径：${sourceInfo.displayPath}`
    : `来源：${sourceInfo.rawSourceUrl || "未知来源"}`;

  const pendingStatus = document.createElement("p");
  pendingStatus.textContent = state.currentDocument?.pendingImportStatus || "";
  pendingStatus.hidden = !pendingStatus.textContent;

  const actions = document.createElement("div");
  actions.className = "pending-pdf-actions";

  if (canRetrySource) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.textContent = "重试读取来源";
    retryButton.addEventListener("click", () => {
      void importPdfFromSourceUrl(state.sourceUrl || sourceInfo.rawSourceUrl);
    });
    actions.append(retryButton);
  }

  const localButton = document.createElement("button");
  localButton.type = "button";
  localButton.className = canRetrySource ? "secondary" : "";
  localButton.textContent = "选择本地 PDF";
  localButton.addEventListener("click", () => {
    openPdfFilePicker({
      sourceUrl: state.sourceUrl || sourceInfo.normalizedSourceUrl || sourceInfo.rawSourceUrl || ""
    });
  });

  actions.append(localButton);
  shell.append(title, description, source, pendingStatus, actions);
  elements.documentContent.append(shell);
}

function openPdfFilePicker(options = {}) {
  if (!elements.pdfFileInput) {
    setStatus("当前浏览器不支持文件选择入口。");
    return;
  }
  elements.pdfFileInput.dataset.sourceUrl = options.sourceUrl || "";
  elements.pdfFileInput.value = "";
  elements.pdfFileInput.click();
}

async function handlePdfFileInputChange(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  const sourceUrl = input.dataset.sourceUrl || "";
  input.dataset.sourceUrl = "";
  input.value = "";

  if (!file) {
    return;
  }

  await importPdfFromFile(file, { sourceUrl });
}

async function importPdfFromSourceUrl(sourceUrl, options = {}) {
  const rawSourceUrl = String(sourceUrl || "").trim();
  if (!rawSourceUrl) {
    setStatus("没有可读取的 PDF 来源。请直接选择本地 PDF 文件。");
    return false;
  }
  if (pdfImportInProgress) {
    setStatus("PDF 正在导入，请稍候。");
    return false;
  }

  setPdfImportBusy(true);
  const sourceInfo = getSourceDisplayInfo(rawSourceUrl);

  try {
    setStatus(options.auto ? "正在尝试读取 PDF 文字层..." : "正在读取 PDF 来源...");
    const result = await readPdfBytesFromSourceUrl(rawSourceUrl);
    await importPdfBytes({
      bytes: result.bytes,
      sourceUrl: result.sourceUrl,
      sourceIdentity: result.sourceUrl,
      title: sourceInfo.title,
      fileName: sourceInfo.fileName,
      importSource: "source-url"
    });
    return true;
  } catch (error) {
    await logTask("pdf.import.source.failed", {
      sourceUrl: rawSourceUrl,
      message: getErrorMessage(error),
      auto: Boolean(options.auto)
    });
    setStatus("无法直接读取这个 PDF 来源。请点击“选择本地 PDF”，用文件导入可复制文字层。");
    return false;
  } finally {
    setPdfImportBusy(false);
  }
}

async function importPdfFromFile(file, options = {}) {
  if (pdfImportInProgress) {
    setStatus("PDF 正在导入，请稍候。");
    return false;
  }

  setPdfImportBusy(true);
  try {
    const fileName = String(file?.name || "local.pdf");
    if (!isPdfFileLike(file)) {
      throw new Error("Selected file is not a PDF.");
    }

    setStatus("正在读取本地 PDF 文件...");
    const bytes = new Uint8Array(await file.arrayBuffer());
    assertLikelyPdfBytes(bytes);

    const sourceUrl = String(options.sourceUrl || "").trim() || fileName;
    const sourceIdentity = options.sourceUrl
      ? sourceUrl
      : `local-pdf:${fileName}:${file.size || 0}:${file.lastModified || 0}`;

    await importPdfBytes({
      bytes,
      sourceUrl,
      sourceIdentity,
      title: deriveTitleFromFileName(fileName),
      fileName,
      importSource: options.sourceUrl ? "local-file-for-source" : "local-file",
      localFile: {
        name: fileName,
        size: file.size || 0,
        lastModified: file.lastModified || 0
      }
    });
    return true;
  } catch (error) {
    await logTask("pdf.import.file.failed", {
      fileName: file?.name || "",
      size: file?.size || 0,
      message: getErrorMessage(error)
    });
    setStatus("PDF 导入失败：只能读取带可复制文字层的 PDF。扫描版或损坏文件无法导入。");
    return false;
  } finally {
    setPdfImportBusy(false);
  }
}

function setPdfImportBusy(isBusy) {
  pdfImportInProgress = Boolean(isBusy);
  if (elements.importPdfButton) {
    elements.importPdfButton.disabled = pdfImportInProgress;
  }
}

async function readPdfBytesFromSourceUrl(sourceUrl) {
  const sourceInfo = getSourceDisplayInfo(sourceUrl);
  const fetchUrl = getFetchablePdfUrl(sourceInfo.normalizedSourceUrl || sourceInfo.rawSourceUrl || sourceUrl);
  if (!fetchUrl) {
    throw new Error("PDF source is not fetchable from an extension page.");
  }

  const response = await fetch(fetchUrl, {
    credentials: "include",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`PDF source returned HTTP ${response.status}.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  assertLikelyPdfBytes(bytes);
  return {
    bytes,
    sourceUrl: sourceInfo.normalizedSourceUrl || fetchUrl
  };
}

function getFetchablePdfUrl(sourceUrl) {
  const value = String(sourceUrl || "").trim();
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    return /^(https?:|blob:|data:)$/i.test(url.protocol) ? url.toString() : "";
  } catch {
    return /^https?:\/\//i.test(value) || /^data:/i.test(value) || /^blob:/i.test(value)
      ? value
      : "";
  }
}

function canFetchPdfSource(sourceUrl) {
  return Boolean(getFetchablePdfUrl(sourceUrl));
}

function getPendingPdfImportBytes(pendingImport) {
  const bytes = pendingImport?.bytes;
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new Error("Pending PDF import does not contain readable bytes.");
}

function getPendingPdfImportFileName(pendingImport) {
  return String(pendingImport?.fileName || pendingImport?.localFile?.name || "local.pdf");
}

function getPendingImportFailureMessage(error) {
  const message = getErrorMessage(error);
  if (/text layer is empty|too short|No usable text blocks/i.test(message)) {
    return "只能读取带可复制文字层的 PDF，扫描版或损坏文件无法导入";
  }
  if (/does not look like a PDF|readable bytes/i.test(message)) {
    return "暂存文件不是有效 PDF";
  }
  return message || "未知错误";
}

function rememberPdfHybridBytes(documentId, bytes) {
  const cloned = clonePdfBytes(bytes);
  if (!documentId || !cloned?.byteLength) {
    return;
  }
  pdfHybridBytesCache.set(documentId, cloned);
}

function getPdfHybridBytes(documentRecord) {
  const documentId = documentRecord?.id || "";
  if (documentId && pdfHybridBytesCache.has(documentId)) {
    return clonePdfBytes(pdfHybridBytesCache.get(documentId));
  }
  const storedBytes = documentRecord?.pdf?.dataBytes || documentRecord?.pdf?.bytes || null;
  const normalized = normalizePdfHybridBytes(storedBytes);
  if (documentId && normalized?.byteLength) {
    pdfHybridBytesCache.set(documentId, clonePdfBytes(normalized));
  }
  return normalized;
}

function createPersistablePdfHybridBytes(bytes) {
  const normalized = normalizePdfHybridBytes(bytes);
  if (!normalized || normalized.byteLength > PDF_HYBRID_PERSIST_MAX_BYTES) {
    return null;
  }
  return clonePdfBytes(normalized);
}

function normalizePdfHybridBytes(bytes) {
  if (bytes instanceof Uint8Array) {
    return bytes;
  }
  if (bytes instanceof ArrayBuffer) {
    return new Uint8Array(bytes);
  }
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return null;
}

function clonePdfBytes(bytes) {
  const normalized = normalizePdfHybridBytes(bytes);
  return normalized ? new Uint8Array(normalized) : null;
}

async function importPdfBytes({
  bytes,
  sourceUrl,
  sourceIdentity,
  title,
  fileName,
  importSource,
  localFile
}) {
  const parsed = await extractPdfTextLayer(bytes);
  const documentId = createStablePdfDocumentId(sourceIdentity || sourceUrl || fileName || "local-pdf");
  rememberPdfHybridBytes(documentId, bytes);
  const blocks = buildStepReadBlocksFromPdfPages(parsed.pages, documentId, {
    sourceUrl,
    fileName
  });
  const documentTextLength = blocks.reduce((total, block) => total + getBlockPlainText(block).length, 0);
  const lowTextLayer = isPdfTextLayerSparse(parsed, documentTextLength);

  const existingDocument = await dbGet("documents", documentId);
  const importedAt = nowIso();
  const documentTitle = normalizeImportedText(
    parsed.metadataTitle || title || deriveTitleFromFileName(fileName) || "StepRead PDF"
  );
  const outline = buildPdfDocumentOutline(parsed.outline, blocks);
  const textLayerWarning = lowTextLayer
    ? "这份 PDF 的可复制文字层很少，可能无法完整提取正文。StepRead 只显示 PDF.js 读到的原始文字层，不做 OCR，也不会识别图片里的公式。"
    : "";
  const persistablePdfBytes = createPersistablePdfHybridBytes(bytes);
  const pdfWorkerEnabled = Boolean(getPdfWorkerSrc());
  const documentRecord = {
    ...(existingDocument || {}),
    id: documentId,
    kind: "pdf-text-layer",
    contentSource: "pdfjs-text-layer",
    title: documentTitle,
    sourceUrl: sourceUrl || fileName || "",
    sourceFileName: fileName || "",
    importSource,
    localFile,
    outline,
    pageCount: parsed.pageCount,
    pdf: {
      ...(existingDocument?.pdf || {}),
      pageCount: parsed.pageCount,
      textLayer: parsed.textItemCount > 0,
      lowTextLayer,
      textItemCount: parsed.textItemCount,
      textLayerWarning,
      dataBytes: persistablePdfBytes,
      dataByteLength: bytes.byteLength || 0,
      hybridMode: true,
      hybridDataPersisted: Boolean(persistablePdfBytes),
      worker: pdfWorkerEnabled,
      ocr: false,
      imageFormulaRecognition: false,
      extractionMethod: "pdf.js getTextContent",
      pdfjsVersion: PDFJS_VERSION,
      importedAt,
      textLength: documentTextLength,
      outline
    },
    createdAt: existingDocument?.createdAt || importedAt,
    updatedAt: importedAt
  };

  rememberPdfHybridBytes(documentId, bytes);
  await replaceDocument(documentRecord, blocks);
  await logTask("pdf.imported", {
    documentId,
    title: documentTitle,
    sourceUrl: sourceUrl || "",
    importSource,
    pageCount: parsed.pageCount,
    blockCount: blocks.length,
    textLength: documentTextLength,
    textItemCount: parsed.textItemCount,
    lowTextLayer,
    pdfjsVersion: PDFJS_VERSION,
    worker: pdfWorkerEnabled,
    ocr: false
  });

  await loadDocument(documentId);
  await refreshDocumentList();
  notifyKnowledgeDataChanged("pdf-imported");
  setStatus(
    lowTextLayer
      ? `PDF 已导入：${parsed.pageCount} 页，${blocks.length} 个正文块；可复制文字层很少，可能无法完整提取正文。`
      : `PDF 已导入：${parsed.pageCount} 页，${blocks.length} 个正文块。`
  );
}

async function extractPdfTextLayer(bytes) {
  const pdfjsLib = getPdfJsLib();
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    disableWorker: !getPdfWorkerSrc(),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true
  });
  let pdf = null;

  try {
    pdf = await loadingTask.promise;
    const metadata = await pdf.getMetadata().catch(() => ({}));
    const outline = await extractPdfOutline(pdf);
    const pages = [];
    let textLength = 0;
    let textItemCount = 0;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      setStatus(`正在解析 PDF 文字层：${pageNumber}/${pdf.numPages}`);
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false
      });
      const parsedPage = parsePdfPageTextContent(textContent, pageNumber);
      pages.push(parsedPage);
      textLength += parsedPage.lines.reduce((total, line) => total + line.text.length, 0);
      textItemCount += parsedPage.textItemCount;
      page.cleanup?.();
    }

    return {
      pageCount: pdf.numPages,
      metadataTitle: normalizeImportedText(metadata?.info?.Title || metadata?.metadata?.get?.("dc:title") || ""),
      pages,
      outline,
      textItemCount,
      textLength
    };
  } finally {
    await Promise.resolve(loadingTask.destroy?.()).catch(() => {});
    await Promise.resolve(pdf?.destroy?.()).catch(() => {});
  }
}

function getPdfJsLib() {
  const pdfjsLib =
    globalThis.pdfjsLib ||
    globalThis.PDFJS ||
    globalThis.pdfjsDistBuildPdf ||
    globalThis["pdfjs-dist/build/pdf"];
  if (!pdfjsLib?.getDocument) {
    throw new Error("PDF.js vendor library is not loaded.");
  }
  const workerSrc = getPdfWorkerSrc();
  pdfjsLib.disableWorker = !workerSrc;
  if ("workerSrc" in pdfjsLib) {
    pdfjsLib.workerSrc = workerSrc;
  }
  if (pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  return pdfjsLib;
}

function getPdfWorkerSrc() {
  if (globalThis.chrome?.runtime?.getURL) {
    return chrome.runtime.getURL(PDF_WORKER_EXTENSION_PATH);
  }
  try {
    return new URL(PDF_WORKER_RELATIVE_PATH, import.meta.url).toString();
  } catch {
    return "";
  }
}

async function extractPdfOutline(pdf) {
  const rawOutline = await Promise.resolve(pdf?.getOutline?.()).catch(() => []);
  if (!Array.isArray(rawOutline) || !rawOutline.length) {
    return [];
  }

  const entries = [];
  async function visit(items, level) {
    for (const item of items || []) {
      const title = normalizeImportedText(item?.title || "");
      if (title) {
        const destination = await resolvePdfOutlineDestination(pdf, item?.dest);
        entries.push({
          id: `pdf_outline_${String(entries.length + 1).padStart(5, "0")}`,
          title,
          level: Math.min(Math.max(level, 1), 6),
          pageNumber: destination.pageNumber,
          destKind: destination.destKind,
          destTop: destination.destTop,
          destLeft: destination.destLeft,
          destZoom: destination.destZoom,
          destName: destination.destName,
          destRaw: destination.destRaw,
          source: "pdf-outline"
        });
      }
      if (Array.isArray(item?.items) && item.items.length) {
        await visit(item.items, level + 1);
      }
    }
  }

  await visit(rawOutline, 1);
  return entries;
}

async function resolvePdfOutlinePageNumber(pdf, dest) {
  const destination = await resolvePdfOutlineDestination(pdf, dest);
  return destination.pageNumber || null;
}

async function resolvePdfOutlineDestination(pdf, dest) {
  const fallback = {
    pageNumber: null,
    destKind: "",
    destTop: null,
    destLeft: null,
    destZoom: null,
    destName: typeof dest === "string" ? dest : "",
    destRaw: []
  };
  if (!dest) {
    return fallback;
  }

  let resolvedDest = dest;
  if (typeof resolvedDest === "string") {
    resolvedDest = await Promise.resolve(pdf.getDestination?.(resolvedDest)).catch(() => null);
  }
  if (!Array.isArray(resolvedDest) || !resolvedDest.length) {
    return fallback;
  }

  const pageRef = resolvedDest[0];
  let pageNumber = null;
  if (Number.isInteger(pageRef)) {
    pageNumber = pageRef + 1;
  } else {
    const pageIndex = await Promise.resolve(pdf.getPageIndex?.(pageRef)).catch(() => null);
    pageNumber = Number.isInteger(pageIndex) ? pageIndex + 1 : null;
  }

  return {
    ...fallback,
    ...extractPdfOutlineDestinationMetadata(resolvedDest),
    pageNumber,
    destRaw: serializePdfOutlineDestination(resolvedDest)
  };
}

function extractPdfOutlineDestinationMetadata(dest) {
  if (!Array.isArray(dest)) {
    return {
      destKind: "",
      destTop: null,
      destLeft: null,
      destZoom: null
    };
  }

  const destKind = getPdfDestinationKind(dest[1]);
  const numberAt = (index) => getNullableFiniteNumber(dest[index]);
  let destTop = null;
  let destLeft = null;
  let destZoom = null;

  switch (destKind) {
    case "XYZ":
      destLeft = numberAt(2);
      destTop = numberAt(3);
      destZoom = numberAt(4);
      break;
    case "FITH":
    case "FITBH":
      destTop = numberAt(2);
      break;
    case "FITV":
    case "FITBV":
      destLeft = numberAt(2);
      break;
    case "FITR":
      destLeft = numberAt(2);
      destTop = numberAt(5);
      break;
    default:
      break;
  }

  return {
    destKind,
    destTop,
    destLeft,
    destZoom
  };
}

function getPdfDestinationKind(value) {
  const rawKind = typeof value === "string" ? value : value?.name || "";
  return String(rawKind || "").trim().toUpperCase();
}

function getNullableFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function serializePdfOutlineDestination(dest) {
  if (!Array.isArray(dest)) {
    return [];
  }
  return dest.slice(0, 8).map((part, index) => serializePdfOutlineDestinationPart(part, index));
}

function serializePdfOutlineDestinationPart(part, index) {
  if (part === null || part === undefined) {
    return null;
  }
  if (typeof part === "number") {
    return Number.isFinite(part) ? part : null;
  }
  if (typeof part === "string" || typeof part === "boolean") {
    return part;
  }
  if (typeof part === "object") {
    const name = typeof part.name === "string" ? part.name : "";
    if (name) {
      return { name };
    }
    const num = getNullableFiniteNumber(part.num);
    const gen = getNullableFiniteNumber(part.gen);
    if (index === 0 && num !== null) {
      return gen !== null ? { num, gen } : { num };
    }
  }
  return null;
}

function parsePdfPageTextContent(textContent, pageNumber) {
  const fragments = (textContent?.items || [])
    .map((item, index) => normalizePdfTextItem(item, index))
    .filter((item) => item.text);
  const lines = buildPdfLines(fragments);
  const metrics = getPdfPageMetrics(lines);
  return {
    pageNumber,
    lines,
    metrics,
    textItemCount: fragments.length
  };
}

function normalizePdfTextItem(item, index) {
  const text = normalizeImportedText(item?.str || "");
  if (!text) {
    return { text: "" };
  }

  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const x = finiteNumber(transform[4], 0);
  const y = finiteNumber(transform[5], 0);
  const width = Math.max(0, finiteNumber(item?.width, 0));
  const fontSize = Math.max(
    1,
    Math.abs(finiteNumber(transform[3], 0)) ||
      Math.abs(finiteNumber(transform[0], 0)) ||
      finiteNumber(item?.height, 0) ||
      10
  );

  return {
    text,
    index,
    x,
    y,
    width,
    fontSize,
    hasEOL: Boolean(item?.hasEOL)
  };
}

function buildPdfLines(fragments) {
  const lines = [];

  for (const fragment of fragments) {
    const currentLine = lines[lines.length - 1];
    if (!currentLine || shouldStartNewPdfLine(currentLine, fragment)) {
      lines.push({
        y: fragment.y,
        fontSize: fragment.fontSize,
        fragments: [fragment],
        forceNextLine: fragment.hasEOL
      });
    } else {
      const previousCount = currentLine.fragments.length;
      currentLine.fragments.push(fragment);
      currentLine.y = (currentLine.y * previousCount + fragment.y) / (previousCount + 1);
      currentLine.fontSize = Math.max(currentLine.fontSize, fragment.fontSize);
      currentLine.forceNextLine = fragment.hasEOL;
    }
  }

  return lines
    .map((line, index) => {
      const fragmentsInLine = line.fragments;
      const text = createPdfLineText(fragmentsInLine);
      const x = fragmentsInLine.length ? Math.min(...fragmentsInLine.map((fragment) => fragment.x)) : 0;
      return {
        index,
        text,
        x,
        y: line.y,
        fontSize: line.fontSize,
        fragmentCount: fragmentsInLine.length
      };
    })
    .filter((line) => line.text && !isPdfPageNoiseLine(line.text));
}

function shouldStartNewPdfLine(line, fragment) {
  if (line.forceNextLine) {
    return true;
  }

  const previous = line.fragments[line.fragments.length - 1];
  const tolerance = Math.max(2, Math.min(8, Math.max(line.fontSize, fragment.fontSize) * 0.5));
  if (Math.abs(line.y - fragment.y) > tolerance) {
    return true;
  }

  const backwardJump = previous ? previous.x - fragment.x : 0;
  return backwardJump > Math.max(8, previous.fontSize * 0.8);
}

function createPdfLineText(fragments) {
  let output = "";
  let previous = null;

  for (const fragment of fragments) {
    if (output && shouldInsertSpaceBetweenPdfFragments(previous, fragment, output)) {
      output += " ";
    }
    output += fragment.text;
    previous = fragment;
  }

  return normalizeImportedText(output);
}

function shouldInsertSpaceBetweenPdfFragments(previous, fragment, output) {
  if (!previous || !fragment?.text || /\s$/.test(output) || /^\s/.test(fragment.text)) {
    return false;
  }
  const gap = fragment.x - (previous.x + previous.width);
  if (gap > Math.max(2, previous.fontSize * 0.22)) {
    return true;
  }
  return /[A-Za-z0-9)\]}]$/.test(previous.text) && /^[A-Za-z0-9([{]/.test(fragment.text);
}

function getPdfPageMetrics(lines) {
  const fontSizes = lines.map((line) => line.fontSize).filter((size) => Number.isFinite(size));
  const xs = lines.map((line) => line.x).filter((x) => Number.isFinite(x));
  const bodyFontSize = median(fontSizes) || 10;
  const leftMargin = median(xs) || 0;
  return {
    bodyFontSize,
    leftMargin,
    lineGap: Math.max(8, bodyFontSize * 1.35)
  };
}

function buildStepReadBlocksFromPdfPages(pages, documentId, sourceInfo) {
  const blocks = [];
  for (const page of pages) {
    appendBlocksForPdfPage(blocks, page, documentId, sourceInfo);
  }
  return blocks;
}

function appendBlocksForPdfPage(blocks, page, documentId, sourceInfo) {
  let paragraphLines = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) {
      return;
    }

    const text = joinPdfParagraphLines(paragraphLines);
    paragraphLines = [];
    for (const chunk of splitLongPdfText(text, PDF_MAX_PARAGRAPH_CHARS)) {
      appendPdfBlock(blocks, {
        documentId,
        type: "paragraph",
        text: chunk,
        pageNumber: page.pageNumber,
        sourceInfo
      });
    }
  };

  for (const line of page.lines) {
    const heading = classifyPdfHeading(line, page.metrics);
    if (heading) {
      flushParagraph();
      appendPdfBlock(blocks, {
        documentId,
        type: "heading",
        text: line.text,
        title: line.text,
        level: heading.level,
        pageNumber: page.pageNumber,
        sourceInfo
      });
      continue;
    }

    const previousLine = paragraphLines[paragraphLines.length - 1];
    if (previousLine && shouldStartNewPdfParagraph(previousLine, line, paragraphLines, page.metrics)) {
      flushParagraph();
    }
    paragraphLines.push(line);
  }

  flushParagraph();
}

function appendPdfBlock(blocks, block) {
  const text = normalizeImportedText(block.text || block.title || "");
  if (!text) {
    return;
  }
  const formulaContext = normalizeFormulaSelection(text);
  const hasMathNormalizedText = Boolean(formulaContext.hasFormulaSignals && formulaContext.normalizedText);

  const order = blocks.length;
  blocks.push({
    id: `${block.documentId}_block_${String(order + 1).padStart(5, "0")}`,
    documentId: block.documentId,
    order,
    type: block.type,
    text,
    title: block.type === "heading" ? text : undefined,
    level: block.level,
    pageNumber: block.pageNumber,
    rawText: text,
    mathNormalizedText: hasMathNormalizedText ? formulaContext.normalizedText : "",
    mathNormalizationSignals: hasMathNormalizedText ? formulaContext.signals : [],
    mathNormalizationRules: hasMathNormalizedText ? formulaContext.normalizationRules || [] : [],
    mathNormalizationNotes: hasMathNormalizedText ? formulaContext.notes : [],
    source: {
      kind: "pdf-text-layer",
      pageNumber: block.pageNumber,
      sourceUrl: block.sourceInfo?.sourceUrl || "",
      fileName: block.sourceInfo?.fileName || ""
    }
  });
}

function buildPdfDocumentOutline(pdfOutline, blocks) {
  const textLayerHeadingOutline = getTextLayerHeadingOutline(blocks);
  const mappedPdfOutline = (Array.isArray(pdfOutline) ? pdfOutline : [])
    .map((entry, index) => {
      const targetBlock = findBlockForOutlineEntry(entry, blocks);
      return {
        id: entry.id || `pdf_outline_${String(index + 1).padStart(5, "0")}`,
        blockId: targetBlock?.id || "",
        order: targetBlock?.order ?? index,
        level: Math.min(Math.max(Number(entry.level || 1), 1), 6),
        title: normalizeImportedText(entry.title || ""),
        pageNumber: entry.pageNumber || targetBlock?.pageNumber || null,
        ...copyPdfOutlineDestinationMetadata(entry),
        source: "pdf-outline"
      };
    })
    .filter((entry) => entry.title);

  if (!mappedPdfOutline.length) {
    return textLayerHeadingOutline;
  }

  const pdfOutlineKeys = new Set(
    mappedPdfOutline.map((entry) => createOutlineDuplicateKey(entry.title, entry.pageNumber))
  );
  const supplementalHeadings = textLayerHeadingOutline.filter(
    (entry) => !pdfOutlineKeys.has(createOutlineDuplicateKey(entry.title, entry.pageNumber))
  );

  return [...mappedPdfOutline, ...supplementalHeadings];
}

function getTextLayerHeadingOutline(blocks) {
  return (blocks || [])
    .filter((block) => block.type === "heading")
    .map((block) => ({
      id: block.id,
      blockId: block.id,
      order: block.order,
      level: block.level || 2,
      title: block.text || block.title || "",
      pageNumber: block.pageNumber,
      source: "text-layer-heading"
    }));
}

function copyPdfOutlineDestinationMetadata(entry) {
  return {
    destKind: typeof entry?.destKind === "string" ? entry.destKind : "",
    destTop: getNullableFiniteNumber(entry?.destTop),
    destLeft: getNullableFiniteNumber(entry?.destLeft),
    destZoom: getNullableFiniteNumber(entry?.destZoom),
    destName: typeof entry?.destName === "string" ? entry.destName : "",
    destRaw: Array.isArray(entry?.destRaw) ? entry.destRaw : []
  };
}

function findBlockForOutlineEntry(entry, blocks) {
  if (!blocks?.length) {
    return null;
  }

  const normalizedTitle = normalizePlainText(entry?.title || "");
  const pageNumber = Number(entry?.pageNumber);
  const pageBlocks = Number.isFinite(pageNumber)
    ? blocks.filter((block) => block.pageNumber === pageNumber)
    : [];
  const searchScopes = pageBlocks.length ? [pageBlocks, blocks] : [blocks];

  for (const scopedBlocks of searchScopes) {
    const exactHeading = findOutlineTitleMatch(scopedBlocks, normalizedTitle, { headingsOnly: true, exact: true });
    if (exactHeading) {
      return exactHeading;
    }
  }

  for (const scopedBlocks of searchScopes) {
    const fuzzyHeading = findOutlineTitleMatch(scopedBlocks, normalizedTitle, { headingsOnly: true, exact: false });
    if (fuzzyHeading) {
      return fuzzyHeading;
    }
  }

  for (const scopedBlocks of searchScopes) {
    const exactBlock = findOutlineTitleMatch(scopedBlocks, normalizedTitle, { headingsOnly: false, exact: true });
    if (exactBlock) {
      return exactBlock;
    }
  }

  for (const scopedBlocks of searchScopes) {
    const fuzzyBlock = findOutlineTitleMatch(scopedBlocks, normalizedTitle, { headingsOnly: false, exact: false });
    if (fuzzyBlock) {
      return fuzzyBlock;
    }
  }

  const pageBlock = findPageOutlineFallbackBlock(pageBlocks);
  if (pageBlock) {
    return pageBlock;
  }

  return blocks[0] || null;
}

function findPageOutlineFallbackBlock(pageBlocks) {
  if (!pageBlocks?.length) {
    return null;
  }
  return pageBlocks.find((block) => block.type === "heading") || pageBlocks[0] || null;
}

function findOutlineTitleMatch(blocks, normalizedTitle, { headingsOnly, exact }) {
  if (!normalizedTitle) {
    return null;
  }

  const normalizedNeedle = normalizeOutlineSearchText(normalizedTitle);
  return (blocks || []).find((block) => {
    if (headingsOnly && block.type !== "heading") {
      return false;
    }
    const blockTitle = normalizePlainText(block.text || block.title || "");
    if (!blockTitle) {
      return false;
    }
    if (exact && blockTitle === normalizedTitle) {
      return true;
    }
    if (exact) {
      return normalizeOutlineSearchText(blockTitle) === normalizedNeedle;
    }
    const normalizedBlockTitle = normalizeOutlineSearchText(blockTitle);
    return (
      normalizedBlockTitle.includes(normalizedNeedle) ||
      normalizedNeedle.includes(normalizedBlockTitle)
    );
  }) || null;
}

function normalizeOutlineSearchText(value) {
  return normalizePlainText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function createOutlineDuplicateKey(title, pageNumber) {
  return `${normalizePlainText(title)}::${Number.isFinite(pageNumber) ? pageNumber : ""}`;
}

function isPdfTextLayerSparse(parsed, documentTextLength) {
  const textItemCount = Number(parsed?.textItemCount || 0);
  const textLength = Number(documentTextLength || parsed?.textLength || 0);
  return textItemCount < PDF_LOW_TEXT_LAYER_MIN_ITEM_COUNT || textLength < PDF_LOW_TEXT_LAYER_MIN_TEXT_LENGTH;
}

function classifyPdfHeading(line, metrics) {
  const text = normalizeImportedText(line.text);
  if (!text || text.length > 140 || isSentenceLikeLine(text)) {
    return null;
  }

  const endsWithSentencePunctuation = /[，,；;。.!！?？:]$/.test(text);
  const shortHeading = text.length <= 96 && !endsWithSentencePunctuation;
  const largerThanBody = line.fontSize >= metrics.bodyFontSize * 1.22;
  const muchLargerThanBody = line.fontSize >= metrics.bodyFontSize * 1.45;
  const numberedMatch = text.match(/^(\d+(?:\.\d+){0,4})[.)、]?\s+\S/);
  if (/^第[一二三四五六七八九十百千万\d]+[章节篇部]/.test(text)) {
    return { level: 1 };
  }
  if (/^[一二三四五六七八九十]+[、.]\s*\S/.test(text)) {
    return { level: 2 };
  }
  if (/^[IVXLC]+[.)]\s+\S/i.test(text) && shortHeading) {
    return { level: 2 };
  }
  if (numberedMatch && shortHeading && (largerThanBody || text.length <= 64)) {
    return { level: Math.min(numberedMatch[1].split(".").length, 4) };
  }
  if (largerThanBody && shortHeading) {
    return { level: muchLargerThanBody ? 1 : 2 };
  }

  return null;
}

function shouldStartNewPdfParagraph(previousLine, line, paragraphLines, metrics) {
  const verticalGap = Math.abs(previousLine.y - line.y);
  if (verticalGap > metrics.lineGap) {
    return true;
  }
  const paragraphText = joinPdfParagraphLines(paragraphLines);
  if (paragraphText.length >= PDF_MAX_PARAGRAPH_CHARS) {
    return true;
  }
  const indent = line.x - metrics.leftMargin;
  return (
    paragraphLines.length >= 2 &&
    indent > metrics.bodyFontSize * 1.4 &&
    /[。.!！?？]$/.test(previousLine.text)
  );
}

function joinPdfParagraphLines(lines) {
  let output = "";
  for (const line of lines || []) {
    const text = normalizeImportedText(line.text);
    if (!text) {
      continue;
    }
    if (!output) {
      output = text;
      continue;
    }
    if (/-$/.test(output) && /^[a-z]/.test(text)) {
      output = `${output.slice(0, -1)}${text}`;
      continue;
    }
    output += shouldInsertSpaceBetweenPdfLines(output, text) ? ` ${text}` : text;
  }
  return normalizeImportedText(output);
}

function shouldInsertSpaceBetweenPdfLines(previousText, nextText) {
  if (!previousText || !nextText || /^[,.;:!?，。；：！？、)]/.test(nextText)) {
    return false;
  }
  return /[A-Za-z0-9)\]}]$/.test(previousText) && /^[A-Za-z0-9([{]/.test(nextText);
}

function splitLongPdfText(text, maxLength) {
  const value = normalizeImportedText(text);
  if (!value || value.length <= maxLength) {
    return value ? [value] : [];
  }

  const chunks = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const sentenceBreak = Math.max(
      candidate.lastIndexOf("。"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("；"),
      candidate.lastIndexOf("; ")
    );
    const splitAt = sentenceBreak > maxLength * 0.45 ? sentenceBreak + 1 : maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function isSentenceLikeLine(text) {
  return text.length > 60 && /[。.!！?？]$/.test(text);
}

function isPdfPageNoiseLine(text) {
  return /^\d{1,4}$/.test(String(text || "").trim());
}

function assertLikelyPdfBytes(bytes) {
  if (!looksLikePdfBytes(bytes)) {
    throw new Error("The selected file does not look like a PDF.");
  }
}

function looksLikePdfBytes(bytes) {
  if (!bytes || bytes.length < 5) {
    return false;
  }
  const headerLength = Math.min(bytes.length, 1024);
  let header = "";
  for (let index = 0; index < headerLength; index += 1) {
    header += String.fromCharCode(bytes[index]);
  }
  return header.includes("%PDF-");
}

function isPdfFileLike(file) {
  const name = String(file?.name || "");
  const type = String(file?.type || "");
  return /\.pdf$/i.test(name) || /^application\/(?:x-)?pdf\b/i.test(type);
}

function deriveTitleFromFileName(fileName) {
  return normalizeImportedText(String(fileName || "").replace(/\.pdf$/i, "")) || "StepRead PDF";
}

function normalizeImportedText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function median(values) {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) {
    return 0;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "");
}

function findDocumentBySourceUrl(documents, sourceUrl) {
  const sourceKeys = getComparableSourceKeys(sourceUrl);
  if (!sourceKeys.size) {
    return null;
  }

  const documentIds = new Set([...sourceKeys].map((sourceKey) => createStablePdfDocumentId(sourceKey)));
  return (
    documents.find((documentRecord) => {
      if (documentIds.has(documentRecord.id)) {
        return true;
      }
      const documentSourceKeys = getComparableSourceKeys(documentRecord.sourceUrl);
      return [...documentSourceKeys].some((sourceKey) => sourceKeys.has(sourceKey));
    }) || null
  );
}

function getComparableSourceKeys(sourceUrl) {
  const keys = new Set();
  const rawSourceUrl = String(sourceUrl || "").trim();
  if (!rawSourceUrl) {
    return keys;
  }

  const sourceInfo = getSourceDisplayInfo(rawSourceUrl);
  for (const candidate of [
    rawSourceUrl,
    normalizePdfSourceUrl(rawSourceUrl),
    sourceInfo.normalizedSourceUrl,
    sourceInfo.rawSourceUrl
  ]) {
    const normalized = normalizePdfSourceUrl(candidate);
    if (normalized) {
      keys.add(normalized);
    }
  }
  return keys;
}

function getPendingPdfDocumentId() {
  const sourceInfo = getSourceDisplayInfo(state.sourceUrl);
  return createStablePdfDocumentId(sourceInfo.normalizedSourceUrl || state.sourceUrl || "pending-pdf");
}

function getSourceDisplayInfo(sourceUrl) {
  const info = getReadablePdfSourceInfo(sourceUrl);
  const normalizedSourceUrl = info.normalizedSourceUrl || normalizePdfSourceUrl(sourceUrl);
  return {
    ...info,
    normalizedSourceUrl,
    title: info.title || "StepRead PDF",
    displaySource: info.displaySource || normalizedSourceUrl || info.rawSourceUrl || "",
    displayPath: info.displayPath || "",
    rawSourceUrl: info.rawSourceUrl || String(sourceUrl || "")
  };
}

function getTocEntries() {
  const documentOutline = normalizeDocumentOutline(state.currentDocument?.outline);
  return documentOutline.length ? documentOutline : getTextLayerHeadingOutline(state.blocks);
}

function normalizeDocumentOutline(outline) {
  if (!Array.isArray(outline) || !outline.length) {
    return [];
  }

  const blocksById = new Map(state.blocks.map((block) => [block.id, block]));
  return outline
    .map((entry, index) => {
      const directBlock = blocksById.get(entry?.blockId) || blocksById.get(entry?.id) || null;
      const targetBlock = resolveOutlineEntryTargetBlock(entry, state.blocks, directBlock);
      const title = normalizeImportedText(entry?.title || entry?.text || "");
      return {
        id: entry?.id || targetBlock?.id || `toc_entry_${index + 1}`,
        blockId: targetBlock?.id || "",
        order: targetBlock?.order ?? entry?.order ?? index,
        level: Math.min(Math.max(Number(entry?.level || 2), 1), 6),
        title,
        pageNumber: entry?.pageNumber || targetBlock?.pageNumber || null,
        ...copyPdfOutlineDestinationMetadata(entry),
        source: entry?.source || "document-outline"
      };
    })
    .filter((entry) => entry.title);
}

function getTocEntryTargetBlockId(entry) {
  return entry?.blockId || resolveOutlineEntryTargetBlock(entry, state.blocks)?.id || "";
}

function hasPdfNativeOutlineDestination(entry) {
  if (!entry || !isPdfNativeOutlineEntry(entry)) {
    return false;
  }
  const destination = getPdfOutlineDestinationForScroll(entry);
  return Boolean(
    destination.pageNumber &&
      destination.destKind &&
      (destination.destTop !== null || destination.destLeft !== null || destination.destZoom !== null)
  );
}

function isPdfNativeOutlineEntry(entry) {
  return isPdfOutlineTocEntry(entry) || /^pdf_outline_/i.test(String(entry?.id || ""));
}

function isTocBlockOnPage(block, pageNumber) {
  const normalizedPageNumber = normalizePageNumber(pageNumber);
  if (!block?.id || !normalizedPageNumber) {
    return false;
  }
  return normalizePageNumber(block.pageNumber) === normalizedPageNumber;
}

function getTocEntryText(entry) {
  return entry?.title || entry?.text || "未命名标题";
}

function renderToc() {
  elements.tocList.replaceChildren();
  const tocEntries = getTocEntries();

  if (!tocEntries.length) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "当前文档还没有可识别的标题。";
    elements.tocList.append(empty);
    return;
  }

  const tree = buildTocTree(tocEntries);
  for (const node of tree) {
    elements.tocList.append(renderTocNode(node));
  }
}

function updateCurrentSectionBar() {
  const tocEntries = getTocEntries();
  const location = getCurrentReaderLocation();
  if (!tocEntries.length) {
    renderReaderLocationBar(null, location, tocEntries);
    markActiveTocEntry("");
    return;
  }

  const manualTargetEntry = getPendingManualTocTargetEntry(tocEntries);
  if (manualTargetEntry) {
    renderReaderLocationBar(manualTargetEntry, location, tocEntries);
    markActiveTocEntry(manualTargetEntry);
    return;
  }

  const activeEntry = getActiveTocEntryForLocation(tocEntries, location);
  renderReaderLocationBar(activeEntry, location, tocEntries);
  markActiveTocEntry(activeEntry);
}

function scheduleReaderLocationUpdate() {
  if (readerLocationUpdateFrame) {
    return;
  }
  readerLocationUpdateFrame = requestAnimationFrame(() => {
    readerLocationUpdateFrame = 0;
    updateCurrentSectionBar();
  });
}

function getCurrentReaderLocation() {
  const hybridLocation = getCurrentPdfHybridPageLocation();
  if (hybridLocation?.pageNumber) {
    return hybridLocation;
  }
  return getCurrentTextBlockPageLocation();
}

function getCurrentPdfHybridPageLocation() {
  const pages = [...elements.documentContent.querySelectorAll(".pdf-hybrid-page[data-page-number]")];
  if (!pages.length) {
    return null;
  }

  const anchorTop = elements.documentContent.scrollTop + READER_LOCATION_SCROLL_OFFSET;
  let activePage = pages[0];
  for (const page of pages) {
    if (page.offsetTop <= anchorTop) {
      activePage = page;
      continue;
    }
    break;
  }

  const pageNumber = normalizePageNumber(activePage.dataset.pageNumber);
  if (!pageNumber) {
    return null;
  }

  return {
    mode: "pdf-hybrid",
    pageNumber,
    pageCount: getPdfPageCount(pages.length),
    pageOffsetRatio: clamp((anchorTop - activePage.offsetTop) / Math.max(1, activePage.offsetHeight), 0, 1)
  };
}

function getCurrentTextBlockPageLocation() {
  const pageCount = getPdfPageCount();
  if (!pageCount) {
    return null;
  }

  const blocksById = new Map(state.blocks.map((block) => [block.id, block]));
  const blockElements = [...elements.documentContent.querySelectorAll(".reader-block[data-block-id]")];
  const anchorTop = elements.documentContent.scrollTop + READER_LOCATION_SCROLL_OFFSET;
  let activePageNumber = 0;
  for (const element of blockElements) {
    if (element.offsetTop > anchorTop) {
      break;
    }
    const block = blocksById.get(element.dataset.blockId);
    const pageNumber = normalizePageNumber(block?.pageNumber);
    if (pageNumber) {
      activePageNumber = pageNumber;
    }
  }

  activePageNumber ||= getFirstAvailablePdfPageNumber();
  return activePageNumber
    ? {
        mode: "text-blocks",
        pageNumber: activePageNumber,
        pageCount,
        pageOffsetRatio: 0
      }
    : null;
}

function getActiveTocEntryForLocation(tocEntries, location) {
  const activeEntries = getPrimaryTocEntriesForActiveState(tocEntries);
  const sortedPositions = getTocEntryPositionsSortedByDocumentPosition(activeEntries);
  if (!sortedPositions.length) {
    return tocEntries[0] || null;
  }

  const locationPosition = getReaderLocationPosition(location);
  let activePosition = sortedPositions[0];
  for (const position of sortedPositions) {
    if (isTocEntryPositionAtOrBeforeLocation(position, locationPosition)) {
      activePosition = position;
      continue;
    }
    break;
  }
  return activePosition.entry;
}

function renderReaderLocationBar(activeEntry, location, tocEntries = getTocEntries()) {
  const sectionText = getReaderSectionText(activeEntry, tocEntries);
  if (elements.currentSectionText) {
    elements.currentSectionText.textContent = sectionText;
  } else if (elements.currentSectionBar) {
    elements.currentSectionBar.textContent = sectionText;
  }

  const pageNumber = normalizePageNumber(location?.pageNumber);
  const pageCount = getPdfPageCount(location?.pageCount);
  state.activePdfPageNumber = pageNumber || 0;
  if (!elements.pdfPageIndicator) {
    return;
  }
  if (pageNumber && pageCount) {
    elements.pdfPageIndicator.hidden = false;
    elements.pdfPageIndicator.textContent = `第 ${pageNumber} / ${pageCount} 页`;
  } else {
    elements.pdfPageIndicator.hidden = true;
    elements.pdfPageIndicator.textContent = "第 - / - 页";
  }
}

function getReaderSectionText(activeEntry, tocEntries) {
  if (!activeEntry) {
    return "当前章节";
  }
  const sectionEntries = getPrimaryTocEntriesForActiveState(tocEntries, activeEntry);
  const sortedEntries = getTocEntryPositionsSortedByDocumentPosition(sectionEntries).map((position) => position.entry);
  const activeIndex = sortedEntries.findIndex((entry) => entry.id === activeEntry.id);
  const entriesBeforeActive = activeIndex >= 0 ? sortedEntries.slice(0, activeIndex + 1) : [activeEntry];
  const chapter =
    [...entriesBeforeActive]
      .reverse()
      .find((entry) => Number(entry.level || 2) <= 2) || activeEntry;
  const subsection =
    Number(activeEntry.level || 2) > Number(chapter.level || 2) ? activeEntry : null;
  const chapterText = getTocEntryText(chapter) || "当前章节";
  const subsectionText = subsection ? getTocEntryText(subsection) : "";
  return subsectionText ? `${chapterText} - ${subsectionText}` : chapterText;
}

function getRenderedPdfPageElement(pageNumber) {
  const normalizedPageNumber = normalizePageNumber(pageNumber);
  if (!normalizedPageNumber) {
    return null;
  }
  return elements.documentContent.querySelector(
    `.pdf-hybrid-page[data-page-number="${CSS.escape(String(normalizedPageNumber))}"]`
  );
}

function getPdfPageCount(fallback = 0) {
  const directCount = normalizePageNumber(state.currentDocument?.pdf?.pageCount || state.currentDocument?.pageCount);
  if (directCount) {
    return directCount;
  }
  const blockPageCount = Math.max(0, ...state.blocks.map((block) => normalizePageNumber(block.pageNumber) || 0));
  return blockPageCount || normalizePageNumber(fallback) || 0;
}

function getFirstAvailablePdfPageNumber() {
  const blockPageNumber = state.blocks.map((block) => normalizePageNumber(block.pageNumber)).find(Boolean);
  if (blockPageNumber) {
    return blockPageNumber;
  }
  const firstPage = elements.documentContent.querySelector(".pdf-hybrid-page[data-page-number]");
  return normalizePageNumber(firstPage?.dataset.pageNumber);
}

function getTocEntryPageNumber(entry) {
  const directPageNumber = normalizePageNumber(entry?.pageNumber);
  if (directPageNumber) {
    return directPageNumber;
  }
  const targetBlock = findTocTargetBlock(entry);
  return normalizePageNumber(targetBlock?.pageNumber);
}

function normalizePageNumber(value) {
  const pageNumber = Number(value);
  return Number.isFinite(pageNumber) && pageNumber > 0 ? Math.floor(pageNumber) : 0;
}

function getPrimaryTocEntriesForActiveState(tocEntries, activeEntry = null) {
  const pdfOutlineEntries = (tocEntries || []).filter(isPdfOutlineTocEntry);
  if (!pdfOutlineEntries.length) {
    return tocEntries || [];
  }
  if (activeEntry && isPdfOutlineTocEntry(activeEntry)) {
    return pdfOutlineEntries;
  }
  return pdfOutlineEntries;
}

function isPdfOutlineTocEntry(entry) {
  return entry?.source === "pdf-outline";
}

function getTocEntryPositionsSortedByDocumentPosition(tocEntries) {
  return (tocEntries || [])
    .map((entry, index) => getTocEntryDocumentPosition(entry, index))
    .sort(compareTocEntryDocumentPositions);
}

function getTocEntryDocumentPosition(entry, originalIndex = 0) {
  const targetBlock = findTocTargetBlock(entry);
  const targetBlockId = targetBlock?.id || entry?.blockId || "";
  const targetElement = targetBlockId
    ? elements.documentContent.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`)
    : null;
  const pageNumber = getTocEntryPageNumber(entry) || normalizePageNumber(targetBlock?.pageNumber);
  const pageElement = pageNumber ? getRenderedPdfPageElement(pageNumber) : null;
  const targetScrollTop = targetElement ? getDocumentContentScrollTopForElement(targetElement) : null;
  const destinationScrollTop = pageElement ? getPdfHybridDestinationScrollTop(pageElement, entry) : null;
  const pageScrollTop = pageElement ? pageElement.offsetTop : null;
  const blockOrder = normalizeTocPositionNumber(targetBlock?.order, normalizeTocPositionNumber(entry?.order, originalIndex));

  return {
    entry,
    originalIndex,
    pageNumber,
    scrollTop: normalizeNullableTocPositionNumber(targetScrollTop ?? destinationScrollTop ?? pageScrollTop),
    blockOrder
  };
}

function getReaderLocationPosition(location) {
  return {
    pageNumber: normalizePageNumber(location?.pageNumber),
    scrollTop: elements.documentContent.scrollTop + READER_LOCATION_SCROLL_OFFSET,
    blockOrder: Number.POSITIVE_INFINITY,
    originalIndex: Number.POSITIVE_INFINITY
  };
}

function isTocEntryPositionAtOrBeforeLocation(position, locationPosition) {
  const entryPageNumber = normalizePageNumber(position?.pageNumber);
  const currentPageNumber = normalizePageNumber(locationPosition?.pageNumber);
  if (entryPageNumber && currentPageNumber) {
    if (entryPageNumber !== currentPageNumber) {
      return entryPageNumber < currentPageNumber;
    }
    if (Number.isFinite(position.scrollTop) && Number.isFinite(locationPosition.scrollTop)) {
      return position.scrollTop <= locationPosition.scrollTop + 1;
    }
    return true;
  }

  if (Number.isFinite(position?.scrollTop) && Number.isFinite(locationPosition?.scrollTop)) {
    return position.scrollTop <= locationPosition.scrollTop + 1;
  }

  return true;
}

function compareTocEntryDocumentPositions(left, right) {
  const leftPageNumber = normalizePageNumber(left?.pageNumber);
  const rightPageNumber = normalizePageNumber(right?.pageNumber);
  if (leftPageNumber && rightPageNumber && leftPageNumber !== rightPageNumber) {
    return leftPageNumber - rightPageNumber;
  }

  if (Number.isFinite(left?.scrollTop) && Number.isFinite(right?.scrollTop)) {
    const scrollDelta = left.scrollTop - right.scrollTop;
    if (Math.abs(scrollDelta) > 1) {
      return scrollDelta;
    }
  }

  const blockOrderDelta = normalizeTocPositionNumber(left?.blockOrder) - normalizeTocPositionNumber(right?.blockOrder);
  if (blockOrderDelta) {
    return blockOrderDelta;
  }

  if (leftPageNumber || rightPageNumber) {
    return (leftPageNumber || Number.POSITIVE_INFINITY) - (rightPageNumber || Number.POSITIVE_INFINITY);
  }

  return normalizeTocPositionNumber(left?.originalIndex) - normalizeTocPositionNumber(right?.originalIndex);
}

function normalizeTocPositionNumber(value, fallback = Number.POSITIVE_INFINITY) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeNullableTocPositionNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function updateCurrentSectionBarLegacy() {
  const tocEntries = getTocEntries();
  if (!tocEntries.length) {
    elements.currentSectionBar.textContent = "当前章节";
    markActiveTocEntry("");
    return;
  }

  const scrollTop = elements.documentContent.scrollTop + 72;
  const entriesWithTargets = tocEntries.filter((entry) => getTocEntryTargetBlockId(entry));
  let activeEntry = entriesWithTargets[0] || tocEntries[0];
  for (const entry of entriesWithTargets) {
    const targetBlockId = getTocEntryTargetBlockId(entry);
    const element = elements.documentContent.querySelector(`[data-block-id="${CSS.escape(targetBlockId)}"]`);
    if (!element) {
      continue;
    }
    if (getDocumentContentScrollTopForElement(element) <= scrollTop) {
      activeEntry = entry;
    } else {
      break;
    }
  }

  const activeIndex = tocEntries.findIndex((entry) => entry.id === activeEntry.id);
  const chapter =
    [...tocEntries.slice(0, activeIndex + 1)]
      .reverse()
      .find((entry) => Number(entry.level || 2) <= 2) || activeEntry;
  const subsection =
    Number(activeEntry.level || 2) > Number(chapter.level || 2) ? activeEntry : null;
  const chapterText = getTocEntryText(chapter) || "当前章节";
  const subsectionText = subsection ? getTocEntryText(subsection) : "";
  elements.currentSectionBar.textContent = subsectionText
    ? `${chapterText} - ${subsectionText}`
    : chapterText;
  markActiveTocEntry(activeEntry);
}

function getDocumentContentScrollTopForElement(element) {
  if (!element) {
    return 0;
  }
  const pageElement = element.closest?.(".pdf-hybrid-page");
  if (pageElement) {
    return pageElement.offsetTop + element.offsetTop;
  }
  return element.offsetTop;
}

function markActiveTocEntry(entryOrTargetBlockId) {
  let entry = typeof entryOrTargetBlockId === "object" ? entryOrTargetBlockId : null;
  if (entry) {
    entry = getPreferredActiveTocEntryForHighlight(entry, getTocEntries());
  }
  const tocEntryId = entry?.id || "";
  const targetBlockId = entry ? getTocEntryTargetBlockId(entry) : entryOrTargetBlockId || "";
  const nextActiveTocEntryId = tocEntryId || (targetBlockId ? `block:${targetBlockId}` : "");
  if (state.activeTocEntryId === nextActiveTocEntryId && elements.tocList.querySelector(".toc-link.active")) {
    return;
  }

  for (const link of elements.tocList.querySelectorAll(".toc-link.active")) {
    link.classList.remove("active");
  }
  state.activeTocEntryId = nextActiveTocEntryId;
  if (tocEntryId) {
    const activeLink = elements.tocList.querySelector(
      `.toc-link[data-toc-entry-id="${CSS.escape(tocEntryId)}"]`
    );
    if (activeLink) {
      activeLink.classList.add("active");
      return;
    }
  }
  if (!targetBlockId) {
    return;
  }
  const activeLink = elements.tocList.querySelector(
    `.toc-link[data-target-block-id="${CSS.escape(targetBlockId)}"]`
  );
  activeLink?.classList.add("active");
}

function getPreferredActiveTocEntryForHighlight(entry, tocEntries) {
  if (!entry || isPdfOutlineTocEntry(entry)) {
    return entry;
  }

  const pdfOutlineEntries = (tocEntries || []).filter(isPdfOutlineTocEntry);
  if (!pdfOutlineEntries.length) {
    return entry;
  }

  const entryIndex = (tocEntries || []).findIndex((tocEntry) => tocEntry.id === entry.id);
  const entryPosition = getTocEntryDocumentPosition(entry, entryIndex >= 0 ? entryIndex : Number.POSITIVE_INFINITY);
  const syntheticLocation = {
    pageNumber: entryPosition.pageNumber,
    scrollTop: Number.isFinite(entryPosition.scrollTop) ? entryPosition.scrollTop : Number.POSITIVE_INFINITY
  };
  let preferredPosition = null;
  for (const position of getTocEntryPositionsSortedByDocumentPosition(pdfOutlineEntries)) {
    if (isTocEntryPositionAtOrBeforeLocation(position, syntheticLocation)) {
      preferredPosition = position;
      continue;
    }
    break;
  }
  return preferredPosition?.entry || pdfOutlineEntries[0] || entry;
}

function markActiveTocEntryLegacy(entryOrTargetBlockId) {
  for (const link of elements.tocList.querySelectorAll(".toc-link.active")) {
    link.classList.remove("active");
  }
  const entry = typeof entryOrTargetBlockId === "object" ? entryOrTargetBlockId : null;
  const tocEntryId = entry?.id || "";
  const targetBlockId = entry ? getTocEntryTargetBlockId(entry) : entryOrTargetBlockId || "";
  if (tocEntryId) {
    const activeLink = elements.tocList.querySelector(
      `.toc-link[data-toc-entry-id="${CSS.escape(tocEntryId)}"]`
    );
    if (activeLink) {
      activeLink.classList.add("active");
      return;
    }
  }
  if (!targetBlockId) {
    return;
  }
  const activeLink = elements.tocList.querySelector(
    `.toc-link[data-target-block-id="${CSS.escape(targetBlockId)}"]`
  );
  activeLink?.classList.add("active");
}

function buildTocTree(headings) {
  const root = [];
  const stack = [{ level: 0, children: root }];

  for (const heading of headings) {
    const level = Math.min(Math.max(Number(heading.level || 2), 1), 6);
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const node = {
      heading,
      level,
      children: []
    };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root;
}

function renderTocNode(node) {
  const item = document.createElement("li");
  item.className = "toc-item";

  const row = document.createElement("div");
  row.className = "toc-row";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = node.children.length ? "toc-toggle" : "toc-toggle empty";
  toggle.textContent = "▾";
  toggle.title = "展开或收起下级目录";
  toggle.addEventListener("click", () => {
    if (!node.children.length) {
      return;
    }
    item.classList.toggle("collapsed");
  });

  const link = document.createElement("button");
  link.type = "button";
  link.className = "toc-link";
  link.textContent = getTocEntryText(node.heading);
  const targetBlockId = hasPdfNativeOutlineDestination(node.heading) ? "" : getTocEntryTargetBlockId(node.heading);
  link.dataset.targetBlockId = targetBlockId;
  link.dataset.tocEntryId = node.heading.id || "";
  const pageNumber = normalizePageNumber(node.heading?.pageNumber);
  if (pageNumber) {
    link.dataset.pageNumber = String(pageNumber);
  }
  if (node.heading?.destKind) {
    link.dataset.destKind = node.heading.destKind;
  }
  if (Number.isFinite(node.heading?.destTop)) {
    link.dataset.destTop = String(node.heading.destTop);
  }
  if (Number.isFinite(node.heading?.destLeft)) {
    link.dataset.destLeft = String(node.heading.destLeft);
  }
  if (Number.isFinite(node.heading?.destZoom)) {
    link.dataset.destZoom = String(node.heading.destZoom);
  }
  link.addEventListener("click", () => {
    scrollToTocEntry(node.heading);
  });

  row.append(toggle, link);
  item.append(row);

  if (node.children.length) {
    const children = document.createElement("ol");
    children.className = "toc-children";
    for (const child of node.children) {
      children.append(renderTocNode(child));
    }
    item.append(children);
  }

  return item;
}

function scrollToTocEntry(entry) {
  const hasNativeDestination = hasPdfNativeOutlineDestination(entry);
  let targetBlock = hasNativeDestination ? null : findTocTargetBlock(entry);
  let targetBlockId = targetBlock?.id || "";
  let targetPageNumber = normalizePageNumber(entry?.pageNumber || targetBlock?.pageNumber);
  if (!targetBlockId && !targetPageNumber) {
    setStatus("Temporarily could not find this TOC target in the document.");
    return;
  }

  const manualTarget = beginPendingManualTocTarget({
    entry,
    targetBlockId,
    pageNumber: targetPageNumber
  });

  if (hasNativeDestination && scrollToPdfHybridDestination(manualTarget)) {
    manualTarget.destinationApplied = true;
    completePendingManualTocTargetAfterSettle(manualTarget.token);
    return;
  }

  if (hasNativeDestination && !manualTarget.destinationApplied) {
    targetBlock = findTocTargetBlock(entry);
    if (isTocBlockOnPage(targetBlock, targetPageNumber)) {
      targetBlockId = targetBlock.id;
      manualTarget.targetBlockId = targetBlockId;
    }
  }

  if (targetBlockId && scrollToPendingManualTocTargetBlock(manualTarget)) {
    completePendingManualTocTargetAfterSettle(manualTarget.token);
    return;
  }

  if (targetPageNumber && scrollToPdfHybridPage(targetPageNumber, { pendingTarget: manualTarget })) {
    markActiveTocEntry(entry);
    if (targetBlockId) {
      schedulePendingManualTocTargetRetry(0);
    } else {
      completePendingManualTocTargetAfterSettle(manualTarget.token);
    }
    return;
  }

  clearPendingManualTocTarget();
  setStatus("The document has not rendered this TOC target yet. Please try again shortly.");
}

function beginPendingManualTocTarget({ entry, targetBlockId, pageNumber }) {
  clearPendingManualTocTarget();
  const token = ++pendingManualTocTargetToken;
  pendingManualTocTarget = {
    token,
    entry,
    entryId: entry?.id || "",
    targetBlockId: targetBlockId || "",
    pageNumber: normalizePageNumber(pageNumber),
    ...copyPdfOutlineDestinationMetadata(entry),
    destinationApplied: false,
    expiresAt: Date.now() + TOC_MANUAL_TARGET_TIMEOUT_MS
  };
  markActiveTocEntry(entry);
  scheduleReaderLocationUpdate();
  return pendingManualTocTarget;
}

function clearPendingManualTocTarget() {
  pendingManualTocTargetToken += 1;
  pendingManualTocTarget = null;
  if (pendingManualTocTargetTimer) {
    clearTimeout(pendingManualTocTargetTimer);
    pendingManualTocTargetTimer = 0;
  }
}

function getPendingManualTocTargetEntry(tocEntries) {
  if (!pendingManualTocTarget) {
    return null;
  }
  if (Date.now() > pendingManualTocTarget.expiresAt) {
    clearPendingManualTocTarget();
    return null;
  }
  return (
    (tocEntries || []).find((tocEntry) => tocEntry.id && tocEntry.id === pendingManualTocTarget.entryId) ||
    pendingManualTocTarget.entry ||
    null
  );
}

function schedulePendingManualTocTargetRetry(delayMs = TOC_MANUAL_TARGET_RETRY_DELAY_MS) {
  const target = pendingManualTocTarget;
  if (!target) {
    return;
  }
  const remainingMs = target.expiresAt - Date.now();
  if (remainingMs <= 0) {
    clearPendingManualTocTarget();
    scheduleReaderLocationUpdate();
    return;
  }
  if (pendingManualTocTargetTimer) {
    clearTimeout(pendingManualTocTargetTimer);
  }
  pendingManualTocTargetTimer = setTimeout(() => {
    pendingManualTocTargetTimer = 0;
    retryPendingManualTocTarget(target.token);
  }, Math.min(Math.max(0, delayMs), remainingMs));
}

function retryPendingManualTocTarget(token) {
  const target = pendingManualTocTarget;
  if (!target || target.token !== token) {
    return;
  }
  if (Date.now() > target.expiresAt) {
    clearPendingManualTocTarget();
    scheduleReaderLocationUpdate();
    return;
  }
  if (hasPdfNativeOutlineDestination(target)) {
    if (target.destinationApplied) {
      return;
    }
    if (!target.destinationApplied && scrollToPdfHybridDestination(target)) {
      target.destinationApplied = true;
      completePendingManualTocTargetAfterSettle(token);
      return;
    }
    if (target.pageNumber && isPdfHybridViewRendered()) {
      queueFocusedPdfHybridPageRender(target.pageNumber);
    }
    schedulePendingManualTocTargetRetry();
    return;
  }
  if (scrollToPendingManualTocTargetBlock(target)) {
    completePendingManualTocTargetAfterSettle(token);
    return;
  }
  if (target.pageNumber && isPdfHybridViewRendered()) {
    queueFocusedPdfHybridPageRender(target.pageNumber);
  }
  schedulePendingManualTocTargetRetry();
}

function scrollToPendingManualTocTargetBlock(target) {
  const targetElement = getTocTargetScrollableElement(target?.targetBlockId, target?.pageNumber);
  if (!targetElement) {
    return false;
  }
  const scrollTop = getDocumentContentScrollTopForElement(targetElement);
  const behavior = getTocProgrammaticScrollBehavior(scrollTop);
  recordPendingManualTocScrollTarget(target, scrollTop, behavior);
  elements.documentContent.scrollTo({ top: scrollTop, behavior });
  markActiveTocEntry(target.entry);
  scheduleReaderLocationUpdate();
  return true;
}

function completePendingManualTocTargetAfterSettle(token, options = {}) {
  const target = pendingManualTocTarget;
  if (!target || target.token !== token) {
    return;
  }
  const remainingMs = target.expiresAt - Date.now();
  if (remainingMs <= 0) {
    clearPendingManualTocTarget();
    scheduleReaderLocationUpdate();
    return;
  }
  if (pendingManualTocTargetTimer) {
    clearTimeout(pendingManualTocTargetTimer);
  }
  const targetScrollTop = normalizeNullableTocPositionNumber(
    options.targetScrollTop ?? target.programmaticScrollTargetTop
  );
  const startedAt = Date.now();
  const checkForStableTarget = () => {
    if (pendingManualTocTarget?.token === token) {
      const elapsedMs = Date.now() - startedAt;
      const isStable =
        !Number.isFinite(targetScrollTop) ||
        Math.abs(elements.documentContent.scrollTop - targetScrollTop) <= TOC_SCROLL_STABLE_TOLERANCE_PX;
      if (!isStable && elapsedMs < Math.min(TOC_MANUAL_SCROLL_SETTLE_MS, remainingMs)) {
        pendingManualTocTargetTimer = setTimeout(checkForStableTarget, TOC_MANUAL_TARGET_RETRY_DELAY_MS);
        return;
      }
      renderReaderLocationBar(target.entry, getCurrentReaderLocation(), getTocEntries());
      markActiveTocEntry(target.entry);
      clearPendingManualTocTarget();
    }
  };
  pendingManualTocTargetTimer = setTimeout(checkForStableTarget, TOC_MANUAL_TARGET_RETRY_DELAY_MS);
}

function getTocTargetScrollableElement(targetBlockId, pageNumber = 0) {
  const blockId = String(targetBlockId || "");
  if (!blockId) {
    return null;
  }
  const blockSelector = `[data-block-id="${CSS.escape(blockId)}"]`;
  const normalizedPageNumber = normalizePageNumber(pageNumber);
  if (normalizedPageNumber) {
    const pageElement = getRenderedPdfPageElement(normalizedPageNumber);
    const pageTarget =
      pageElement?.querySelector(`.pdf-text-fragment${blockSelector}`) ||
      pageElement?.querySelector(blockSelector);
    if (pageElement) {
      return pageTarget || null;
    }
    if (pageTarget) {
      return pageTarget;
    }
  }
  return (
    elements.documentContent.querySelector(`.pdf-text-fragment${blockSelector}`) ||
    elements.documentContent.querySelector(blockSelector)
  );
}

function handlePdfHybridPageRendered(pageNumber) {
  retryPendingHighlightScrollForRenderedPage(pageNumber);
  const target = pendingManualTocTarget;
  if (!target || normalizePageNumber(pageNumber) !== target.pageNumber) {
    return;
  }
  requestAnimationFrame(() => retryPendingManualTocTarget(target.token));
}

function queueFocusedPdfHybridPageRender(pageNumber) {
  const normalizedPageNumber = normalizePageNumber(pageNumber);
  if (!normalizedPageNumber) {
    return;
  }
  const expandedPageNumbers = expandPdfHybridPageNumbers([normalizedPageNumber]);
  queuePdfHybridPages(
    [
      normalizedPageNumber,
      ...expandedPageNumbers.filter((expandedPageNumber) => expandedPageNumber !== normalizedPageNumber)
    ],
    { priority: true }
  );
}

function getTocProgrammaticScrollBehavior(targetScrollTop) {
  const targetTop = Number(targetScrollTop);
  if (!Number.isFinite(targetTop)) {
    return "smooth";
  }
  const viewportHeight = Math.max(1, elements.documentContent?.clientHeight || 1);
  const distance = Math.abs((elements.documentContent?.scrollTop || 0) - targetTop);
  return distance > viewportHeight * TOC_INSTANT_SCROLL_VIEWPORT_THRESHOLD ? "auto" : "smooth";
}

function recordPendingManualTocScrollTarget(target, targetScrollTop, behavior) {
  if (!target) {
    return;
  }
  const scrollTop = Number(targetScrollTop);
  target.programmaticScrollTargetTop = Number.isFinite(scrollTop) ? scrollTop : null;
  target.programmaticScrollBehavior = behavior || "smooth";
}

function scrollToPdfHybridDestination(target) {
  const destination = getPdfOutlineDestinationForScroll(target);
  if (!destination.pageNumber || destination.destTop === null) {
    return false;
  }
  const pageElement = getRenderedPdfPageElement(destination.pageNumber);
  if (!pageElement) {
    return false;
  }

  const scrollTop = getPdfHybridDestinationScrollTop(pageElement, destination);
  if (!Number.isFinite(scrollTop)) {
    return false;
  }

  const behavior = getTocProgrammaticScrollBehavior(scrollTop);
  recordPendingManualTocScrollTarget(target, scrollTop, behavior);
  const scrollOptions = {
    top: scrollTop,
    behavior
  };
  const scrollLeft = getPdfHybridDestinationScrollLeft(pageElement, destination);
  if (Number.isFinite(scrollLeft)) {
    scrollOptions.left = scrollLeft;
  }

  queueFocusedPdfHybridPageRender(destination.pageNumber);
  elements.documentContent.scrollTo(scrollOptions);
  markActiveTocEntry(target.entry || target);
  scheduleReaderLocationUpdate();
  requestAnimationFrame(() => {
    schedulePdfHybridVisiblePageRender({ immediate: true });
    queueFocusedPdfHybridPageRender(destination.pageNumber);
  });
  return true;
}

function getPdfOutlineDestinationForScroll(target) {
  const entry = target?.entry || target || {};
  return {
    pageNumber: normalizePageNumber(target?.pageNumber || entry.pageNumber),
    destKind: target?.destKind || entry.destKind || "",
    destTop: getNullableFiniteNumber(target?.destTop ?? entry.destTop),
    destLeft: getNullableFiniteNumber(target?.destLeft ?? entry.destLeft),
    destZoom: getNullableFiniteNumber(target?.destZoom ?? entry.destZoom)
  };
}

function getPdfHybridDestinationScrollTop(pageElement, destination) {
  const pageNumber = normalizePageNumber(destination?.pageNumber || pageElement?.dataset?.pageNumber);
  const destTop = getNullableFiniteNumber(destination?.destTop);
  if (!pageNumber || destTop === null) {
    return null;
  }

  const pageRecord = pdfHybridRenderState.pageRecords.get(pageNumber) || {};
  const scale = getPdfHybridPageRecordScale(pageElement, pageRecord);
  const baseHeight = getPdfHybridPageRecordBaseHeight(pageElement, pageRecord, scale);
  const viewportTop = clamp((baseHeight - destTop) * scale, 0, Math.max(0, pageElement.offsetHeight));
  return Math.max(0, pageElement.offsetTop + viewportTop - PDF_DESTINATION_SCROLL_PADDING);
}

function getPdfHybridDestinationScrollLeft(pageElement, destination) {
  const pageNumber = normalizePageNumber(destination?.pageNumber || pageElement?.dataset?.pageNumber);
  const destLeft = getNullableFiniteNumber(destination?.destLeft);
  if (!pageNumber || destLeft === null) {
    return null;
  }

  const pageRecord = pdfHybridRenderState.pageRecords.get(pageNumber) || {};
  const scale = getPdfHybridPageRecordScale(pageElement, pageRecord);
  const viewportLeft = clamp(destLeft * scale, 0, Math.max(0, pageElement.offsetWidth));
  return Math.max(0, pageElement.offsetLeft + viewportLeft - PDF_DESTINATION_SCROLL_PADDING);
}

function getPdfHybridPageRecordScale(pageElement, pageRecord) {
  const recordScale = getNullableFiniteNumber(pageRecord?.scale);
  if (recordScale !== null && recordScale > 0) {
    return recordScale;
  }
  const baseHeight = getNullableFiniteNumber(pageRecord?.baseHeight);
  if (baseHeight !== null && baseHeight > 0) {
    return pageElement.offsetHeight / baseHeight;
  }
  const baseWidth = getNullableFiniteNumber(pageRecord?.baseWidth);
  if (baseWidth !== null && baseWidth > 0) {
    return pageElement.offsetWidth / baseWidth;
  }
  return 1;
}

function getPdfHybridPageRecordBaseHeight(pageElement, pageRecord, scale) {
  const baseHeight = getNullableFiniteNumber(pageRecord?.baseHeight);
  if (baseHeight !== null && baseHeight > 0) {
    return baseHeight;
  }
  return pageElement.offsetHeight / Math.max(scale, 0.001);
}

function scrollToTocEntryLegacy(entry) {
  const targetBlock = findTocTargetBlock(entry);
  if (!targetBlock?.id) {
    if (scrollToPdfHybridPage(entry?.pageNumber)) {
      markActiveTocEntry(entry);
      return;
    }
    setStatus("暂时没有找到这个书签在正文中的对应位置。");
    return;
  }

  const blockElement = elements.documentContent.querySelector(
    `[data-block-id="${CSS.escape(targetBlock.id)}"]`
  );
  if (!blockElement) {
    if (scrollToPdfHybridPage(targetBlock.pageNumber || entry?.pageNumber)) {
      markActiveTocEntry(entry);
      return;
    }
    setStatus("正文还没有渲染出这个书签位置，请稍后重试。");
    return;
  }

  blockElement.scrollIntoView({ behavior: "smooth", block: "start" });
  markActiveTocEntry(entry);
}

function scrollToPdfHybridPage(pageNumber, options = {}) {
  const normalizedPageNumber = normalizePageNumber(pageNumber);
  if (!normalizedPageNumber) {
    return false;
  }
  const pageElement = elements.documentContent.querySelector(
    `.pdf-hybrid-page[data-page-number="${CSS.escape(String(normalizedPageNumber))}"]`
  );
  if (!pageElement) {
    return false;
  }
  queueFocusedPdfHybridPageRender(normalizedPageNumber);
  const scrollTop = pageElement.offsetTop;
  const behavior = getTocProgrammaticScrollBehavior(scrollTop);
  recordPendingManualTocScrollTarget(options.pendingTarget, scrollTop, behavior);
  elements.documentContent.scrollTo({ top: scrollTop, behavior });
  requestAnimationFrame(() => {
    schedulePdfHybridVisiblePageRender({ immediate: true });
    queueFocusedPdfHybridPageRender(normalizedPageNumber);
  });
  return true;
}

function findTocTargetBlock(entry) {
  if (!entry) {
    return null;
  }

  const blocksById = new Map(state.blocks.map((block) => [block.id, block]));
  const directBlock = blocksById.get(entry.blockId) || blocksById.get(entry.id);
  return resolveOutlineEntryTargetBlock(entry, state.blocks, directBlock);
}

function resolveOutlineEntryTargetBlock(entry, blocks, directBlock = null) {
  const inferredBlock = findBlockForOutlineEntry(entry, blocks);
  if (isReliableOutlineDirectBlock(entry, directBlock, inferredBlock)) {
    return directBlock;
  }
  return inferredBlock || directBlock || null;
}

function isReliableOutlineDirectBlock(entry, directBlock, inferredBlock) {
  if (!directBlock) {
    return false;
  }

  const pageNumber = Number(entry?.pageNumber);
  const directPageNumber = Number(directBlock.pageNumber);
  if (Number.isFinite(pageNumber) && Number.isFinite(directPageNumber) && directPageNumber !== pageNumber) {
    return false;
  }

  const normalizedTitle = normalizePlainText(entry?.title || entry?.text || "");
  if (!normalizedTitle) {
    return true;
  }

  if (doesBlockMatchOutlineTitle(directBlock, normalizedTitle)) {
    return true;
  }

  return !inferredBlock || inferredBlock.id === directBlock.id;
}

function doesBlockMatchOutlineTitle(block, normalizedTitle) {
  const normalizedNeedle = normalizeOutlineSearchText(normalizedTitle);
  const normalizedBlockTitle = normalizeOutlineSearchText(block?.text || block?.title || "");
  if (!normalizedNeedle || !normalizedBlockTitle) {
    return false;
  }
  return (
    normalizedBlockTitle === normalizedNeedle ||
    normalizedBlockTitle.includes(normalizedNeedle) ||
    normalizedNeedle.includes(normalizedBlockTitle)
  );
}

async function refreshDocumentList() {
  const documents = await dbGetAll("documents");
  const settings = await getSettings();
  const folders = normalizeDocumentFolders(settings.reader?.documentFolders);
  const activeFolders = folders.filter((folder) => !folder.deletedAt);
  const trashedFolders = folders.filter((folder) => folder.deletedAt);
  const activeFolderIds = new Set(activeFolders.map((folder) => folder.id));
  const activeDocuments = getActiveDocumentRecords(documents, folders);
  const trashedDocuments = documents.filter(
    (documentRecord) => documentRecord.deletedAt && !documentRecord.deletedWithFolderId
  );
  const showPendingPdfItem = Boolean(
    state.sourceUrl &&
      isLikelyPdfSourceUrl(state.sourceUrl) &&
      !findDocumentBySourceUrl(activeDocuments, state.sourceUrl)
  );
  activeDocuments.sort(sortDocumentRecords);
  elements.documentList.replaceChildren();

  if (!activeDocuments.length && !activeFolders.length && !showPendingPdfItem) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有本地文档。后续接入 PDF 解析后，这里会显示已经处理过的 PDF 阅读结果。";
    elements.documentList.append(empty);
  }

  if (showPendingPdfItem) {
    elements.documentList.append(renderPendingPdfDocumentItem());
  }

  const rootDocuments = activeDocuments.filter((documentRecord) => !activeFolderIds.has(documentRecord.folderId));
  renderDocumentItems(elements.documentList, rootDocuments, {
    showEmpty: !activeFolders.length && !showPendingPdfItem
  });

  for (const folder of activeFolders) {
    const folderDocuments = activeDocuments
      .filter((documentRecord) => documentRecord.folderId === folder.id)
      .sort(sortDocumentRecords);
    elements.documentList.append(renderDocumentFolder(folder, folderDocuments));
  }

  renderTrashSection(trashedFolders, trashedDocuments);
}

function renderPendingPdfDocumentItem() {
  const sourceInfo = getSourceDisplayInfo(state.sourceUrl);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "document-item pending-document active";
  button.dataset.documentId = getPendingPdfDocumentId();
  button.title = sourceInfo.displayPath || sourceInfo.rawSourceUrl || "";
  button.addEventListener("click", () => {
    void showPendingPdfSourceView();
  });

  const title = document.createElement("span");
  title.className = "pending-document-title";
  title.textContent = sourceInfo.title || "待转换 PDF";

  const marker = document.createElement("small");
  marker.className = "pending-document-marker";
  marker.textContent = "待处理";
  button.append(title, marker);
  return button;
}

function renderDocumentFolder(folder, documents) {
  const section = document.createElement("section");
  section.className = "document-folder";
  section.dataset.folderId = folder.id;

  const heading = document.createElement("div");
  heading.className = "folder-heading";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "folder-toggle";
  toggle.textContent = folder.collapsed ? "▸" : "▾";
  toggle.title = "展开或收起文件夹";
  toggle.addEventListener("click", async () => {
    await updateDocumentFolder(folder.id, { collapsed: !folder.collapsed });
  });

  const title = document.createElement("span");
  title.className = "folder-name";
  title.textContent = folder.name;
  title.addEventListener("dblclick", () => beginFolderRename(folder.id, title));

  const count = document.createElement("small");
  count.textContent = `${documents.length}`;

  heading.append(toggle, title, count);
  heading.addEventListener("contextmenu", (event) =>
    showDocumentContextMenu(event, { type: "folder", id: folder.id, trashed: Boolean(folder.deletedAt) })
  );
  heading.addEventListener("dragover", handleDocumentDragOver);
  heading.addEventListener("dragleave", handleDocumentDragLeave);
  heading.addEventListener("drop", (event) => handleDocumentDrop(event, folder.id));

  const body = document.createElement("div");
  body.className = "folder-body";
  body.dataset.folderId = folder.id;
  body.hidden = Boolean(folder.collapsed);
  body.addEventListener("dragover", handleDocumentDragOver);
  body.addEventListener("dragleave", handleDocumentDragLeave);
  body.addEventListener("drop", (event) => handleDocumentDrop(event, folder.id));
  renderDocumentItems(body, documents);

  section.append(heading, body);
  return section;
}

function renderTrashSection(trashedFolders, trashedDocuments) {
  const total = trashedFolders.length + trashedDocuments.length;
  elements.trashSection.hidden = total === 0;
  elements.trashCount.textContent = String(total);
  elements.trashList.replaceChildren();

  if (!total) {
    elements.trashList.hidden = true;
    elements.trashToggle.setAttribute("aria-expanded", "false");
    return;
  }

  for (const folder of trashedFolders) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "trash-item";
    row.title = "右键还原";
    row.textContent = `文件夹：${folder.name}`;
    row.addEventListener("contextmenu", (event) =>
      showDocumentContextMenu(event, { type: "folder", id: folder.id, trashed: true })
    );
    elements.trashList.append(row);
  }

  for (const documentRecord of trashedDocuments) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "trash-item";
    row.title = "右键还原";
    row.textContent = `文档：${documentRecord.title || "未命名文档"}`;
    row.addEventListener("contextmenu", (event) =>
      showDocumentContextMenu(event, { type: "document", id: documentRecord.id, trashed: true })
    );
    elements.trashList.append(row);
  }
}

function renderDocumentItems(container, documents, options = {}) {
  if (!documents.length) {
    if (!options.showEmpty) {
      return;
    }
    const empty = document.createElement("p");
    empty.className = "folder-empty";
    empty.textContent = "主目录暂无文档";
    container.append(empty);
    return;
  }

  for (const documentRecord of documents) {
    container.append(renderDocumentItem(documentRecord));
  }
}

function renderDocumentItem(documentRecord) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "document-item";
  button.draggable = true;
  button.dataset.documentId = documentRecord.id;
  if (documentRecord.id === state.currentDocument?.id) {
    button.classList.add("active");
  }
  button.textContent = documentRecord.title || "未命名文档";
  button.addEventListener("click", (event) => {
    if (event.detail > 1) {
      clearDocumentLoadClickTimer();
      return;
    }
    clearDocumentLoadClickTimer();
    markDocumentItemActive(button);
    documentLoadClickTimer = window.setTimeout(() => {
      documentLoadClickTimer = 0;
      if (!button.isConnected || button.querySelector(".inline-rename-input")) {
        return;
      }
      void (async () => {
        await discardUnsubmittedDraft({ clearSelection: true, render: true });
        await loadDocument(documentRecord.id);
      })();
    }, 260);
  });
  button.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearDocumentLoadClickTimer();
    beginDocumentRename(documentRecord.id, button);
  });
  button.addEventListener("contextmenu", (event) =>
    showDocumentContextMenu(event, { type: "document", id: documentRecord.id, trashed: Boolean(documentRecord.deletedAt) })
  );
  button.addEventListener("dragstart", (event) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", documentRecord.id);
    button.classList.add("dragging");
  });
  button.addEventListener("dragend", () => {
    button.classList.remove("dragging");
  });
  return button;
}

function markDocumentItemActive(button) {
  if (!button.isConnected || button.querySelector(".inline-rename-input")) {
    return;
  }
  for (const item of elements.documentList.querySelectorAll(".document-item.active")) {
    item.classList.remove("active");
  }
  button.classList.add("active");
}

function clearDocumentLoadClickTimer() {
  if (!documentLoadClickTimer) {
    return;
  }
  window.clearTimeout(documentLoadClickTimer);
  documentLoadClickTimer = 0;
}

function showFolderCreator() {
  elements.folderCreateRow.hidden = false;
  elements.newFolderButton.hidden = true;
  elements.folderNameInput.value = "新建文件夹";
  elements.folderNameInput.focus();
  elements.folderNameInput.select();
}

function hideFolderCreator() {
  elements.folderCreateRow.hidden = true;
  elements.newFolderButton.hidden = false;
  elements.folderNameInput.value = "";
  setFolderCreatorBusy(false);
}

function handleFolderNameKeydown(event) {
  if (event.isComposing) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    void createDocumentFolder();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    hideFolderCreator();
  }
}

async function createDocumentFolder() {
  if (folderCreatePending) {
    return;
  }

  const trimmed = elements.folderNameInput.value.trim();
  if (!trimmed) {
    elements.folderNameInput.focus();
    return;
  }

  folderCreatePending = true;
  setFolderCreatorBusy(true);

  try {
    const settings = await getSettings();
    const folders = normalizeDocumentFolders(settings.reader?.documentFolders);
    const folderName = createUniqueFolderName(trimmed, folders.filter((folder) => !folder.deletedAt));

    folders.push({
      id: createId("folder"),
      name: folderName,
      collapsed: false,
      createdAt: nowIso()
    });

    await saveSettings({
      ...settings,
      reader: {
        ...settings.reader,
        documentFolders: folders
      }
    });
    await refreshDocumentList();
    hideFolderCreator();
    setStatus(`已新建文件夹：${folderName}`);
  } catch (error) {
    console.error(error);
    setStatus("新建文件夹失败，请稍后再试。");
  } finally {
    folderCreatePending = false;
    setFolderCreatorBusy(false);
    if (!elements.folderCreateRow.hidden) {
      elements.folderNameInput.focus();
    }
  }
}

function createUniqueFolderName(baseName, folders) {
  const existingNames = new Set(folders.map((folder) => folder.name.trim()));
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let index = 2;
  let nextName = `${baseName} (${index})`;
  while (existingNames.has(nextName)) {
    index += 1;
    nextName = `${baseName} (${index})`;
  }
  return nextName;
}

function setFolderCreatorBusy(isBusy) {
  elements.folderNameInput.disabled = isBusy;
  elements.confirmFolderButton.disabled = isBusy;
  elements.cancelFolderButton.disabled = isBusy;
}

async function updateDocumentFolder(folderId, patch) {
  const settings = await getSettings();
  const folders = normalizeDocumentFolders(settings.reader?.documentFolders).map((folder) =>
    folder.id === folderId ? { ...folder, ...patch } : folder
  );
  await saveSettings({
    ...settings,
    reader: {
      ...settings.reader,
      documentFolders: folders
    }
  });
  await refreshDocumentList();
}

async function renameDocument(documentId, title) {
  const trimmed = title.trim();
  if (!trimmed) {
    return;
  }

  const documentRecord = await dbGet("documents", documentId);
  if (!documentRecord) {
    return;
  }

  await dbPut("documents", {
    ...documentRecord,
    title: trimmed,
    updatedAt: nowIso()
  });
  if (state.currentDocument?.id === documentId) {
    state.currentDocument = {
      ...state.currentDocument,
      title: trimmed,
      updatedAt: nowIso()
    };
    elements.documentTitle.textContent = trimmed;
  }
  await refreshDocumentList();
  setStatus("文档已重命名。");
}

async function renameFolder(folderId, name) {
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  const settings = await getSettings();
  const folders = normalizeDocumentFolders(settings.reader?.documentFolders);
  const folder = folders.find((item) => item.id === folderId);
  if (!folder) {
    return;
  }
  const nextName = createUniqueFolderName(
    trimmed,
    folders.filter((item) => item.id !== folderId && !item.deletedAt)
  );
  await updateDocumentFolder(folderId, { name: nextName });
  setStatus("文件夹已重命名。");
}

async function trashDocument(documentId) {
  const documentRecord = await dbGet("documents", documentId);
  if (!documentRecord) {
    return;
  }

  await dbPut("documents", {
    ...documentRecord,
    deletedAt: nowIso(),
    deletedWithFolderId: ""
  });
  if (state.currentDocument?.id === documentId) {
    await loadFallbackDocumentAfterDelete(documentId);
  }
  await refreshDocumentList();
  setStatus("文档已移入回收站。");
}

async function deleteReadingThread(threadId) {
  await discardUnsubmittedDraft({ clearSelection: false, render: false });
  const thread =
    state.threads.find((item) => item.id === threadId) ||
    (await dbGet("threads", threadId));
  if (!thread?.highlightId) {
    return;
  }

  const deletedActiveThread = state.activeThread?.id === thread.id;
  const summary = await deleteHighlightsCascade([thread.highlightId]);
  state.highlights = state.highlights.filter((highlight) => !summary.highlightIds.includes(highlight.id));
  state.threads = state.threads.filter((item) => !summary.threadIds.includes(item.id));

  if (deletedActiveThread || summary.highlightIds.includes(state.activeHighlight?.id)) {
    state.activeThread = null;
    state.activeHighlight = null;
    clearDraftSelection();
    elements.questionInput.value = "";
    state.panelView = "history";
  }

  refreshDocumentHighlights();
  renderThreads();
  renderSelection();
  renderPanelView();
  await renderMessages();
  notifyKnowledgeDataChanged("thread-deleted");
  setStatus("历史划线已删除。");
}

async function loadFallbackDocumentAfterDelete(deletedDocumentId) {
  const settings = await getSettings();
  const folders = normalizeDocumentFolders(settings.reader?.documentFolders);
  const documents = await dbGetAll("documents");
  const nextDocument = getActiveDocumentRecords(documents, folders)
    .filter((documentRecord) => documentRecord.id !== deletedDocumentId)
    .sort(sortDocumentRecords)[0];

  if (nextDocument) {
    await loadDocument(nextDocument.id);
    return;
  }

  await clearCurrentDocumentView();
}

async function trashFolder(folderId) {
  const deletedAt = nowIso();
  await updateDocumentFolder(folderId, { deletedAt, collapsed: false });
  const documents = await dbGetAll("documents");
  await Promise.all(
    documents
      .filter((documentRecord) => documentRecord.folderId === folderId && !documentRecord.deletedAt)
      .map((documentRecord) =>
        dbPut("documents", {
          ...documentRecord,
          deletedAt,
          deletedWithFolderId: folderId
        })
      )
  );
  if (state.currentDocument?.folderId === folderId) {
    await loadFallbackDocumentAfterDelete(state.currentDocument.id);
  }
  await refreshDocumentList();
  setStatus("文件夹已移入回收站。");
}

async function restoreDocument(documentId) {
  const documentRecord = await dbGet("documents", documentId);
  if (!documentRecord) {
    return;
  }
  const settings = await getSettings();
  const folders = normalizeDocumentFolders(settings.reader?.documentFolders);
  const parentFolder = folders.find((folder) => folder.id === documentRecord.folderId);

  await dbPut("documents", {
    ...documentRecord,
    deletedAt: "",
    deletedWithFolderId: "",
    folderId: parentFolder?.deletedAt ? "" : documentRecord.folderId || ""
  });
  await refreshDocumentList();
  setStatus("文档已还原。");
}

async function restoreFolder(folderId) {
  await updateDocumentFolder(folderId, { deletedAt: "", collapsed: false });
  const documents = await dbGetAll("documents");
  await Promise.all(
    documents
      .filter((documentRecord) => documentRecord.folderId === folderId && documentRecord.deletedWithFolderId === folderId)
      .map((documentRecord) =>
        dbPut("documents", {
          ...documentRecord,
          deletedAt: "",
          deletedWithFolderId: ""
        })
      )
  );
  await refreshDocumentList();
  setStatus("文件夹已还原。");
}

function beginDocumentRename(documentId, button) {
  beginInlineRename(button, button.textContent || "未命名文档", (value) => renameDocument(documentId, value));
}

function beginFolderRename(folderId, labelElement) {
  beginInlineRename(labelElement, labelElement.textContent || "新建文件夹", (value) => renameFolder(folderId, value));
}

function beginInlineRename(target, currentValue, onCommit) {
  const input = document.createElement("input");
  input.className = "inline-rename-input";
  input.value = currentValue;
  target.replaceChildren(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = async () => {
    if (committed) {
      return;
    }
    committed = true;
    await onCommit(input.value);
  };
  const cancel = () => {
    if (committed) {
      return;
    }
    committed = true;
    void refreshDocumentList();
  };

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  input.addEventListener("blur", () => {
    void commit();
  });
}

function handleDocumentDragOver(event) {
  if (!Array.from(event.dataTransfer.types || []).includes("text/plain")) {
    return;
  }
  event.stopPropagation();
  event.preventDefault();
  event.currentTarget.classList.add("drag-over");
  event.dataTransfer.dropEffect = "move";
}

function handleDocumentDragLeave(event) {
  event.stopPropagation();
  event.currentTarget.classList.remove("drag-over");
}

async function handleDocumentDrop(event, folderId) {
  event.stopPropagation();
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");
  const documentId = event.dataTransfer.getData("text/plain");
  if (!documentId) {
    return;
  }

  const documentRecord = await dbGet("documents", documentId);
  if (!documentRecord || (documentRecord.folderId || "") === folderId) {
    return;
  }

  await dbPut("documents", {
    ...documentRecord,
    folderId
  });
  await refreshDocumentList();
  setStatus(folderId ? "已移动到文件夹。" : "已移回主目录。");
}

function toggleTrashSection() {
  const isExpanded = elements.trashToggle.getAttribute("aria-expanded") === "true";
  elements.trashToggle.setAttribute("aria-expanded", String(!isExpanded));
  elements.trashList.hidden = isExpanded;
}

function showDocumentContextMenu(event, target) {
  event.preventDefault();
  event.stopPropagation();
  contextMenuTarget = target;

  for (const button of elements.documentContextMenu.querySelectorAll("button")) {
    const action = button.dataset.action;
    if (target.type === "thread") {
      button.hidden = action !== "delete";
      continue;
    }
    button.hidden = target.trashed ? action !== "restore" : action === "restore";
  }

  elements.documentContextMenu.hidden = false;
  const menuRect = elements.documentContextMenu.getBoundingClientRect();
  const left = Math.min(event.clientX, window.innerWidth - menuRect.width - 8);
  const top = Math.min(event.clientY, window.innerHeight - menuRect.height - 8);
  elements.documentContextMenu.style.left = `${Math.max(8, left)}px`;
  elements.documentContextMenu.style.top = `${Math.max(8, top)}px`;
}

function hideDocumentContextMenu() {
  if (!elements.documentContextMenu.hidden) {
    elements.documentContextMenu.hidden = true;
  }
  contextMenuTarget = null;
}

async function handleContextMenuAction(event) {
  const action = event.target?.dataset?.action;
  if (!action || !contextMenuTarget) {
    return;
  }

  event.stopPropagation();
  const target = contextMenuTarget;
  hideDocumentContextMenu();

  if (action === "rename") {
    if (target.type === "thread") {
      return;
    }
    const selector =
      target.type === "folder"
        ? `[data-folder-id="${CSS.escape(target.id)}"] .folder-name`
        : `[data-document-id="${CSS.escape(target.id)}"]`;
    const element = elements.documentList.querySelector(selector);
    if (element) {
      target.type === "folder" ? beginFolderRename(target.id, element) : beginDocumentRename(target.id, element);
    }
    return;
  }

  if (action === "delete") {
    if (target.type === "thread") {
      await deleteReadingThread(target.id);
      return;
    }
    target.type === "folder" ? await trashFolder(target.id) : await trashDocument(target.id);
    return;
  }

  if (action === "restore") {
    target.type === "folder" ? await restoreFolder(target.id) : await restoreDocument(target.id);
  }
}

function normalizeDocumentFolders(folders) {
  return Array.isArray(folders)
    ? folders
        .filter((folder) => folder?.id && folder?.name)
        .map((folder) => ({
          id: String(folder.id),
          name: String(folder.name),
          collapsed: Boolean(folder.collapsed),
          createdAt: folder.createdAt || "",
          deletedAt: folder.deletedAt || ""
        }))
    : [];
}

function getActiveDocumentRecords(documents, folders) {
  const trashedFolderIds = new Set(
    normalizeDocumentFolders(folders)
      .filter((folder) => folder.deletedAt)
      .map((folder) => folder.id)
  );
  return (Array.isArray(documents) ? documents : []).filter(
    (documentRecord) => !documentRecord.deletedAt && !trashedFolderIds.has(documentRecord.folderId)
  );
}

function sortDocumentRecords(a, b) {
  return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
}

async function auditInvalidReadingRecords(documentId, blocks, highlights, threads) {
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const highlightsById = new Map(highlights.map((highlight) => [highlight.id, highlight]));
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const invalidHighlightIds = new Set();

  for (const highlight of highlights) {
    const hasThread =
      (highlight.threadId && threadById.has(highlight.threadId)) ||
      threads.some((thread) => thread.highlightId === highlight.id);
    if (!hasThread || !isHighlightValid(highlight, blocksById)) {
      invalidHighlightIds.add(highlight.id);
    }
  }

  const invalidThreads = [];
  for (const thread of threads) {
    const messages = await getThreadMessages(thread.id);
    const hasReadableThreadRecord = messages.some((message) => message.role === "user");
    if (!highlightsById.has(thread.highlightId) || invalidHighlightIds.has(thread.highlightId) || !hasReadableThreadRecord) {
      invalidThreads.push(thread);
      if (thread.highlightId) {
        invalidHighlightIds.add(thread.highlightId);
      }
    }
  }

  if (invalidThreads.length || invalidHighlightIds.size) {
    await logTask("document.invalid_highlights.detected", {
      documentId,
      invalidHighlights: invalidHighlightIds.size,
      invalidThreads: invalidThreads.length
    });
  }

  return invalidHighlightIds.size + invalidThreads.length;
}

function isHighlightValid(highlight, blocksById) {
  if (Array.isArray(highlight.blockRanges) && highlight.blockRanges.length) {
    return highlight.blockRanges.every((range) =>
      isHighlightRangeValid(range, blocksById.get(range.blockId))
    );
  }

  return isHighlightRangeValid(
    {
      text: highlight.text,
      localStartOffset: highlight.localStartOffset,
      localEndOffset: highlight.localEndOffset
    },
    blocksById.get(highlight.blockId)
  );
}

function isHighlightRangeValid(range, block) {
  const selectedText = String(range?.text || "").trim();
  if (!block || !selectedText) {
    return false;
  }

  const blockText = getBlockPlainText(block);
  const localStart = Number(range.localStartOffset);
  const localEnd = Number(range.localEndOffset);
  if (
    Number.isFinite(localStart) &&
    Number.isFinite(localEnd) &&
    localEnd > localStart &&
    blockText.slice(localStart, localEnd).trim() === selectedText
  ) {
    return true;
  }
  if (
    Number.isFinite(localStart) &&
    blockText.slice(localStart, localStart + selectedText.length) === selectedText
  ) {
    return true;
  }

  return blockText.includes(selectedText) || normalizePlainText(blockText).includes(normalizePlainText(selectedText));
}

function renderThreads() {
  elements.threadList.replaceChildren();
  const committedHighlights = state.highlights.filter((highlight) => !isDraftHighlight(highlight));
  const highlightsById = new Map(committedHighlights.map((highlight) => [highlight.id, highlight]));
  const threads = state.threads.filter((thread) => !isDraftThread(thread)).sort((a, b) => {
    const highlightA = highlightsById.get(a.highlightId);
    const highlightB = highlightsById.get(b.highlightId);
    const positionA = getHighlightSortPosition(highlightA);
    const positionB = getHighlightSortPosition(highlightB);
    return positionA - positionB || String(a.createdAt).localeCompare(String(b.createdAt));
  });

  if (!threads.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "还没有历史划线。选中正文后，在右侧输入问题并发送，它才会进入这里。";
    elements.threadList.append(empty);
    return;
  }

  for (const thread of threads) {
    const highlight = highlightsById.get(thread.highlightId);
    const row = document.createElement("div");
    row.className = "thread-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thread-item";
    if (thread.id === state.activeThread?.id) {
      button.classList.add("active");
    }
    button.textContent = createHistoryTitle(highlight?.text || thread.title || "未命名问答");
    button.addEventListener("click", () => activateThread(thread.id));
    const showThreadMenu = (event) =>
      showDocumentContextMenu(event, {
        type: "thread",
        id: thread.id,
        highlightId: thread.highlightId,
        trashed: false
      });
    button.addEventListener("contextmenu", showThreadMenu);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "thread-delete-button";
    deleteButton.title = "删除这条历史划线";
    deleteButton.setAttribute("aria-label", "删除这条历史划线");
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteReadingThread(thread.id);
    });
    deleteButton.addEventListener("contextmenu", showThreadMenu);

    row.append(button, deleteButton);
    elements.threadList.append(row);
  }
}

function renderSelection() {
  const draftText = state.selectedText || "";
  const activeText = state.activeHighlight?.text || "";
  elements.selectionTitle.textContent = "划线区";
  elements.activeSelectionPreview.textContent = draftText || activeText || "尚未选择正文文本。";
  updateSendState();
}

function renderPanelView() {
  const isDetail = state.panelView === "detail";
  elements.historyLayer.toggleAttribute("hidden", isDetail);
  elements.detailLayer.toggleAttribute("hidden", !isDetail);
  elements.historyLayer.setAttribute("aria-hidden", String(isDetail));
  elements.detailLayer.setAttribute("aria-hidden", String(!isDetail));
  elements.qaPanelTitle.textContent = isDetail ? "划线问答" : "历史划线";
  elements.panelToggleButton.textContent = isDetail ? "◀" : "▶";
  elements.panelToggleButton.title = isDetail ? "查看历史划线" : "返回当前提问";
  if (isDetail) {
    hideSelectionAskButton();
    elements.questionInput.focus();
  }
}

function getMessageListBottomDistance() {
  const list = elements.messageList;
  return Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight);
}

function isMessageListNearBottom() {
  return getMessageListBottomDistance() <= MESSAGE_BOTTOM_FOLLOW_THRESHOLD;
}

function scrollMessageListToBottom() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function restoreMessageListBottomDistance(bottomDistance) {
  const list = elements.messageList;
  list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - bottomDistance);
}

async function renderMessages(options = {}) {
  const preserveViewerScroll = options.preserveViewerScroll === true;
  const bottomDistanceBeforeRender = getMessageListBottomDistance();
  const shouldFollowBottom = !preserveViewerScroll || isMessageListNearBottom();
  elements.messageList.replaceChildren();
  updateSendState();

  if (!state.activeThread) {
    return;
  }

  const settings = await getSettings();
  const fallbackModelLabel = settings.ai?.model || "当前模型";
  const messages = await getThreadMessages(state.activeThread.id);
  const visibleMessages = messages.filter((item) => item.role !== "selection");
  for (const message of visibleMessages) {
    const card = document.createElement("div");
    card.className = `message message-${message.role}`;

    const content = document.createElement("div");
    content.className = "message-content";
    renderMessageContent(content, message.content);

    if (message.role !== "user") {
      const role = document.createElement("span");
      role.className = "message-role";
      role.textContent =
        message.role === "assistant" ? message.model || fallbackModelLabel : getRoleLabel(message.role);
      card.append(role);
    }

    card.append(content);
    elements.messageList.append(card);

    if (message.role === "user") {
      const turnState = getTurnStateForUserMessage(message, visibleMessages);
      if (turnState) {
        elements.messageList.append(
          turnState.status === "running" ? renderStreamingAnswerCard(turnState) : renderTurnStateCard(turnState)
        );
      }
    }
  }

  if (shouldFollowBottom) {
    scrollMessageListToBottom();
  } else {
    restoreMessageListBottomDistance(bottomDistanceBeforeRender);
  }
}

function getTurnStateForUserMessage(message, messages) {
  const activeRun = state.activeAnswerRun;
  if (activeRun?.threadId === message.threadId && activeRun.userMessageId === message.id) {
    return {
      status: "running",
      threadId: message.threadId,
      userMessageId: message.id,
      answerRun: activeRun,
      question: activeRun.question,
      model: activeRun.model,
      streamContent: activeRun.streamContent || "",
      text: "正在生成回答。你可以点击“停止”中断，本次不会保存未完成的模型回答。"
    };
  }

  if (message.answerStatus === "failed") {
    return {
      status: "failed",
      threadId: message.threadId,
      userMessageId: message.id,
      question: message.content,
      text: `回答失败：${message.answerError || "模型请求没有成功。"}`
    };
  }

  if (message.answerStatus === "cancelled") {
    return {
      status: "cancelled",
      threadId: message.threadId,
      userMessageId: message.id,
      question: message.content,
      text: "回答已停止，未保存 assistant message 和 summary。"
    };
  }

  const hasLaterAssistant = messages.some(
    (item) =>
      item.role === "assistant" &&
      String(item.createdAt || "").localeCompare(String(message.createdAt || "")) > 0
  );
  if (message.answerStatus === "submitted" && !hasLaterAssistant) {
    return {
      status: "submitted",
      threadId: message.threadId,
      userMessageId: message.id,
      question: message.content,
      text: "这条问题还没有生成可保存的回答。"
    };
  }

  return null;
}

function renderTurnStateCard(turnState) {
  const card = document.createElement("div");
  card.className = `message message-assistant message-status message-status-${turnState.status}`;

  const role = document.createElement("span");
  role.className = "message-role";
  role.textContent = "回答状态";

  const content = document.createElement("div");
  content.className = "message-content";
  const paragraph = document.createElement("p");
  paragraph.className = "message-paragraph";
  paragraph.textContent = turnState.text;
  content.append(paragraph);

  card.append(role, content);

  if (turnState.status !== "running") {
    const actions = document.createElement("div");
    actions.className = "message-actions";
    actions.append(
      createTurnActionButton("retry-answer", "重试", turnState),
      createTurnActionButton("edit-question", "编辑问题", turnState)
    );
    card.append(actions);
  }

  return card;
}

function renderStreamingAnswerCard(turnState) {
  const card = document.createElement("div");
  card.className = "message message-assistant message-streaming";
  card.setAttribute("aria-live", "polite");
  card.setAttribute("aria-busy", "true");
  card.dataset.answerRunId = turnState.answerRun?.id || "";
  card.dataset.userMessageId = turnState.userMessageId;

  const role = document.createElement("span");
  role.className = "message-role";
  role.textContent = turnState.model || "当前模型";

  const content = document.createElement("div");
  content.className = "message-content";
  const streamContent = String(turnState.streamContent || "");
  if (streamContent.trim()) {
    renderMessageContent(content, streamContent);
  } else {
    const paragraph = document.createElement("p");
    paragraph.className = "message-paragraph message-stream-placeholder";
    paragraph.textContent = "正在生成回答…";
    content.append(paragraph);
  }

  card.append(role, content);
  if (turnState.answerRun && isCurrentAnswerRun(turnState.answerRun)) {
    turnState.answerRun.streamCard = card;
    turnState.answerRun.streamContentNode = content;
    turnState.answerRun.streamRenderedContent = streamContent;
  }
  return card;
}

function createTurnActionButton(action, label, turnState) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = action === "retry-answer" ? "message-action-button" : "message-action-button secondary";
  button.dataset.messageAction = action;
  button.dataset.threadId = turnState.threadId;
  button.dataset.userMessageId = turnState.userMessageId;
  button.textContent = label;
  return button;
}

function renderMessageContent(container, content) {
  container.replaceChildren();
  const text = String(content || "").replace(/\r\n/g, "\n");
  const codeBlockPattern = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = codeBlockPattern.exec(text))) {
    appendRichText(container, text.slice(cursor, match.index));
    appendCodeBlock(container, match[2], match[1]);
    cursor = match.index + match[0].length;
  }

  appendRichText(container, text.slice(cursor));
}

function appendRichText(container, text) {
  if (!text) {
    return;
  }

  const blockMathPattern = /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g;
  let cursor = 0;
  let match;

  while ((match = blockMathPattern.exec(text))) {
    appendParagraphs(container, text.slice(cursor, match.index));
    appendMathBlock(container, stripMathDelimiters(match[0]));
    cursor = match.index + match[0].length;
  }

  appendParagraphs(container, text.slice(cursor));
}

function appendParagraphs(container, text) {
  const paragraphs = String(text || "").split(/\n{2,}/);
  for (const paragraphText of paragraphs) {
    if (!paragraphText.trim()) {
      continue;
    }
    const paragraph = document.createElement("p");
    paragraph.className = "message-paragraph";
    appendInlineContent(paragraph, paragraphText);
    container.append(paragraph);
  }
}

function appendInlineContent(parent, text) {
  const inlinePattern = /(`[^`]+`|\\\([^]*?\\\)|\$[^$\n]+\$)/g;
  let cursor = 0;
  let match;

  while ((match = inlinePattern.exec(text))) {
    appendPlainInline(parent, text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.className = "message-inline-code";
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (!isLikelyInlineMathToken(token)) {
      appendPlainInline(parent, token);
    } else {
      const math = document.createElement("span");
      math.className = "math-inline";
      math.textContent = stripMathDelimiters(token);
      parent.append(math);
    }
    cursor = match.index + token.length;
  }

  appendPlainInline(parent, text.slice(cursor));
}

function appendPlainInline(parent, text) {
  const lines = String(text || "").split("\n");
  lines.forEach((line, index) => {
    if (index > 0) {
      parent.append(document.createElement("br"));
    }
    if (line) {
      parent.append(document.createTextNode(line));
    }
  });
}

function appendCodeBlock(container, codeText, language) {
  const pre = document.createElement("pre");
  pre.className = "message-code-block";
  const code = document.createElement("code");
  if (language) {
    code.dataset.language = language;
  }
  code.textContent = codeText.trim();
  pre.append(code);
  container.append(pre);
}

function appendMathBlock(container, mathText) {
  const block = document.createElement("div");
  block.className = "math-block";
  block.textContent = mathText.trim();
  container.append(block);
}

function stripMathDelimiters(token) {
  if (token.startsWith("$$") && token.endsWith("$$")) {
    return token.slice(2, -2);
  }
  if (token.startsWith("\\[") && token.endsWith("\\]")) {
    return token.slice(2, -2);
  }
  if (token.startsWith("\\(") && token.endsWith("\\)")) {
    return token.slice(2, -2);
  }
  if (token.startsWith("$") && token.endsWith("$")) {
    return token.slice(1, -1);
  }
  return token;
}

function isLikelyInlineMathToken(token) {
  if (token.startsWith("\\(") && token.endsWith("\\)")) {
    return true;
  }

  if (!token.startsWith("$") || !token.endsWith("$")) {
    return false;
  }

  const formula = stripMathDelimiters(token).trim();
  return /\\[a-zA-Z]+|[\^_=+\-*/<>]|[∑∫√∞≈≠≤≥±×÷]|^[a-zA-Z][a-zA-Z0-9']*$/.test(formula);
}

async function captureSelection() {
  const selection = window.getSelection();
  let selectedText = selection?.toString().trim() || "";

  if (!selectedText) {
    await discardUnsubmittedDraft({ clearSelection: true, render: true });
    if (!isDraftThread(state.activeThread)) {
      clearDraftSelection();
    }
    hideSelectionAskButton();
    renderSelection();
    updateSendState();
    return;
  }

  const blockRanges = getSelectionBlockRanges(selection);
  if (!blockRanges.length) {
    return;
  }
  selectedText = createSelectionTextFromRanges(blockRanges) || selectedText;

  const firstRange = blockRanges[0];
  const lastRange = blockRanges[blockRanges.length - 1];

  await discardUnsubmittedDraft({ clearSelection: false, render: false });
  state.activeThread = null;
  state.activeHighlight = null;
  state.selectedText = selectedText;
  state.selectedBlockId = firstRange.blockId;
  state.selectedBlockRanges = blockRanges;
  state.selectedLocalStartOffset = firstRange.localStartOffset;
  state.selectedLocalEndOffset = firstRange.localEndOffset;
  state.selectedGlobalStartOffset = firstRange.globalStartOffset;
  state.selectedGlobalEndOffset = lastRange.globalEndOffset;

  renderSelection();
  renderThreads();
  if (state.panelView === "detail") {
    void renderMessages();
  }
  showSelectionAskButton(selection);
}

async function createThreadFromSelection(options = {}) {
  if (selectionThreadCreationPromise) {
    const thread = await selectionThreadCreationPromise;
    if (thread && options.focusInput !== false) {
      elements.questionInput.focus();
    }
    return thread;
  }

  if (!state.currentDocument || !state.selectedText) {
    return null;
  }

  elements.selectionAskButton.disabled = true;
  selectionThreadCreationPromise = persistThreadFromSelection(options);
  try {
    return await selectionThreadCreationPromise;
  } finally {
    selectionThreadCreationPromise = null;
    elements.selectionAskButton.disabled = false;
  }
}

async function persistThreadFromSelection(options = {}) {
  const selectedText = state.selectedText;
  const selectedBlockRanges = state.selectedBlockRanges.length
    ? state.selectedBlockRanges
    : [
        {
          blockId: state.selectedBlockId,
          text: selectedText,
          localStartOffset: state.selectedLocalStartOffset,
          localEndOffset: state.selectedLocalEndOffset,
          globalStartOffset: state.selectedGlobalStartOffset,
          globalEndOffset: state.selectedGlobalEndOffset,
          blockOrder: state.blocks.findIndex((block) => block.id === state.selectedBlockId)
        }
      ];
  const firstRange = selectedBlockRanges[0];
  const lastRange = selectedBlockRanges[selectedBlockRanges.length - 1];
  const selectedBlockId = firstRange.blockId;
  const createdAt = nowIso();
  const blockOrder = firstRange.blockOrder;
  const formulaContext = normalizeFormulaSelection(selectedText);
  const highlight = {
    id: createId("highlight"),
    documentId: state.currentDocument.id,
    blockId: selectedBlockId,
    endBlockId: lastRange.blockId,
    blockRanges: selectedBlockRanges.map((range) => ({
      blockId: range.blockId,
      text: range.text,
      localStartOffset: range.localStartOffset,
      localEndOffset: range.localEndOffset,
      globalStartOffset: range.globalStartOffset,
      globalEndOffset: range.globalEndOffset,
      blockOrder: range.blockOrder
    })),
    text: selectedText,
    color: "yellow",
    threadId: "",
    localStartOffset: firstRange.localStartOffset,
    localEndOffset: firstRange.localEndOffset,
    endLocalEndOffset: lastRange.localEndOffset,
    globalStartOffset: firstRange.globalStartOffset,
    globalEndOffset: lastRange.globalEndOffset,
    blockOrder,
    formulaContext,
    status: "draft",
    isDraft: true,
    createdAt,
    updatedAt: createdAt
  };
  const thread = {
    id: createId("thread"),
    documentId: state.currentDocument.id,
    highlightId: highlight.id,
    title: createThreadTitle(selectedText),
    status: "draft",
    isDraft: true,
    createdAt,
    updatedAt: createdAt
  };
  highlight.threadId = thread.id;

  state.activeHighlight = highlight;
  state.activeThread = thread;
  clearDraftSelection();
  state.panelView = "detail";
  hideSelectionAskButton();

  refreshDocumentHighlights();
  renderThreads();
  renderSelection();
  renderPanelView();
  await renderMessages();
  scrollHighlightIntoCenter(highlight.id);
  if (options.focusInput !== false) {
    elements.questionInput.focus();
  }
  setStatus("已进入划线提问草稿；发送问题后才会保存到历史划线。");
  return thread;
}

async function commitDraftThread() {
  if (!isDraftThread(state.activeThread) || !isDraftHighlight(state.activeHighlight)) {
    return;
  }

  const committedAt = nowIso();
  const highlight = {
    ...state.activeHighlight,
    status: "active",
    isDraft: false,
    updatedAt: committedAt
  };
  const thread = {
    ...state.activeThread,
    status: "active",
    isDraft: false,
    updatedAt: committedAt
  };
  const selectionMessage = {
    id: createId("msg"),
    threadId: thread.id,
    role: "selection",
    content: highlight.text,
    createdAt: highlight.createdAt || committedAt
  };

  await Promise.all([
    dbPut("highlights", highlight),
    dbPut("threads", thread),
    dbPut("messages", selectionMessage)
  ]);
  await logTask("highlight.thread.created", {
    documentId: state.currentDocument.id,
    highlightId: highlight.id,
    threadId: thread.id,
    globalStartOffset: highlight.globalStartOffset
  });

  state.activeHighlight = highlight;
  state.activeThread = thread;
  state.highlights = [
    ...state.highlights.filter((item) => item.id !== highlight.id),
    highlight
  ];
  state.threads = [
    ...state.threads.filter((item) => item.id !== thread.id),
    thread
  ];
  notifyKnowledgeDataChanged("thread-created");
}

async function discardUnsubmittedDraft(options = {}) {
  const { clearSelection = true, clearQuestion = true, render = false } = options;
  const hadDraft = isDraftThread(state.activeThread) || isDraftHighlight(state.activeHighlight);
  if (!hadDraft) {
    if (clearSelection) {
      clearDraftSelection();
    }
    return false;
  }

  state.activeThread = null;
  state.activeHighlight = null;
  if (clearSelection) {
    clearDraftSelection();
  }
  if (clearQuestion) {
    elements.questionInput.value = "";
    state.editingQuestion = null;
  }
  hideSelectionAskButton();

  if (render) {
    refreshDocumentHighlights();
    renderThreads();
    renderSelection();
    renderPanelView();
    await renderMessages();
  }
  return true;
}

async function activateThread(threadId) {
  await discardUnsubmittedDraft({ clearSelection: true, render: false });
  const thread = state.threads.find((item) => item.id === threadId) || (await dbGet("threads", threadId));
  if (!thread) {
    return;
  }

  state.activeThread = thread;
  state.activeHighlight =
    state.highlights.find((highlight) => highlight.id === thread.highlightId) ||
    state.highlights.find((highlight) => highlight.threadId === thread.id) ||
    (thread.highlightId ? await dbGet("highlights", thread.highlightId) : null);
  clearDraftSelection();
  state.panelView = "detail";
  hideSelectionAskButton();

  renderSelection();
  renderPanelView();
  renderThreads();
  await renderMessages();
  scrollHighlightIntoCenter(state.activeHighlight?.id);
}

async function handleDocumentClick(event) {
  const mark = event.target.closest?.(".reader-highlight");
  if (mark?.dataset.threadId) {
    await activateThread(mark.dataset.threadId);
  }
}

function handleDocumentHighlightContextMenu(event) {
  const mark = event.target.closest?.(".reader-highlight");
  const threadId = mark?.dataset.threadId || "";
  if (!threadId) {
    return;
  }
  const thread = state.threads.find((item) => item.id === threadId);
  showDocumentContextMenu(event, {
    type: "thread",
    id: threadId,
    highlightId: thread?.highlightId || mark.dataset.highlightId || "",
    trashed: false
  });
}

async function handleQuestionButtonClick() {
  if (state.activeAnswerRun) {
    await stopActiveAnswerRun();
    return;
  }

  await sendQuestion();
}

async function handleMessageListClick(event) {
  const button = event.target.closest?.("[data-message-action]");
  if (!button) {
    return;
  }

  event.preventDefault();
  const action = button.dataset.messageAction;
  const threadId = button.dataset.threadId || "";
  const userMessageId = button.dataset.userMessageId || "";
  if (!threadId || !userMessageId) {
    return;
  }
  if (state.activeAnswerRun) {
    setStatus("当前回答仍在生成，请先停止后再重试或编辑。");
    return;
  }
  if (state.activeThread?.id !== threadId) {
    await activateThread(threadId);
  }

  const userMessage = await dbGet("messages", userMessageId);
  if (!userMessage || userMessage.role !== "user") {
    setStatus("没有找到这条问题记录。");
    return;
  }

  if (action === "edit-question") {
    loadQuestionForEditing(userMessage);
    return;
  }
  if (action === "retry-answer") {
    await retryQuestion(userMessage);
  }
}

async function sendQuestion(options = {}) {
  if (state.activeAnswerRun) {
    setStatus("当前回答仍在生成，请先停止后再发送。");
    return;
  }

  const question = String(options.question ?? elements.questionInput.value).trim();
  if (!question) {
    return;
  }

  if (!state.activeThread && state.selectedText) {
    await createThreadFromSelection({ focusInput: false });
  }

  if (isDraftThread(state.activeThread)) {
    await commitDraftThread();
    refreshDocumentHighlights();
    renderThreads();
  }

  if (!state.activeThread || !state.activeHighlight || !state.currentDocument) {
    setStatus("请先在正文中选中一段文字，再输入问题。");
    return;
  }

  const settingsAtQuestion = await getSettings();
  const aiSettingsAtQuestion = { ...(settingsAtQuestion.ai || {}) };
  const modelAtQuestion = aiSettingsAtQuestion.model || "当前模型";
  const userMessage = await persistUserQuestionMessage({
    question,
    model: modelAtQuestion,
    existingUserMessage: options.userMessage
  });
  const answerRun = {
    id: createId("answerRun"),
    controller: new AbortController(),
    cancelled: false,
    threadId: state.activeThread.id,
    highlightId: state.activeHighlight.id,
    userMessageId: userMessage.id,
    question,
    userMessage,
    thread: { ...state.activeThread },
    highlight: { ...state.activeHighlight },
    documentRecord: { ...state.currentDocument },
    blocks: [...state.blocks],
    highlights: [...state.highlights],
    threads: [...state.threads],
    aiSettings: aiSettingsAtQuestion,
    model: modelAtQuestion,
    streamContent: "",
    streamMeta: null,
    streamRenderQueued: false,
    streamRenderedContent: "",
    streamCard: null,
    streamContentNode: null
  };

  state.activeAnswerRun = answerRun;
  state.editingQuestion = {
    threadId: userMessage.threadId,
    userMessageId: userMessage.id
  };
  elements.questionInput.value = question;
  updateSendState();
  await renderMessages();
  setStatus("正在生成回答；可点击“停止”中断。");

  try {
    const messagesBeforeAnswer = await getThreadMessages(answerRun.threadId);
    const previousMessages = messagesBeforeAnswer.filter((message) => message.id !== userMessage.id);
    const messagesByThread = await getMessagesByThreadIds(answerRun.threads.map((thread) => thread.id));
    messagesByThread[answerRun.threadId] = previousMessages;
    const answerResult = await answerThread({
      thread: answerRun.thread,
      highlight: answerRun.highlight,
      blocks: answerRun.blocks,
      messages: previousMessages,
      highlights: answerRun.highlights,
      threads: answerRun.threads,
      messagesByThread,
      question,
      documentRecord: answerRun.documentRecord,
      documentTitle: answerRun.documentRecord.title,
      aiSettings: answerRun.aiSettings,
      signal: answerRun.controller.signal,
      onDelta: (delta, meta) => appendAnswerDelta(answerRun, delta, meta)
    });

    if (!isCurrentAnswerRun(answerRun)) {
      return;
    }

    const normalizedResult = normalizeAnswerThreadResult(answerResult, answerRun);
    if (normalizedResult.cancelled) {
      await markQuestionCancelled(answerRun);
      return;
    }
    if (!normalizedResult.ok) {
      await markQuestionFailed(answerRun, normalizedResult.error);
      return;
    }

    await saveSuccessfulAnswer(answerRun, normalizedResult.content);
  } catch (error) {
    if (!isCurrentAnswerRun(answerRun)) {
      return;
    }
    if (answerRun.cancelled || answerRun.controller.signal.aborted || isAbortLikeError(error)) {
      await markQuestionCancelled(answerRun);
      return;
    }
    await markQuestionFailed(answerRun, getErrorMessage(error));
  } finally {
    if (state.activeAnswerRun?.id === answerRun.id) {
      state.activeAnswerRun = null;
    }
    updateSendState();
  }
}

async function persistUserQuestionMessage({ question, model, existingUserMessage }) {
  const now = nowIso();
  const editableMessage = existingUserMessage || (await getEditingQuestionMessage());
  const userMessage = editableMessage
    ? {
        ...editableMessage,
        content: question,
        model,
        answerStatus: "submitted",
        answerError: "",
        answerUpdatedAt: now,
        updatedAt: now
      }
    : {
        id: createId("msg"),
        threadId: state.activeThread.id,
        role: "user",
        content: question,
        model,
        answerStatus: "submitted",
        answerError: "",
        answerUpdatedAt: now,
        createdAt: now
      };

  await dbPut("messages", userMessage);
  notifyKnowledgeDataChanged(editableMessage ? "question-updated" : "question-created");
  return userMessage;
}

async function getEditingQuestionMessage() {
  if (!state.editingQuestion || state.editingQuestion.threadId !== state.activeThread?.id) {
    return null;
  }
  const message = await dbGet("messages", state.editingQuestion.userMessageId);
  return message?.role === "user" ? message : null;
}

async function retryQuestion(userMessage) {
  const question = String(userMessage.content || "").trim();
  if (!question) {
    setStatus("这条问题内容为空，无法重试。");
    return;
  }

  state.editingQuestion = {
    threadId: userMessage.threadId,
    userMessageId: userMessage.id
  };
  elements.questionInput.value = question;
  await sendQuestion({ question, userMessage });
}

function loadQuestionForEditing(userMessage) {
  state.editingQuestion = {
    threadId: userMessage.threadId,
    userMessageId: userMessage.id
  };
  elements.questionInput.value = userMessage.content || "";
  elements.questionInput.readOnly = false;
  elements.questionInput.focus();
  updateSendState();
  setStatus("已载入问题，可编辑后点击“重新发送”。");
}

async function stopActiveAnswerRun() {
  const answerRun = state.activeAnswerRun;
  if (!answerRun) {
    return;
  }

  answerRun.cancelled = true;
  answerRun.controller.abort();
  await markQuestionCancelled(answerRun);
}

async function saveSuccessfulAnswer(answerRun, content) {
  const createdAt = nowIso();
  const assistantMessage = {
    id: createId("msg"),
    threadId: answerRun.threadId,
    role: "assistant",
    content,
    model: answerRun.model,
    createdAt
  };
  const answeredThread = {
    ...answerRun.thread,
    updatedAt: createdAt
  };
  const answeredUserMessage = {
    ...answerRun.userMessage,
    answerStatus: "answered",
    answerError: "",
    answerUpdatedAt: createdAt
  };

  await Promise.all([
    dbPut("messages", answeredUserMessage),
    dbPut("messages", assistantMessage),
    dbPut("threads", answeredThread),
    saveQaTurnSummary({
      documentId: answerRun.documentRecord.id,
      highlight: answerRun.highlight,
      thread: answeredThread,
      userMessage: answeredUserMessage,
      assistantMessage,
      aiSettings: answerRun.aiSettings
    }),
    logTask("thread.question.answered", {
      threadId: answerRun.threadId,
      highlightId: answerRun.highlightId
    })
  ]);

  if (state.activeThread?.id === answeredThread.id) {
    state.activeThread = answeredThread;
  }
  state.threads = state.threads.map((thread) =>
    thread.id === answeredThread.id ? answeredThread : thread
  );
  state.activeAnswerRun = null;
  if (state.editingQuestion?.userMessageId === answeredUserMessage.id) {
    state.editingQuestion = null;
  }
  elements.questionInput.value = "";
  notifyKnowledgeDataChanged("answer-created");

  renderThreads();
  await renderMessages({ preserveViewerScroll: true });
  setStatus("回答已生成。");
}

async function markQuestionFailed(answerRun, errorMessage) {
  const userMessage = await updateQuestionAnswerStatus(answerRun.userMessage, "failed", errorMessage);
  answerRun.userMessage = userMessage;
  state.activeAnswerRun = null;
  state.editingQuestion = {
    threadId: answerRun.threadId,
    userMessageId: userMessage.id
  };
  elements.questionInput.value = answerRun.question;
  await renderMessages({ preserveViewerScroll: true });
  setStatus(`回答失败：${errorMessage || "模型请求没有成功"}。未保存模型回答，可重试或编辑后重新发送。`);
}

async function markQuestionCancelled(answerRun) {
  const userMessage = await updateQuestionAnswerStatus(answerRun.userMessage, "cancelled", "");
  answerRun.userMessage = userMessage;
  state.activeAnswerRun = null;
  state.editingQuestion = {
    threadId: answerRun.threadId,
    userMessageId: userMessage.id
  };
  elements.questionInput.value = answerRun.question;
  await renderMessages({ preserveViewerScroll: true });
  setStatus("已停止回答。未保存 assistant message 和 summary，可重试或编辑后重新发送。");
}

async function updateQuestionAnswerStatus(userMessage, answerStatus, answerError) {
  const updatedMessage = {
    ...userMessage,
    answerStatus,
    answerError: answerError || "",
    answerUpdatedAt: nowIso()
  };
  await dbPut("messages", updatedMessage);
  return updatedMessage;
}

function normalizeAnswerThreadResult(answerResult, answerRun) {
  if (answerRun.cancelled || answerRun.controller.signal.aborted) {
    return { ok: false, cancelled: true, content: "", error: "回答已停止。" };
  }

  if (answerResult && typeof answerResult === "object" && !Array.isArray(answerResult)) {
    if (answerResult.cancelled) {
      return {
        ok: false,
        cancelled: true,
        content: "",
        error: answerResult.error || "回答已停止。"
      };
    }
    if (answerResult.ok === false) {
      return {
        ok: false,
        cancelled: false,
        content: "",
        error: getAnswerResultError(answerResult)
      };
    }
    if (answerResult.error && answerResult.ok !== true && !answerResult.content) {
      return {
        ok: false,
        cancelled: false,
        content: "",
        error: getAnswerResultError(answerResult)
      };
    }

    const content = String(answerResult.content ?? answerResult.answer ?? answerResult.text ?? "");
    if (!content.trim()) {
      return { ok: false, cancelled: false, content: "", error: "模型返回了空回答。" };
    }
    return { ok: true, cancelled: false, content, error: "" };
  }

  const content = String(answerResult ?? "");
  if (isLegacyAnswerErrorText(content)) {
    return {
      ok: false,
      cancelled: false,
      content: "",
      error: stripLegacyAnswerError(content)
    };
  }
  if (!content.trim()) {
    return { ok: false, cancelled: false, content: "", error: "模型返回了空回答。" };
  }
  return { ok: true, cancelled: false, content, error: "" };
}

function getAnswerResultError(answerResult) {
  if (typeof answerResult.error === "string") {
    return answerResult.error;
  }
  if (answerResult.error?.message) {
    return answerResult.error.message;
  }
  return "模型请求没有成功。";
}

function isLegacyAnswerErrorText(content) {
  return /^AI request failed(?::| with HTTP|\b)/i.test(String(content || "").trim());
}

function stripLegacyAnswerError(content) {
  return String(content || "")
    .trim()
    .replace(/^AI request failed:\s*/i, "")
    .replace(/^AI request failed\s*/i, "")
    .trim() || "模型请求没有成功。";
}

function appendAnswerDelta(answerRun, delta, meta) {
  if (!isCurrentAnswerRun(answerRun) || answerRun.cancelled || answerRun.controller.signal.aborted) {
    return;
  }

  const chunk = normalizeAnswerDelta(delta);
  if (!chunk) {
    return;
  }

  answerRun.streamContent = `${answerRun.streamContent || ""}${chunk}`;
  answerRun.streamMeta = meta || answerRun.streamMeta;
  queueAnswerRunRender(answerRun);
}

function normalizeAnswerDelta(delta) {
  if (typeof delta === "string") {
    return delta;
  }
  if (delta == null) {
    return "";
  }
  if (typeof delta === "number" || typeof delta === "boolean") {
    return String(delta);
  }
  if (typeof delta !== "object") {
    return "";
  }

  const value = delta.delta ?? delta.content ?? delta.text ?? delta.answer ?? delta.outputText ?? "";
  return typeof value === "string" ? value : "";
}

function queueAnswerRunRender(answerRun) {
  if (answerRun.streamRenderQueued) {
    return;
  }

  answerRun.streamRenderQueued = true;
  const schedule =
    typeof requestAnimationFrame === "function" ? requestAnimationFrame : (callback) => setTimeout(callback, 16);
  schedule(() => {
    answerRun.streamRenderQueued = false;
    if (isCurrentAnswerRun(answerRun)) {
      renderAnswerRunDelta(answerRun);
    }
  });
}

function renderAnswerRunDelta(answerRun) {
  if (!isCurrentAnswerRun(answerRun)) {
    return;
  }

  const content = getAnswerRunStreamContentNode(answerRun);
  if (!content) {
    return;
  }

  const nextContent = String(answerRun.streamContent || "");
  const shouldFollowBottom = isMessageListNearBottom();
  if (answerRun.streamRenderedContent !== nextContent) {
    renderMessageContent(content, nextContent);
    answerRun.streamRenderedContent = nextContent;
  }
  if (shouldFollowBottom) {
    scrollMessageListToBottom();
  }
}

function getAnswerRunStreamContentNode(answerRun) {
  if (answerRun.streamContentNode?.isConnected) {
    return answerRun.streamContentNode;
  }
  if (answerRun.streamCard?.isConnected) {
    const content = answerRun.streamCard.querySelector(".message-content");
    if (content) {
      answerRun.streamContentNode = content;
      return content;
    }
  }
  return null;
}

function isAbortLikeError(error) {
  const name = error?.name || "";
  const message = getErrorMessage(error).toLowerCase();
  return name === "AbortError" || message.includes("abort") || message.includes("cancel");
}

function isCurrentAnswerRun(answerRun) {
  return state.activeAnswerRun?.id === answerRun.id;
}

function updateSendState() {
  const isRunning = Boolean(state.activeAnswerRun);
  const hasQuestion = Boolean(elements.questionInput.value.trim());
  const hasContext = Boolean(state.activeThread || state.selectedText);
  const isEditing =
    Boolean(state.editingQuestion) &&
    Boolean(state.activeThread) &&
    state.editingQuestion.threadId === state.activeThread.id;

  elements.questionInput.readOnly = isRunning;
  elements.questionInput.setAttribute("aria-busy", String(isRunning));
  elements.composer?.classList.toggle("answer-running", isRunning);
  elements.sendQuestionButton.textContent = isRunning ? "停止" : isEditing ? "重新发送" : "发送";
  elements.sendQuestionButton.classList.toggle("stop-button", isRunning);
  elements.sendQuestionButton.disabled = isRunning ? false : !hasQuestion || !hasContext;
}

function handleQuestionKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }
  event.preventDefault();
  if (state.activeAnswerRun) {
    setStatus("当前回答仍在生成；点击“停止”后才能重新发送。");
    return;
  }
  if (!elements.sendQuestionButton.disabled) {
    void sendQuestion();
  }
}

async function handleShortcut(event) {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "q") {
    event.preventDefault();
    await captureSelection();
    if (state.selectedText) {
      openDraftQuestion();
    } else {
      setStatus("请先选中正文文本，再使用快捷键进入提问。");
    }
  }
}

async function handlePanelToggle() {
  if (state.panelView === "detail") {
    await discardUnsubmittedDraft({ clearSelection: true, render: true });
    hideSelectionAskButton();
    setPanelView("history");
    return;
  }

  await discardUnsubmittedDraft({ clearSelection: true, render: false });
  state.activeThread = null;
  state.activeHighlight = null;
  hideSelectionAskButton();
  setPanelView("detail");
  renderSelection();
  void renderMessages();
}

async function openDraftQuestion() {
  if (!state.selectedText) {
    setStatus("请先在正文中选中一段文字。");
    return;
  }
  await createThreadFromSelection({ focusInput: true });
  pulseSelectionCard();
}

async function openKnowledgePage() {
  if (!state.currentDocument?.id) {
    setStatus("请先打开一份文档，再生成知识图谱。");
    return;
  }
  await discardUnsubmittedDraft({ clearSelection: true, render: true });
  await openOrFocusExtensionPage(
    `src/knowledge/knowledge.html?documentId=${encodeURIComponent(state.currentDocument.id)}`
  );
}

function setPanelView(view) {
  state.panelView = view === "detail" ? "detail" : "history";
  renderPanelView();
}

function toggleSidebarSection(button) {
  const section = button.closest(".sidebar-section");
  const isCollapsed = section.classList.toggle("collapsed");
  button.setAttribute("aria-expanded", String(!isCollapsed));
}

function showSelectionAskButton(selection) {
  if (!selection?.rangeCount) {
    hideSelectionAskButton();
    return;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) {
    hideSelectionAskButton();
    return;
  }

  elements.selectionAskButton.hidden = false;
  const buttonRect = elements.selectionAskButton.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - buttonRect.width / 2),
    window.innerWidth - buttonRect.width - 8
  );
  const top =
    rect.top - buttonRect.height - 8 > 8
      ? rect.top - buttonRect.height - 8
      : rect.bottom + 8;

  elements.selectionAskButton.style.left = `${left}px`;
  elements.selectionAskButton.style.top = `${Math.min(top, window.innerHeight - buttonRect.height - 8)}px`;
}

function hideSelectionAskButton() {
  elements.selectionAskButton.hidden = true;
}

function pulseSelectionCard() {
  if (!elements.selectionCard) {
    return;
  }

  elements.selectionCard.classList.remove("selection-card-feedback");
  void elements.selectionCard.offsetWidth;
  elements.selectionCard.classList.add("selection-card-feedback");

  window.clearTimeout(selectionFeedbackTimer);
  selectionFeedbackTimer = window.setTimeout(() => {
    elements.selectionCard.classList.remove("selection-card-feedback");
    selectionFeedbackTimer = 0;
  }, 900);
}

function scrollHighlightIntoCenter(highlightId) {
  if (!highlightId) {
    return;
  }

  const highlight = findHighlightById(highlightId);
  const pageNumber = getHighlightTargetPageNumber(highlight);
  const token = ++pendingHighlightScrollToken;
  window.clearTimeout(pendingHighlightScrollTimer);
  pendingHighlightScrollTarget = {
    token,
    highlightId,
    pageNumber,
    attempts: 0
  };

  requestAnimationFrame(() => retryPendingHighlightScroll(token));
}

function retryPendingHighlightScroll(token) {
  const target = pendingHighlightScrollTarget;
  if (!target || target.token !== token) {
    return;
  }

  const marks = getHighlightMarks(target.highlightId);
  if (marks.length) {
    completePendingHighlightScroll(target, marks);
    return;
  }

  if (target.pageNumber && isPdfHybridViewRendered()) {
    scrollToPdfHybridPage(target.pageNumber);
    queueFocusedPdfHybridPageRender(target.pageNumber);
  }

  target.attempts += 1;
  if (target.attempts >= HIGHLIGHT_SCROLL_MAX_RETRIES) {
    pendingHighlightScrollTarget = null;
    setStatus("这条划线记录已打开，但暂时没有在当前 PDF 渲染层中定位到原文。请稍后重试或重新导入 PDF 后验证。");
    return;
  }

  window.clearTimeout(pendingHighlightScrollTimer);
  pendingHighlightScrollTimer = window.setTimeout(
    () => retryPendingHighlightScroll(token),
    HIGHLIGHT_SCROLL_RETRY_DELAY_MS
  );
}

function completePendingHighlightScroll(target, marks) {
  pendingHighlightScrollTarget = null;
  window.clearTimeout(pendingHighlightScrollTimer);

  marks[0].scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  marks.forEach((mark) => mark.classList.add("active-highlight"));

  window.clearTimeout(highlightFocusTimer);
  highlightFocusTimer = window.setTimeout(() => {
    marks.forEach((mark) => mark.classList.remove("active-highlight"));
    highlightFocusTimer = 0;
  }, 1200);
  scheduleReaderLocationUpdate();
  if (target.pageNumber) {
    queueFocusedPdfHybridPageRender(target.pageNumber);
  }
}

function retryPendingHighlightScrollForRenderedPage(pageNumber) {
  const target = pendingHighlightScrollTarget;
  if (!target || normalizePageNumber(pageNumber) !== target.pageNumber) {
    return;
  }
  requestAnimationFrame(() => retryPendingHighlightScroll(target.token));
}

function getHighlightMarks(highlightId) {
  return [
    ...elements.documentContent.querySelectorAll(`[data-highlight-id="${CSS.escape(highlightId)}"]`)
  ];
}

function findHighlightById(highlightId) {
  const id = String(highlightId || "");
  return state.highlights.find((highlight) => highlight.id === id) ||
    (state.activeHighlight?.id === id ? state.activeHighlight : null);
}

function getHighlightTargetPageNumber(highlight) {
  for (const range of getHighlightBlockRanges(highlight)) {
    const block = getBlockById(range.blockId);
    const pageNumber = normalizePageNumber(block?.pageNumber || range.pageNumber);
    if (pageNumber) {
      return pageNumber;
    }
  }
  return 0;
}

function notifyKnowledgeDataChanged(reason) {
  if (!state.currentDocument?.id || !globalThis.chrome?.storage?.local) {
    return;
  }

  const result = chrome.storage.local.set({
    [KNOWLEDGE_REFRESH_KEY]: {
      documentId: state.currentDocument.id,
      reason,
      updatedAt: nowIso(),
      nonce: createId("refresh")
    }
  });
  result?.catch?.(() => {});
}

function toggleWholeSidebar() {
  const scrollAnchor = getPdfHybridScrollAnchor();
  layoutState.sidebarCollapsed = !layoutState.sidebarCollapsed;
  applyLayoutState({ scrollAnchor });
}

function beginResize(event, side) {
  if (event.target === elements.sidebarCollapseButton) {
    return;
  }

  event.preventDefault();
  if (side === "left" && layoutState.sidebarCollapsed) {
    const scrollAnchor = getPdfHybridScrollAnchor();
    layoutState.sidebarCollapsed = false;
    applyLayoutState({ scrollAnchor });
  }

  const workspaceRect = elements.workspace.getBoundingClientRect();
  layoutState.resizing = {
    side,
    workspaceRect,
    scrollAnchor: getPdfHybridScrollAnchor()
  };

  elements.readerApp.classList.add("resizing");
  event.currentTarget.classList.add("resizing");
  event.currentTarget.setPointerCapture?.(event.pointerId);
  window.addEventListener("pointermove", handleResizeMove);
  window.addEventListener("pointerup", endResize, { once: true });
  window.addEventListener("pointercancel", endResize, { once: true });
  window.addEventListener("blur", endResize, { once: true });
}

function handleResizeMove(event) {
  if (!layoutState.resizing) {
    return;
  }

  const { side, workspaceRect, scrollAnchor } = layoutState.resizing;
  if (side === "left") {
    const availableForSidebar = workspaceRect.width - layoutState.qaWidth - MIN_DOCUMENT_WIDTH;
    const maxSidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, availableForSidebar);
    layoutState.sidebarWidth = clamp(event.clientX - workspaceRect.left, MIN_SIDEBAR_WIDTH, maxSidebarWidth);
  } else {
    const activeSidebarWidth = layoutState.sidebarCollapsed ? 0 : layoutState.sidebarWidth;
    const availableForQa = workspaceRect.width - activeSidebarWidth - MIN_DOCUMENT_WIDTH;
    const maxQaWidth = Math.max(MIN_QA_WIDTH, availableForQa);
    layoutState.qaWidth = clamp(workspaceRect.right - event.clientX, MIN_QA_WIDTH, maxQaWidth);
  }
  pendingPdfViewportRefreshAnchor = scrollAnchor || pendingPdfViewportRefreshAnchor;
  applyLayoutState({ scrollAnchor, skipPdfViewportRefresh: true });
}

function endResize() {
  if (!layoutState.resizing) {
    return;
  }
  const resizeState = layoutState.resizing;
  layoutState.resizing = null;
  elements.readerApp.classList.remove("resizing");
  elements.leftResizer.classList.remove("resizing");
  elements.rightResizer.classList.remove("resizing");
  window.removeEventListener("pointermove", handleResizeMove);
  window.removeEventListener("pointerup", endResize);
  window.removeEventListener("pointercancel", endResize);
  window.removeEventListener("blur", endResize);
  handleDocumentContentWidthChange(resizeState?.scrollAnchor || pendingPdfViewportRefreshAnchor, {
    force: true,
    deferMs: PDF_RESIZE_RERENDER_DEBOUNCE_MS
  });
  scheduleReaderLocationUpdate();
}

function handleResizerKeydown(event, side) {
  const key = event.key;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) {
    return;
  }

  event.preventDefault();
  const scrollAnchor = getPdfHybridScrollAnchor();
  if (side === "left" && layoutState.sidebarCollapsed) {
    layoutState.sidebarCollapsed = false;
  }

  const bounds = getLayoutResizeBounds(side);
  const step = event.shiftKey ? 40 : 16;
  if (side === "left") {
    if (key === "Home") {
      layoutState.sidebarWidth = bounds.min;
    } else if (key === "End") {
      layoutState.sidebarWidth = bounds.max;
    } else {
      const delta = key === "ArrowLeft" ? -step : step;
      layoutState.sidebarWidth = clamp(layoutState.sidebarWidth + delta, bounds.min, bounds.max);
    }
  } else if (key === "Home") {
    layoutState.qaWidth = bounds.min;
  } else if (key === "End") {
    layoutState.qaWidth = bounds.max;
  } else {
    const delta = key === "ArrowLeft" ? step : -step;
    layoutState.qaWidth = clamp(layoutState.qaWidth + delta, bounds.min, bounds.max);
  }

  applyLayoutState({ scrollAnchor, skipPdfViewportRefresh: true });
  handleDocumentContentWidthChange(scrollAnchor, {
    force: true,
    deferMs: PDF_RESIZE_RERENDER_DEBOUNCE_MS
  });
  scheduleReaderLocationUpdate();
}

function getLayoutResizeBounds(side) {
  const workspaceRect = elements.workspace.getBoundingClientRect();
  if (side === "left") {
    const availableForSidebar = workspaceRect.width - layoutState.qaWidth - MIN_DOCUMENT_WIDTH;
    return {
      min: MIN_SIDEBAR_WIDTH,
      max: Math.max(MIN_SIDEBAR_WIDTH, availableForSidebar)
    };
  }

  const activeSidebarWidth = layoutState.sidebarCollapsed ? 0 : layoutState.sidebarWidth;
  const availableForQa = workspaceRect.width - activeSidebarWidth - MIN_DOCUMENT_WIDTH;
  return {
    min: MIN_QA_WIDTH,
    max: Math.max(MIN_QA_WIDTH, availableForQa)
  };
}

function applyLayoutState(options = {}) {
  elements.readerApp.classList.toggle("sidebar-collapsed", layoutState.sidebarCollapsed);
  elements.sidebarCollapseButton.textContent = layoutState.sidebarCollapsed ? "▶" : "◀";
  elements.sidebarCollapseButton.title = layoutState.sidebarCollapsed ? "展开左侧栏" : "收起左侧栏";
  elements.sidebarCollapseButton.setAttribute("aria-expanded", String(!layoutState.sidebarCollapsed));

  elements.readerApp.style.setProperty(
    "--sidebar-width",
    layoutState.sidebarCollapsed ? "0px" : `${layoutState.sidebarWidth}px`
  );
  elements.readerApp.style.setProperty("--qa-width", `${layoutState.qaWidth}px`);
  updateLayoutSeparatorValues();
  if (!options.skipPdfViewportRefresh) {
    handleDocumentContentWidthChange(options.scrollAnchor || null);
  }
}

function updateLayoutSeparatorValues() {
  const leftBounds = getLayoutResizeBounds("left");
  const rightBounds = getLayoutResizeBounds("right");
  elements.leftResizer?.setAttribute("aria-valuemin", String(leftBounds.min));
  elements.leftResizer?.setAttribute("aria-valuemax", String(Math.round(leftBounds.max)));
  elements.leftResizer?.setAttribute(
    "aria-valuenow",
    String(layoutState.sidebarCollapsed ? 0 : Math.round(layoutState.sidebarWidth))
  );
  elements.rightResizer?.setAttribute("aria-valuemin", String(rightBounds.min));
  elements.rightResizer?.setAttribute("aria-valuemax", String(Math.round(rightBounds.max)));
  elements.rightResizer?.setAttribute("aria-valuenow", String(Math.round(layoutState.qaWidth)));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function getThreadMessages(threadId) {
  const messages = await dbGetAllByIndex("messages", "by_threadId", threadId);
  return messages.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

async function getMessagesByThreadIds(threadIds = []) {
  const uniqueThreadIds = [...new Set((threadIds || []).filter(Boolean))];
  const entries = await Promise.all(
    uniqueThreadIds.map(async (threadId) => [threadId, await getThreadMessages(threadId)])
  );
  return Object.fromEntries(entries);
}

function getSelectionBlockRanges(selection) {
  if (!selection?.rangeCount) {
    return [];
  }

  if (isPdfHybridViewRendered()) {
    return getPdfHybridSelectionBlockRanges(selection);
  }

  const selectionRange = selection.getRangeAt(0);
  const blockElements = [...elements.documentContent.querySelectorAll(".reader-block")];
  const ranges = [];

  for (const blockElement of blockElements) {
    if (!rangeIntersectsElement(selectionRange, blockElement)) {
      continue;
    }

    const intersection = getRangeIntersection(selectionRange, blockElement);
    const text = intersection?.toString() || "";
    if (!text.trim()) {
      continue;
    }

    const blockId = blockElement.dataset.blockId || "";
    const blockOrder = state.blocks.findIndex((block) => block.id === blockId);
    const localStartOffset = getRangeOffsetWithinBlock(
      blockElement,
      intersection.startContainer,
      intersection.startOffset
    );
    const localEndOffset = getRangeOffsetWithinBlock(
      blockElement,
      intersection.endContainer,
      intersection.endOffset
    );
    const blockBaseOffset = getBlockBaseOffset(blockId);

    ranges.push({
      blockId,
      text,
      localStartOffset,
      localEndOffset,
      globalStartOffset: blockBaseOffset + localStartOffset,
      globalEndOffset: blockBaseOffset + localEndOffset,
      blockOrder
    });
  }

  return ranges;
}

function isPdfHybridViewRendered() {
  return Boolean(elements.documentContent.querySelector(".pdf-hybrid-document"));
}

function getPdfHybridSelectionBlockRanges(selection) {
  const selectionRange = selection.getRangeAt(0);
  const fragments = [...elements.documentContent.querySelectorAll(".pdf-text-fragment[data-block-id]")];
  const rangesByBlock = new Map();

  for (const fragment of fragments) {
    if (!rangeIntersectsElement(selectionRange, fragment)) {
      continue;
    }
    const intersection = getRangeIntersection(selectionRange, fragment);
    const text = intersection?.toString() || "";
    if (!text.trim()) {
      continue;
    }

    const blockId = fragment.dataset.blockId || "";
    const fragmentStartOffset = Number(fragment.dataset.blockLocalStartOffset);
    if (!blockId || !Number.isFinite(fragmentStartOffset)) {
      continue;
    }

    const localStartOffset =
      fragmentStartOffset +
      getRangeOffsetWithinBlock(fragment, intersection.startContainer, intersection.startOffset);
    const localEndOffset =
      fragmentStartOffset +
      getRangeOffsetWithinBlock(fragment, intersection.endContainer, intersection.endOffset);
    const blockOrder = Number(fragment.dataset.blockOrder);
    const entry =
      rangesByBlock.get(blockId) ||
      {
        blockId,
        textParts: [],
        localStartOffset,
        localEndOffset,
        blockOrder: Number.isFinite(blockOrder)
          ? blockOrder
          : state.blocks.findIndex((block) => block.id === blockId)
      };
    entry.textParts.push(text);
    entry.localStartOffset = Math.min(entry.localStartOffset, localStartOffset);
    entry.localEndOffset = Math.max(entry.localEndOffset, localEndOffset);
    rangesByBlock.set(blockId, entry);
  }

  return [...rangesByBlock.values()]
    .sort((a, b) => a.blockOrder - b.blockOrder || a.localStartOffset - b.localStartOffset)
    .map((entry) => {
      const blockBaseOffset = getBlockBaseOffset(entry.blockId);
      return {
        blockId: entry.blockId,
        text: createPdfHybridSelectionText(entry.textParts),
        localStartOffset: entry.localStartOffset,
        localEndOffset: entry.localEndOffset,
        globalStartOffset: blockBaseOffset + entry.localStartOffset,
        globalEndOffset: blockBaseOffset + entry.localEndOffset,
        blockOrder: entry.blockOrder
      };
    });
}

function createPdfHybridSelectionText(parts) {
  return (parts || []).reduce((output, part) => {
    const text = String(part || "");
    if (!output) {
      return text;
    }
    if (!text) {
      return output;
    }
    return shouldInsertSpaceBetweenPdfLines(output, text) ? `${output} ${text}` : `${output}${text}`;
  }, "").trim();
}

function createSelectionTextFromRanges(ranges) {
  return ranges
    .map((range) => String(range.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function rangeIntersectsElement(range, element) {
  try {
    return range.intersectsNode(element);
  } catch {
    return false;
  }
}

function getRangeIntersection(selectionRange, blockElement) {
  const blockRange = document.createRange();
  blockRange.selectNodeContents(blockElement);

  try {
    const intersection = selectionRange.cloneRange();
    if (selectionRange.compareBoundaryPoints(Range.START_TO_START, blockRange) < 0) {
      intersection.setStart(blockRange.startContainer, blockRange.startOffset);
    }
    if (selectionRange.compareBoundaryPoints(Range.END_TO_END, blockRange) > 0) {
      intersection.setEnd(blockRange.endContainer, blockRange.endOffset);
    }
    return intersection;
  } catch {
    return null;
  }
}

function getRangeOffsetWithinBlock(blockElement, container, offset) {
  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(blockElement);
  try {
    prefixRange.setEnd(container, offset);
    return prefixRange.toString().length;
  } catch {
    return 0;
  }
}

function getRenderedBlockText(blockElement, block) {
  return blockElement?.innerText || blockElement?.textContent || getBlockPlainText(block);
}

function getBlockPlainText(block) {
  if (!block) {
    return "";
  }
  if (block.type === "list" && Array.isArray(block.items)) {
    return block.items.join("\n");
  }
  if (block.type === "image") {
    return block.caption || block.alt || "";
  }
  if (block.type === "table_html") {
    return block.text || block.caption || tableHtmlToPlainText(block.table_html || block.tableHtml || "");
  }
  return block.text || block.content || block.title || "";
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

function normalizePlainText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getBlockBaseOffset(blockId) {
  let offset = 0;
  for (const block of state.blocks) {
    if (block.id === blockId) {
      return offset;
    }
    offset += getBlockPlainText(block).length + 1;
  }
  return 0;
}

function getHighlightSortPosition(highlight) {
  if (Number.isFinite(highlight?.globalStartOffset)) {
    return highlight.globalStartOffset;
  }
  if (Number.isFinite(highlight?.blockOrder)) {
    return highlight.blockOrder;
  }
  return Number.MAX_SAFE_INTEGER;
}

function isDraftThread(thread) {
  return Boolean(thread?.isDraft || thread?.status === "draft");
}

function isDraftHighlight(highlight) {
  return Boolean(highlight?.isDraft || highlight?.status === "draft");
}

function clearDraftSelection() {
  state.selectedText = "";
  state.selectedBlockId = "";
  state.selectedBlockRanges = [];
  state.selectedLocalStartOffset = -1;
  state.selectedLocalEndOffset = -1;
  state.selectedGlobalStartOffset = -1;
  state.selectedGlobalEndOffset = -1;
}

function createThreadTitle(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > 56 ? `${compact.slice(0, 56)}...` : compact;
}

function createHistoryTitle(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > 42 ? `${compact.slice(0, 42)}...` : compact;
}

function getRoleLabel(role) {
  if (role === "selection") {
    return "划线原文";
  }
  if (role === "assistant") {
    return "模型回答";
  }
  return role;
}

function setStatus(message) {
  elements.status.textContent = message;
}
