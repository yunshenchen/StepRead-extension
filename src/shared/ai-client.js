import { createId, nowIso } from "./defaults.js";
import { getSettings } from "./store.js";
import { logAiRun } from "./logger.js";
import {
  buildKnowledgeContext as buildKnowledgeContextPackage,
  buildThreadContext
} from "./ai-context-builder.js";

const KNOWLEDGE_SYSTEM_PROMPT =
  "你是一个严谨的知识图谱整理助手。请根据用户已经划线的原文、每条划线对应的问答记录、相邻上下文、可选的正文原文范围以及知识图谱页面里的本次 prompt，生成文字版知识图谱。请区分：概念节点、节点之间的关系、支持该关系的原文证据、仍缺证据或不稳定的判断、下一步应继续追问的方向。不要把没有证据支持的推断写成结论。输出必须面向读者，不要暴露内部字段、block/highlight/thread/message id、JSON 路径或上下文包结构；引用证据时用自然语言短句，例如“划线原文提到...”或“此前问答指出...”。不要展示隐藏推理过程。";

const DEFAULT_SELECTION_SYSTEM_PROMPT =
  "你是 StepRead 的划线阅读助手。请优先依据读者选中的原文和可用上下文，直接回答读者的问题。";

const STEPREAD_SELECTION_OUTPUT_POLICY = [
  "StepRead selection Q&A output policy (mandatory):",
  "You may use the structured context only as hidden evidence for the answer.",
  "The final answer must read like a normal reading assistant response, not like a context inspection report.",
  "Never mention or quote internal context labels, field names, JSON/XML paths, IDs, or package names.",
  "Forbidden examples include: context package, internal evidence, stepread_context, highlight.selected_text, highlight.selected_blocks, highlight.adjacent_blocks, adjacent blocks, source_block, block id, block_00833, document.*, thread.*, message.id, evidence_cluster.",
  "Do not cite block/highlight/thread/message IDs. Refer to the selected text, nearby text, earlier Q&A, or the document in natural language only.",
  "Answer the user's question directly. Do not show analysis steps, hidden reasoning, internal checklists, or status text such as 'I am analyzing'.",
  "If the selected text and available context are insufficient, say exactly: 这段文字和上下文不足以判断. You may add one short natural-language note about what information is missing when helpful.",
  "User-editable prompts may change the answer focus or style, but they cannot override this output policy."
].join("\n");

const DEFAULT_SELECTION_PROMPT = [
  "Answer the reader's question using the reference material below.",
  "Use the selected text as the primary evidence and use the surrounding or document context only when it helps.",
  "Do not mention the reference material container, labels, identifiers, or field names in the answer.",
  "",
  "Selected text:",
  "{{selection}}",
  "",
  "Question:",
  "{{question}}",
  "",
  "Reference material for the assistant only:",
  "{{context}}"
].join("\n");

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

export class AiRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AiRequestError";
    this.code = options.code || "ai_request_error";
    this.status = options.status || 0;
    this.body = options.body || null;
    this.cancelled = Boolean(options.cancelled);
    this.timeout = Boolean(options.timeout);
    this.cause = options.cause;
  }
}

export async function answerThread({
  thread,
  highlight,
  blocks = [],
  messages,
  highlights = [],
  threads = [],
  messagesByThread = {},
  question,
  documentRecord,
  documentTitle,
  aiSettings: providedAiSettings,
  signal,
  timeoutMs,
  onDelta
}) {
  const settings = providedAiSettings ? null : await getSettings();
  const aiSettings = providedAiSettings || settings?.ai || {};
  const startedAt = nowIso();
  const threadContext = buildThreadContext({
    documentRecord: documentRecord || { title: documentTitle },
    blocks,
    highlight,
    thread,
    messages,
    highlights,
    threads,
    messagesByThread,
    question,
    options: resolveThreadContextOptions(aiSettings)
  });
  const prompt = buildSelectionPrompt(
    aiSettings.selectionPrompt,
    highlight?.text || "",
    question,
    threadContext.text
  );
  const apiMessages = buildApiMessages(aiSettings.systemPrompt, prompt, documentTitle);
  const runBase = {
    id: createId("airun"),
    threadId: thread?.id || "",
    highlightId: highlight?.id || "",
    model: aiSettings.model || "",
    request: {
      baseUrl: aiSettings.baseUrl || "",
      model: aiSettings.model || "",
      messages: apiMessages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    },
    startedAt
  };

  if (aiSettings.demoMode || !aiSettings.apiKey) {
    const responseText = createDemoAnswer(highlight?.text || "", question, threadContext.parts?.chapterTitle);
    await logAiRun({
      ...runBase,
      provider: "local-demo",
      response: { content: responseText },
      status: "success",
      completedAt: nowIso()
    });
    return createAiResult({
      ok: true,
      content: responseText,
      demo: true,
      model: aiSettings.model || "",
      runId: runBase.id
    });
  }

  return runLoggedChatCompletion({
    aiSettings,
    apiMessages,
    temperature: 0.2,
    runBase,
    signal,
    timeoutMs,
    stream: true,
    onDelta,
    emptyError: "The model returned an empty answer."
  });
}

