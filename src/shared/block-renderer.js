const ALLOWED_TABLE_TAGS = new Set([
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "TH",
  "TD",
  "CAPTION",
  "COLGROUP",
  "COL"
]);

const ALLOWED_TABLE_ATTRIBUTES = new Set(["colspan", "rowspan", "scope", "align"]);

export function renderBlocks(container, blocks, options = {}) {
  container.replaceChildren();
  const highlightsByBlock = groupHighlights(options.highlights || []);

  for (const block of blocks) {
    container.append(renderBlock(block, {
      highlights: highlightsByBlock.get(block.id) || []
    }));
  }
}

export function renderBlock(block, options = {}) {
  const article = document.createElement("article");
  article.className = `reader-block reader-block-${block.type || "paragraph"}`;
  article.dataset.blockId = block.id;
  article.dataset.blockType = block.type || "paragraph";

  switch (block.type) {
    case "heading":
      article.append(renderHeading(block, options.highlights));
      break;
    case "quote":
      article.append(renderTextElement("blockquote", block.text || "", options.highlights));
      break;
    case "formula":
      article.append(renderFormula(block, options.highlights));
      break;
    case "annotation":
      article.append(renderAnnotation(block, options.highlights));
      break;
    case "list":
      article.append(renderList(block, options.highlights));
      break;
    case "code":
      article.append(renderCode(block, options.highlights));
      break;
    case "table_html":
      article.append(renderTable(block, options.highlights));
      break;
    case "image":
      article.append(renderImage(block, options.highlights));
      break;
    default:
      article.append(renderTextElement("p", block.text || block.content || "", options.highlights));
      break;
  }

  return article;
}

export function sanitizeImageSrc(src) {
  const value = String(src || "").trim();
  if (!value) {
    return "";
  }
  if (/^(https?:|data:image\/|blob:)/i.test(value)) {
    return value;
  }
  if (value.startsWith("images/")) {
    return value;
  }
  return "";
}

export function sanitizeTableFragment(tableHtml) {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(String(tableHtml || ""), "text/html");
  const fragment = document.createDocumentFragment();

  for (const node of parsed.body.childNodes) {
    appendSanitizedNode(fragment, node);
  }

  return fragment;
}

function renderHeading(block, highlights) {
  const level = Math.min(Math.max(Number(block.level || 2), 1), 6);
  return renderTextElement(`h${level}`, block.text || block.title || "", highlights);
}

function renderTextElement(tagName, text, highlights) {
  const element = document.createElement(tagName);
  appendHighlightedText(element, String(text || ""), highlights);
  return element;
}

function renderFormula(block, highlights) {
  const formula = document.createElement("div");
  formula.className = "formula-block";
  appendHighlightedText(formula, block.text || block.latex || "", highlights);
  return formula;
}

function renderAnnotation(block, highlights) {
  const annotation = document.createElement("aside");
  annotation.className = "annotation-block";
  appendHighlightedText(annotation, block.text || block.content || "", highlights);
  return annotation;
}

function renderList(block, highlights) {
  const list = document.createElement(block.ordered ? "ol" : "ul");
  const items = (Array.isArray(block.items) ? block.items : String(block.text || "").split("\n"))
    .filter(Boolean)
    .map((item) => String(item));
  let itemStartOffset = 0;

  for (const item of items) {
    const li = document.createElement("li");
    appendHighlightedText(li, item, getListItemHighlights(highlights, itemStartOffset, item.length, item));
    list.append(li);
    itemStartOffset += item.length + 1;
  }
  return list;
}

function renderCode(block, highlights) {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  if (block.language) {
    code.dataset.language = block.language;
  }
  appendHighlightedText(code, block.text || "", highlights);
  pre.append(code);
  return pre;
}

function renderTable(block, highlights) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrap";
  wrapper.append(sanitizeTableFragment(block.table_html || block.tableHtml || ""));
  applyTextNodeHighlights(wrapper, highlights);
  return wrapper;
}

function renderImage(block, highlights) {
  const safeSrc = sanitizeImageSrc(block.src || block.url || "");
  const figure = document.createElement("figure");
  if (!safeSrc) {
    const warning = document.createElement("figcaption");
    warning.textContent = "Image blocked because its source is not allowed.";
    figure.append(warning);
    return figure;
  }

  const image = document.createElement("img");
  image.src = safeSrc;
  image.alt = block.alt || block.caption || "Document image";
  image.loading = "lazy";
  figure.append(image);
  if (block.caption) {
    const caption = document.createElement("figcaption");
    appendHighlightedText(caption, block.caption, highlights);
    figure.append(caption);
  }
  return figure;
}

