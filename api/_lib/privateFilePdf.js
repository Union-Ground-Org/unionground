import { createRequire } from "node:module";
import { inspectPrivateRaster } from "./privateFileRaster.js";

// Use one CJS module graph so the allocation hook covers the parser's exact
// DecodeStream constructor in both Node workers and instrumented tests.
const require = createRequire(import.meta.url);
const { PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } = require("pdf-lib");
const DecodeStream = require("pdf-lib/cjs/core/streams/DecodeStream.js").default;

const reject = (reason) => { throw new Error(`private-file-pdf-${reason}`); };
const ACTIVE = new Set([
  "JavaScript", "JS", "Launch", "GoToR", "GoToE", "SubmitForm", "ImportData",
  "RichMedia", "RichMediaContent", "Movie", "Sound", "Rendition", "Screen",
  "XFA", "EmbeddedFile", "EmbeddedFiles", "Filespec", "EF", "AA",
]);
let inspecting = false;

function nameText(name) {
  // PDF names permit hexadecimal escapes. Normalize escaped names even when a
  // parser preserves an escape; a raw /JavaScript substring check is inadequate.
  return name.decodeText().replace(/#([a-f0-9]{2})/ig, (_, value) => String.fromCharCode(parseInt(value, 16)));
}

/** Runs in a dedicated worker with a parent-owned wall timer and heap limit.
 * pdf-lib 1.17.1's stream decoders share ensureBuffer. Guard that allocation
 * before parsing, including compressed object/xref streams: V8 heap limits do
 * not bound Uint8Array backing stores. Count all growth allocations, including
 * old buffers, against the shared budget and restore the pinned hook on exit.
 * This structural/active-content profile is not a malware verdict or renderer. */
export async function inspectPrivatePdf(bytes, budget) {
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(bytes.toString("latin1", 0, 10))) throw new Error("private-file-mime-mismatch");
  const tail = bytes.subarray(Math.max(0, bytes.length - 128)).toString("latin1");
  const end = /startxref\s+(\d+)\s+%%EOF[\t\r\n ]*$/.exec(tail);
  if (!end || Number(end[1]) >= bytes.length || Number(end[1]) < 8) reject("trailing-or-truncated");
  if (inspecting) reject("inspection-busy");
  const prototype = DecodeStream.prototype;
  const original = prototype.ensureBuffer;
  if (typeof original !== "function") reject("decoder-contract");
  inspecting = true;
  prototype.ensureBuffer = function boundedPdfBuffer(requested) {
    if (!Number.isSafeInteger(requested) || requested < 0) reject("expanded-size");
    if (requested <= this.buffer.byteLength) return this.buffer;
    let allocated = this.minBufferLength;
    if (!Number.isSafeInteger(allocated) || allocated < 1) reject("expanded-size");
    while (allocated < requested && allocated <= budget.remaining) allocated *= 2;
    if (allocated > budget.remaining) reject("expanded-size");
    budget.remaining -= allocated;
    return original.call(this, requested);
  };
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
    if (doc.isEncrypted) reject("encrypted");
    const pages = doc.getPages();
    if (!pages.length || pages.length > 300) reject("page-limit");
    const pending = doc.context.enumerateIndirectObjects().map(([, object]) => object);
    const visited = new Set();
    let inspected = 0;
    while (pending.length) {
      if (++inspected > 100000) reject("object-limit");
      const object = pending.pop();
      if (object == null) reject("invalid-reference");
      if (visited.has(object)) continue;
      visited.add(object);
      if (object instanceof PDFRef) {
        pending.push(doc.context.lookup(object));
      } else if (object instanceof PDFName) {
        if (ACTIVE.has(nameText(object))) reject("active-content");
      } else if (object instanceof PDFArray) {
        if (object.size() > 100000 - inspected) reject("object-limit");
        pending.push(...object.asArray());
      } else if (object instanceof PDFDict) {
        for (const [key, value] of object.entries()) {
          if (ACTIVE.has(nameText(key))) reject("active-content");
          pending.push(value);
        }
      } else if (object instanceof PDFRawStream) {
        pending.push(object.dict);
        const filter = object.dict.lookup(PDFName.of("Filter"));
        if (filter instanceof PDFName && nameText(filter) === "DCTDecode") {
          await inspectPrivateRaster(Buffer.from(object.contents), "jpeg", budget);
        } else {
          // Unsupported codecs fail closed. Every ordinary compressed stream,
          // including streams not referenced by a page, is actually decoded.
          decodePDFRawStream(object).decode();
        }
      }
    }
  } catch (error) {
    if (/^private-file-(?:pdf|image)-[a-z-]+$/.test(error?.message)) throw error;
    reject("invalid");
  } finally {
    prototype.ensureBuffer = original;
    inspecting = false;
  }
}