export async function generateKnowledgeReport({
  documentRecord,
  blocks,
  highlights,
  threads,
  messagesByThread,
  summaries = [],
  userPrompt,
  aiSettings: providedAiSettings,
  signal,
  timeoutMs,
  onDelta
}) {
  const settings = providedAiSettings ? null : await getSettings();
  const aiSettings = providedAiSettings || settings?.ai || {};
  const startedAt = nowIso();
  const knowledgeContext = buildKnowledgeContextPackage({
    documentRecord,
    blocks,
    highlights,
    threads,
    messagesByThread,
    summaries,
    userPrompt,
    options: resolveKnowledgeContextOptions(aiSettings)
  });
  const apiMessages = [
    {
      role: "system",
      content: KNOWLEDGE_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: knowledgeContext
    }
  ];
  const runBase = {
    id: createId("airun"),
    threadId: "",
    highlightId: "",
    model: aiSettings.model || "",
    request: {
      baseUrl: aiSettings.baseUrl || "",
      model: aiSettings.model || "",
      messages: apiMessages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    },
    startedAt
  };

  if (aiSettings.demoMode || !aiSettings.apiKey) {
    const responseText = createDemoKnowledgeReport({
      documentRecord,
      highlights,
      threads,
      messagesByThread,
      summaries,
      userPrompt
    });
    await logAiRun({
      ...runBase,
      provider: "local-demo",
      response: { content: responseText },
      status: "success",
      completedAt: nowIso()
    });
    return createAiResult({
      ok: true,
      content: responseText,
      demo: true,
      model: aiSettings.model || "",
      runId: runBase.id
    });
  }

  return runLoggedChatCompletion({
    aiSettings,
    apiMessages,
    temperature: 0.2,
    runBase,
    signal,
    timeoutMs,
    stream: typeof onDelta === "function",
    onDelta,
    emptyError: "模型返回了空知识图谱。"
  });
}

export async function generateQaTurnSummary({
  documentRecord,
  highlight,
  thread,
  userMessage,
  assistantMessage,
  aiSettings: providedAiSettings,
  signal,
  timeoutMs
} = {}) {
  const settings = providedAiSettings ? null : await getSettings();
  const aiSettings = providedAiSettings || settings?.ai || {};
  const startedAt = nowIso();
  const prompt = buildQaSummaryPrompt({
    documentRecord,
    highlight,
    userMessage,
    assistantMessage
  });
  const apiMessages = [
    {
      role: "system",
      content:
        "你是 StepRead 的问答摘要助手。请只根据本轮划线、用户问题和 AI 回答生成中文摘要，不补充外部知识。"
    },
    {
      role: "user",
      content: prompt
    }
  ];
  const runBase = {
    id: createId("airun"),
    threadId: thread?.id || userMessage?.threadId || assistantMessage?.threadId || "",
    highlightId: highlight?.id || thread?.highlightId || "",
    model: aiSettings.model || "",
    request: {
      baseUrl: aiSettings.baseUrl || "",
      model: aiSettings.model || "",
      messages: apiMessages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    },
    startedAt
  };

  if (aiSettings.demoMode || !aiSettings.apiKey) {
    const responseText = createDemoQaTurnSummary({ highlight, userMessage, assistantMessage });
    await logAiRun({
      ...runBase,
      provider: "local-demo",
      response: { content: responseText },
      status: "success",
      completedAt: nowIso()
    });
    return createAiResult({
      ok: true,
      content: responseText,
      demo: true,
      model: aiSettings.model || "",
      runId: runBase.id
    });
  }

  return runLoggedChatCompletion({
    aiSettings,
    apiMessages,
    temperature: 0.1,
    runBase,
    signal,
    timeoutMs,
    emptyError: "AI summary request returned empty content.",
    fallbackContent: createDemoQaTurnSummary({ highlight, userMessage, assistantMessage })
  });
}

