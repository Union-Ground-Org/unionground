import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { readFilingFont } from "../../src/lib/filingFont.js";

// Noto Sans Regular (SIL Open Font License 1.1, fonts/OFL.txt), embedded in
// official filing copies so a typed signature prints exactly as it was typed
// (#8701). Read from the deployment bundle the first time a copy is built,
// never fetched over the network.
let font = null;

export function filingFont() {
  if (!font) {
    const read = readFilingFont(readFileSync(new URL("./fonts/NotoSans-Regular.ttf", import.meta.url)));
    // The embedded font file is stored compressed in each copy.
    font = { ...read, deflated: deflateSync(read.bytes, { level: 9 }) };
  }
  return font;
}
