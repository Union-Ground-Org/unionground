// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ event: "error", instances: [] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    constructor() {
      super();
      this.terminate = vi.fn(async () => 1);
      failure.instances.push(this);
      queueMicrotask(() => this.emit(failure.event, failure.event === "error" ? new Error("private parser detail") : 1));
    }
  } };
});
import { extractKnowledgeText } from "../api/_lib/knowledgeIngest.js";

describe("knowledge extraction worker infrastructure failures", () => {
  it.each(["error", "exit"])("rejects a worker %s before any result without exposing parser details", async (event) => {
    failure.event = event;
    const result = extractKnowledgeText(Buffer.from(String.raw`{\rtf1\ansi Pay \'31\'30\'30 dollars.}`), "policy.rtf", "application/rtf", {
      signal: new AbortController().signal,
    });
    await expect(result).rejects.toThrow(/^knowledge-extraction-worker-failed$/u);
    expect(failure.instances.at(-1).terminate).toHaveBeenCalledOnce();
  });
});