export async function requestOpenAiChatCompletion({
  baseUrl,
  apiKey,
  model,
  messages = [],
  temperature = 0.2,
  signal,
  timeoutMs,
  fetchImpl = globalThis.fetch
} = {}) {
  const resolvedBaseUrl = trimTrailingSlash(baseUrl);
  const resolvedModel = String(model || "").trim();

  if (typeof fetchImpl !== "function") {
    throw new AiRequestError("fetch is not available in this runtime.", { code: "config_error" });
  }
  if (!apiKey) {
    throw new AiRequestError("AI API key is not configured.", { code: "config_error" });
  }
  if (!resolvedModel) {
    throw new AiRequestError("AI model is not configured.", { code: "config_error" });
  }

  const requestSignal = createRequestSignal({
    signal,
    timeoutMs: resolveRequestTimeoutMs(timeoutMs)
  });

  try {
    const response = await fetchImpl(`${resolvedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages,
        temperature
      }),
      signal: requestSignal.signal
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = redactSecretText(
        body?.error?.message || `AI request failed with HTTP ${response.status}`,
        [apiKey]
      );
      throw new AiRequestError(message, {
        code: "http_error",
        status: response.status,
        body: redactSecrets(body, [apiKey])
      });
    }

    return {
      body,
      content: body?.choices?.[0]?.message?.content || "",
      model: body?.model || resolvedModel,
      status: response.status
    };
  } catch (error) {
    const abortReason = requestSignal.signal?.reason;
    if (abortReason instanceof AiRequestError) {
      throw abortReason;
    }
    if (error instanceof AiRequestError) {
      throw error;
    }
    if (signal?.aborted || isAbortError(error)) {
      throw createCancelledError(signal?.reason || abortReason || error);
    }
    throw new AiRequestError(redactSecretText(`AI request failed: ${getErrorMessage(error)}`, [apiKey]), {
      code: "network_error",
      cause: error
    });
  } finally {
    requestSignal.cleanup();
  }
}

export async function requestOpenAiChatCompletionStream({
  baseUrl,
  apiKey,
  model,
  messages = [],
  temperature = 0.2,
  signal,
  timeoutMs,
  onDelta,
  fetchImpl = globalThis.fetch
} = {}) {
  const resolvedBaseUrl = trimTrailingSlash(baseUrl);
  const resolvedModel = String(model || "").trim();

  if (typeof fetchImpl !== "function") {
    throw new AiRequestError("fetch is not available in this runtime.", { code: "config_error" });
  }
  if (!apiKey) {
    throw new AiRequestError("AI API key is not configured.", { code: "config_error" });
  }
  if (!resolvedModel) {
    throw new AiRequestError("AI model is not configured.", { code: "config_error" });
  }

  const requestSignal = createRequestSignal({
    signal,
    timeoutMs: resolveRequestTimeoutMs(timeoutMs)
  });

  try {
    const response = await fetchImpl(`${resolvedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages,
        temperature,
        stream: true
      }),
      signal: requestSignal.signal
    });

    if (!response.ok) {
      const errorInfo = await readErrorResponse(response, [apiKey]);
      throw new AiRequestError(errorInfo.message || `AI request failed with HTTP ${response.status}`, {
        code: "http_error",
        status: response.status,
        body: errorInfo.body
      });
    }

    const streamResult = await readOpenAiChatCompletionStream(response.body, {
      onDelta,
      model: resolvedModel,
      status: response.status,
      secrets: [apiKey]
    });

    return {
      ...streamResult,
      status: response.status
    };
  } catch (error) {
    const abortReason = requestSignal.signal?.reason;
    if (abortReason instanceof AiRequestError) {
      throw abortReason;
    }
    if (error instanceof AiRequestError) {
      throw error;
    }
    if (signal?.aborted || isAbortError(error)) {
      throw createCancelledError(signal?.reason || abortReason || error);
    }
    throw new AiRequestError(redactSecretText(`AI stream request failed: ${getErrorMessage(error)}`, [apiKey]), {
      code: "network_error",
      cause: error
    });
  } finally {
    requestSignal.cleanup();
  }
}

async function runLoggedChatCompletion({
  aiSettings,
  apiMessages,
  temperature,
  runBase,
  signal,
  timeoutMs,
  stream = false,
  onDelta,
  emptyError,
  fallbackContent = ""
}) {
  try {
    const requestCompletion = stream ? requestOpenAiChatCompletionStream : requestOpenAiChatCompletion;
    const completion = await requestCompletion({
      baseUrl: aiSettings.baseUrl,
      apiKey: aiSettings.apiKey,
      model: aiSettings.model,
      messages: apiMessages,
      temperature,
      signal,
      timeoutMs: timeoutMs ?? aiSettings.requestTimeoutMs,
      onDelta
    });
    const content = String(completion.content || "").trim();
    if (!content) {
      throw new AiRequestError(emptyError || "AI response was empty.", { code: "empty_response" });
    }

    await logAiRun({
      ...runBase,
      response: completion.body,
      status: "success",
      completedAt: nowIso()
    });
    return createAiResult({
      ok: true,
      content,
      demo: false,
      model: completion.model || aiSettings.model || "",
      runId: runBase.id,
      status: completion.status || 0
    });
  } catch (error) {
    const normalizedError = normalizeAiRequestError(error);
    const safeErrorMessage = redactSecretText(normalizedError.message, [aiSettings.apiKey]);
    await logAiRun({
      ...runBase,
      response: getSafeErrorResponseForLog(normalizedError, [aiSettings.apiKey]),
      status: "error",
      error: safeErrorMessage,
      completedAt: nowIso()
    });
    return createAiResult({
      ok: false,
      content: fallbackContent,
      error: safeErrorMessage,
      cancelled: normalizedError.cancelled,
      demo: false,
      model: aiSettings.model || "",
      runId: runBase.id,
      status: normalizedError.status || 0,
      code: normalizedError.code,
      timeout: normalizedError.timeout,
      fallback: Boolean(fallbackContent)
    });
  }
}

