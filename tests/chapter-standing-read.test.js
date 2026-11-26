// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  CHAPTER_STANDING_RETRY_DELAY_MS,
  loadChapterStandingWithRetry,
  shouldRetryChapterStanding,
} from "../src/lib/chapterStandingRead.js";

describe("bounded chapter-standing read recovery", () => {
  it("waits once and recovers an upstream HTTP 500 without changing the result shape", async () => {
    const recovered = { data: { enoughData: true, standingBand: "top25" }, error: null, status: 200 };
    const client = {
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: null, error: { message: "upstream request timeout" }, status: 500 })
        .mockResolvedValueOnce(recovered),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(loadChapterStandingWithRetry(client, { wait })).resolves.toBe(recovered);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(client.rpc).toHaveBeenNthCalledWith(1, "get_chapter_standing");
    expect(client.rpc).toHaveBeenNthCalledWith(2, "get_chapter_standing");
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(CHAPTER_STANDING_RETRY_DELAY_MS);
  });

  it("does not retry authorization, validation, or other definitive failures", async () => {
    for (const result of [
      { data: null, error: { message: "authentication required", code: "42501" }, status: 403 },
      { data: null, error: { message: "bad request", code: "22023" }, status: 400 },
    ]) {
      const client = { rpc: vi.fn().mockResolvedValue(result) };
      const wait = vi.fn();
      await expect(loadChapterStandingWithRetry(client, { wait })).resolves.toBe(result);
      expect(client.rpc).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
    }
  });

  it("stops after the single bounded retry when the upstream remains unavailable", async () => {
    const unavailable = { data: null, error: { message: "gateway timeout", code: "PGRST003" }, status: 504 };
    const client = { rpc: vi.fn().mockResolvedValue(unavailable) };
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(loadChapterStandingWithRetry(client, { wait })).resolves.toBe(unavailable);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("uses the bounded default timer and degrades a rejected retry into the RPC result shape", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        rpc: vi.fn()
          .mockResolvedValueOnce({
            data: null,
            error: { message: "connection reset by peer", code: "08006" },
            status: 0,
          })
          .mockRejectedValueOnce(new Error("upstream transport unavailable")),
      };

      const resultPromise = loadChapterStandingWithRetry(client);
      await vi.advanceTimersByTimeAsync(CHAPTER_STANDING_RETRY_DELAY_MS);

      await expect(resultPromise).resolves.toMatchObject({
        data: null,
        error: { message: "upstream transport unavailable" },
        status: 0,
      });
      expect(client.rpc).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes a primitive transport rejection without retrying a third time", async () => {
    const client = {
      rpc: vi.fn()
        .mockRejectedValueOnce("gateway temporarily unavailable")
        .mockResolvedValueOnce({ data: null, error: { message: "still unavailable" }, status: 503 }),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(loadChapterStandingWithRetry(client, { wait })).resolves.toMatchObject({ status: 503 });
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  it("recognizes only retry-safe transient response classes", () => {
    expect(shouldRetryChapterStanding({ error: {}, status: 429 })).toBe(true);
    expect(shouldRetryChapterStanding({ error: {}, status: 503 })).toBe(true);
    expect(shouldRetryChapterStanding({ error: { code: "PGRST003" } })).toBe(true);
    expect(shouldRetryChapterStanding({ error: { code: "57014" } })).toBe(true);
    expect(shouldRetryChapterStanding({ error: { message: "temporarily unavailable upstream" } })).toBe(true);
    expect(shouldRetryChapterStanding({ error: { message: "Failed to fetch" } })).toBe(true);
    expect(shouldRetryChapterStanding({ error: { message: "NetworkError when attempting to fetch resource" } })).toBe(true);
    expect(shouldRetryChapterStanding({ error: { message: "Load failed" } })).toBe(true);
    expect(shouldRetryChapterStanding({ error: { code: "42501" }, status: 403 })).toBe(false);
    expect(shouldRetryChapterStanding({ data: {}, error: null, status: 200 })).toBe(false);
  });
});
