import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
} from "https://cdn.jsdelivr.net/npm/@codemirror/state@6.5.2/+esm";
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "https://cdn.jsdelivr.net/npm/@codemirror/view@6.38.6/+esm";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "https://cdn.jsdelivr.net/npm/@codemirror/commands@6.8.1/+esm";
import {
  bracketMatching,
  indentUnit,
} from "https://cdn.jsdelivr.net/npm/@codemirror/language@6.11.3/+esm";
import { formatRecordsWithBlocks, parseJsonlInput } from "./formatter.js";

const editorRoot = document.querySelector("#editor");
const emptyState = document.querySelector("#empty-state");
const status = document.querySelector("#status");
const fileInput = document.querySelector("#file-input");
const uploadButton = document.querySelector("#upload-button");
const exampleButton = document.querySelector("#example-button");
const copyButton = document.querySelector("#copy-button");
const clearButton = document.querySelector("#clear-button");
const editorShell = document.querySelector(".editor-shell");
const autoFormatDelayMs = 220;
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

const setDecorationsEffect = StateEffect.define();
const decorationField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);

    for (const effect of transaction.effects) {
      if (effect.is(setDecorationsEffect)) {
        return effect.value;
      }
    }

    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    background: "linear-gradient(180deg, #f3efe9, #f8f4ee)",
    color: "var(--text)",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
    lineHeight: "1.65",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "14px 18px 18px",
    caretColor: "#d04e22",
  },
  ".cm-line": {
    padding: "0 8px 0 0",
    borderRadius: "0",
  },
  ".cm-gutters": {
    borderRight: "1px solid rgba(19, 64, 78, 0.1)",
    background: "rgba(243, 237, 231, 0.9)",
    color: "rgba(22, 50, 61, 0.52)",
  },
  ".cm-gutterElement": {
    fontFamily: '"IBM Plex Mono", "SFMono-Regular", monospace',
    fontSize: "15px",
    lineHeight: "1.65",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "2.6rem",
    padding: "0 1rem 0 0.6rem",
  },
  ".cm-activeLine": {
    background: "rgba(226, 109, 61, 0.08)",
  },
  ".cm-activeLineGutter": {
    background: "rgba(226, 109, 61, 0.08)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    background: "rgba(226, 109, 61, 0.18)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "#d04e22",
  },
  ".cm-focused": {
    outline: "none",
  },
});

let autoFormatTimer = 0;
let isApplyingFormat = false;
let recordBlocks = [];
let errorLineNumber = 0;
let decorationRefreshFrame = 0;
let blockRenderFrame = 0;

const editorView = new EditorView({
  parent: editorRoot,
  state: EditorState.create({
    doc: "",
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      EditorState.tabSize.of(2),
      indentUnit.of("  "),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": "JSONL editor",
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off",
        autocorrect: "off",
      }),
      bracketMatching(),
      editorTheme,
      decorationField,
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.geometryChanged
        ) {
          queueBlockRender();
        }

        if (!update.docChanged) {
          return;
        }

        syncEmptyState();

        if (isApplyingFormat) {
          return;
        }

        recordBlocks = [];
        errorLineNumber = 0;
        queueDecorationRefresh();

        if (!getEditorValue().trim()) {
          window.clearTimeout(autoFormatTimer);
          setStatus("Ready for JSONL.");
          return;
        }

        queueAutoFormat();
      }),
    ],
  }),
});

const recordBlockLayer = document.createElement("div");
recordBlockLayer.className = "editor-block-layer";
editorView.scrollDOM.prepend(recordBlockLayer);

function setStatus(message, tone = "default") {
  status.textContent = message;

  if (tone === "error") {
    status.dataset.tone = "error";
    return;
  }

  delete status.dataset.tone;
}

function syncEmptyState() {
  emptyState.hidden = getEditorValue().trim().length > 0;
}

function getEditorValue() {
  return editorView.state.doc.toString();
}

function addMarkRange(ranges, from, to, className) {
  if (to <= from) {
    return;
  }

  ranges.push(Decoration.mark({ class: className }).range(from, to));
}