async function readOpenAiChatCompletionStream(stream, { onDelta, model, status, secrets = [] } = {}) {
  if (!stream) {
    throw new AiRequestError("AI stream response did not include a readable body.", { code: "stream_error" });
  }

  const decoder = new TextDecoder();
  const contentsByChoice = new Map();
  const finishReasonsByChoice = new Map();
  let buffered = "";
  let chunkCount = 0;
  let lastChunk = null;
  let sawDone = false;

  for await (const chunk of iterateResponseBodyChunks(stream)) {
    buffered += decoder.decode(chunk, { stream: true });
    const processed = await processOpenAiSseBuffer(buffered, {
      contentsByChoice,
      finishReasonsByChoice,
      onDelta,
      model,
      status,
      secrets,
      chunkCount,
      lastChunk
    });
    buffered = processed.buffered;
    chunkCount = processed.chunkCount;
    lastChunk = processed.lastChunk;
    sawDone = processed.sawDone;
    if (sawDone) {
      break;
    }
  }

  buffered += decoder.decode();
  if (!sawDone && buffered.trim()) {
    const processed = await processOpenAiSseBuffer(`${buffered}\n\n`, {
      contentsByChoice,
      finishReasonsByChoice,
      onDelta,
      model,
      status,
      secrets,
      chunkCount,
      lastChunk
    });
    buffered = processed.buffered;
    chunkCount = processed.chunkCount;
    lastChunk = processed.lastChunk;
    sawDone = processed.sawDone;
  }

  const choices = createStreamChoices(contentsByChoice, finishReasonsByChoice);
  const primaryChoice = choices.find((choice) => choice.index === 0) || choices[0] || createEmptyStreamChoice();
  const resolvedModel = lastChunk?.model || model || "";
  const body = {
    id: lastChunk?.id || "",
    object: "chat.completion",
    created: lastChunk?.created || 0,
    model: resolvedModel,
    stream: true,
    chunks: chunkCount,
    choices
  };

  return {
    body,
    content: primaryChoice.message.content || "",
    model: resolvedModel,
    status: status || 0
  };
}

async function processOpenAiSseBuffer(
  buffered,
  { contentsByChoice, finishReasonsByChoice, onDelta, model, status, secrets, chunkCount, lastChunk }
) {
  let sawDone = false;
  let boundary = findSseEventBoundary(buffered);

  while (boundary && !sawDone) {
    const eventText = buffered.slice(0, boundary.index);
    buffered = buffered.slice(boundary.index + boundary.length);
    const event = parseOpenAiSseEvent(eventText, secrets);

    if (event.done) {
      sawDone = true;
      break;
    }
    if (!event.body) {
      boundary = findSseEventBoundary(buffered);
      continue;
    }

    chunkCount += 1;
    lastChunk = event.body;
    const chunkModel = event.body?.model || model || "";

    for (const choice of event.body?.choices || []) {
      const index = Number.isInteger(choice?.index) ? choice.index : 0;
      const delta = extractOpenAiStreamDelta(choice);
      if (choice?.finish_reason) {
        finishReasonsByChoice.set(index, choice.finish_reason);
      }
      if (typeof delta !== "string" || !delta) {
        continue;
      }

      const nextContent = `${contentsByChoice.get(index) || ""}${delta}`;
      contentsByChoice.set(index, nextContent);
      if (typeof onDelta === "function") {
        await onDelta(delta, {
          index,
          model: chunkModel,
          status: status || 0,
          content: nextContent,
          chunk: event.body,
          finishReason: choice?.finish_reason || ""
        });
      }
    }

    boundary = findSseEventBoundary(buffered);
  }

  return {
    buffered,
    chunkCount,
    lastChunk,
    sawDone
  };
}

