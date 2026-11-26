// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectPrivateFileInWorker } from "../api/_lib/privateFileInspection.js";

const file = { filename: "synthetic.txt", mimeType: "text/plain", expectedSize: 5 };

describe("isolated private file inspection", () => {
  it("validates a private copy in a real worker while preserving caller bytes", async () => {
    const bytes = Buffer.from("hello");
    const pending = inspectPrivateFileInWorker(bytes, file);
    bytes.fill(65);
    await expect(pending).resolves.toEqual({ profile: "structure-only", mimeType: "text/plain", sizeBytes: 5, sha256: createHash("sha256").update("hello").digest("hex") });
    expect(bytes.toString()).toBe("AAAAA");
  });
  it("returns only a fixed validation code for hostile data", async () => {
    await expect(inspectPrivateFileInWorker(Buffer.from("MZbad"), file)).rejects.toThrow(/^private-file-executable$/);
  });
  it("terminates parsing when the parent signal is cancelled", async () => {
    const controller = new AbortController();
    const pending = inspectPrivateFileInWorker(Buffer.from("hello"), file, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/budget/);
  });
  it("enforces a timer that is independent of the worker event loop", async () => {
    await expect(inspectPrivateFileInWorker(Buffer.from("hello"), file, { timeoutMs: 1 })).rejects.toThrow(/budget/);
  });
  it("rejects invalid or pre-cancelled invocations before parsing", async () => {
    await expect(inspectPrivateFileInWorker(Buffer.alloc(0), file)).rejects.toThrow(/size/);
    await expect(inspectPrivateFileInWorker(Buffer.from("hello"), file, { timeoutMs: 1000000 })).rejects.toThrow(/budget/);
    await expect(inspectPrivateFileInWorker(Buffer.from("hello"), file, { signal: AbortSignal.abort() })).rejects.toThrow(/budget/);
  });
});
