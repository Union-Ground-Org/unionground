// Bounded RTF text reader. Character escapes carry document content, not
// formatting: https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxrtfex/205e1abf-b794-4fd0-b1e4-5210882233ab
const DESTINATIONS = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "objdata",
  "nonshppict", "shppict", "fldinst", "generator", "xmlnstbl", "datastore", "themedata",
  "colorschememapping", "listtable", "listoverridetable", "rsidtbl"]);
const TEXT_CONTROLS = { par: "\n", line: "\n", tab: "\t", emdash: "—", endash: "–", bullet: "•",
  lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”" };
// Node's optimized windows-1252 TextDecoder can map this range as Latin-1.
// Undefined Windows-1252 bytes are refused rather than indexed as replacement text.
const WINDOWS_1252 = [0x20ac, null, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x2c6, 0x2030, 0x160, 0x2039, 0x152, null, 0x17d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x2dc, 0x2122, 0x161, 0x203a, 0x153, null, 0x17e, 0x178];

export function rtfText(bytes) {
  const source = Buffer.from(bytes).toString("latin1");
  const stack = []; const fonts = new Map();
  let state = { skip: false, fontTable: false, font: 0, codePage: 1252, uc: 1 };
  let defaultFont = 0; let fallback = 0; let output = "";
  const invalid = () => { throw new Error("knowledge-rtf-invalid"); };
  const requireEncoding = (codePage) => {
    // Windows-1252 only. Other code pages and font-symbol encodings
    // need another decoder; refusing them avoids silently changing policy text.
    if (codePage !== 1252) {
      throw new Error("knowledge-rtf-encoding-unsupported");
    }
  };
  const emitByte = (byte) => {
    if (state.skip) return;
    requireEncoding(fonts.get(state.font) ?? state.codePage);
    const codePoint = byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252[byte - 0x80] : byte;
    if (codePoint === null) throw new Error("knowledge-rtf-encoding-unsupported");
    output += String.fromCodePoint(codePoint);
  };
  for (let index = 0; index < source.length;) {
    const character = source[index++];
    if (character === "{") {
      fallback = 0;
      if (stack.length >= 256) throw new Error("knowledge-rtf-too-deep");
      stack.push(state); state = { ...state }; continue;
    }
    if (character === "}") {
      fallback = 0;
      if (!stack.length) invalid();
      state = stack.pop(); continue;
    }
    if (character === "\r" || character === "\n") continue;
    if (character !== "\\") {
      if (fallback) fallback -= 1;
      else emitByte(character.charCodeAt(0));
      continue;
    }
    if (index >= source.length) invalid();
    const symbol = source[index++];
    if (symbol === "'") {
      const hex = source.slice(index, index + 2);
      if (!/^[0-9a-f]{2}$/iu.test(hex)) invalid();
      index += 2;
      if (fallback) fallback -= 1;
      else emitByte(Number.parseInt(hex, 16));
      continue;
    }
    if (!/[a-z]/iu.test(symbol)) {
      if (fallback) { fallback -= 1; continue; }
      if (symbol === "*") state.skip = true;
      else if (["\\", "{", "}"].includes(symbol)) emitByte(symbol.charCodeAt(0));
      else if (!state.skip && symbol === "~") output += "\u00a0";
      else if (!state.skip && symbol === "_") output += "\u2011";
      continue;
    }
    const start = index - 1;
    while (index < source.length && /[a-z]/iu.test(source[index])) index += 1;
    const word = source.slice(start, index).toLowerCase();
    const numberStart = index;
    if (source[index] === "-") index += 1;
    while (index < source.length && /[0-9]/u.test(source[index])) index += 1;
    const parameter = index === numberStart ? null : Number(source.slice(numberStart, index));
    if (source[index] === " ") index += 1;
    if (word === "bin") {
      if (!Number.isSafeInteger(parameter) || parameter < 0 || parameter > source.length - index) invalid();
      index += parameter;
      if (fallback) fallback -= 1;
      continue;
    }
    if (fallback) { fallback -= 1; continue; }
    if (DESTINATIONS.has(word)) { state.skip = true; if (word === "fonttbl") state.fontTable = true; }
    if (word === "f" && Number.isInteger(parameter)) state.font = parameter;
    if (state.fontTable) {
      if (word === "fcharset") fonts.set(state.font, [0, 1].includes(parameter) ? null : -1);
      if (word === "cpg") fonts.set(state.font, parameter);
      continue;
    }
    if (state.skip) continue;
    if (word === "deff") { defaultFont = parameter; state.font = parameter; }
    else if (word === "plain") state.font = defaultFont;
    else if (["mac", "pc", "pca"].includes(word)) throw new Error("knowledge-rtf-encoding-unsupported");
    else if (word === "ansicpg") { requireEncoding(parameter); state.codePage = parameter; }
    else if (word === "uc") {
      if (!Number.isInteger(parameter) || parameter < 0 || parameter > 32767) invalid();
      state.uc = parameter;
    } else if (word === "u") {
      if (!Number.isInteger(parameter) || parameter < -32768 || parameter > 32767) invalid();
      output += String.fromCharCode(parameter < 0 ? parameter + 65536 : parameter);
      fallback = state.uc;
    } else if (Object.hasOwn(TEXT_CONTROLS, word)) output += TEXT_CONTROLS[word];
  }
  if (stack.length) invalid();
  return output;
}