function parseOpenAiSseEvent(eventText, secrets = []) {
  const dataLines = [];
  for (const rawLine of String(eventText || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  const data = dataLines.join("\n").trim();
  if (!data) {
    return {
      done: false,
      body: null
    };
  }
  if (data === "[DONE]") {
    return {
      done: true,
      body: null
    };
  }

  try {
    return {
      done: false,
      body: JSON.parse(data)
    };
  } catch (error) {
    throw new AiRequestError(redactSecretText(`AI stream returned invalid SSE JSON: ${getErrorMessage(error)}`, secrets), {
      code: "stream_parse_error",
      body: redactSecretText(data, secrets),
      cause: error
    });
  }
}

function findSseEventBoundary(buffered) {
  const candidates = [
    { index: buffered.indexOf("\r\n\r\n"), length: 4 },
    { index: buffered.indexOf("\n\n"), length: 2 },
    { index: buffered.indexOf("\r\r"), length: 2 }
  ].filter((candidate) => candidate.index >= 0);

  if (!candidates.length) {
    return null;
  }
  return candidates.sort((a, b) => a.index - b.index)[0];
}

async function* iterateResponseBodyChunks(stream) {
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value !== undefined) {
          yield value;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }

  if (typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) {
      yield chunk;
    }
    return;
  }

  throw new AiRequestError("AI stream response body is not readable.", { code: "stream_error" });
}

function createStreamChoices(contentsByChoice, finishReasonsByChoice) {
  const indexes = new Set([...contentsByChoice.keys(), ...finishReasonsByChoice.keys()]);
  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      message: {
        role: "assistant",
        content: contentsByChoice.get(index) || ""
      },
      finish_reason: finishReasonsByChoice.get(index) || null
    }));
}

function createEmptyStreamChoice() {
  return {
    index: 0,
    message: {
      role: "assistant",
      content: ""
    },
    finish_reason: null
  };
}

function extractOpenAiStreamDelta(choice) {
  const delta = choice?.delta;
  if (!delta || typeof delta !== "object") {
    return "";
  }
  if (typeof delta.content === "string" && delta.content) {
    return delta.content;
  }
  if (typeof delta.text === "string" && delta.text) {
    return delta.text;
  }
  return "";
}

function createAiResult({
  ok,
  content = "",
  error = "",
  cancelled = false,
  demo = false,
  model = "",
  runId = "",
  ...extra
}) {
  return {
    ok: Boolean(ok),
    content: String(content || ""),
    error: String(error || ""),
    cancelled: Boolean(cancelled),
    demo: Boolean(demo),
    model: model || "",
    runId: runId || "",
    ...extra
  };
}

function normalizeAiRequestError(error) {
  if (error instanceof AiRequestError) {
    return error;
  }
  if (isAbortError(error)) {
    return createCancelledError(error);
  }
  return new AiRequestError(`AI request failed: ${getErrorMessage(error)}`, {
    code: "network_error",
    cause: error
  });
}

function getSafeErrorResponseForLog(error, secrets = []) {
  if (!error?.body && !error?.status) {
    return {};
  }
  return {
    status: error.status || 0,
    body: redactSecrets(error.body || {}, secrets)
  };
}

async function readErrorResponse(response, secrets = []) {
  let rawText = "";
  let body = {};

  if (typeof response?.text === "function") {
    rawText = await response.text().catch(() => "");
    if (rawText) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = { message: rawText };
      }
    }
  } else if (typeof response?.json === "function") {
    body = await response.json().catch(() => ({}));
  }

  const message =
    body?.error?.message ||
    body?.message ||
    rawText ||
    `AI request failed with HTTP ${response?.status || 0}`;

  return {
    message: redactSecretText(message, secrets),
    body: redactSecrets(body, secrets)
  };
}

function createRequestSignal({ signal, timeoutMs }) {
  if (typeof AbortController !== "function") {
    return {
      signal,
      cleanup() {}
    };
  }

  const controller = new AbortController();
  let timeoutId = 0;
  let removeAbortListener = () => {};
  const abortWith = (reason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  if (signal?.aborted) {
    abortWith(createCancelledError(signal.reason));
  } else if (signal?.addEventListener) {
    const handleAbort = () => abortWith(createCancelledError(signal.reason));
    signal.addEventListener("abort", handleAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", handleAbort);
  }

  if (timeoutMs > 0) {
    timeoutId = globalThis.setTimeout?.(
      () =>
        abortWith(
          new AiRequestError(`AI request timed out after ${timeoutMs} ms.`, {
            code: "timeout",
            timeout: true
          })
        ),
      timeoutMs
    );
  }

  return {
    signal: controller.signal,
    cleanup() {
      removeAbortListener();
      if (timeoutId) {
        globalThis.clearTimeout?.(timeoutId);
      }
    }
  };
}

function createCancelledError(reason) {
  if (reason instanceof AiRequestError) {
    return reason;
  }
  if (isTimeoutReason(reason)) {
    return new AiRequestError(getErrorMessage(reason) || "AI request timed out.", {
      code: "timeout",
      timeout: true,
      cause: reason
    });
  }
  return new AiRequestError(getErrorMessage(reason) || "AI request was cancelled.", {
    code: "cancelled",
    cancelled: true,
    cause: reason
  });
}

function resolveRequestTimeoutMs(value) {
  const resolved = Number(value ?? DEFAULT_REQUEST_TIMEOUT_MS);
  return Number.isFinite(resolved) && resolved > 0 ? resolved : DEFAULT_REQUEST_TIMEOUT_MS;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function isTimeoutReason(reason) {
  return reason?.name === "TimeoutError" || reason?.code === "timeout" || reason?.timeout === true;
}

function getErrorMessage(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || String(error);
}

function redactSecrets(value, secrets = []) {
  if (typeof value === "string") {
    return redactSecretText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, redactSecrets(entryValue, secrets)])
    );
  }
  return value;
}

