// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

const envelope = vi.hoisted(() => ({ port: null, data: null }));
vi.mock("node:worker_threads", () => ({
  get parentPort() { return envelope.port; },
  get workerData() { return envelope.data; },
}));
beforeEach(() => {
  vi.resetModules();
  envelope.port = { postMessage: vi.fn(), close: vi.fn() };
  envelope.data = { bytes: Uint8Array.from(Buffer.from("hello")).buffer,
    metadata: { filename: "synthetic.txt", mimeType: "text/plain", expectedSize: 5 } };
});

// Real-thread tests cover isolation. These exercise the entrypoint's message
// boundary in the instrumented process, including malformed IPC envelopes.
it("emits only the validated descriptor and closes its port", async () => {
  await import("../api/_lib/privateFileInspectionWorker.js");
  expect(envelope.port.postMessage).toHaveBeenCalledWith({ ok: true, result: {
    profile: "structure-only", mimeType: "text/plain", sizeBytes: 5, sha256: createHash("sha256").update("hello").digest("hex"),
  } });
  expect(envelope.port.close).toHaveBeenCalledOnce();
});

it("preserves a fixed validation error without sending the input", async () => {
  envelope.data.bytes = Uint8Array.from(Buffer.from("MZbad")).buffer;
  await import("../api/_lib/privateFileInspectionWorker.js");
  expect(envelope.port.postMessage).toHaveBeenCalledWith({ ok: false, error: "private-file-executable" });
  expect(envelope.port.close).toHaveBeenCalledOnce();
});

it("sanitizes an invalid IPC envelope that fails before the validator", async () => {
  envelope.data.bytes = -1;
  await import("../api/_lib/privateFileInspectionWorker.js");
  expect(envelope.port.postMessage).toHaveBeenCalledWith({ ok: false, error: "private-file-inspection-failed" });
  expect(envelope.port.close).toHaveBeenCalledOnce();
});

it("refuses execution without a worker message port", async () => {
  envelope.port = null;
  await expect(import("../api/_lib/privateFileInspectionWorker.js")).rejects.toThrow(/^private-file-inspection-failed$/);
});
