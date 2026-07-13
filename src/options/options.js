import { DEFAULT_SETTINGS, deepMerge } from "../shared/defaults.js";
import { dbGetAllByIndex, getDocumentWithBlocks } from "../shared/db.js";
import { getSettings, saveSettings } from "../shared/store.js";
import { applyReaderPreferences, applyTheme } from "../shared/theme.js";
import {
  analyzeContextCapabilities
} from "../shared/context-capabilities.js";

const form = document.querySelector("#settingsForm");
const baseUrl = document.querySelector("#baseUrl");
const apiKey = document.querySelector("#apiKey");
const model = document.querySelector("#model");
const demoMode = document.querySelector("#demoMode");
const systemPrompt = document.querySelector("#systemPrompt");
const selectionPrompt = document.querySelector("#selectionPrompt");
const fontFamily = document.querySelector("#fontFamily");
const fontSize = document.querySelector("#fontSize");
const fontSizeValue = document.querySelector("#fontSizeValue");
const themeInputs = [...document.querySelectorAll('input[name="theme"]')];
const resetButton = document.querySelector("#resetButton");
const status = document.querySelector("#status");
const contextAvailabilityPanel = document.querySelector("#contextAvailabilityPanel");
const contextStatusLabel = document.querySelector(".context-status-label");
const pageParams = new URLSearchParams(location.search);
const contextDocumentId = pageParams.get("documentId") || "";

const aiContextControls = {
  selection: {
    neighborBlockCount: document.querySelector("#aiSelectionNeighborBlockCount"),
    includeDocumentOutline: document.querySelector("#aiSelectionIncludeDocumentOutline"),
    includeSelectedBlock: document.querySelector("#aiSelectionIncludeSelectedBlock"),
    chapterTextScope: document.querySelector("#aiSelectionChapterTextScope"),
    qaHistoryScope: document.querySelector("#aiSelectionQaHistoryScope")
  },
  knowledge: {
    neighborBlockCount: document.querySelector("#aiKnowledgeNeighborBlockCount"),
    includeDocumentOutline: document.querySelector("#aiKnowledgeIncludeDocumentOutline"),
    includeSelectedBlock: document.querySelector("#aiKnowledgeIncludeSelectedBlock"),
    includeThreadHistory: document.querySelector("#aiKnowledgeIncludeThreadHistory"),
    includeKnowledgeHighlights: document.querySelector("#aiKnowledgeIncludeHighlights"),
    fullTextScope: document.querySelector("#aiKnowledgeFullTextScope")
  }
};

const contextCapabilityState = {
  documentId: contextDocumentId,
  documentTitle: "",
  hasDocumentContext: false,
  capabilities: null,
  loadError: ""
};

init();

async function init() {
  const [settings] = await Promise.all([
    getSettings(),
    loadContextCapabilities()
  ]);
  renderSettings(settings);
}

async function loadContextCapabilities() {
  if (!contextDocumentId) {
    contextCapabilityState.hasDocumentContext = false;
    contextCapabilityState.capabilities = null;
    contextCapabilityState.loadError = "";
    return;
  }

  try {
    const [{ document, blocks }, highlights, threads, summaries] = await Promise.all([
      getDocumentWithBlocks(contextDocumentId),
      dbGetAllByIndex("highlights", "by_documentId", contextDocumentId),
      dbGetAllByIndex("threads", "by_documentId", contextDocumentId),
      dbGetAllByIndex("summaries", "by_documentId", contextDocumentId)
    ]);

    if (!document) {
      throw new Error(`No document record found for documentId=${contextDocumentId}.`);
    }

    const messagesByThread = await loadMessagesByThread(threads);
    contextCapabilityState.documentTitle = document.title || contextDocumentId;
    contextCapabilityState.hasDocumentContext = true;
    contextCapabilityState.loadError = "";
    contextCapabilityState.capabilities = analyzeContextCapabilities({
      documentRecord: document,
      blocks,
      highlights,
      threads,
      messagesByThread,
      summaries
    });
  } catch (error) {
    contextCapabilityState.hasDocumentContext = false;
    contextCapabilityState.capabilities = null;
    contextCapabilityState.loadError = error instanceof Error ? error.message : String(error);
  }
}

