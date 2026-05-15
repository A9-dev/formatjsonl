import { formatRecordsWithBlocks, parseJsonlInput } from "./formatter.js";

const editor = ace.edit("editor");
const emptyState = document.querySelector("#empty-state");
const status = document.querySelector("#status");
const fileInput = document.querySelector("#file-input");
const uploadButton = document.querySelector("#upload-button");
const exampleButton = document.querySelector("#example-button");
const copyButton = document.querySelector("#copy-button");
const clearButton = document.querySelector("#clear-button");
const editorShell = document.querySelector(".editor-shell");
const editorScroller = editor.container.querySelector(".ace_scroller");
const autoFormatDelayMs = 220;
const blockGapPx = 12;
const formatOptions = {
  indent: 2,
  layout: "pretty-records",
  sortKeys: false,
};
const exampleJsonl = [
  JSON.stringify({
    event: "page_view",
    userId: 1842,
    path: "/pricing",
    tags: ["landing", "experiment-b"],
    ts: "2026-05-15T11:42:00Z",
  }),
  JSON.stringify({
    event: "checkout_started",
    userId: 1842,
    amount: 129.5,
    currency: "USD",
    items: 3,
    ts: "2026-05-15T11:44:12Z",
  }),
].join("\n");

const blockLayer = document.createElement("div");
blockLayer.className = "editor-block-layer";
editorScroller.prepend(blockLayer);

let autoFormatTimer = 0;
let isApplyingFormat = false;
let recordBlocks = [];
let blockRenderFrame = 0;

editor.setTheme("ace/theme/github");
editor.session.setMode("ace/mode/json");
editor.session.setUseWorker(false);
editor.setOptions({
  fontFamily: "IBM Plex Mono",
  fontSize: "15px",
  highlightActiveLine: true,
  highlightSelectedWord: true,
  printMargin: false,
  showFoldWidgets: false,
  tabSize: 2,
  useSoftTabs: true,
  wrap: true,
});
editor.renderer.setScrollMargin(10, 18, 0, 0);

function setStatus(message, tone = "default") {
  status.textContent = message;

  if (tone === "error") {
    status.dataset.tone = "error";
    return;
  }

  delete status.dataset.tone;
}

function syncEmptyState() {
  emptyState.hidden = editor.getValue().trim().length > 0;
}

function clearAnnotations() {
  editor.session.setAnnotations([]);
}

function queueRecordBlockRender() {
  if (blockRenderFrame) {
    window.cancelAnimationFrame(blockRenderFrame);
  }

  blockRenderFrame = window.requestAnimationFrame(() => {
    blockRenderFrame = 0;
    renderRecordBlocks();
  });
}

function clearRecordBlocks() {
  recordBlocks = [];
  blockLayer.replaceChildren();
}

function focusLine(lineNumber) {
  editor.scrollToLine(lineNumber, true, true, () => {});
  editor.gotoLine(lineNumber, 1, true);
}

function getScreenRow(row, column) {
  return editor.session.documentToScreenPosition(row, column).row;
}

function renderRecordBlocks() {
  if (!recordBlocks.length) {
    blockLayer.replaceChildren();
    return;
  }

  const scrollTop = editor.session.getScrollTop();
  const scrollLeft = editor.session.getScrollLeft();
  const lineHeight = editor.renderer.lineHeight;
  const viewportHeight = editorScroller.clientHeight;
  const fragment = document.createDocumentFragment();

  recordBlocks.forEach((block) => {
    const endColumn = editor.session.getLine(block.endRow).length;
    const startTop = getScreenRow(block.startRow, 0) * lineHeight - scrollTop;
    const endBottom =
      (getScreenRow(block.endRow, endColumn) + 1) * lineHeight - scrollTop;

    if (endBottom < 0 || startTop > viewportHeight) {
      return;
    }

    const blockElement = document.createElement("div");
    blockElement.className = "editor-block";
    blockElement.style.top = `${startTop + blockGapPx / 2}px`;
    blockElement.style.height = `${Math.max(endBottom - startTop - blockGapPx, lineHeight - 8)}px`;
    fragment.append(blockElement);
  });

  blockLayer.style.transform = `translateX(${-scrollLeft}px)`;
  blockLayer.replaceChildren(fragment);
}

function updateRecordBlocks(blocks) {
  recordBlocks = blocks;
  queueRecordBlockRender();
}

