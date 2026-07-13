import { DEFAULT_SETTINGS, STORAGE_KEYS, deepMerge } from "./defaults.js";

export async function getSettings() {
  const result = await storageGet(STORAGE_KEYS.settings);
  return deepMerge(DEFAULT_SETTINGS, stripDeprecatedSettings(result[STORAGE_KEYS.settings]));
}

export async function saveSettings(settings) {
  const merged = deepMerge(DEFAULT_SETTINGS, stripDeprecatedSettings(settings));
  await storageSet({ [STORAGE_KEYS.settings]: merged });
  return merged;
}

export async function ensureDefaultSettings() {
  const result = await storageGet(STORAGE_KEYS.settings);
  if (!result[STORAGE_KEYS.settings]) {
    await storageSet({ [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
    return DEFAULT_SETTINGS;
  }
  const merged = deepMerge(DEFAULT_SETTINGS, stripDeprecatedSettings(result[STORAGE_KEYS.settings]));
  await storageSet({ [STORAGE_KEYS.settings]: merged });
  return merged;
}

async function storageGet(key) {
  const localStorageApi = getChromeLocalStorage();
  if (localStorageApi) {
    return localStorageApi.get(key);
  }

  return {
    [key]: readFallbackStorage(key)
  };
}

async function storageSet(values) {
  const localStorageApi = getChromeLocalStorage();
  if (localStorageApi) {
    return localStorageApi.set(values);
  }

  for (const [key, value] of Object.entries(values || {})) {
    writeFallbackStorage(key, value);
  }
}

function getChromeLocalStorage() {
  return globalThis.chrome?.storage?.local || null;
}

function readFallbackStorage(key) {
  try {
    const raw = globalThis.localStorage?.getItem(getFallbackStorageKey(key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeFallbackStorage(key, value) {
  try {
    globalThis.localStorage?.setItem(getFallbackStorageKey(key), JSON.stringify(value));
  } catch {
    // Non-extension local previews can ignore persistence failures.
  }
}

function getFallbackStorageKey(key) {
  return `stepread:${key}`;
}

function stripDeprecatedSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return settings;
  }
  const cleaned = { ...settings };
  delete cleaned.pdfProcessing;
  stripDeprecatedPdfWorkerSettings(cleaned);
  if (cleaned.ai && typeof cleaned.ai === "object" && !Array.isArray(cleaned.ai)) {
    cleaned.ai = stripDeprecatedPdfWorkerSettings({ ...cleaned.ai });
    if (cleaned.ai.context && typeof cleaned.ai.context === "object" && !Array.isArray(cleaned.ai.context)) {
      cleaned.ai.context = stripDeprecatedPdfWorkerSettings({ ...cleaned.ai.context });
    }
  }
  if (cleaned.reader && typeof cleaned.reader === "object" && !Array.isArray(cleaned.reader)) {
    cleaned.reader = stripDeprecatedPdfWorkerSettings({ ...cleaned.reader });
  }
  return cleaned;
}

function stripDeprecatedPdfWorkerSettings(settings) {
  const deprecatedKeys = [
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
  for (const key of deprecatedKeys) {
    delete settings[key];
  }
  return settings;
}
