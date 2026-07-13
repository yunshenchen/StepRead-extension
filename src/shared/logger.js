import { createId, nowIso } from "./defaults.js";
import { dbPut } from "./db.js";

export async function logTask(type, payload = {}, status = "info") {
  const entry = {
    id: createId("task"),
    type,
    status,
    payload,
    createdAt: nowIso()
  };
  await dbPut("taskLogs", entry);
  return entry;
}

export async function logAiRun(run) {
  const entry = {
    id: run.id || createId("airun"),
    threadId: run.threadId || "",
    highlightId: run.highlightId || "",
    provider: run.provider || "openai-compatible",
    model: run.model || "",
    request: run.request || {},
    response: run.response || {},
    status: run.status || "success",
    error: run.error || "",
    startedAt: run.startedAt || nowIso(),
    completedAt: run.completedAt || nowIso(),
    createdAt: nowIso()
  };
  await dbPut("aiRuns", entry);
  return entry;
}
