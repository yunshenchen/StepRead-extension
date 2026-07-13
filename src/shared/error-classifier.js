const DEFAULT_DOMAIN = "general";

export const ERROR_CODES = Object.freeze({
  NETWORK: "network",
  OFFLINE: "offline",
  TIMEOUT: "timeout",
  ABORT: "abort",
  AUTH: "auth",
  RATE_LIMIT: "rate_limit",
  QUOTA: "quota",
  FILE_TOO_LARGE: "file_too_large",
  PAGE_LIMIT: "page_limit",
  UNSUPPORTED_FILE: "unsupported_file",
  PARSE_FAILED: "parse_failed",
  RESULT_INCOMPLETE: "result_incomplete",
  CANCELLED: "cancelled",
  UNKNOWN: "unknown"
});

export const ERROR_SEVERITIES = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  ERROR: "error"
});

const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODES));

const DOMAIN_LABELS = Object.freeze({
  ai: "AI 请求",
  pdf: "PDF 处理",
  general: "当前操作"
});

const ERROR_COPY = Object.freeze({
  [ERROR_CODES.NETWORK]: {
    severity: ERROR_SEVERITIES.WARNING,
    retryable: true,
    title: "连接失败",
    message: "{domainLabel}没有成功连接到服务。",
    action: "请检查网络连接后重试；如果使用代理、VPN 或内网环境，请确认目标服务可以访问。"
  },
  [ERROR_CODES.OFFLINE]: {
    severity: ERROR_SEVERITIES.WARNING,
    retryable: true,
    title: "当前没有网络连接",
    message: "{domainLabel}需要联网才能继续，但浏览器当前处于离线或断网状态。",
    action: "请恢复网络连接后重试。"
  },
  [ERROR_CODES.TIMEOUT]: {
    severity: ERROR_SEVERITIES.WARNING,
    retryable: true,
    title: "请求超时",
    message: "{domainLabel}等待服务响应的时间过长。",
    action: "请稍后重试；如果文件较大或服务繁忙，可以减少输入内容后再试。"
  },
  [ERROR_CODES.ABORT]: {
    severity: ERROR_SEVERITIES.WARNING,
    retryable: true,
    title: "请求被中断",
    message: "{domainLabel}在完成前被浏览器或运行环境中断。",
    action: "请重新发起操作；如果反复出现，请检查页面是否被刷新、关闭或切换。"
  },
  [ERROR_CODES.AUTH]: {
    severity: ERROR_SEVERITIES.ERROR,
    retryable: false,
    title: "权限校验失败",
    message: "服务拒绝了这次{domainLabel}。",
    action: "请检查账号权限、API Key、Base URL、模型名称或相关服务授权后再试。"
  },
  [ERROR_CODES.RATE_LIMIT]: {
    severity: ERROR_SEVERITIES.WARNING,
    retryable: true,
    title: "请求过于频繁",
    message: "{domainLabel}触发了服务的频率限制。",
    action: "请等待一段时间后重试；如果多人共用同一额度，请减少并发请求。"
  },
  [ERROR_CODES.QUOTA]: {
    severity: ERROR_SEVERITIES.ERROR,
    retryable: false,
    title: "服务额度不足",
    message: "{domainLabel}无法继续，因为账号额度、余额或计费状态不足。",
    action: "请检查服务账户的配额、余额、账单状态或项目用量限制。"
  },
  [ERROR_CODES.FILE_TOO_LARGE]: {
    severity: ERROR_SEVERITIES.ERROR,
    retryable: false,
    title: "文件过大",
    message: "{domainLabel}无法处理这个文件，因为它超过了当前支持的大小限制。",
    action: "请换用更小的文件，或先压缩、拆分 PDF 后再导入。"
  },
  [ERROR_CODES.PAGE_LIMIT]: {
    severity: ERROR_SEVERITIES.ERROR,
    retryable: false,
    title: "页数超出限制",
    message: "{domainLabel}无法处理这个文件，因为页数超过了当前支持范围。",
    action: "请拆分 PDF，或只导入需要阅读的章节后再试。"
  },
  [ERROR_CODES.UNSUPPORTED_FILE]: {
    severity: ERROR_SEVERITIES.ERROR,
    retryable: false,
    title: "文件类型不支持",
    message: "{domainLabel}无法识别当前文件类型。",
    action: "请确认打开的是 PDF 文件，或换用 StepRead 当前支持的文件格式。"
  },
  [ERROR_CODES.PARSE_FAILED]: {
    severity: ERROR_SEVERITIES.ERROR,
    retryable: false,
    title: "内容解析失败",
    message: "{domainLabel}没有成功解析返回内容或文件内容。",
    action: "请确认文件没有损坏；如果是 AI 返回内容解析失败，请稍后重试。"
  },
  [ERROR_CODES.RESULT_INCOMPLETE]: {
    severity: ERROR_SEVERITIES.WARNING,
    retryable: true,
    title: "结果不完整",
    message: "{domainLabel}返回的内容不完整，可能被服务截断或缺少必要字段。",
    action: "请重试；如果内容很长，请缩短输入或分段处理。"
  },
  [ERROR_CODES.CANCELLED]: {
    severity: ERROR_SEVERITIES.INFO,
    retryable: false,
    title: "任务已取消",
    message: "{domainLabel}已停止，没有继续处理。",
    action: "如果需要继续，请重新发起任务。"
  },
  [ERROR_CODES.UNKNOWN]: {
    severity: ERROR_SEVERITIES.ERROR,
    retryable: false,
    title: "操作失败",
    message: "{domainLabel}遇到了暂时无法识别的问题。",
    action: "请重试；如果问题持续出现，请保留技术信息用于排查。"
  }
});

