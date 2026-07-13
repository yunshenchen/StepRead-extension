import { openOrFocusExtensionPage } from "../shared/navigation.js";
import { createId, nowIso } from "../shared/defaults.js";
import { savePendingPdfImport } from "../shared/db.js";
import {
  getReadablePdfSourceInfo,
  isLikelyPdfSourceUrl
} from "../shared/paper-deepreport-adapter.js";

const PDF_REQUIRED_MESSAGE = "当前标签页不是可直接读取的 PDF；也可以点击“选择本地 PDF”导入。";

let activeTab = null;
let localImportInProgress = false;

const currentUrl = document.querySelector("#currentUrl");
const status = document.querySelector("#status");
const openReaderButton = document.querySelector("#openReaderButton");
const selectLocalPdfButton = document.querySelector("#selectLocalPdfButton");
const localPdfFileInput = document.querySelector("#localPdfFileInput");
const openOptionsButton = document.querySelector("#openOptionsButton");

init();

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab = tab || null;
    renderCurrentUrl(activeTab?.url || "");
  } catch (error) {
    currentUrl.textContent = "无法读取当前标签页 URL";
    openReaderButton.disabled = true;
    status.textContent = formatUserFacingError(error);
  }
}

openReaderButton.addEventListener("click", async () => {
  const sourceUrl = activeTab?.url || "";
  if (!isLikelyPdfSourceUrl(sourceUrl)) {
    status.textContent = PDF_REQUIRED_MESSAGE;
    return;
  }

  openReaderButton.disabled = true;
  status.textContent = "正在打开 StepRead 阅读器...";
  try {
    await openOrFocusExtensionPage(createReaderPath(sourceUrl));
    status.textContent = "已打开 StepRead 阅读器。";
    window.setTimeout(() => window.close(), 0);
  } catch (error) {
    status.textContent = `打开失败：${formatUserFacingError(error)}`;
  } finally {
    openReaderButton.disabled = false;
  }
});

selectLocalPdfButton.addEventListener("click", () => {
  if (!localPdfFileInput) {
    status.textContent = "当前浏览器不支持文件选择入口。";
    return;
  }
  localPdfFileInput.value = "";
  localPdfFileInput.click();
});

localPdfFileInput?.addEventListener("change", handleLocalPdfFileInputChange);

openOptionsButton.addEventListener("click", async () => {
  await openOrFocusExtensionPage("src/options/options.html");
});

async function handleLocalPdfFileInputChange(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = "";

  if (!file) {
    return;
  }

  if (!isPdfFileLike(file)) {
    status.textContent = "请选择 PDF 文件。";
    return;
  }

  setLocalImportBusy(true);
  status.textContent = "正在暂存本地 PDF...";

  try {
    const bytes = await file.arrayBuffer();
    const pendingImport = createPendingPdfImport(file, bytes);
    await savePendingPdfImport(pendingImport);
    status.textContent = "正在打开 StepRead 阅读器...";
    await openOrFocusExtensionPage(createPendingImportReaderPath(pendingImport.id));
    status.textContent = "已交给 StepRead 阅读器导入。";
    window.setTimeout(() => window.close(), 0);
  } catch (error) {
    status.textContent = `本地 PDF 暂存失败：${formatUserFacingError(error)}`;
  } finally {
    setLocalImportBusy(false);
  }
}

function renderCurrentUrl(url) {
  if (!url) {
    currentUrl.textContent = "当前标签页没有可读取 URL";
    currentUrl.title = "";
    openReaderButton.disabled = true;
    status.textContent = PDF_REQUIRED_MESSAGE;
    return;
  }

  if (!isLikelyPdfSourceUrl(url)) {
    currentUrl.textContent = url;
    currentUrl.title = url;
    openReaderButton.disabled = true;
    status.textContent = PDF_REQUIRED_MESSAGE;
    return;
  }

  const sourceInfo = getReadablePdfSourceInfo(url);
  currentUrl.textContent = sourceInfo.displayPath || sourceInfo.displaySource || url;
  currentUrl.title = sourceInfo.rawSourceUrl || url;
  openReaderButton.disabled = false;
  status.textContent = "当前 PDF 将在 StepRead 阅读器中打开。";
}

function createReaderPath(sourceUrl) {
  return `src/reader/reader.html?sourceUrl=${encodeURIComponent(sourceUrl)}`;
}

function createPendingImportReaderPath(pendingImportId) {
  return `src/reader/reader.html?pendingImportId=${encodeURIComponent(pendingImportId)}`;
}

function createPendingPdfImport(file, bytes) {
  const activeUrl = activeTab?.url || "";
  const fileName = String(file?.name || "local.pdf");
  return {
    id: createId("pending_pdf_import"),
    bytes,
    fileName,
    fileType: file?.type || "application/pdf",
    size: file?.size || bytes?.byteLength || 0,
    lastModified: file?.lastModified || 0,
    sourceUrl: isLikelyPdfSourceUrl(activeUrl) ? activeUrl : "",
    selectedFromUrl: activeUrl,
    selectedFromTitle: activeTab?.title || "",
    createdAt: nowIso()
  };
}

function isPdfFileLike(file) {
  const name = String(file?.name || "");
  const type = String(file?.type || "");
  return /\.pdf$/i.test(name) || /^application\/(?:x-)?pdf\b/i.test(type);
}

function setLocalImportBusy(isBusy) {
  localImportInProgress = Boolean(isBusy);
  if (selectLocalPdfButton) {
    selectLocalPdfButton.disabled = localImportInProgress;
  }
}

function formatUserFacingError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/requested version\s*\(\d+\)\s*is less than the existing version\s*\(\d+\)|VersionError/i.test(message)) {
    return "本地阅读数据库已经升级，但浏览器还在运行旧版 StepRead 后台。请在扩展管理页重新加载 StepRead 后再处理 PDF。";
  }
  return message || "未知错误";
}