async function loadMessagesByThread(threads = []) {
  const entries = await Promise.all(
    (threads || [])
      .filter((thread) => thread?.id)
      .map(async (thread) => {
        const messages = await dbGetAllByIndex("messages", "by_threadId", thread.id);
        return [thread.id, messages || []];
      })
  );
  return Object.fromEntries(entries);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const validation = validateSettingsForm();
  if (!validation.ok) {
    showStatus(validation.message, "error");
    return;
  }

  const scrollPosition = getScrollPosition();
  const currentSettings = await getSettings();
  const currentAiSettings = removeLegacyAiBudgetSettings(currentSettings.ai);
  const aiContext = collectAiContextSettings(currentSettings.ai);
  const saved = await saveSettings({
    ai: {
      ...currentAiSettings,
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      model: model.value.trim(),
      demoMode: demoMode.checked,
      context: aiContext,
      systemPrompt: systemPrompt.value,
      selectionPrompt: selectionPrompt.value
    },
    reader: {
      ...currentSettings.reader,
      fontFamily: fontFamily.value,
      preferredFontSize: Number(fontSize.value),
      theme: getSelectedTheme()
    }
  });
  renderSettings(saved);
  applyTheme(saved.reader?.theme);
  applyReaderPreferences(saved.reader);
  restoreScrollPosition(scrollPosition);
  showStatus(`设置已保存：${formatTime(new Date())}`);
});

resetButton.addEventListener("click", async () => {
  const currentSettings = await getSettings();
  const defaultAiContext = applyActiveContextCapabilities(DEFAULT_SETTINGS.ai.context);
  const saved = await saveSettings({
    ...DEFAULT_SETTINGS,
    ai: {
      ...DEFAULT_SETTINGS.ai,
      context: defaultAiContext
    },
    reader: {
      ...DEFAULT_SETTINGS.reader,
      ...getReaderResetPreservedState(currentSettings.reader)
    }
  });
  renderSettings(saved);
  applyTheme(saved.reader?.theme);
  applyReaderPreferences(saved.reader);
  showStatus(`已恢复默认设置：${formatTime(new Date())}`);
});

for (const input of themeInputs) {
  input.addEventListener("change", () => {
    if (input.checked) {
      applyTheme(input.value);
    }
  });
}

fontSize.addEventListener("input", () => {
  fontSizeValue.textContent = `${fontSize.value}px`;
  applyReaderPreferences({
    fontFamily: fontFamily.value,
    preferredFontSize: Number(fontSize.value)
  });
});

fontFamily.addEventListener("change", () => {
  applyReaderPreferences({
    fontFamily: fontFamily.value,
    preferredFontSize: Number(fontSize.value)
  });
});

function renderSettings(settings) {
  const ai = resolveAiSettings(settings.ai);
  const aiContext = applyActiveContextCapabilities(ai.context);
  baseUrl.value = ai.baseUrl;
  apiKey.value = ai.apiKey;
  model.value = ai.model;
  demoMode.checked = Boolean(ai.demoMode);
  systemPrompt.value = ai.systemPrompt;
  selectionPrompt.value = ai.selectionPrompt;
  renderAiContextSettings(aiContext);
  renderContextAvailabilityPanel();
  applyContextCapabilityControlState();

  fontFamily.value = settings.reader?.fontFamily || DEFAULT_SETTINGS.reader.fontFamily;
  fontSize.value = String(settings.reader?.preferredFontSize || DEFAULT_SETTINGS.reader.preferredFontSize);
  fontSizeValue.textContent = `${fontSize.value}px`;

  const theme = settings.reader?.theme || DEFAULT_SETTINGS.reader.theme;
  for (const input of themeInputs) {
    input.checked = input.value === theme;
  }
  applyTheme(theme);
  applyReaderPreferences(settings.reader);
}