function groupHighlights(highlights) {
  const map = new Map();
  for (const highlight of highlights) {
    const ranges = Array.isArray(highlight.blockRanges) ? highlight.blockRanges : [];
    if (ranges.length) {
      for (const [segmentIndex, range] of ranges.entries()) {
        if (!range.blockId) {
          continue;
        }
        const list = map.get(range.blockId) || [];
        list.push({
          ...highlight,
          blockId: range.blockId,
          segmentIndex,
          segmentText: range.text || "",
          localStartOffset: range.localStartOffset,
          localEndOffset: range.localEndOffset
        });
        map.set(range.blockId, list);
      }
      continue;
    }

    if (!highlight.blockId) {
      continue;
    }

    const list = map.get(highlight.blockId) || [];
    list.push(highlight);
    map.set(highlight.blockId, list);
  }
  return map;
}

function getListItemHighlights(highlights, itemStartOffset, itemLength, itemText) {
  if (!highlights?.length) {
    return [];
  }

  const itemEndOffset = itemStartOffset + itemLength;
  const itemHighlights = [];
  for (const highlight of highlights) {
    const start = Number(highlight.localStartOffset);
    const end = Number(highlight.localEndOffset);
    const rawSelectedText = String(highlight.segmentText ?? highlight.text ?? "");

    if (Number.isFinite(start) && Number.isFinite(end) && end > itemStartOffset && start < itemEndOffset) {
      const localStart = Math.max(start, itemStartOffset) - itemStartOffset;
      const localEnd = Math.min(end, itemEndOffset) - itemStartOffset;
      if (localEnd > localStart) {
        itemHighlights.push({
          ...highlight,
          segmentText: itemText.slice(localStart, localEnd),
          localStartOffset: localStart,
          localEndOffset: localEnd
        });
      }
      continue;
    }

    const trimmedSelectedText = rawSelectedText.trim();
    const localIndex = trimmedSelectedText ? itemText.indexOf(trimmedSelectedText) : -1;
    if (localIndex >= 0) {
      itemHighlights.push({
        ...highlight,
        segmentText: trimmedSelectedText,
        localStartOffset: localIndex,
        localEndOffset: localIndex + trimmedSelectedText.length
      });
      continue;
    }

    if (rawSelectedText && rawSelectedText.includes(itemText)) {
      itemHighlights.push({
        ...highlight,
        segmentText: itemText,
        localStartOffset: 0,
        localEndOffset: itemText.length
      });
    }
  }
  return itemHighlights;
}

function appendHighlightedText(parent, text, highlights) {
  if (!highlights?.length || !text) {
    parent.textContent = text;
    return;
  }

  const filtered = getHighlightMatches(text, highlights);

  if (!filtered.length) {
    parent.textContent = text;
    return;
  }

  let cursor = 0;
  for (const match of filtered) {
    if (match.start > cursor) {
      parent.append(document.createTextNode(text.slice(cursor, match.start)));
    }
    const mark = createHighlightMark(match.highlight);
    mark.textContent = text.slice(match.start, match.end);
    parent.append(mark);
    cursor = match.end;
  }
  if (cursor < text.length) {
    parent.append(document.createTextNode(text.slice(cursor)));
  }
}

function getHighlightMatches(text, highlights) {
  const matches = [];
  for (const highlight of highlights || []) {
    const rawSelectedText = String(highlight.segmentText ?? highlight.text ?? "");
    const fallbackText = rawSelectedText.trim();
    if (!fallbackText) {
      continue;
    }
    const offsetStart = Number(highlight.localStartOffset);
    const offsetEnd = Number(highlight.localEndOffset);
    let start = -1;
    let end = -1;

    if (
      Number.isFinite(offsetStart) &&
      Number.isFinite(offsetEnd) &&
      offsetEnd > offsetStart &&
      text.slice(offsetStart, offsetEnd) === rawSelectedText
    ) {
      start = offsetStart;
      end = offsetEnd;
    } else if (
      Number.isFinite(offsetStart) &&
      text.slice(offsetStart, offsetStart + rawSelectedText.length) === rawSelectedText
    ) {
      start = offsetStart;
      end = offsetStart + rawSelectedText.length;
    } else {
      const rawStart = text.indexOf(rawSelectedText);
      const fallbackStart = rawStart >= 0 ? rawStart : text.indexOf(fallbackText);
      start = fallbackStart;
      end = fallbackStart >= 0 ? fallbackStart + (rawStart >= 0 ? rawSelectedText.length : fallbackText.length) : -1;
    }

    if (start >= 0 && end > start) {
      matches.push({
        start,
        end,
        highlight,
        text: text.slice(start, end)
      });
    }
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const filtered = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) {
      continue;
    }
    filtered.push(match);
    cursor = match.end;
  }
  return filtered;
}

