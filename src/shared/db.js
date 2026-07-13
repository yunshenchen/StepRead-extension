import { DB_NAME, DB_VERSION } from "./defaults.js";

const STORE_DEFINITIONS = {
  documents: [
    ["by_createdAt", "createdAt", { unique: false }],
    ["by_updatedAt", "updatedAt", { unique: false }]
  ],
  blocks: [
    ["by_documentId", "documentId", { unique: false }],
    ["by_document_order", ["documentId", "order"], { unique: false }]
  ],
  highlights: [
    ["by_documentId", "documentId", { unique: false }],
    ["by_blockId", "blockId", { unique: false }],
    ["by_threadId", "threadId", { unique: false }]
  ],
  threads: [
    ["by_documentId", "documentId", { unique: false }],
    ["by_highlightId", "highlightId", { unique: false }],
    ["by_updatedAt", "updatedAt", { unique: false }]
  ],
  messages: [
    ["by_threadId", "threadId", { unique: false }],
    ["by_createdAt", "createdAt", { unique: false }]
  ],
  summaries: [
    ["by_documentId", "documentId", { unique: false }],
    ["by_highlightId", "highlightId", { unique: false }],
    ["by_threadId", "threadId", { unique: false }],
    ["by_messageId", "messageId", { unique: false }],
    ["by_createdAt", "createdAt", { unique: false }]
  ],
  aiRuns: [
    ["by_threadId", "threadId", { unique: false }],
    ["by_createdAt", "createdAt", { unique: false }]
  ],
  taskLogs: [
    ["by_type", "type", { unique: false }],
    ["by_createdAt", "createdAt", { unique: false }]
  ],
  pendingPdfImports: [
    ["by_createdAt", "createdAt", { unique: false }]
  ]
};

let dbPromise;

export function openReaderDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      const rejectOpen = (error) => {
        dbPromise = null;
        reject(createDbOpenError(error));
      };

      request.onupgradeneeded = () => {
        const db = request.result;
        for (const [storeName, indexes] of Object.entries(STORE_DEFINITIONS)) {
          const store = db.objectStoreNames.contains(storeName)
            ? request.transaction.objectStore(storeName)
            : db.createObjectStore(storeName, { keyPath: "id" });

          for (const [indexName, keyPath, options] of indexes) {
            if (!store.indexNames.contains(indexName)) {
              store.createIndex(indexName, keyPath, options);
            }
          }
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => rejectOpen(request.error);
      request.onblocked = () => rejectOpen(new Error("IndexedDB upgrade blocked"));
    });
  }
  return dbPromise;
}

function createDbOpenError(error) {
  const originalMessage = error instanceof Error ? error.message : String(error || "");
  const message = [
    `Failed to open IndexedDB ${DB_NAME} at version ${DB_VERSION}.`,
    originalMessage
  ]
    .filter(Boolean)
    .join(" ");
  const wrapped = new Error(message);
  wrapped.name = error?.name || "IndexedDBOpenError";
  wrapped.cause = error;
  return wrapped;
}

export async function dbPut(storeName, value) {
  return runRequest(storeName, "readwrite", (store) => store.put(value));
}

export async function dbPutMany(storeName, values) {
  const db = await openReaderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const value of values) {
      store.put(value);
    }
    tx.oncomplete = () => resolve(values);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function dbGet(storeName, key) {
  return runRequest(storeName, "readonly", (store) => store.get(key));
}

export async function dbGetAll(storeName) {
  return runRequest(storeName, "readonly", (store) => store.getAll());
}

export async function dbGetAllByIndex(storeName, indexName, value) {
  return runRequest(storeName, "readonly", (store) => store.index(indexName).getAll(value));
}

export async function dbDelete(storeName, key) {
  return runRequest(storeName, "readwrite", (store) => store.delete(key));
}

