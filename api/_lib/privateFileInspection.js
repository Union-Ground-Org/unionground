import { Worker } from "node:worker_threads";
import { PRIVATE_FILE_MAX_BYTES } from "./privateFileSafety.js";

const WORKER = new URL("./privateFileInspectionWorker.js", import.meta.url);

/** All request paths use this isolation boundary, including when inspecting
 * images inside Office archives. A request-thread Promise race cannot stop a
 * synchronous hostile parser; this timer can terminate its dedicated worker. */
export async function inspectPrivateFileInWorker(bytes, metadata, { signal, timeoutMs = 3000 } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > PRIVATE_FILE_MAX_BYTES) throw new Error("private-file-size");
  if (signal?.aborted || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("private-file-inspection-budget");
  const input = Uint8Array.from(bytes);
  return new Promise((resolve, reject) => {
    let worker;
    let timer;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker?.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new Error("private-file-inspection-budget"));
    timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      worker = new Worker(WORKER, {
        workerData: { bytes: input.buffer, metadata: {
          filename: metadata?.filename, mimeType: metadata?.mimeType, expectedSize: metadata?.expectedSize,
        } }, transferList: [input.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
    } catch { finish(new Error("private-file-inspection-failed")); return; }
    worker.once("message", (message) => {
      if (message?.ok) finish(null, message.result);
      else finish(new Error(/^private-file-[a-z-]{1,80}$/.test(message?.error) ? message.error : "private-file-inspection-failed"));
    });
    worker.once("error", () => finish(new Error("private-file-inspection-failed")));
    worker.once("exit", () => finish(new Error("private-file-inspection-failed")));
    if (signal?.aborted) abort();
  });
}