function renderAiContextSettings(context) {
  const selection = context.selection;
  const knowledge = context.knowledge;
  writeNumberInput(aiContextControls.selection.neighborBlockCount, selection.neighborBlockCount);
  aiContextControls.selection.includeDocumentOutline.checked = Boolean(selection.includeDocumentOutline);
  aiContextControls.selection.includeSelectedBlock.checked = Boolean(selection.includeSelectedBlock);
  setSelectValue(
    aiContextControls.selection.chapterTextScope,
    normalizeChapterTextScope(selection.chapterTextScope, selection.includeCurrentChapterBlocks),
    DEFAULT_SETTINGS.ai.context.selection.chapterTextScope
  );
  setSelectValue(
    aiContextControls.selection.qaHistoryScope,
    normalizeSelectionQaScope(selection.qaHistoryScope),
    DEFAULT_SETTINGS.ai.context.selection.qaHistoryScope
  );

  writeNumberInput(aiContextControls.knowledge.neighborBlockCount, knowledge.neighborBlockCount);
  aiContextControls.knowledge.includeDocumentOutline.checked = Boolean(knowledge.includeDocumentOutline);
  aiContextControls.knowledge.includeSelectedBlock.checked = Boolean(knowledge.includeSelectedBlock);
  aiContextControls.knowledge.includeThreadHistory.checked = Boolean(knowledge.includeThreadHistory);
  aiContextControls.knowledge.includeKnowledgeHighlights.checked = Boolean(knowledge.includeKnowledgeHighlights);
  setSelectValue(
    aiContextControls.knowledge.fullTextScope,
    normalizeKnowledgeFullTextScope(knowledge.fullTextScope, knowledge.includeFullText),
    DEFAULT_SETTINGS.ai.context.knowledge.fullTextScope
  );
}

function collectAiContextSettings(aiSettings = {}) {
  const existing = resolveAiSettings(aiSettings).context;
  const selectionNeighborBlockCount = readNumberInput(
    aiContextControls.selection.neighborBlockCount,
    existing.selection.neighborBlockCount,
    { integer: true, min: 0 }
  );
  const knowledgeNeighborBlockCount = readNumberInput(
    aiContextControls.knowledge.neighborBlockCount,
    existing.knowledge.neighborBlockCount,
    { integer: true, min: 0 }
  );
  const chapterTextScope = normalizeChapterTextScope(aiContextControls.selection.chapterTextScope.value);
  const fullTextScope = normalizeKnowledgeFullTextScope(aiContextControls.knowledge.fullTextScope.value);
  const context = {
    selection: {
      neighborBlockCount: selectionNeighborBlockCount,
      includeDocumentOutline: aiContextControls.selection.includeDocumentOutline.checked,
      includeChapterTitle: true,
      includeSelectedBlock: aiContextControls.selection.includeSelectedBlock.checked,
      includeAdjacentBlocks: selectionNeighborBlockCount > 0,
      includeCurrentChapterBlocks: chapterTextScope === "current-chapter",
      includeThreadHistory: true,
      chapterTextScope,
      sectionSummaryScope: "none",
      qaHistoryScope: normalizeSelectionQaScope(aiContextControls.selection.qaHistoryScope.value)
    },
    knowledge: {
      neighborBlockCount: knowledgeNeighborBlockCount,
      includeDocumentOutline: aiContextControls.knowledge.includeDocumentOutline.checked,
      includeChapterTitle: true,
      includeSelectedBlock: aiContextControls.knowledge.includeSelectedBlock.checked,
      includeAdjacentBlocks: knowledgeNeighborBlockCount > 0,
      includeCurrentChapterBlocks: false,
      includeThreadHistory: aiContextControls.knowledge.includeThreadHistory.checked,
      includeKnowledgeHighlights: aiContextControls.knowledge.includeKnowledgeHighlights.checked,
      includeFullText: fullTextScope === "full-text",
      fullTextScope,
      sectionSummaryScope: "none",
      qaHistoryScope: aiContextControls.knowledge.includeThreadHistory.checked ? "all-highlights" : "current-thread"
    }
  };
  return applyActiveContextCapabilities(context);
}

function applyActiveContextCapabilities(context) {
  return context;
}