function setEditorValue(text) {
  const cursor = editor.getCursorPosition();
  const scrollTop = editor.session.getScrollTop();
  const scrollLeft = editor.session.getScrollLeft();

  isApplyingFormat = true;
  editor.setValue(text, -1);
  isApplyingFormat = false;

  const lastRow = Math.max(editor.session.getLength() - 1, 0);
  const targetRow = Math.min(cursor.row, lastRow);
  const targetColumn = Math.min(
    cursor.column,
    editor.session.getLine(targetRow).length,
  );

  editor.session.setScrollTop(scrollTop);
  editor.session.setScrollLeft(scrollLeft);
  editor.moveCursorTo(targetRow, targetColumn);
  editor.clearSelection();
}

function loadContent(text) {
  clearAnnotations();
  clearRecordBlocks();
  editor.setValue(text, -1);
  syncEmptyState();
}

function applyFormatting(sourceLabel = "Auto-formatted") {
  const sourceText = editor.getValue();

  if (!sourceText.trim()) {
    clearAnnotations();
    clearRecordBlocks();
    setStatus("Ready for JSONL.");
    return false;
  }

  try {
    const records = parseJsonlInput(sourceText);
    const { output, blocks } = formatRecordsWithBlocks(records, formatOptions);

    clearAnnotations();
    setEditorValue(output);
    updateRecordBlocks(blocks);
    syncEmptyState();

    const noun = records.length === 1 ? "record" : "records";
    setStatus(`${sourceLabel}: ${records.length} ${noun}.`);
    return true;
  } catch (error) {
    const lineNumber = typeof error?.line === "number" ? error.line : 1;
    const message =
      typeof error?.message === "string"
        ? error.message
        : "Unable to format the JSONL input.";

    clearRecordBlocks();
    editor.session.setAnnotations([
      {
        row: Math.max(lineNumber - 1, 0),
        column: 0,
        text: message,
        type: "error",
      },
    ]);
    focusLine(lineNumber);
    setStatus(`Line ${lineNumber}: ${message}`, "error");
    return false;
  }
}

function queueAutoFormat(
  sourceLabel = "Auto-formatted",
  delayMs = autoFormatDelayMs,
) {
  window.clearTimeout(autoFormatTimer);
  autoFormatTimer = window.setTimeout(() => {
    autoFormatTimer = 0;
    applyFormatting(sourceLabel);
  }, delayMs);
}

async function importFile(file) {
  try {
    const text = await file.text();
    loadContent(text);
    queueAutoFormat(`Loaded ${file.name}`, 0);
  } catch {
    setStatus(`Couldn't read ${file.name}.`, "error");
  }
}

async function copyOutput() {
  const text = editor.getValue();

  if (!text.trim()) {
    setStatus("Nothing to copy yet.", "error");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied the current output to the clipboard.");
  } catch {
    setStatus(
      "Copy failed. Select the text in the editor and copy it manually.",
      "error",
    );
  }
}

uploadButton.addEventListener("click", () => {
  fileInput.click();
});

exampleButton.addEventListener("click", () => {
  loadContent(exampleJsonl);
  queueAutoFormat("Loaded example JSONL", 0);
});

fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files ?? [];

  if (!file) {
    return;
  }

  await importFile(file);
  fileInput.value = "";
});

copyButton.addEventListener("click", () => {
  copyOutput();
});

clearButton.addEventListener("click", () => {
  window.clearTimeout(autoFormatTimer);
  clearAnnotations();
  clearRecordBlocks();
  editor.setValue("", -1);
  syncEmptyState();
  setStatus("Cleared the editor.");
});

editor.session.on("change", () => {
  syncEmptyState();

  if (isApplyingFormat) {
    return;
  }

  clearAnnotations();
  clearRecordBlocks();

  if (!editor.getValue().trim()) {
    window.clearTimeout(autoFormatTimer);
    setStatus("Ready for JSONL.");
    return;
  }

  queueAutoFormat();
});

editor.session.on("changeScrollTop", () => {
  queueRecordBlockRender();
});

editor.session.on("changeScrollLeft", () => {
  queueRecordBlockRender();
});

window.addEventListener("resize", () => {
  queueRecordBlockRender();
});

editorShell.addEventListener("dragover", (event) => {
  event.preventDefault();
});

editorShell.addEventListener("drop", async (event) => {
  event.preventDefault();
  const [file] = event.dataTransfer?.files ?? [];

  if (file) {
    await importFile(file);
  }
});

setStatus("Ready for JSONL.");
syncEmptyState();