function addSyntaxRanges(ranges, state) {
  const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
  const literalPattern = /^(true|false|null)\b/;

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const text = line.text;
    let index = 0;

    while (index < text.length) {
      const character = text[index];

      if (character === '"') {
        let endIndex = index + 1;
        let escaped = false;

        while (endIndex < text.length) {
          const nextCharacter = text[endIndex];

          if (!escaped && nextCharacter === '"') {
            endIndex += 1;
            break;
          }

          escaped = !escaped && nextCharacter === "\\";
          endIndex += 1;
        }

        let lookaheadIndex = endIndex;

        while (
          lookaheadIndex < text.length &&
          /\s/.test(text[lookaheadIndex])
        ) {
          lookaheadIndex += 1;
        }

        const tokenClass =
          text[lookaheadIndex] === ":" ? "cm-token-key" : "cm-token-string";

        addMarkRange(
          ranges,
          line.from + index,
          line.from + endIndex,
          tokenClass,
        );
        index = endIndex;
        continue;
      }

      if (/[{}\[\]]/.test(character)) {
        addMarkRange(
          ranges,
          line.from + index,
          line.from + index + 1,
          "cm-token-bracket",
        );
        index += 1;
        continue;
      }

      if (/[,:]/.test(character)) {
        addMarkRange(
          ranges,
          line.from + index,
          line.from + index + 1,
          "cm-token-punctuation",
        );
        index += 1;
        continue;
      }

      if (character === "-" || /\d/.test(character)) {
        const match = text.slice(index).match(numberPattern);

        if (match) {
          addMarkRange(
            ranges,
            line.from + index,
            line.from + index + match[0].length,
            "cm-token-number",
          );
          index += match[0].length;
          continue;
        }
      }

      if (/[tfn]/.test(character)) {
        const match = text.slice(index).match(literalPattern);

        if (match) {
          const tokenClass =
            match[0] === "null" ? "cm-token-null" : "cm-token-bool";
          addMarkRange(
            ranges,
            line.from + index,
            line.from + index + match[0].length,
            tokenClass,
          );
          index += match[0].length;
          continue;
        }
      }

      index += 1;
    }
  }
}

function buildDecorations(state, blocks, lineNumber) {
  const ranges = [];
  const lineClasses = new Map();

  if (lineNumber > 0 && lineNumber <= state.doc.lines) {
    const classes = lineClasses.get(lineNumber) ?? new Set();
    classes.add("cm-error-line");
    lineClasses.set(lineNumber, classes);
  }

  lineClasses.forEach((classes, currentLine) => {
    const line = state.doc.line(currentLine);
    ranges.push(
      Decoration.line({
        attributes: {
          class: Array.from(classes).join(" "),
        },
      }).range(line.from),
    );
  });

  addSyntaxRanges(ranges, state);

  return Decoration.set(ranges, true);
}

function renderRecordBlocks() {
  if (!recordBlocks.length) {
    recordBlockLayer.replaceChildren();
    return;
  }

  const scrollRect = editorView.scrollDOM.getBoundingClientRect();
  const gutterRect = editorView.dom
    .querySelector(".cm-gutters")
    ?.getBoundingClientRect();
  const scrollTop = editorView.scrollDOM.scrollTop;
  const viewportHeight = editorView.scrollDOM.clientHeight;
  const fragment = document.createDocumentFragment();
  const contentStyle = window.getComputedStyle(editorView.contentDOM);
  const contentTopInset = Number.parseFloat(contentStyle.paddingTop) || 0;
  const leftInset =
    (gutterRect?.right ?? scrollRect.left) - scrollRect.left + 12;

  recordBlocks.forEach((block) => {
    const startLineNumber = Math.max(block.startRow + 1, 1);
    const endLineNumber = Math.min(
      block.endRow + 1,
      editorView.state.doc.lines,
    );
    const startLine = editorView.state.doc.line(startLineNumber);
    const endLine = editorView.state.doc.line(endLineNumber);
    const startBlock = editorView.lineBlockAt(startLine.from);
    const endBlock = editorView.lineBlockAt(endLine.from);
    const top = startBlock.top + contentTopInset;
    const bottom = endBlock.bottom + contentTopInset;
    const visibleTop = top - scrollTop;
    const visibleBottom = bottom - scrollTop;

    if (visibleBottom < 0 || visibleTop > viewportHeight) {
      return;
    }

    const blockElement = document.createElement("div");
    blockElement.className = "editor-block";
    blockElement.style.top = `${top}px`;
    blockElement.style.left = `${leftInset}px`;
    blockElement.style.right = `18px`;
    blockElement.style.height = `${Math.max(bottom - top, 0)}px`;
    fragment.append(blockElement);
  });

  recordBlockLayer.replaceChildren(fragment);
}