function renderContextAvailabilityPanel() {
  if (!contextAvailabilityPanel) {
    return;
  }
  if (contextStatusLabel) {
    contextStatusLabel.textContent = "当前文档数据状态";
  }

  contextAvailabilityPanel.classList.toggle("is-global", !contextDocumentId);
  contextAvailabilityPanel.classList.toggle("is-error", Boolean(contextCapabilityState.loadError));

  if (!contextDocumentId) {
    contextAvailabilityPanel.textContent = "当前正在编辑全局默认 context 参数；只有从具体文档进入设置页时，这里才会显示该文档的数据量。所有 context 模块仍可配置。";
    return;
  }

  if (contextCapabilityState.loadError) {
    contextAvailabilityPanel.textContent = `无法读取当前文档数据状态：${contextCapabilityState.loadError}；下面模块仍可配置，生成 context 时会按已保存设置读取已有数据。`;
    return;
  }

  const capabilities = contextCapabilityState.capabilities;
  const counts = capabilities?.counts || {};
  contextAvailabilityPanel.textContent = [
    `当前文档：${contextCapabilityState.documentTitle || contextDocumentId}`,
    `正文 block：${counts.textBlocks || counts.blocks || 0}`,
    `目录项：${counts.outlineItems || 0}`,
    `已保存划线：${counts.highlights || 0}`,
    `问答线程：${counts.threads || 0}`,
    `问答消息：${counts.allThreadMessages || 0}`,
    "这里显示的是当前数据量，不是模块开关；所有 context 模块保持可选，生成时会按已保存设置读取已有数据。"
  ].join("；");
}

function applyContextCapabilityControlState() {
  const controls = [
    ...Object.values(aiContextControls.selection),
    ...Object.values(aiContextControls.knowledge)
  ].filter(Boolean);
  for (const control of controls) {
    clearContextControlUnavailableState(control);
  }
}

function clearContextControlUnavailableState(control) {
  control.disabled = false;
  control.removeAttribute("title");
  const card = control.closest(".context-card") || control.closest("label");
  if (!card) {
    return;
  }
  card.classList.remove("is-unavailable");
  card.setAttribute("aria-disabled", "false");
  card.querySelector("[data-context-unavailable-note]")?.remove();
}

function resolveAiSettings(aiSettings = {}) {
  const ai = deepMerge(DEFAULT_SETTINGS.ai, aiSettings);
  const context = resolveAiContextSettings(ai.context, aiSettings);
  return {
    ...ai,
    context
  };
}

function resolveAiContextSettings(contextSettings = {}, aiSettings = {}) {
  const context = isPlainObject(contextSettings) ? contextSettings : {};
  const selectionSource = isPlainObject(context.selection) ? context.selection : context;
  const knowledgeSource = isPlainObject(context.knowledge) ? context.knowledge : context;
  const selection = deepMerge(DEFAULT_SETTINGS.ai.context.selection, removeUndefinedValues({
    neighborBlockCount: selectionSource.neighborBlockCount,
    includeDocumentOutline: selectionSource.includeDocumentOutline,
    includeChapterTitle: selectionSource.includeChapterTitle,
    includeSelectedBlock: selectionSource.includeSelectedBlock,
    includeAdjacentBlocks: selectionSource.includeAdjacentBlocks,
    includeCurrentChapterBlocks: selectionSource.includeCurrentChapterBlocks,
    includeThreadHistory: selectionSource.includeThreadHistory,
    chapterTextScope: normalizeChapterTextScope(selectionSource.chapterTextScope, selectionSource.includeCurrentChapterBlocks),
    sectionSummaryScope: "none",
    qaHistoryScope: normalizeSelectionQaScope(selectionSource.qaHistoryScope)
  }));
  const knowledge = deepMerge(DEFAULT_SETTINGS.ai.context.knowledge, removeUndefinedValues({
    neighborBlockCount:
      knowledgeSource.neighborBlockCount ??
      context.knowledgeNeighborBlockCount ??
      context.neighborBlockCount,
    includeDocumentOutline: knowledgeSource.includeDocumentOutline ?? context.includeDocumentOutline,
    includeChapterTitle: knowledgeSource.includeChapterTitle ?? context.includeChapterTitle,
    includeSelectedBlock: knowledgeSource.includeSelectedBlock ?? context.includeSelectedBlock,
    includeAdjacentBlocks: knowledgeSource.includeAdjacentBlocks ?? context.includeAdjacentBlocks,
    includeCurrentChapterBlocks: knowledgeSource.includeCurrentChapterBlocks ?? context.includeCurrentChapterBlocks,
    includeThreadHistory: knowledgeSource.includeThreadHistory ?? context.includeThreadHistory,
    includeKnowledgeHighlights: knowledgeSource.includeKnowledgeHighlights ?? context.includeKnowledgeHighlights,
    includeFullText: knowledgeSource.includeFullText ?? context.includeFullText,
    fullTextScope: normalizeKnowledgeFullTextScope(
      knowledgeSource.fullTextScope ?? context.fullTextScope,
      knowledgeSource.includeFullText ?? context.includeFullText
    ),
    sectionSummaryScope: "none",
    qaHistoryScope: knowledgeSource.includeThreadHistory === false ? "current-thread" : "all-highlights"
  }));
  return {
    selection: normalizeSelectionContext(selection),
    knowledge: normalizeKnowledgeContext(knowledge)
  };
}

