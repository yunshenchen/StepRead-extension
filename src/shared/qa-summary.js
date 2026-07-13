import { createId, nowIso } from "./defaults.js";
import { dbPut } from "./db.js";
import { generateQaTurnSummary } from "./ai-client.js";
import { logTask } from "./logger.js";

export async function saveQaTurnSummary({
  documentId,
  highlight,
  thread,
  userMessage,
  assistantMessage,
  aiSettings
} = {}) {
  const createdAt = nowIso();
  const summary = {
    id: createId("summary"),
    documentId: documentId || highlight?.documentId || thread?.documentId || "",
    highlightId: highlight?.id || thread?.highlightId || "",
    threadId: thread?.id || userMessage?.threadId || assistantMessage?.threadId || "",
    messageId: assistantMessage?.id || "",
    summaryType: "qa-turn",
    text: "",
    evidence: {
      selectedText: highlight?.text || "",
      blockIds: getEvidenceBlockIds(highlight),
      messageIds: [userMessage?.id, assistantMessage?.id].filter(Boolean)
    },
    formulaContext: highlight?.formulaContext || null,
    createdAt,
    updatedAt: createdAt
  };

  const summaryResult = await generateQaTurnSummary({
    documentRecord: { id: summary.documentId },
    highlight,
    thread,
    userMessage,
    assistantMessage,
    aiSettings
  });

  if (!summaryResult.ok || !summaryResult.content.trim()) {
    await logTask(
      "summary.qa_turn.skipped",
      {
        documentId: summary.documentId,
        highlightId: summary.highlightId,
        threadId: summary.threadId,
        messageId: summary.messageId,
        runId: summaryResult.runId || "",
        model: summaryResult.model || "",
        error: summaryResult.error || "QA summary result was empty.",
        cancelled: Boolean(summaryResult.cancelled),
        timeout: Boolean(summaryResult.timeout),
        fallback: Boolean(summaryResult.fallback)
      },
      "warning"
    );
    return {
      ...summary,
      skipped: true,
      aiResult: summaryResult
    };
  }

  summary.text = summaryResult.content;
  summary.ai = {
    runId: summaryResult.runId || "",
    model: summaryResult.model || "",
    demo: Boolean(summaryResult.demo),
    fallback: Boolean(summaryResult.fallback)
  };

  await dbPut("summaries", summary);
  await logTask("summary.qa_turn.saved", {
    documentId: summary.documentId,
    highlightId: summary.highlightId,
    threadId: summary.threadId,
    messageId: summary.messageId,
    summaryId: summary.id,
    runId: summaryResult.runId || "",
    demo: Boolean(summaryResult.demo)
  });
  return summary;
}

function getEvidenceBlockIds(highlight) {
  const ids = new Set();
  if (highlight?.blockId) {
    ids.add(highlight.blockId);
  }
  for (const range of Array.isArray(highlight?.blockRanges) ? highlight.blockRanges : []) {
    if (range?.blockId) {
      ids.add(range.blockId);
    }
  }
  return [...ids];
}