const DOMAIN_COPY = Object.freeze({
  ai: {
    [ERROR_CODES.NETWORK]: {
      title: "AI 服务连接失败",
      message: "StepRead 没有成功连接到 AI 服务。"
    },
    [ERROR_CODES.AUTH]: {
      title: "AI 授权失败",
      message: "AI 服务拒绝了这次请求，通常是 API Key 无效、权限不足或模型不可用。"
    },
    [ERROR_CODES.RATE_LIMIT]: {
      title: "AI 请求过于频繁",
      message: "AI 服务暂时限制了当前账号或项目的请求频率。"
    },
    [ERROR_CODES.QUOTA]: {
      title: "AI 额度不足",
      message: "AI 服务返回额度、余额或计费状态不足。"
    },
    [ERROR_CODES.RESULT_INCOMPLETE]: {
      title: "AI 返回不完整",
      message: "AI 返回内容被截断，或缺少 StepRead 需要的字段。"
    }
  },
  pdf: {
    [ERROR_CODES.FILE_TOO_LARGE]: {
      title: "PDF 文件过大",
      message: "这个 PDF 超过了当前处理流程支持的大小限制。"
    },
    [ERROR_CODES.PAGE_LIMIT]: {
      title: "PDF 页数过多",
      message: "这个 PDF 的页数超过了当前处理流程支持的范围。"
    },
    [ERROR_CODES.UNSUPPORTED_FILE]: {
      title: "当前文件不是可处理的 PDF",
      message: "StepRead 无法把当前页面识别为可处理的 PDF 文件。"
    },
    [ERROR_CODES.PARSE_FAILED]: {
      title: "PDF 解析失败",
      message: "StepRead 没有成功从这个 PDF 中解析出可阅读内容。"
    }
  }
});

const CODE_ALIASES = Object.freeze({
  abort_error: ERROR_CODES.ABORT,
  aborted: ERROR_CODES.ABORT,
  auth_error: ERROR_CODES.AUTH,
  authentication_error: ERROR_CODES.AUTH,
  billing_error: ERROR_CODES.QUOTA,
  canceled: ERROR_CODES.CANCELLED,
  cancelled: ERROR_CODES.CANCELLED,
  content_filter: ERROR_CODES.RESULT_INCOMPLETE,
  econnaborted: ERROR_CODES.TIMEOUT,
  err_internet_disconnected: ERROR_CODES.OFFLINE,
  err_network: ERROR_CODES.NETWORK,
  etimedout: ERROR_CODES.TIMEOUT,
  forbidden: ERROR_CODES.AUTH,
  incomplete: ERROR_CODES.RESULT_INCOMPLETE,
  insufficient_quota: ERROR_CODES.QUOTA,
  invalid_api_key: ERROR_CODES.AUTH,
  invalid_file: ERROR_CODES.UNSUPPORTED_FILE,
  invalid_file_type: ERROR_CODES.UNSUPPORTED_FILE,
  non_pdf: ERROR_CODES.UNSUPPORTED_FILE,
  parse_error: ERROR_CODES.PARSE_FAILED,
  parsing_failed: ERROR_CODES.PARSE_FAILED,
  payload_too_large: ERROR_CODES.FILE_TOO_LARGE,
  permission_denied: ERROR_CODES.AUTH,
  quota_exceeded: ERROR_CODES.QUOTA,
  rate_limit_exceeded: ERROR_CODES.RATE_LIMIT,
  request_timeout: ERROR_CODES.TIMEOUT,
  timeout_error: ERROR_CODES.TIMEOUT,
  too_large: ERROR_CODES.FILE_TOO_LARGE,
  too_many_pages: ERROR_CODES.PAGE_LIMIT,
  too_many_requests: ERROR_CODES.RATE_LIMIT,
  unauthorized: ERROR_CODES.AUTH,
  unsupported: ERROR_CODES.UNSUPPORTED_FILE,
  unsupported_file_type: ERROR_CODES.UNSUPPORTED_FILE
});