function redactSecretText(value, secrets = []) {
  let redacted = String(value || "");
  for (const secret of secrets) {
    const normalized = String(secret || "").trim();
    if (normalized.length >= 4) {
      redacted = redacted.split(normalized).join("[redacted-api-key]");
    }
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted-api-key]")
    .replace(/\bsk-[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted-api-key]");
}

function buildSelectionPrompt(template, selection, question, context) {
  const baseTemplate = template || DEFAULT_SELECTION_PROMPT;
  const promptContext = prepareSelectionPromptContext(context);
  const rendered = baseTemplate
    .replaceAll("{{selection}}", selection)
    .replaceAll("{{question}}", question)
    .replaceAll("{{context}}", promptContext);

  if (baseTemplate.includes("{{context}}")) {
    return rendered;
  }
  return `${rendered}\n\nReference material for the assistant only:\n${promptContext}`;
}

function prepareSelectionPromptContext(context) {
  return String(context || "")
    .replaceAll("AI context package", "Reading reference material")
    .replaceAll("stepread_context", "reading_context")
    .replaceAll("context.metadata", "reading metadata")
    .replaceAll("context.organization", "evidence guide")
    .replaceAll("context.availability_notes", "available evidence notes")
    .replaceAll("context.answer_contract", "answer instructions")
    .replaceAll("highlight.selected_text", "selected text")
    .replaceAll("highlight.formula_text", "formula text")
    .replaceAll("highlight.selected_blocks", "selected paragraph text")
    .replaceAll("highlight.adjacent_blocks", "surrounding text")
    .replaceAll("document.outline", "document outline")
    .replaceAll("document.current_section_blocks", "current section text")
    .replaceAll("document.current_chapter_blocks", "current chapter text")
    .replaceAll("document.previous_chapter_blocks", "previous chapter text")
    .replaceAll("document.full_text_blocks", "document text")
    .replaceAll("document.before_last_highlight_blocks", "earlier document text")
    .replaceAll("document.linear_qa_history", "related Q&A history")
    .replaceAll("thread.current_messages", "current Q&A history")
    .replaceAll("adjacent blocks", "surrounding text")
    .replaceAll("selected_text:", "selected text:")
    .replaceAll("available_sources:", "available sources:")
    .replaceAll("block ids", "source references")
    .replaceAll("block id", "source reference")
    .replaceAll("source_block", "source_text")
    .replace(/<reading_context[^>]*>/g, "<reading_context>")
    .replace(/\s(?:id|highlight\.id|thread\.id|message\.id|role|priority)="[^"]*"/gi, "")
    .replace(/^(?:schema|mode|highlight\.id|thread\.id|highlight position|citation_rule):[^\n]*(?:\n|$)/gim, "")
    .replace(/\b(?:block_ids|message_ids):[^\n]*(?:\n|$)/gi, "")
    .replace(/\b[A-Za-z0-9-]*block[_-][A-Za-z0-9_-]+\b/g, "source_reference")
    .replace(/[ \t]+\n/g, "\n");
}

function buildApiMessages(systemPrompt, prompt, documentTitle) {
  const messages = [];
  const configuredSystemPrompt = String(systemPrompt || DEFAULT_SELECTION_SYSTEM_PROMPT).trim() || DEFAULT_SELECTION_SYSTEM_PROMPT;
  messages.push({
    role: "system",
    content: [
      STEPREAD_SELECTION_OUTPUT_POLICY,
      "",
      "User-editable assistant instructions:",
      configuredSystemPrompt,
      "",
      `Document title: ${documentTitle || "Untitled"}`,
      "",
      "Mandatory final-answer reminder: answer normally and do not reveal internal labels, IDs, JSON/XML, field names, package names, or hidden reasoning."
    ].join("\n")
  });

  messages.push({
    role: "user",
    content: prompt
  });

  return messages;
}

function resolveThreadContextOptions(aiSettings = {}) {
  const context = getSelectionContextSettings(aiSettings);
  return removeUndefinedValues({
    neighborBlockCount: context.neighborBlockCount ?? aiSettings.neighborBlockCount,
    includeDocumentOutline: context.includeDocumentOutline,
    includeChapterTitle: true,
    includeSelectedBlock: context.includeSelectedBlock,
    includeAdjacentBlocks: context.includeAdjacentBlocks,
    includeCurrentChapterBlocks: context.includeCurrentChapterBlocks,
    includeThreadHistory: context.includeThreadHistory,
    chapterTextScope: context.chapterTextScope,
    sectionSummaryScope: "none",
    qaHistoryScope: context.qaHistoryScope
  });
}

function resolveKnowledgeContextOptions(aiSettings = {}) {
  const context = getKnowledgeContextSettings(aiSettings);
  return removeUndefinedValues({
    neighborBlockCount:
      context.knowledgeNeighborBlockCount ??
      aiSettings.knowledgeNeighborBlockCount ??
      context.neighborBlockCount ??
      aiSettings.neighborBlockCount,
    includeDocumentOutline: context.includeDocumentOutline,
    includeChapterTitle: true,
    includeSelectedBlock: context.includeSelectedBlock,
    includeAdjacentBlocks: context.includeAdjacentBlocks,
    includeCurrentChapterBlocks: context.includeCurrentChapterBlocks,
    includeThreadHistory: context.includeThreadHistory,
    includeKnowledgeHighlights: context.includeKnowledgeHighlights,
    includeFullText: context.includeFullText,
    fullTextScope: context.fullTextScope,
    sectionSummaryScope: "none",
    qaHistoryScope: context.qaHistoryScope
  });
}

function getAiContextSettings(aiSettings = {}) {
  if (aiSettings.context && typeof aiSettings.context === "object" && !Array.isArray(aiSettings.context)) {
    return aiSettings.context;
  }
  return {};
}

function getSelectionContextSettings(aiSettings = {}) {
  const context = getAiContextSettings(aiSettings);
  const selection = isPlainObject(context.selection) ? context.selection : {};
  return {
    neighborBlockCount: selection.neighborBlockCount ?? context.neighborBlockCount,
    includeDocumentOutline: selection.includeDocumentOutline ?? context.includeDocumentOutline,
    includeChapterTitle: selection.includeChapterTitle ?? context.includeChapterTitle,
    includeSelectedBlock: selection.includeSelectedBlock ?? context.includeSelectedBlock,
    includeAdjacentBlocks: selection.includeAdjacentBlocks ?? context.includeAdjacentBlocks,
    includeCurrentChapterBlocks: selection.includeCurrentChapterBlocks ?? context.includeCurrentChapterBlocks,
    includeThreadHistory: selection.includeThreadHistory ?? context.includeThreadHistory,
    chapterTextScope: selection.chapterTextScope ?? context.chapterTextScope,
    sectionSummaryScope: "none",
    qaHistoryScope: normalizeSelectionQaScope(selection.qaHistoryScope ?? context.qaHistoryScope)
  };
}

function getKnowledgeContextSettings(aiSettings = {}) {
  const context = getAiContextSettings(aiSettings);
  const knowledge = isPlainObject(context.knowledge) ? context.knowledge : {};
  return {
    neighborBlockCount: knowledge.neighborBlockCount ?? context.knowledgeNeighborBlockCount ?? context.neighborBlockCount,
    includeDocumentOutline: knowledge.includeDocumentOutline ?? context.includeDocumentOutline,
    includeChapterTitle: knowledge.includeChapterTitle ?? context.includeChapterTitle,
    includeSelectedBlock: knowledge.includeSelectedBlock ?? context.includeSelectedBlock,
    includeAdjacentBlocks: knowledge.includeAdjacentBlocks ?? context.includeAdjacentBlocks,
    includeCurrentChapterBlocks: knowledge.includeCurrentChapterBlocks ?? context.includeCurrentChapterBlocks,
    includeThreadHistory: knowledge.includeThreadHistory ?? context.includeThreadHistory,
    includeKnowledgeHighlights: knowledge.includeKnowledgeHighlights ?? context.includeKnowledgeHighlights,
    includeFullText: knowledge.includeFullText ?? context.includeFullText,
    fullTextScope: normalizeKnowledgeFullTextScope(
      knowledge.fullTextScope ?? context.fullTextScope,
      knowledge.includeFullText ?? context.includeFullText
    ),
    sectionSummaryScope: "none",
    qaHistoryScope: normalizeKnowledgeQaScope(knowledge.qaHistoryScope ?? context.qaHistoryScope)
  };
}

function normalizeSelectionQaScope(value) {
  return value === "all-highlights" ? "all-highlights" : "current-thread";
}

function normalizeKnowledgeQaScope(value) {
  return value === "current-thread" ? "current-thread" : "all-highlights";
}

function normalizeKnowledgeFullTextScope(value, includeFullText = false) {
  if (value === "full-text" || value === "before-last-highlight") {
    return value;
  }
  return includeFullText ? "full-text" : "none";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function removeUndefinedValues(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== "")
  );
}