function applyTextNodeHighlights(root, highlights) {
  const text = root.textContent || "";
  const matches = getHighlightMatches(text, highlights);
  if (!matches.length) {
    applyContainedTextNodeHighlights(root, highlights);
    return;
  }

  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length || 0;
    textNodes.push({ node, start: offset, end: offset + length });
    offset += length;
    node = walker.nextNode();
  }

  const segments = [];
  for (const match of matches) {
    for (const item of textNodes) {
      const start = Math.max(match.start, item.start);
      const end = Math.min(match.end, item.end);
      if (end > start) {
        segments.push({
          node: item.node,
          localStart: start - item.start,
          localEnd: end - item.start,
          highlight: match.highlight,
          globalStart: start
        });
      }
    }
  }

  segments
    .sort((a, b) => b.globalStart - a.globalStart)
    .forEach((segment) => wrapTextNodeSegment(segment));
}

function applyContainedTextNodeHighlights(root, highlights) {
  for (const highlight of highlights || []) {
    const selectedText = String(highlight.segmentText ?? highlight.text ?? "");
    const normalizedSelection = normalizePlainText(selectedText);
    if (!normalizedSelection) {
      continue;
    }

    const textNodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node);
      node = walker.nextNode();
    }

    for (const textNode of textNodes) {
      if (!textNode.parentNode) {
        continue;
      }
      const nodeText = textNode.textContent || "";
      const directIndex = nodeText.indexOf(selectedText.trim());
      if (directIndex >= 0) {
        wrapTextNodeSegment({
          node: textNode,
          localStart: directIndex,
          localEnd: directIndex + selectedText.trim().length,
          highlight
        });
        continue;
      }

      const normalizedNodeText = normalizePlainText(nodeText);
      if (!normalizedNodeText || !normalizedSelection.includes(normalizedNodeText)) {
        continue;
      }
      wrapTextNodeSegment({
        node: textNode,
        localStart: 0,
        localEnd: nodeText.length,
        highlight
      });
    }
  }
}

function wrapTextNodeSegment({ node, localStart, localEnd, highlight }) {
  if (!node.parentNode || localEnd <= localStart) {
    return;
  }

  const selectedNode = node.splitText(localStart);
  selectedNode.splitText(localEnd - localStart);
  const mark = createHighlightMark(highlight);
  selectedNode.parentNode.insertBefore(mark, selectedNode);
  mark.append(selectedNode);
}

function createHighlightMark(highlight) {
  const mark = document.createElement("mark");
  mark.className = "reader-highlight";
  if (highlight.isDraft || highlight.status === "draft") {
    mark.classList.add("reader-highlight-draft");
  }
  mark.dataset.highlightId = highlight.id;
  mark.dataset.threadId = highlight.isDraft || highlight.status === "draft" ? "" : highlight.threadId || "";
  mark.dataset.segmentIndex = String(highlight.segmentIndex || 0);
  return mark;
}

function normalizePlainText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function appendSanitizedNode(parent, node) {
  if (node.nodeType === Node.TEXT_NODE) {
    parent.append(document.createTextNode(node.textContent || ""));
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }

  if (!ALLOWED_TABLE_TAGS.has(node.tagName)) {
    for (const child of node.childNodes) {
      appendSanitizedNode(parent, child);
    }
    return;
  }

  const clean = document.createElement(node.tagName.toLowerCase());
  for (const attribute of node.attributes) {
    const name = attribute.name.toLowerCase();
    if (!ALLOWED_TABLE_ATTRIBUTES.has(name)) {
      continue;
    }
    if ((name === "colspan" || name === "rowspan") && !/^\d{1,2}$/.test(attribute.value)) {
      continue;
    }
    clean.setAttribute(name, attribute.value);
  }

  for (const child of node.childNodes) {
    appendSanitizedNode(clean, child);
  }
  parent.append(clean);
}
