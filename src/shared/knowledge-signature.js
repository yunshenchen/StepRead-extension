export function createKnowledgeReportSignaturePayload({
  documentRecord,
  highlights = [],
  threads = [],
  messagesByThread = {},
  summaries = [],
  userPrompt = "",
  settings = {}
} = {}) {
  return {
    documentId: documentRecord?.id || "",
    updatedAt: documentRecord?.updatedAt || "",
    userPrompt: String(userPrompt || "").trim(),
    context: settings?.ai?.context || {},
    model: settings?.ai?.model || "",
    demoMode: Boolean(settings?.ai?.demoMode),
    highlights: (highlights || []).map((highlight) => ({
      id: highlight.id,
      blockId: highlight.blockId,
      endBlockId: highlight.endBlockId || "",
      blockRanges: Array.isArray(highlight.blockRanges) ? highlight.blockRanges : [],
      text: highlight.text,
      globalStartOffset: highlight.globalStartOffset ?? null,
      globalEndOffset: highlight.globalEndOffset ?? null,
      localStartOffset: highlight.localStartOffset ?? null,
      localEndOffset: highlight.localEndOffset ?? null,
      startOffset: highlight.startOffset ?? null,
      createdAt: highlight.createdAt,
      updatedAt: highlight.updatedAt
    })),
    threads: (threads || []).map((thread) => ({
      id: thread.id,
      highlightId: thread.highlightId,
      title: thread.title || "",
      createdAt: thread.createdAt || "",
      updatedAt: thread.updatedAt || "",
      messages: (messagesByThread[thread.id] || []).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        model: message.model || "",
        createdAt: message.createdAt
      }))
    })),
    summaries: (summaries || []).map((summary) => ({
      id: summary.id,
      highlightId: summary.highlightId,
      threadId: summary.threadId,
      messageId: summary.messageId,
      summaryType: summary.summaryType,
      text: summary.text,
      evidence: summary.evidence || {},
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt
    }))
  };
}

export async function createKnowledgeReportSignature(input = {}) {
  return sha256(JSON.stringify(createKnowledgeReportSignaturePayload(input)));
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