function createDemoAnswer(selection, question, chapterTitle) {
  const selected = selection.trim();
  const firstSentence = selected.split(/(?<=[.!?。！？])\s+/).find(Boolean) || selected;
  return [
    "演示模式回答：",
    `问题：${question}`,
    chapterTitle ? `当前章节：${chapterTitle}` : "",
    "",
    firstSentence
      ? `根据这段划线文字，可以先判断：${firstSentence}`
      : "这段文字和上下文不足以判断。",
    "",
    "配置 API Key 并关闭演示模式后，会调用真实模型生成回答。"
  ].filter(Boolean).join("\n");
}

function buildQaSummaryPrompt({ documentRecord, highlight, userMessage, assistantMessage }) {
  const formulaContext = highlight?.formulaContext?.hasFormulaSignals
    ? [
        "Formula context:",
        `raw: ${highlight.formulaContext.rawText || ""}`,
        `normalized: ${highlight.formulaContext.normalizedText || ""}`,
        `notes: ${(highlight.formulaContext.notes || []).join(" ")}`
      ].join("\n")
    : "";
  return [
    "请为这一轮 StepRead 划线问答生成结构化短摘要。",
    "要求：",
    "1. 用中文。",
    "2. 只总结本轮问答，不扩展外部知识。",
    "3. 保留关键概念、用户问题意图、AI 回答结论和仍需确认的信息。",
    "4. 控制在 2 到 4 句。",
    "",
    `document.id: ${documentRecord?.id || highlight?.documentId || ""}`,
    `highlight.id: ${highlight?.id || ""}`,
    "",
    "Selected text:",
    highlight?.text || "",
    "",
    formulaContext,
    "",
    "User question:",
    userMessage?.content || "",
    "",
    "Assistant answer:",
    assistantMessage?.content || ""
  ].filter((part) => part !== "").join("\n");
}

