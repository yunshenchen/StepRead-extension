import { STORAGE_KEYS } from "./defaults.js";
import { getSettings } from "./store.js";

export const THEMES = new Set(["light", "dark"]);
const FONT_FAMILIES = {
  system: 'Inter, "Segoe UI", system-ui, sans-serif',
  yahei: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  serif: '"Noto Serif SC", "Songti SC", SimSun, serif',
  kaiti: 'KaiTi, "STKaiti", serif',
  mono: '"Cascadia Code", Consolas, monospace'
};

export function applyTheme(theme) {
  const nextTheme = THEMES.has(theme) ? theme : "light";
  document.documentElement.dataset.theme = nextTheme;
  return nextTheme;
}

export function applyReaderPreferences(reader = {}) {
  const fontSize = clamp(Number(reader.preferredFontSize) || 17, 14, 24);
  const appFontScale = Number((fontSize / 17).toFixed(4));
  const fontFamily = FONT_FAMILIES[reader.fontFamily] || FONT_FAMILIES.system;
  const letterSpacing = fontSize >= 20 ? "0.01em" : "0";
  document.documentElement.style.setProperty("--app-font-scale", `${appFontScale}`);
  document.documentElement.style.setProperty("--reader-font-size", `${fontSize}px`);
  document.documentElement.style.setProperty("--reader-font-family", fontFamily);
  document.documentElement.style.setProperty("--reader-letter-spacing", letterSpacing);
}

export async function applyStoredTheme() {
  try {
    const settings = await getSettings();
    applyReaderPreferences(settings.reader);
    return applyTheme(settings.reader?.theme);
  } catch (error) {
    console.warn("Failed to apply stored theme.", error);
    return applyTheme("light");
  }
}

if (globalThis.chrome?.storage?.onChanged) {
  globalThis.chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    const nextReader = changes[STORAGE_KEYS.settings]?.newValue?.reader;
    if (nextReader) {
      applyTheme(nextReader.theme);
      applyReaderPreferences(nextReader);
    }
  });
}

applyStoredTheme();

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
