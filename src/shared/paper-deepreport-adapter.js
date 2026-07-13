export function normalizePdfSourceUrl(sourceUrl = "") {
  const rawSourceUrl = String(sourceUrl || "").trim();
  if (!rawSourceUrl) {
    return "";
  }

  try {
    const url = new URL(rawSourceUrl);
    url.hash = "";
    if (url.hostname) {
      url.hostname = url.hostname.toLowerCase();
    }
    return url.toString();
  } catch {
    return rawSourceUrl.replace(/#.*$/, "");
  }
}

export function createStablePdfDocumentId(sourceUrl = "") {
  const normalizedSourceUrl = normalizePdfSourceUrl(sourceUrl);
  const hash = hashStableString(normalizedSourceUrl || "unknown-pdf-source");
  const slug = createSourceSlug(normalizedSourceUrl);
  return `pdf_${hash}_${slug}`.slice(0, 96);
}

export function isLikelyPdfSourceUrl(sourceUrl = "") {
  const rawSourceUrl = String(sourceUrl || "").trim();
  if (!rawSourceUrl) {
    return false;
  }

  try {
    const url = new URL(rawSourceUrl);
    if (/\.pdf$/i.test(url.pathname)) {
      return true;
    }
    if (isKnownBrowserPdfViewerUrl(url)) {
      return true;
    }
  } catch {
    return /\.pdf(?:[?#]|$)/i.test(rawSourceUrl);
  }

  return false;
}

export function getReadablePdfSourceInfo(sourceUrl = "") {
  const rawSourceUrl = String(sourceUrl || "");
  const readableSourceUrl = getReadablePdfSourceUrl(rawSourceUrl);
  const normalizedSourceUrl = normalizePdfSourceUrl(readableSourceUrl);
  const sourceForDisplay = normalizedSourceUrl || readableSourceUrl;
  const fileName = getPdfSourceFileName(sourceForDisplay);
  const displayPath = getPdfDisplayPath(sourceForDisplay);
  const title = deriveReadablePdfTitle(sourceForDisplay, fileName);

  return {
    normalizedSourceUrl,
    title,
    fileName,
    displayPath,
    displaySource: getPdfDisplaySource(sourceForDisplay, displayPath),
    rawSourceUrl
  };
}

function hashStableString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createSourceSlug(sourceUrl) {
  const fallback = "source";
  if (!sourceUrl) {
    return fallback;
  }

  try {
    const url = new URL(sourceUrl);
    const lastPathSegment = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    return sanitizeSlug(lastPathSegment.replace(/\.pdf$/i, "")) || sanitizeSlug(url.hostname) || fallback;
  } catch {
    const lastPathSegment = String(sourceUrl).split(/[\\/]/).filter(Boolean).pop() || "";
    return sanitizeSlug(lastPathSegment.replace(/\.pdf(?:[?#].*)?$/i, "")) || fallback;
  }
}

function sanitizeSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
}

function isKnownBrowserPdfViewerUrl(url) {
  const embeddedSource = getEmbeddedPdfSourceFromUrl(url);
  if (!embeddedSource) {
    return false;
  }

  if (
    url.protocol === "chrome-extension:" &&
    url.hostname === "mhjfbmdgcfjbbpaeojofohoefgiehjai"
  ) {
    return true;
  }

  if (
    (url.protocol === "chrome:" || url.protocol === "edge:") &&
    (url.hostname === "pdf-viewer" || /pdf/i.test(url.pathname))
  ) {
    return true;
  }

  return false;
}

export function getPdfSourceFileName(sourceUrl) {
  const rawSourceUrl = getReadablePdfSourceUrl(sourceUrl);
  if (!rawSourceUrl) {
    return "";
  }

  if (isWindowsPathLike(rawSourceUrl)) {
    return getLastPathSegment(rawSourceUrl);
  }

  try {
    const url = new URL(rawSourceUrl);
    return getLastPathSegment(url.protocol === "file:" ? fileUrlToWindowsPath(url) : url.pathname);
  } catch {
    const pathWithoutHash = rawSourceUrl.replace(/#.*$/, "").replace(/[?#].*$/, "");
    return getLastPathSegment(pathWithoutHash);
  }
}

function getReadablePdfSourceUrl(sourceUrl) {
  const rawSourceUrl = String(sourceUrl || "").trim();
  if (!rawSourceUrl) {
    return "";
  }

  return getNestedPdfSourceUrl(rawSourceUrl) || rawSourceUrl;
}

function getNestedPdfSourceUrl(sourceUrl, seen = new Set()) {
  const rawSourceUrl = String(sourceUrl || "").trim();
  if (!rawSourceUrl || seen.has(rawSourceUrl) || seen.size >= 8) {
    return "";
  }
  seen.add(rawSourceUrl);

  try {
    const url = new URL(rawSourceUrl);
    const embeddedSource = getEmbeddedPdfSourceFromUrl(url);
    if (!embeddedSource) {
      return "";
    }
    return getNestedPdfSourceUrl(embeddedSource, seen) || embeddedSource;
  } catch {
    return "";
  }
}

function getEmbeddedPdfSourceFromUrl(url) {
  for (const paramName of ["src", "file"]) {
    const embeddedSource = normalizeEmbeddedPdfSourceParam(url.searchParams.get(paramName));
    if (embeddedSource) {
      return embeddedSource;
    }
  }
  return "";
}

function normalizeEmbeddedPdfSourceParam(value) {
  let candidate = String(value || "").trim();
  for (let pass = 0; pass < 3; pass += 1) {
    if (isPdfSourceReference(candidate)) {
      return candidate;
    }
    const decoded = safeDecodeURIComponent(candidate).trim();
    if (!decoded || decoded === candidate) {
      break;
    }
    candidate = decoded;
  }
  return isPdfSourceReference(candidate) ? candidate : "";
}

function isPdfSourceReference(value) {
  return /\.pdf(?:[?#]|$)/i.test(String(value || ""));
}

function getPdfDisplayPath(sourceUrl) {
  const rawSourceUrl = String(sourceUrl || "").trim();
  if (!rawSourceUrl) {
    return "";
  }

  if (isWindowsPathLike(rawSourceUrl)) {
    return safeDecodeURIComponent(rawSourceUrl.replace(/#.*$/, "").replace(/[?#].*$/, ""));
  }

  try {
    const url = new URL(rawSourceUrl);
    if (url.protocol === "file:") {
      return fileUrlToWindowsPath(url);
    }
    return safeDecodeURIComponent(url.pathname);
  } catch {
    return safeDecodeURIComponent(rawSourceUrl.replace(/#.*$/, "").replace(/[?#].*$/, ""));
  }
}

function getPdfDisplaySource(sourceUrl, displayPath) {
  const rawSourceUrl = String(sourceUrl || "").trim();
  if (!rawSourceUrl) {
    return "";
  }
  if (displayPath && (isWindowsPathLike(rawSourceUrl) || isFileUrl(rawSourceUrl))) {
    return displayPath;
  }
  return normalizePdfSourceUrl(rawSourceUrl) || displayPath || rawSourceUrl;
}

function deriveReadablePdfTitle(sourceUrl, fileName) {
  const title = String(fileName || "").replace(/\.pdf$/i, "").trim();
  return title || derivePdfTitle(sourceUrl);
}

function isFileUrl(sourceUrl) {
  try {
    return new URL(sourceUrl).protocol === "file:";
  } catch {
    return false;
  }
}

function isWindowsPathLike(value) {
  return /^[a-z]:[\\/]/i.test(String(value || "")) || /^\\\\[^\\]+\\[^\\]+/.test(String(value || ""));
}

function fileUrlToWindowsPath(url) {
  const decodedPath = safeDecodeURIComponent(url.pathname);
  if (url.hostname) {
    const host = safeDecodeURIComponent(url.hostname);
    const sharePath = decodedPath.replace(/\//g, "\\");
    return `\\\\${host}${sharePath.startsWith("\\") ? sharePath : `\\${sharePath}`}`;
  }
  return decodedPath.replace(/^\/([a-z]:[\\/])/i, "$1").replace(/\//g, "\\");
}

function getLastPathSegment(value) {
  const pathWithoutQuery = String(value || "").replace(/#.*$/, "").replace(/[?#].*$/, "");
  const lastPathSegment = pathWithoutQuery.split(/[\\/]/).filter(Boolean).pop() || "";
  return safeDecodeURIComponent(lastPathSegment);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function derivePdfTitle(sourceUrl) {
  if (!sourceUrl) {
    return "StepRead PDF Demo Document";
  }

  try {
    const url = new URL(sourceUrl);
    const lastPathSegment = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    const fileName = lastPathSegment.replace(/\.pdf$/i, "").trim();
    return fileName || url.hostname || "StepRead PDF Demo Document";
  } catch {
    const fallback = String(sourceUrl).split(/[\\/]/).filter(Boolean).pop() || sourceUrl;
    return fallback.replace(/\.pdf(?:[?#].*)?$/i, "").trim() || "StepRead PDF Demo Document";
  }
}