function queueBlockRender() {
  if (blockRenderFrame) {
    window.cancelAnimationFrame(blockRenderFrame);
  }

  blockRenderFrame = window.requestAnimationFrame(() => {
    blockRenderFrame = 0;
    renderRecordBlocks();
  });
}

function updateDecorations() {
  editorView.dispatch({
    effects: setDecorationsEffect.of(
      buildDecorations(editorView.state, recordBlocks, errorLineNumber),
    ),
  });
}

function queueDecorationRefresh() {
  if (decorationRefreshFrame) {
    window.cancelAnimationFrame(decorationRefreshFrame);
  }

  decorationRefreshFrame = window.requestAnimationFrame(() => {
    decorationRefreshFrame = 0;
    updateDecorations();
  });
}

function clearAnnotations() {
  errorLineNumber = 0;
  updateDecorations();
}

function clearRecordBlocks() {
  recordBlocks = [];
  updateDecorations();
  queueBlockRender();
}

function focusLine(lineNumber) {
  const boundedLine = Math.min(
    Math.max(lineNumber, 1),
    editorView.state.doc.lines,
  );
  const line = editorView.state.doc.line(boundedLine);

  editorView.dispatch({
    selection: EditorSelection.cursor(line.from),
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
  });
  editorView.focus();
}

function updateRecordBlocks(blocks) {
  recordBlocks = blocks;
  updateDecorations();
  queueBlockRender();
}

function getSelectionLineColumn(position) {
  const line = editorView.state.doc.lineAt(position);

  return {
    lineNumber: line.number,
    column: position - line.from,
  };
}

function getPositionFromLineColumn(doc, lineNumber, column) {
  const safeLineNumber = Math.min(Math.max(lineNumber, 1), doc.lines || 1);
  const line = doc.line(safeLineNumber);

  return Math.min(line.from + column, line.to);
}

function setEditorValue(text) {
  const selection = editorView.state.selection.main;
  const scrollTop = editorView.scrollDOM.scrollTop;
  const scrollLeft = editorView.scrollDOM.scrollLeft;
  const anchorLocation = getSelectionLineColumn(selection.anchor);
  const headLocation = getSelectionLineColumn(selection.head);

  isApplyingFormat = true;
  const nextState = editorView.state.update({
    changes: { from: 0, to: editorView.state.doc.length, insert: text },
  }).state;
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: text },
    selection: EditorSelection.range(
      getPositionFromLineColumn(
        nextState.doc,
        anchorLocation.lineNumber,
        anchorLocation.column,
      ),
      getPositionFromLineColumn(
        nextState.doc,
        headLocation.lineNumber,
        headLocation.column,
      ),
    ),
  });
  isApplyingFormat = false;

  editorView.scrollDOM.scrollTop = scrollTop;
  editorView.scrollDOM.scrollLeft = scrollLeft;
}

function loadContent(text) {
  errorLineNumber = 0;
  recordBlocks = [];
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: text },
    selection: EditorSelection.cursor(0),
  });
  updateDecorations();
  syncEmptyState();
}

function applyFormatting(sourceLabel = "Auto-formatted") {
  const sourceText = getEditorValue();

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

    recordBlocks = [];
    errorLineNumber = Math.max(lineNumber, 1);
    updateDecorations();
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
  const text = getEditorValue();

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
  errorLineNumber = 0;
  recordBlocks = [];
  editorView.dispatch({
    changes: { from: 0, to: editorView.state.doc.length, insert: "" },
    selection: EditorSelection.cursor(0),
  });
  updateDecorations();
  syncEmptyState();
  setStatus("Cleared the editor.");
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

editorView.scrollDOM.addEventListener("scroll", () => {
  queueBlockRender();
});

window.addEventListener("resize", () => {
  queueBlockRender();
});

setStatus("Ready for JSONL.");
syncEmptyState();
updateDecorations();
queueBlockRender();
