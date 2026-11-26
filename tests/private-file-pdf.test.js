// @vitest-environment node
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { inspectPrivateFileBytes } from "../api/_lib/privateFileSafety.js";
import { inspectPrivateFileInWorker } from "../api/_lib/privateFileInspection.js";

const metadata = (bytes) => ({ filename: "document.pdf", mimeType: "application/pdf", expectedSize: bytes.length });
const inspect = (bytes) => inspectPrivateFileBytes(bytes, metadata(bytes));
async function pdf(change = () => {}, objectStreams = true) {
  const doc = await PDFDocument.create();
  doc.addPage().drawText("Synthetic document");
  await change(doc);
  return Buffer.from(await doc.save({ useObjectStreams: objectStreams }));
}

describe("private PDF structure and active-content inspection", () => {
  it.each([true, false])("parses an ordinary PDF with object streams %s", async (objectStreams) => {
    const bytes = await pdf(undefined, objectStreams);
    await expect(inspect(bytes)).resolves.toMatchObject({ profile: "structure-only", mimeType: "application/pdf" });
    await expect(inspectPrivateFileInWorker(bytes, metadata(bytes))).resolves.toMatchObject({ sizeBytes: bytes.length });
  });

  it.each([true, false])("rejects JavaScript and attachments, including inside compressed objects %s", async (objectStreams) => {
    const script = await pdf((doc) => doc.addJavaScript("synthetic", "void 0"), objectStreams);
    await expect(inspect(script)).rejects.toThrow(/pdf-active/);
    const attachment = await pdf((doc) => doc.attach(Buffer.from("synthetic"), "attachment.txt"), objectStreams);
    await expect(inspect(attachment)).rejects.toThrow(/pdf-active/);
  });

  it.each(["Launch", "GoToR", "SubmitForm", "ImportData", "RichMedia", "XFA"])("rejects %s actions hidden in indirect dictionaries", async (action) => {
    const bytes = await pdf((doc) => {
      const ref = doc.context.register(doc.context.obj({ S: PDFName.of(action), F: PDFString.of("synthetic") }));
      doc.catalog.set(PDFName.of("SyntheticAction"), ref);
    });
    await expect(inspect(bytes)).rejects.toThrow(/pdf-active/);
  });

  it("rejects encoded action names rather than scanning raw strings alone", async () => {
    const bytes = await pdf((doc) => doc.addJavaScript("synthetic", "void 0"), false);
    const encoded = Buffer.from(bytes.toString("latin1").replaceAll("/JavaScript", "/J#61vaScript"));
    await expect(inspect(encoded)).rejects.toThrow(/pdf-active/);
  });

  it("rejects malformed, truncated and trailing content", async () => {
    const bytes = await pdf();
    for (const corrupt of [Buffer.from("%PDF-1.7\n%%EOF"), bytes.subarray(0, -20), Buffer.concat([bytes, Buffer.from("MZsynthetic")])]) {
      await expect(inspect(corrupt)).rejects.toThrow(/pdf/);
    }
  });

  it("enforces a cumulative decompression allocation limit, including object-stream parsing", async () => {
    const bytes = await pdf((doc) => {
      const raw = doc.context.stream(deflateSync(Buffer.alloc(32 * 1024 * 1024, 32)), { Filter: "FlateDecode" });
      doc.catalog.set(PDFName.of("SyntheticStream"), doc.context.register(raw));
    });
    await expect(inspectPrivateFileInWorker(bytes, metadata(bytes))).rejects.toThrow(/pdf-(expanded-size|invalid)|inspection-budget/);
  });

  it("rejects excessive page counts", async () => {
    const bytes = await pdf((doc) => { for (let index = 0; index < 300; index += 1) doc.addPage(); });
    await expect(inspect(bytes)).rejects.toThrow(/pdf-page-limit/);
  });
});