function removeLegacyAiBudgetSettings(aiSettings = {}) {
  const cleaned = { ...(aiSettings || {}) };
  delete cleaned.knowledgeSystemPrompt;
  const legacyTopLevelKeys = [
    "selectionContextCharBudget",
    "knowledgeContextCharBudget",
    "selectedBlockCharBudget",
    "adjacentBlockCharBudget",
    "historyCharBudget",
    "messageCharBudget",
    "maxHistoryMessages",
    "knowledgeItemCharBudget",
    "pdfProcessing",
    "pdfConfig",
    "pdfProcessor",
    "pdfPipeline",
    "pdfUseReaderAiDefaults",
    "pdfDefaultModel",
    "pdfDefaultTemperature",
    "pdfDefaultMaxConcurrent",
    "pdfStageModels",
    "pdfStageModel",
    "pdfStages",
    "pdfStageRoutes",
    "pdfStageRoutingPanel",
    "stageModels",
    "workflowConfig",
    "minerU",
    "mineru",
    "mineruConfig",
    "mineruEndpoint",
    "mineruModel",
    "ocr",
    "ocrConfig",
    "ocrEndpoint",
    "ocrModel",
    "localWorker",
    "localWorkerUrl",
    "worker",
    "workerUrl"
  ];
  for (const key of legacyTopLevelKeys) {
    delete cleaned[key];
  }
  return cleaned;
}

function normalizeSelectionContext(context) {
  const chapterTextScope = normalizeChapterTextScope(context.chapterTextScope, context.includeCurrentChapterBlocks);
  return {
    ...context,
    neighborBlockCount: Math.max(0, Number(context.neighborBlockCount) || 0),
    qaHistoryScope: normalizeSelectionQaScope(context.qaHistoryScope),
    includeChapterTitle: context.includeChapterTitle !== false,
    includeCurrentChapterBlocks: chapterTextScope === "current-chapter",
    chapterTextScope,
    sectionSummaryScope: "none",
    includeThreadHistory: context.includeThreadHistory !== false
  };
}

function normalizeKnowledgeContext(context) {
  const includeThreadHistory = Boolean(context.includeThreadHistory);
  const fullTextScope = normalizeKnowledgeFullTextScope(context.fullTextScope, context.includeFullText);
  return {
    ...context,
    neighborBlockCount: Math.max(0, Number(context.neighborBlockCount) || 0),
    sectionSummaryScope: "none",
    includeChapterTitle: context.includeChapterTitle !== false,
    includeCurrentChapterBlocks: false,
    includeFullText: fullTextScope === "full-text",
    fullTextScope,
    includeThreadHistory,
    qaHistoryScope: includeThreadHistory ? "all-highlights" : "current-thread"
  };
}

function normalizeChapterTextScope(value, includeCurrentChapterBlocks = false) {
  if (
    value === "current-section" ||
    value === "current-chapter" ||
    value === "previous-chapters" ||
    value === "full-text"
  ) {
    return value;
  }
  return includeCurrentChapterBlocks ? "current-chapter" : "none";
}

function normalizeSelectionQaScope(value) {
  return value === "all-highlights" ? "all-highlights" : "current-thread";
}

function normalizeKnowledgeFullTextScope(value, includeFullText = false) {
  if (value === "full-text" || value === "before-last-highlight") {
    return value;
  }
  return includeFullText ? "full-text" : "none";
}