export async function clearReaderRecords() {
  const db = await openReaderDb();
  const storeNames = Object.keys(STORE_DEFINITIONS).filter((storeName) =>
    db.objectStoreNames.contains(storeName)
  );

  if (!storeNames.length) {
    return {};
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, "readwrite");
    const summary = Object.fromEntries(storeNames.map((storeName) => [storeName, 0]));

    for (const storeName of storeNames) {
      const store = tx.objectStore(storeName);
      const countRequest = store.count();
      countRequest.onsuccess = () => {
        summary[storeName] = countRequest.result || 0;
        store.clear();
      };
      countRequest.onerror = () => tx.abort();
    }

    tx.oncomplete = () => resolve(summary);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function savePendingPdfImport(importRecord) {
  return dbPut("pendingPdfImports", importRecord);
}

export async function getPendingPdfImport(importId) {
  return dbGet("pendingPdfImports", importId);
}

export async function deletePendingPdfImport(importId) {
  return dbDelete("pendingPdfImports", importId);
}

export async function deleteDocumentReadingHistory(documentId) {
  const db = await openReaderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["highlights", "threads", "messages", "summaries", "aiRuns"], "readwrite");
    const highlightStore = tx.objectStore("highlights");
    const threadStore = tx.objectStore("threads");
    const messageStore = tx.objectStore("messages");
    const summaryStore = tx.objectStore("summaries");
    const aiRunStore = tx.objectStore("aiRuns");
    const summary = {
      documentId,
      highlights: 0,
      threads: 0,
      messages: 0,
      summaries: 0,
      aiRuns: 0
    };

    deleteKeysByIndex(highlightStore, "by_documentId", documentId, (count) => {
      summary.highlights = count;
    });

    const threadsRequest = threadStore.index("by_documentId").getAll(documentId);
    threadsRequest.onsuccess = () => {
      const threads = threadsRequest.result || [];
      summary.threads = threads.length;

      for (const thread of threads) {
        const threadId = thread?.id;
        if (!threadId) {
          continue;
        }

        deleteKeysByIndex(messageStore, "by_threadId", threadId, (count) => {
          summary.messages += count;
        });
        deleteKeysByIndex(summaryStore, "by_threadId", threadId, (count) => {
          summary.summaries += count;
        });
        deleteKeysByIndex(aiRunStore, "by_threadId", threadId, (count) => {
          summary.aiRuns += count;
        });
        threadStore.delete(threadId);
      }
    };
    threadsRequest.onerror = () => tx.abort();

    tx.oncomplete = () => resolve(summary);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteHighlightsCascade(highlightIds) {
  const uniqueHighlightIds = [...new Set((Array.isArray(highlightIds) ? highlightIds : []).filter(Boolean))];
  const summary = {
    highlights: 0,
    threads: 0,
    messages: 0,
    summaries: 0,
    aiRuns: 0,
    highlightIds: [],
    threadIds: []
  };

  if (!uniqueHighlightIds.length) {
    return summary;
  }

  const db = await openReaderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["highlights", "threads", "messages", "summaries", "aiRuns"], "readwrite");
    const highlightStore = tx.objectStore("highlights");
    const threadStore = tx.objectStore("threads");
    const messageStore = tx.objectStore("messages");
    const summaryStore = tx.objectStore("summaries");
    const aiRunStore = tx.objectStore("aiRuns");
    const deletedThreadIds = new Set();

    function deleteThreadCascade(thread) {
      const threadId = thread?.id;
      if (!threadId || deletedThreadIds.has(threadId)) {
        return;
      }

      deletedThreadIds.add(threadId);
      summary.threads += 1;
      summary.threadIds.push(threadId);
      deleteKeysByIndex(messageStore, "by_threadId", threadId, (count) => {
        summary.messages += count;
      });
      deleteKeysByIndex(summaryStore, "by_threadId", threadId, (count) => {
        summary.summaries += count;
      });
      deleteKeysByIndex(aiRunStore, "by_threadId", threadId, (count) => {
        summary.aiRuns += count;
      });
      threadStore.delete(threadId);
    }

    for (const highlightId of uniqueHighlightIds) {
      const highlightRequest = highlightStore.get(highlightId);
      highlightRequest.onsuccess = () => {
        const highlight = highlightRequest.result;
        if (!highlight) {
          return;
        }

        summary.highlights += 1;
        summary.highlightIds.push(highlightId);
        highlightStore.delete(highlightId);

        if (highlight.threadId) {
          const linkedThreadRequest = threadStore.get(highlight.threadId);
          linkedThreadRequest.onsuccess = () => deleteThreadCascade(linkedThreadRequest.result);
          linkedThreadRequest.onerror = () => tx.abort();
        }

        const highlightThreadsRequest = threadStore.index("by_highlightId").getAll(highlightId);
        highlightThreadsRequest.onsuccess = () => {
          for (const thread of highlightThreadsRequest.result || []) {
            deleteThreadCascade(thread);
          }
        };
        highlightThreadsRequest.onerror = () => tx.abort();
      };
      highlightRequest.onerror = () => tx.abort();
    }

    tx.oncomplete = () => resolve(summary);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteDocumentCascade(documentId) {
  const db = await openReaderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ["documents", "blocks", "highlights", "threads", "messages", "summaries", "aiRuns"],
      "readwrite"
    );
    const documentStore = tx.objectStore("documents");
    const blockStore = tx.objectStore("blocks");
    const highlightStore = tx.objectStore("highlights");
    const threadStore = tx.objectStore("threads");
    const messageStore = tx.objectStore("messages");
    const summaryStore = tx.objectStore("summaries");
    const aiRunStore = tx.objectStore("aiRuns");
    const summary = {
      documentId,
      deleted: false,
      blocks: 0,
      highlights: 0,
      threads: 0,
      messages: 0,
      summaries: 0,
      aiRuns: 0
    };

    const documentRequest = documentStore.get(documentId);
    documentRequest.onsuccess = () => {
      if (!documentRequest.result) {
        return;
      }

      summary.deleted = true;
      documentStore.delete(documentId);
      deleteKeysByIndex(blockStore, "by_documentId", documentId, (count) => {
        summary.blocks = count;
      });
      deleteKeysByIndex(highlightStore, "by_documentId", documentId, (count) => {
        summary.highlights = count;
      });
      deleteKeysByIndex(summaryStore, "by_documentId", documentId, (count) => {
        summary.summaries += count;
      });

      const threadsRequest = threadStore.index("by_documentId").getAll(documentId);
      threadsRequest.onsuccess = () => {
        const threads = threadsRequest.result || [];
        summary.threads = threads.length;

        for (const thread of threads) {
          const threadId = thread?.id;
          if (!threadId) {
            continue;
          }

          deleteKeysByIndex(messageStore, "by_threadId", threadId, (count) => {
            summary.messages += count;
          });
          deleteKeysByIndex(aiRunStore, "by_threadId", threadId, (count) => {
            summary.aiRuns += count;
          });
          threadStore.delete(threadId);
        }
      };
      threadsRequest.onerror = () => tx.abort();
    };
    documentRequest.onerror = () => tx.abort();

    tx.oncomplete = () => resolve(summary);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function replaceDocument(document, blocks) {
  const db = await openReaderDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["documents", "blocks"], "readwrite");
    const documentStore = tx.objectStore("documents");
    const blockStore = tx.objectStore("blocks");
    const blockIndex = blockStore.index("by_documentId");
    const existingRequest = blockIndex.getAllKeys(document.id);

    existingRequest.onsuccess = () => {
      for (const key of existingRequest.result) {
        blockStore.delete(key);
      }
      documentStore.put(document);
      for (const block of blocks) {
        blockStore.put(block);
      }
    };

    existingRequest.onerror = () => reject(existingRequest.error);
    tx.oncomplete = () => resolve({ document, blocks });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function deleteKeysByIndex(store, indexName, value, onCount) {
  const request = store.index(indexName).getAllKeys(value);
  request.onsuccess = () => {
    const keys = request.result || [];
    onCount?.(keys.length);
    for (const key of keys) {
      store.delete(key);
    }
  };
  request.onerror = () => store.transaction.abort();
}

export async function getDocumentWithBlocks(documentId) {
  const [document, blocks] = await Promise.all([
    dbGet("documents", documentId),
    dbGetAllByIndex("blocks", "by_documentId", documentId)
  ]);
  return {
    document,
    blocks: blocks.sort((a, b) => a.order - b.order)
  };
}

function runRequest(storeName, mode, makeRequest) {
  return openReaderDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = makeRequest(tx.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.onerror = () => reject(tx.error);
      })
  );
}
