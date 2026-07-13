import { createId, nowIso } from "./defaults.js";

export function markdownToDocument(markdown, title = "Markdown Import") {
  const documentId = createId("doc");
  const createdAt = nowIso();
  const blocks = markdownToBlocks(markdown, documentId);
  return {
    document: {
      id: documentId,
      title,
      sourceUrl: "markdown://paste",
      kind: "markdown",
      createdAt,
      updatedAt: createdAt
    },
    blocks
  };
}

export function markdownToBlocks(markdown, documentId) {
  const blocks = [];
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let paragraph = [];
  let list = [];
  let listOrdered = false;
  let inCode = false;
  let codeLanguage = "";
  let codeLines = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push(makeBlock(documentId, blocks.length, "paragraph", {
        text: paragraph.join(" ").trim()
      }));
      paragraph = [];
    }
  };

  const flushList = () => {
    if (list.length) {
      blocks.push(makeBlock(documentId, blocks.length, "list", {
        ordered: listOrdered,
        items: list
      }));
      list = [];
      listOrdered = false;
    }
  };

  const flushCode = () => {
    blocks.push(makeBlock(documentId, blocks.length, "code", {
      language: codeLanguage,
      text: codeLines.join("\n")
    }));
    inCode = false;
    codeLanguage = "";
    codeLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        inCode = true;
        codeLanguage = trimmed.slice(3).trim();
      }
      continue;
    }

    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push(makeBlock(documentId, blocks.length, "heading", {
        level: headingMatch[1].length,
        text: headingMatch[2].trim()
      }));
      continue;
    }

    const unorderedMatch = /^[-*+]\s+(.+)$/.exec(trimmed);
    const orderedMatch = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (unorderedMatch || orderedMatch) {
      flushParagraph();
      const isOrdered = Boolean(orderedMatch);
      if (list.length && listOrdered !== isOrdered) {
        flushList();
      }
      listOrdered = isOrdered;
      list.push((unorderedMatch?.[1] || orderedMatch?.[1] || "").trim());
      continue;
    }

    if (isMarkdownTableStart(lines, rawLine)) {
      flushParagraph();
      flushList();
      const tableLines = collectTableLines(lines, lines.indexOf(rawLine));
      if (tableLines.length > 1) {
        blocks.push(makeBlock(documentId, blocks.length, "table_html", {
          table_html: markdownTableToHtml(tableLines)
        }));
        lines.splice(lines.indexOf(rawLine), tableLines.length, ...Array(tableLines.length).fill(""));
        continue;
      }
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      flushList();
      blocks.push(makeBlock(documentId, blocks.length, "quote", {
        text: trimmed.replace(/^>\s?/, "")
      }));
      continue;
    }

    paragraph.push(trimmed);
  }

  if (inCode) {
    flushCode();
  }
  flushParagraph();
  flushList();

  if (!blocks.length) {
    blocks.push(makeBlock(documentId, 0, "paragraph", { text: "Empty markdown import." }));
  }
  return blocks;
}

function makeBlock(documentId, order, type, fields) {
  return {
    id: createId("block"),
    documentId,
    order,
    type,
    ...fields
  };
}

function isMarkdownTableStart(lines, currentLine) {
  const index = lines.indexOf(currentLine);
  if (index < 0 || index + 1 >= lines.length) {
    return false;
  }
  return currentLine.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]);
}

function collectTableLines(lines, startIndex) {
  const tableLines = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !line.includes("|")) {
      break;
    }
    tableLines.push(line);
  }
  return tableLines;
}

function markdownTableToHtml(tableLines) {
  const header = splitTableRow(tableLines[0]);
  const rows = tableLines.slice(2).map(splitTableRow);
  const headHtml = header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");
  const rowHtml = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${headHtml}</tr></thead><tbody>${rowHtml}</tbody></table>`;
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
