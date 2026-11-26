import { parentPort, workerData } from "node:worker_threads";
import { extractKnowledgeTextInProcess } from "./knowledgeIngest.js";

if (!parentPort) throw new Error("knowledge-extraction-worker-failed");

try {
  const text = await extractKnowledgeTextInProcess(
    new Uint8Array(workerData.bytes),
    workerData.fileName,
    workerData.mimeType,
  );
  parentPort.postMessage({ ok: true, text });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: String(error?.message || "knowledge-ingest-failed").slice(0, 120),
  });
} finally {
  parentPort.close();
}