const MATCHERS = Object.freeze({
  auth: /\b(unauthorized|forbidden|invalid api key|api key|authentication|permission denied|401|403)\b|认证|鉴权|权限|密钥/i,
  cancelled: /\b(cancelled|canceled|user cancelled|user canceled)\b|用户取消|已取消|取消/i,
  fileTooLarge: /\b(file too large|payload too large|too large|size limit|413)\b|文件过大|体积过大|大小.{0,12}超过|超过.{0,12}大小/i,
  network: /\b(failed to fetch|networkerror|network error|fetch failed|err_network|enotfound|econnreset|econnrefused|dns)\b|连接失败|网络错误|无法连接/i,
  offline: /\b(offline|internet disconnected|err_internet_disconnected)\b|离线|断网|无网络|网络.{0,8}断/i,
  pageLimit: /\b(page limit|too many pages|pages exceeded|max pages|page count)\b|页数.{0,12}超过|超过.{0,12}页|页面数.{0,12}过多/i,
  parseFailed: /\b(parse failed|parsing failed|parse error|pdf parse|extract failed|extraction failed|unexpected token|invalid json|json parse)\b|解析失败|提取失败/i,
  quota: /\b(insufficient_quota|quota|billing|credit|balance)\b|配额|额度|余额|账单|欠费/i,
  rateLimit: /\b(rate limit|rate_limit|too many requests|429)\b|限流|频率|请求过多/i,
  resultIncomplete: /\b(incomplete|truncated|finish_reason.?length|content_filter|empty result|empty answer)\b|结果不完整|生成不完整|被截断|空结果/i,
  timeout: /\b(timeout|timed out|etimedout|request_timeout|408|504)\b|超时|请求超时/i,
  unsupportedFile: /\b(unsupported file|unsupported mime|unsupported.*pdf|not a pdf|non[-_ ]?pdf|invalid file type|415)\b|不支持.{0,12}文件|不是.{0,8}pdf|非\s*pdf/i
});

export function classifyStepReadError(error, options = {}) {
  const domain = normalizeDomain(options.domain || readObjectField(error, "domain"));
  const status = getHttpStatus(error, options);
  const body = getBody(error, options);
  const searchText = buildSearchText(error, options, body, status);
  const code = detectErrorCode(error, options, {
    body,
    domain,
    searchText,
    status
  });
  const copy = getCopyFor(domain, code);

  return {
    domain,
    code,
    severity: overrideOrDefault(options.severity, copy.severity),
    retryable: typeof options.retryable === "boolean" ? options.retryable : copy.retryable,
    title: renderCopy(copy.title, domain),
    message: renderCopy(copy.message, domain),
    action: renderCopy(copy.action, domain),
    technicalMessage: getTechnicalMessage(error, options, body, status)
  };
}

export function classifyPdfError(error, options = {}) {
  return classifyStepReadError(error, {
    ...options,
    domain: "pdf"
  });
}

export function classifyAiError(error, options = {}) {
  return classifyStepReadError(error, {
    ...options,
    domain: "ai"
  });
}

export function isKnownErrorCode(code) {
  return Boolean(normalizeErrorCode(code));
}

