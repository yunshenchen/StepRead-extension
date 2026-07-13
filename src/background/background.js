import { openOrFocusExtensionPage } from "../shared/navigation.js";
import { isLikelyPdfSourceUrl } from "../shared/paper-deepreport-adapter.js";
import { ensureDefaultSettings } from "../shared/store.js";

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaultSettings();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-reader") {
    return;
  }

  const tab = await getActiveTab();
  await openOrFocusExtensionPage(createReaderPathForTab(tab));
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function createReaderPathForTab(tab) {
  const sourceUrl = tab?.url || "";
  if (!isLikelyPdfSourceUrl(sourceUrl)) {
    return "src/reader/reader.html";
  }
  return `src/reader/reader.html?sourceUrl=${encodeURIComponent(sourceUrl)}`;
}
