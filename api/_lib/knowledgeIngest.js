import { strFromU8, unzipSync } from "fflate";
import { Worker } from "node:worker_threads";
import { extractText as extractPdfText } from "unpdf";
import { rtfText } from "./knowledgeRtf.js";
import { xlsxText } from "./knowledgeXlsx.js";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 2000;
const CHUNK_SIZE = 6000;
const CHUNK_OVERLAP = 240;
const EXTRACTION_WORKER_URL = new URL("./knowledgeExtractWorker.js", import.meta.url);

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function xmlText(value) {
  return decodeEntities(value
    .replace(/<(?:w:tab|a:tab)[^>]*\/>/g, "\t")
    .replace(/<\/(?:w:p|a:p|row)>/g, "\n")
    .replace(/<[^>]+>/g, " "));
}

function normalized(value) {
  return String(value || "")
    .replaceAll(String.fromCharCode(0), "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function archiveText(bytes, extension) {
  let archiveFileCount = 0;
  let declaredUncompressedBytes = 0;
  const wanted = (name) => {
    if (extension === "docx") return /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name);
    if (extension === "pptx") return /^ppt\/slides\/slide\d+\.xml$/.test(name);
    return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
  };
  const entries = unzipSync(new Uint8Array(bytes), {
    filter: (entry) => {
      archiveFileCount += 1;
      declaredUncompressedBytes += entry.originalSize;
      if (archiveFileCount > MAX_ARCHIVE_FILES) throw new Error("knowledge-archive-too-many-files");
      if (declaredUncompressedBytes > MAX_UNZIPPED_BYTES) throw new Error("knowledge-archive-too-large");
      return wanted(entry.name);
    },
  });
  const names = Object.keys(entries);
  const uncompressedBytes = names.reduce((total, name) => total + entries[name].byteLength, 0);
  if (uncompressedBytes > MAX_UNZIPPED_BYTES) throw new Error("knowledge-archive-too-large");
  const selected = names.filter(wanted);
  selected.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  if (!selected.length) throw new Error("knowledge-office-content-missing");
  if (extension === "xlsx") {
    const sheets = selected.filter(name => name !== "xl/sharedStrings.xml");
    if (!sheets.length) throw new Error("knowledge-office-content-missing");
    return normalized(xlsxText(entries["xl/sharedStrings.xml"] ? strFromU8(entries["xl/sharedStrings.xml"]) : undefined,
      sheets.map(name => strFromU8(entries[name]))));
  }
  return normalized(selected.map((name) => xmlText(strFromU8(entries[name]))).join("\n\n"));
}

// CONVERSION PROVENANCE (REQ-UG-DOCUMENT-CONVERSION-PROVENANCE-20260904).
//
// An operator asked, months later, which bytes and which converter produced the
// clause a model quoted has to be able to get an answer. That answer needs three
// things this module is the only place that knows: the input format it selected,
// the library that parsed it, and that library's version.
//
// The versions are constants rather than a runtime read of the installed
// package. A bundled serverless function has no reliable path to a dependency's
// package.json, and a provenance field that resolves to "unknown" in production
// is worse than no field at all. tests/knowledge-ingest.test.js asserts every
// constant here equals the version package-lock.json actually resolves, so the
// drift these constants could develop is caught by a required test rather than
// discovered during an incident.
export const KNOWLEDGE_CONVERTERS = Object.freeze({
  pdf: Object.freeze({ name: "unpdf", version: "1.9.1" }),
  docx: Object.freeze({ name: "fflate", version: "0.8.3" }),
  pptx: Object.freeze({ name: "fflate", version: "0.8.3" }),
  xlsx: Object.freeze({ name: "fflate-saxes", version: "0.8.3+6.0.0" }),
  rtf: Object.freeze({ name: "union-ground-rtf", version: "2" }),
  txt: Object.freeze({ name: "union-ground-text", version: "1" }),
  csv: Object.freeze({ name: "union-ground-text", version: "1" }),
});

// Bump this when THIS repository's extraction, normalization or chunking
// behaviour changes, even if no dependency moved. Two runs of unpdf 1.8.1 can
// still produce different stored text if the code around it changed, and a
// ledger that could not say so would be quietly wrong in the one case it exists
// to explain.
export const KNOWLEDGE_PIPELINE_VERSION = "2026.10.23";