function detectErrorCode(error, options, context) {
  const explicitCode = normalizeErrorCode(
    options.code ||
      readObjectField(error, "code") ||
      readObjectField(error, "errorCode") ||
      readObjectField(context.body, "code") ||
      readObjectField(readObjectField(context.body, "error"), "code")
  );
  if (explicitCode) {
    return explicitCode;
  }

  if (isCancelledError(error, context.searchText)) {
    return ERROR_CODES.CANCELLED;
  }
  if (isAbortError(error, context.searchText)) {
    return ERROR_CODES.ABORT;
  }
  if (isOffline(options, context.searchText)) {
    return ERROR_CODES.OFFLINE;
  }
  if (isTimeoutStatus(context.status) || MATCHERS.timeout.test(context.searchText)) {
    return ERROR_CODES.TIMEOUT;
  }
  if (isIncompleteResult(error, options, context.body) || MATCHERS.resultIncomplete.test(context.searchText)) {
    return ERROR_CODES.RESULT_INCOMPLETE;
  }

  if (context.status === 401 || context.status === 403) {
    return ERROR_CODES.AUTH;
  }
  if (context.status === 408 || context.status === 504) {
    return ERROR_CODES.TIMEOUT;
  }
  if (context.status === 413) {
    return ERROR_CODES.FILE_TOO_LARGE;
  }
  if (context.status === 415) {
    return ERROR_CODES.UNSUPPORTED_FILE;
  }
  if (context.status === 429) {
    return MATCHERS.quota.test(context.searchText) ? ERROR_CODES.QUOTA : ERROR_CODES.RATE_LIMIT;
  }
  if (context.status >= 500 && context.status <= 599) {
    return ERROR_CODES.NETWORK;
  }

  if (isSyntaxError(error) || MATCHERS.parseFailed.test(context.searchText)) {
    return ERROR_CODES.PARSE_FAILED;
  }
  if (MATCHERS.auth.test(context.searchText)) {
    return ERROR_CODES.AUTH;
  }
  if (MATCHERS.quota.test(context.searchText)) {
    return ERROR_CODES.QUOTA;
  }
  if (MATCHERS.rateLimit.test(context.searchText)) {
    return ERROR_CODES.RATE_LIMIT;
  }
  if (MATCHERS.fileTooLarge.test(context.searchText)) {
    return ERROR_CODES.FILE_TOO_LARGE;
  }
  if (MATCHERS.pageLimit.test(context.searchText)) {
    return ERROR_CODES.PAGE_LIMIT;
  }
  if (MATCHERS.unsupportedFile.test(context.searchText)) {
    return ERROR_CODES.UNSUPPORTED_FILE;
  }
  if (isFetchTypeError(error) || MATCHERS.network.test(context.searchText)) {
    return ERROR_CODES.NETWORK;
  }

  return ERROR_CODES.UNKNOWN;
}

function normalizeErrorCode(value) {
  const rawCode = String(value || "").trim();
  if (!rawCode) {
    return "";
  }
  const normalizedCode = rawCode.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (KNOWN_ERROR_CODES.has(normalizedCode)) {
    return normalizedCode;
  }
  return CODE_ALIASES[normalizedCode] || "";
}

function normalizeDomain(value) {
  const domain = String(value || DEFAULT_DOMAIN).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return domain || DEFAULT_DOMAIN;
}

function getCopyFor(domain, code) {
  return {
    ...ERROR_COPY[code],
    ...(DOMAIN_COPY[domain]?.[code] || {})
  };
}

function renderCopy(value, domain) {
  return String(value || "").replaceAll("{domainLabel}", getDomainLabel(domain));
}

function getDomainLabel(domain) {
  return DOMAIN_LABELS[domain] || domain || DOMAIN_LABELS[DEFAULT_DOMAIN];
}

function overrideOrDefault(value, fallback) {
  return value || fallback;
}

function getHttpStatus(error, options) {
  const status =
    options.status ||
    options.statusCode ||
    options.httpStatus ||
    readObjectField(options.response, "status") ||
    readObjectField(error, "status") ||
    readObjectField(error, "statusCode") ||
    readObjectField(error, "httpStatus") ||
    readObjectField(readObjectField(error, "response"), "status") ||
    (typeof error === "number" ? error : "");

  const normalizedStatus = normalizeStatus(status);
  if (normalizedStatus) {
    return normalizedStatus;
  }

  return parseStatusFromText(buildSearchText(error, options, getBody(error, options), ""));
}

function normalizeStatus(value) {
  const status = Number.parseInt(String(value || ""), 10);
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    return status;
  }
  return 0;
}

function parseStatusFromText(value) {
  const match = String(value || "").match(/\b(?:http\s*)?(401|403|408|413|415|422|429|5\d{2})\b/i);
  return match ? normalizeStatus(match[1]) : 0;
}

