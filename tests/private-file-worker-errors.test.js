// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ event: "error" }));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit(state.event, state.event === "error" ? new Error("private worker installation path") : 1));
    }
    terminate() { return Promise.reject(new Error("private termination detail")); }
  },
}));
import { inspectPrivateFileInWorker } from "../api/_lib/privateFileInspection.js";

describe("inspection worker lifecycle failures", () => {
  it.each(["error", "exit"])("fails closed on worker %s and suppresses a secondary termination failure", async (event) => {
    state.event = event;
    await expect(inspectPrivateFileInWorker(Buffer.from("hello"), {
      filename: "synthetic.txt", mimeType: "text/plain", expectedSize: 5,
    })).rejects.toThrow(/^private-file-inspection-failed$/);
  });
});
