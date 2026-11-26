import { parentPort, workerData } from "node:worker_threads";
import { inspectPrivateFileBytes } from "./privateFileSafety.js";

if (!parentPort) throw new Error("private-file-inspection-failed");
try {
  const result = await inspectPrivateFileBytes(new Uint8Array(workerData.bytes), workerData.metadata);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: /^private-file-[a-z-]{1,80}$/.test(error?.message)
    ? error.message : "private-file-inspection-failed" });
} finally { parentPort.close(); }