function getBody(error, options) {
  return (
    options.body ||
    options.data ||
    readObjectField(error, "body") ||
    readObjectField(error, "data") ||
    readObjectField(readObjectField(error, "response"), "body") ||
    readObjectField(readObjectField(error, "response"), "data") ||
    null
  );
}

function buildSearchText(error, options, body, status) {
  return [
    status ? `HTTP ${status}` : "",
    options.code,
    options.reason,
    options.message,
    options.technicalMessage,
    stringifyErrorLike(error),
    stringifyBodyMessage(body)
  ]
    .filter(Boolean)
    .join(" ");
}

function stringifyErrorLike(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string" || typeof error === "number") {
    return String(error);
  }
  if (error instanceof Error) {
    return [
      error.name,
      error.message,
      readObjectField(error, "code"),
      readObjectField(error, "status"),
      readObjectField(error, "statusCode")
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (typeof error === "object") {
    const compactFields = [
      "name",
      "message",
      "error",
      "reason",
      "code",
      "status",
      "statusCode",
      "httpStatus",
      "type",
      "finish_reason",
      "finishReason"
    ];
    const fieldText = compactFields.map((field) => readObjectField(error, field)).filter(Boolean);
    const bodyMessage = stringifyBodyMessage(getBody(error, {}));
    const serialized = safeJsonSnippet(error);
    return [...fieldText, bodyMessage, serialized].filter(Boolean).join(" ");
  }
  return String(error);
}

function stringifyBodyMessage(body) {
  if (!body) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Error) {
    return `${body.name} ${body.message}`;
  }
  if (typeof body !== "object") {
    return String(body);
  }

  return [
    readObjectField(body, "message"),
    readObjectField(body, "detail"),
    readObjectField(body, "error_description"),
    readObjectField(readObjectField(body, "error"), "message"),
    readObjectField(readObjectField(body, "error"), "code"),
    Array.isArray(body.errors) ? body.errors.map(stringifyBodyMessage).join(" ") : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function getTechnicalMessage(error, options, body, status) {
  const technicalMessage =
    options.technicalMessage ||
    stringifyBodyMessage(body) ||
    stringifyErrorLike(error) ||
    options.message ||
    "";
  const prefixedMessage = status ? `HTTP ${status}${technicalMessage ? `: ${technicalMessage}` : ""}` : technicalMessage;
  return clipText(prefixedMessage.trim(), 1200);
}

function isCancelledError(error, searchText) {
  return normalizeErrorCode(readObjectField(error, "code")) === ERROR_CODES.CANCELLED || MATCHERS.cancelled.test(searchText);
}

function isAbortError(error, searchText) {
  return (
    readObjectField(error, "name") === "AbortError" ||
    normalizeErrorCode(readObjectField(error, "code")) === ERROR_CODES.ABORT ||
    /\b(abort|aborted|abort_error)\b|中断/i.test(searchText)
  );
}

function isOffline(options, searchText) {
  if (options.offline === true || options.isOnline === false) {
    return true;
  }
  if (typeof navigator !== "undefined" && navigator?.onLine === false) {
    return true;
  }
  return MATCHERS.offline.test(searchText);
}

function isTimeoutStatus(status) {
  return status === 408 || status === 504;
}

function isFetchTypeError(error) {
  return error instanceof TypeError && /\b(fetch|network|failed to fetch)\b/i.test(error.message || "");
}

function isSyntaxError(error) {
  return error instanceof SyntaxError || readObjectField(error, "name") === "SyntaxError";
}

function isIncompleteResult(error, options, body) {
  if (options.resultIncomplete === true || options.emptyResult === true) {
    return true;
  }

  const finishReason =
    options.finishReason ||
    options.finish_reason ||
    readObjectField(error, "finishReason") ||
    readObjectField(error, "finish_reason") ||
    readObjectField(body, "finishReason") ||
    readObjectField(body, "finish_reason");
  if (isIncompleteFinishReason(finishReason)) {
    return true;
  }

  const choices = readObjectField(body, "choices") || readObjectField(error, "choices");
  return Array.isArray(choices) && choices.some((choice) => isIncompleteFinishReason(readObjectField(choice, "finish_reason")));
}

function isIncompleteFinishReason(value) {
  return value === "length" || value === "content_filter";
}

function readObjectField(value, field) {
  if (!value || typeof value !== "object") {
    return "";
  }
  return value[field] ?? "";
}

function safeJsonSnippet(value) {
  try {
    return clipText(JSON.stringify(value), 600);
  } catch {
    return "";
  }
}

function clipText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}