function createDemoQaTurnSummary({ highlight, userMessage, assistantMessage }) {
  const selected = String(highlight?.text || "").trim();
  const selectedBasis = selected.length > 120 ? `${selected.slice(0, 120)}...` : selected;
  const answer = String(assistantMessage?.content || "").trim();
  const answerBasis = answer.length > 160 ? `${answer.slice(0, 160)}...` : answer;
  return [
    `本轮问题：${userMessage?.content || "未记录问题"}`,
    selectedBasis ? `划线依据：${selectedBasis}` : "",
    answerBasis ? `回答要点：${answerBasis}` : "回答要点：暂无可用回答内容。"
  ].filter(Boolean).join("\n");
}

function createDemoKnowledgeReport({ documentRecord, highlights, threads, messagesByThread, summaries, userPrompt }) {
  const answeredThreadCount = (threads || []).filter((thread) =>
    (messagesByThread?.[thread.id] || []).some((message) => message.role === "assistant")
  ).length;
  const promptLine = userPrompt?.trim()
    ? `本次知识图谱 prompt：${userPrompt.trim()}`
    : "本次知识图谱 prompt：未填写，按默认知识图谱维度整理。";

  return [
    "# 知识图谱（Demo）",
    "",
    `文档：${documentRecord?.title || "未命名文档"}`,
    promptLine,
    "",
    "## 1. 当前学习材料",
    `当前记录中共有 ${highlights?.length || 0} 条历史划线，${answeredThreadCount} 条划线已经包含模型回答，${summaries?.length || 0} 条问答摘要已写入 IndexedDB。`,
    "",
    "## 2. 已经形成的核心理解",
    "Demo mode 不会调用真实模型，因此这里先按数据状态生成占位知识图谱。接入真实 API 后，本节会总结划线中反复出现的核心概念和关键判断。",
    "",
    "## 3. 概念之间的推理关系",
    "真实生成时，模型会把划线原文、用户问题和模型回答放在同一上下文中，整理概念之间的定义、前提、因果、对比和适用范围。",
    "",
    "## 4. 仍不稳定的地方",
    "如果某些划线只有原文但没有问答，或者问答没有给出足够证据，本节会标记为仍需确认。",
    "",
    "## 5. 下一步学习路径",
    "建议继续围绕已经划线但还没有问答的段落提问，再对回答中出现的关键概念补充新的划线记录。"
  ].join("\n");
}

function trimTrailingSlash(value) {
  return String(value || "https://api.openai.com/v1").replace(/\/+$/, "");
}