// The same decision extractKnowledgeTextInProcess makes, as a pure function, so
// the request handler can record what will be used without re-reading bytes and
// without the worker protocol having to carry it back.
export function resolveKnowledgeConverter(fileName = "", mimeType = "") {
  const extension = String(fileName).toLowerCase().split(".").pop();
  let format = null;
  if (extension === "pdf" || mimeType === "application/pdf") format = "pdf";
  else if (["docx", "pptx", "xlsx"].includes(extension)) format = extension;
  else if (extension === "rtf" || mimeType === "application/rtf") format = "rtf";
  else if (["txt", "csv"].includes(extension)) format = extension;
  else if (/^text\//.test(mimeType)) format = "txt";
  if (!format) return null;
  const converter = KNOWLEDGE_CONVERTERS[format];
  return {
    sourceFormat: format,
    converterName: converter.name,
    converterVersion: converter.version,
    pipelineVersion: KNOWLEDGE_PIPELINE_VERSION,
  };
}

export async function extractKnowledgeTextInProcess(bytes, fileName = "", mimeType = "") {
  const input = Buffer.from(bytes);
  if (!input.length || input.length > MAX_INPUT_BYTES) throw new Error("knowledge-file-size-invalid");
  const extension = String(fileName).toLowerCase().split(".").pop();
  let text;
  if (extension === "pdf" || mimeType === "application/pdf") {
    if (input.subarray(0, 5).toString() !== "%PDF-") throw new Error("knowledge-pdf-signature-invalid");
    const extracted = await extractPdfText(new Uint8Array(input), { mergePages: true });
    text = extracted.text;
  } else if (["docx", "pptx", "xlsx"].includes(extension)) {
    if (input[0] !== 0x50 || input[1] !== 0x4b) throw new Error("knowledge-office-signature-invalid");
    text = archiveText(input, extension);
  } else if (extension === "rtf" || mimeType === "application/rtf") {
    text = rtfText(input);
  } else if (["txt", "csv"].includes(extension) || /^text\//.test(mimeType)) {
    text = normalized(new TextDecoder().decode(input));
  } else {
    throw new Error("knowledge-file-type-not-ingestible");
  }
  const clean = normalized(Array.isArray(text) ? text.join("\n\n") : text);
  if (!clean) throw new Error("knowledge-file-no-extractable-text");
  return clean;
}

function extractionBudgetError() {
  return new Error("knowledge-ingest-time-budget");
}

// PDF.js parsing and Office decompression can hold one event-loop turn, so a
// Promise race in the request thread cannot enforce its timer. Isolating that
// work lets the request thread terminate it and spend the reserved budget on
// recording the source failure.
function extractKnowledgeTextInWorker(bytes, fileName, mimeType, signal) {
  if (signal.aborted) throw extractionBudgetError();
  const input = Uint8Array.from(bytes);
  const worker = new Worker(EXTRACTION_WORKER_URL, {
    workerData: { bytes: input.buffer, fileName, mimeType },
    transferList: [input.buffer],
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => {});
      callback(value);
    };
    const onAbort = () => finish(reject, extractionBudgetError());

    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message) => {
      if (message?.ok && typeof message.text === "string") finish(resolve, message.text);
      else finish(reject, new Error(String(message?.error || "knowledge-extraction-worker-failed")));
    });
    worker.once("error", () => finish(reject, new Error("knowledge-extraction-worker-failed")));
    worker.once("exit", () => finish(reject, new Error("knowledge-extraction-worker-failed")));
    if (signal.aborted) onAbort();
  });
}

// Supplying a signal moves all parser work to a worker that can be terminated
// while PDF or ZIP processing is still running. The ingest API always supplies
// its shared request-budget signal; direct unit callers may omit it.
export async function extractKnowledgeText(bytes, fileName = "", mimeType = "", { signal } = {}) {
  const input = Buffer.from(bytes);
  if (!input.length || input.length > MAX_INPUT_BYTES) throw new Error("knowledge-file-size-invalid");
  return signal
    ? extractKnowledgeTextInWorker(input, fileName, mimeType, signal)
    : extractKnowledgeTextInProcess(input, fileName, mimeType);
}

export function chunkKnowledgeText(value) {
  const text = normalized(value);
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < 500) {
    let end = Math.min(text.length, start + CHUNK_SIZE);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf("\n\n", end), text.lastIndexOf(". ", end));
      if (boundary > start + CHUNK_SIZE / 2) end = boundary + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) { start = text.length; break; }
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  if (start < text.length) throw new Error("knowledge-file-too-much-text");
  return chunks.filter(Boolean);
}

export function publicIngestError(error) {
  const code = String(error?.message || "knowledge-ingest-failed");
  return /^knowledge-[a-z0-9-]+$/.test(code) ? code.slice(0, 120) : "knowledge-ingest-failed";
}
