import { SaxesParser } from "saxes";

const NAMESPACES = new Set(["", "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main"]);
const MAX_ITEMS = 100_000;
const MAX_TEXT = 25 * 1024 * 1024;
const tooLarge = () => new Error("knowledge-archive-too-large");

function parseXml(xml, root, handlers) {
  const stack = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => { throw new Error("knowledge-xlsx-xml-invalid"); });
  parser.on("opentag", tag => {
    const name = NAMESPACES.has(tag.uri) ? tag.local : "";
    stack.push(name);
    if (stack.length > 64) throw tooLarge();
    if (stack.length === 1 && name !== root) throw new Error("knowledge-xlsx-xml-invalid");
    handlers.open?.(name, tag, stack);
  });
  parser.on("text", text => handlers.text?.(text, stack));
  parser.on("cdata", text => handlers.text?.(text, stack));
  parser.on("closetag", () => {
    handlers.close?.(stack.at(-1), stack);
    stack.pop();
  });
  try { parser.write(xml).close(); } catch (error) {
    if (error.message?.startsWith("knowledge-")) throw error;
    throw new Error("knowledge-xlsx-xml-invalid", { cause: error });
  }
}

// Only displayed text runs: phonetic annotations and extension metadata are not
// cell values. Joining runs without a separator preserves split words.
function textRun(stack, parent) {
  return stack.at(-1) === "t" && (stack.at(-2) === parent || (stack.at(-2) === "r" && stack.at(-3) === parent));
}

function sharedStrings(xml) {
  const strings = [];
  if (xml === undefined) return strings;
  let current = "";
  parseXml(xml, "sst", {
    open(name, _tag, stack) {
      if (name === "si" && stack.length === 2) {
        if (strings.length >= MAX_ITEMS) throw tooLarge();
        current = "";
      }
    },
    text(text, stack) { if (stack[1] === "si" && textRun(stack, "si")) current += text; },
    close(name, stack) { if (name === "si" && stack.length === 2) strings.push(current); },
  });
  return strings;
}

function cellValue(cell, strings) {
  const value = cell.value.trim();
  if (cell.type === "inlineStr") return cell.inline;
  if (cell.type === "s" && value) {
    const index = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || index >= strings.length) {
      throw new Error("knowledge-xlsx-shared-string-invalid");
    }
    return strings[index];
  }
  if (cell.type === "b") return value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
  return value;
}

function worksheetText(xml, strings, budget) {
  const rows = [];
  let row = [];
  let cell = null;
  parseXml(xml, "worksheet", {
    open(name, tag, stack) {
      if (stack[1] !== "sheetData") return;
      if (name === "row" && stack.length === 3) row = [];
      if (name === "c" && stack.length === 4 && stack[2] === "row") {
        if (++budget.cells > MAX_ITEMS) throw tooLarge();
        const reference = tag.attributes.r?.value || "";
        if (reference && !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(reference)) throw new Error("knowledge-xlsx-xml-invalid");
        cell = { type: tag.attributes.t?.value, reference, value: "", inline: "" };
      }
    },
    text(text, stack) {
      if (!cell || stack[1] !== "sheetData") return;
      if (stack.length === 5 && stack.at(-1) === "v") cell.value += text;
      if (stack[4] === "is" && textRun(stack, "is")) cell.inline += text;
    },
    close(name, stack) {
      if (stack[1] !== "sheetData") return;
      if (name === "c" && stack.length === 4 && cell) {
        const value = cellValue(cell, strings);
        if (value.trim()) {
          const text = cell.reference ? `${cell.reference}: ${value}` : value;
          // References can amplify a small dictionary far beyond ZIP size.
          budget.characters += text.length + 3;
          if (budget.characters > MAX_TEXT) throw tooLarge();
          row.push(text);
        }
        cell = null;
      }
      // A cell is a text boundary: joining it to a heading cell would let a
      // downstream article parser mistake adjacent terms for a heading title.
      if (name === "row" && stack.length === 3 && row.length) rows.push(row.join("\n"));
    },
  });
  return rows.join("\n");
}

export function xlsxText(sharedXml, worksheetXml) {
  const strings = sharedStrings(sharedXml);
  const budget = { cells: 0, characters: 0 };
  return worksheetXml.map(xml => worksheetText(xml, strings, budget)).join("\n\n");
}