function removeUndefinedValues(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function getSelectedTheme() {
  return themeInputs.find((input) => input.checked)?.value || DEFAULT_SETTINGS.reader.theme;
}

function getReaderResetPreservedState(reader = {}) {
  const persistentReaderState = { ...(reader || {}) };
  delete persistentReaderState.fontFamily;
  delete persistentReaderState.preferredFontSize;
  delete persistentReaderState.theme;

  return {
    ...persistentReaderState,
    lastDocumentId: reader?.lastDocumentId || "",
    documentFolders: Array.isArray(reader?.documentFolders) ? reader.documentFolders : []
  };
}

function readNumberInput(input, fallback, { allowNull = false, integer = false, min = null, max = null } = {}) {
  const rawValue = String(input.value || "").trim();
  if (!rawValue) {
    return allowNull ? null : fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return allowNull ? null : fallback;
  }
  const withMin = min === null ? parsed : Math.max(min, parsed);
  const bounded = max === null ? withMin : Math.min(max, withMin);
  return integer ? Math.floor(bounded) : bounded;
}

function writeNumberInput(input, value) {
  input.value = value === null || value === undefined ? "" : String(value);
}

function setSelectValue(select, value, fallback) {
  const normalizedValue = String(value || fallback || "");
  select.value = normalizedValue;
  if (select.value !== normalizedValue) {
    select.value = fallback;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateSettingsForm() {
  clearValidationState();
  const errors = [
    validateUrlInput(baseUrl, "基础 AI 接口地址", { required: true }),
    validateNumberInput(aiContextControls.selection.neighborBlockCount, "划线问答相邻段落数量", {
      min: 0,
      integer: true
    }),
    validateNumberInput(aiContextControls.knowledge.neighborBlockCount, "知识图谱相邻段落数量", {
      min: 0,
      integer: true
    }),
    validateNumberInput(fontSize, "正文字号", {
      min: 14,
      max: 24,
      integer: true
    })
  ].filter(Boolean);

  if (!errors.length) {
    return { ok: true, message: "" };
  }

  return {
    ok: false,
    message: `保存失败：${errors[0]}`
  };
}

function validateUrlInput(input, label, { required = false } = {}) {
  if (!input) {
    return "";
  }
  const value = input.value.trim();
  if (!value) {
    if (!required) {
      return "";
    }
    markInvalidInput(input);
    return `${label}不能为空。`;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      markInvalidInput(input);
      return `${label}必须以 http:// 或 https:// 开头。`;
    }
  } catch {
    markInvalidInput(input);
    return `${label}格式不正确，请填写完整地址，例如 https://api.example.com/v1。`;
  }
  return "";
}

function validateNumberInput(
  input,
  label,
  { min = null, max = null, integer = false, allowEmpty = false, ignoreDisabled = false } = {}
) {
  if (!input || (ignoreDisabled && input.disabled)) {
    return "";
  }
  const rawValue = String(input.value || "").trim();
  if (!rawValue) {
    if (allowEmpty) {
      return "";
    }
    markInvalidInput(input);
    return `${label}不能为空。`;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    markInvalidInput(input);
    return `${label}必须是数字。`;
  }
  if (integer && !Number.isInteger(parsed)) {
    markInvalidInput(input);
    return `${label}必须是整数。`;
  }
  if (min !== null && parsed < min) {
    markInvalidInput(input);
    return `${label}不能小于 ${min}。`;
  }
  if (max !== null && parsed > max) {
    markInvalidInput(input);
    return `${label}不能大于 ${max}。`;
  }
  return "";
}

function clearValidationState() {
  for (const input of form.querySelectorAll("[aria-invalid='true']")) {
    input.removeAttribute("aria-invalid");
  }
}

function markInvalidInput(input) {
  input.setAttribute("aria-invalid", "true");
}

form.addEventListener("input", (event) => {
  event.target?.removeAttribute?.("aria-invalid");
});

form.addEventListener("change", (event) => {
  event.target?.removeAttribute?.("aria-invalid");
});

function getScrollPosition() {
  return {
    x: window.scrollX,
    y: window.scrollY
  };
}

function restoreScrollPosition(position) {
  requestAnimationFrame(() => {
    window.scrollTo(position.x, position.y);
  });
}

function showStatus(message, tone = "normal") {
  status.textContent = message;
  status.classList.toggle("status-error", tone === "error");
  status.classList.remove("status-flash");
  void status.offsetWidth;
  status.classList.add("status-flash");
}

function formatTime(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}
