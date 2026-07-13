export async function openOrFocusExtensionPage(path) {
  const targetUrl = chrome.runtime.getURL(path.replace(/^\/+/, ""));
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => normalizeUrl(tab.url) === normalizeUrl(targetUrl));

  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId && chrome.windows?.update) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return existing;
  }

  return chrome.tabs.create({ url: targetUrl });
}

function normalizeUrl(url) {
  return String(url || "").replace(/#.*$/, "");
}
