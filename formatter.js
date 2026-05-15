function countLines(text, endIndex) {
  let lines = 1;

  for (let index = 0; index < endIndex; index += 1) {
    if (text[index] === "\n") {
      lines += 1;
    }
  }

  return lines;
}

function scanCompositeValue(text, startIndex) {
  const stack = [text[startIndex]];
  let inString = false;
  let escaping = false;

  for (let index = startIndex + 1; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (character === "\\") {
        escaping = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      stack.push(character);
      continue;
    }

    if (character === "}") {
      if (stack[stack.length - 1] !== "{") {
        throw new SyntaxError("Unexpected closing brace.");
      }

      stack.pop();
    }

    if (character === "]") {
      if (stack[stack.length - 1] !== "[") {
        throw new SyntaxError("Unexpected closing bracket.");
      }

      stack.pop();
    }

    if (stack.length === 0) {
      return index + 1;
    }
  }

  throw new SyntaxError(
    "Reached the end of the input before the JSON value closed.",
  );
}

function scanSimpleValue(text, startIndex) {
  let index = startIndex;

  while (index < text.length && !/\s/.test(text[index])) {
    index += 1;
  }

  return index;
}

function extractJsonValue(text, startIndex) {
  const opener = text[startIndex];

  if (opener === "{" || opener === "[") {
    return scanCompositeValue(text, startIndex);
  }

  if (opener === '"' || opener === "-" || /[0-9tfn]/.test(opener)) {
    return scanSimpleValue(text, startIndex);
  }

  throw new SyntaxError(`Unexpected token ${opener}.`);
}

function parseSequence(text) {
  const records = [];
  let index = 0;

  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) {
      index += 1;
    }

    if (index >= text.length) {
      break;
    }

    const valueStart = index;
    const valueEnd = extractJsonValue(text, valueStart);
    const snippet = text.slice(valueStart, valueEnd);

    try {
      records.push(JSON.parse(snippet));
    } catch (error) {
      throw {
        line: countLines(text, valueStart),
        message:
          error instanceof Error
            ? error.message
            : "Failed to parse JSON value.",
      };
    }

    index = valueEnd;
  }

  return records;
}

export function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .reduce((result, key) => {
        result[key] = sortKeysDeep(value[key]);
        return result;
      }, {});
  }

  return value;
}

export function parseJsonlInput(sourceText) {
  const normalized = sourceText.replace(/\r\n?/g, "\n");
  const trimmed = normalized.trim();

  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      return parseSequence(normalized);
    } catch (error) {
      const issue = error && typeof error === "object" ? error : {};
      throw {
        line: typeof issue.line === "number" ? issue.line : 1,
        message:
          typeof issue.message === "string"
            ? issue.message
            : "Unable to parse the JSONL input.",
      };
    }
  }
}

function buildPrettyRecordBlocks(records, indent) {
  const renderedRecords = records.map((record) =>
    JSON.stringify(record, null, indent),
  );
  const blocks = [];
  let currentRow = 0;

  const output = renderedRecords
    .map((recordText, index) => {
      const lineCount = recordText.split("\n").length;
      blocks.push({ startRow: currentRow, endRow: currentRow + lineCount - 1 });
      currentRow += lineCount;

      return recordText;
    })
    .join("\n");

  return { output, blocks };
}

function buildCompactRecordBlocks(records) {
  const renderedRecords = records.map((record) => JSON.stringify(record));
  const blocks = renderedRecords.map((_, index) => ({
    startRow: index,
    endRow: index,
  }));

  return {
    output: renderedRecords.join("\n"),
    blocks,
  };
}

function buildArrayRecordBlocks(records, indent) {
  if (records.length === 0) {
    return { output: "[]", blocks: [] };
  }

  const indentUnit = typeof indent === "number" ? " ".repeat(indent) : indent;
  const lines = ["["];
  const blocks = [];
  let currentRow = 1;

  records.forEach((record, index) => {
    const recordLines = JSON.stringify(record, null, indent)
      .split("\n")
      .map((line) => `${indentUnit}${line}`);

    if (index < records.length - 1) {
      recordLines[recordLines.length - 1] =
        `${recordLines[recordLines.length - 1]},`;
    }

    lines.push(...recordLines);
    blocks.push({
      startRow: currentRow,
      endRow: currentRow + recordLines.length - 1,
    });
    currentRow += recordLines.length;
  });

  lines.push("]");

  return {
    output: lines.join("\n"),
    blocks,
  };
}

export function formatRecordsWithBlocks(records, options) {
  const { indent, layout, sortKeys } = options;
  const preparedRecords = sortKeys ? records.map(sortKeysDeep) : records;

  if (layout === "json-array") {
    return buildArrayRecordBlocks(preparedRecords, indent);
  }

  if (layout === "compact-jsonl") {
    return buildCompactRecordBlocks(preparedRecords);
  }

  return buildPrettyRecordBlocks(preparedRecords, indent);
}

export function formatRecords(records, options) {
  return formatRecordsWithBlocks(records, options).output;
}
