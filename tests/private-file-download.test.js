// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { downloadPrivateObjectBytes } from "../api/_lib/privateFileDownload.js";

const backend = { url: "https://project.supabase.co", serviceRoleKey: "synthetic-service-key" };
const target = { bucketId: "case-files", objectName: "owner/case/file/notes.txt", sizeBytes: 5 };
const signal = AbortSignal.timeout(10000);

describe("bounded private object download", () => {
  it.each([
    [["sb", "secret", "synthetic-example"].join("_"), null, "UnionGround-Server/1.0"],
    ["synthetic-legacy-service-jwt", "Bearer synthetic-legacy-service-jwt", null],
  ])("downloads with the correct credential transport for %s", async (serviceRoleKey, authorization, userAgent) => {
    const fetcher = vi.fn(async () => new Response("hello"));
    await expect(downloadPrivateObjectBytes({ ...backend, serviceRoleKey }, target, { fetch: fetcher, signal }))
      .resolves.toEqual(Buffer.from("hello"));
    const headers = new Headers(fetcher.mock.calls[0][1].headers);
    expect(headers.get("apikey")).toBe(serviceRoleKey);
    expect(headers.get("authorization")).toBe(authorization);
    expect(headers.get("user-agent")).toBe(userAgent);
  });

  it("reads the authorized exact path with server credentials and no redirects", async () => {
    const fetcher = vi.fn(async () => new Response("hello", { headers: { "content-length": "5" } }));
    const result = await downloadPrivateObjectBytes(backend, target, { fetch: fetcher, signal });
    expect(result).toEqual(Buffer.from("hello"));
    expect(fetcher).toHaveBeenCalledWith("https://project.supabase.co/storage/v1/object/authenticated/case-files/owner/case/file/notes.txt", {
      method: "GET", redirect: "error", signal,
      headers: { apikey: "synthetic-service-key", Authorization: "Bearer synthetic-service-key" },
    });
  });

  it("checks an existing digest rather than accepting different stored bytes", async () => {
    const exact = { ...target, sha256: createHash("sha256").update("hello").digest("hex") };
    await expect(downloadPrivateObjectBytes(backend, exact, { signal, fetch: async () => new Response("hello") })).resolves.toEqual(Buffer.from("hello"));
    await expect(downloadPrivateObjectBytes(backend, exact, { signal, fetch: async () => new Response("other") })).rejects.toThrow(/digest/);
  });

  it.each(["0", "6", "10485761", "not-a-number", "5.0"]) ("rejects invalid or mismatching content lengths before consuming a body", async (length) => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("hello")); }, cancel });
    await expect(downloadPrivateObjectBytes(backend, target, { signal, fetch: async () => new Response(stream, { headers: { "content-length": length } }) })).rejects.toThrow(/size/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an oversized chunked stream at the registered bound", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("hello!")); }, cancel });
    await expect(downloadPrivateObjectBytes(backend, target, { signal, fetch: async () => new Response(stream) })).rejects.toThrow(/size/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects truncated bytes and hides upstream error bodies", async () => {
    await expect(downloadPrivateObjectBytes(backend, target, { signal, fetch: async () => new Response("hi") })).rejects.toThrow(/size/);
    await expect(downloadPrivateObjectBytes(backend, target, { signal, fetch: async () => new Response("upstream secret or file content", { status: 403 }) })).rejects.toThrow(/^private-file-storage-unavailable$/);
  });

  it.each(["../escape", "folder/../escape", "folder/./file", "/absolute", "folder//file", "folder\\file"]) ("rejects noncanonical paths before a privileged fetch", async (objectName) => {
    const fetcher = vi.fn();
    await expect(downloadPrivateObjectBytes(backend, { ...target, objectName }, { signal, fetch: fetcher })).rejects.toThrow(/target/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires a bounded registered size, known private bucket and live signal", async () => {
    const fetcher = vi.fn();
    for (const invalid of [{ ...target, sizeBytes: 10485761 }, { ...target, sizeBytes: 0 }, { ...target, bucketId: "public" }]) {
      await expect(downloadPrivateObjectBytes(backend, invalid, { signal, fetch: fetcher })).rejects.toThrow(/target/);
    }
    await expect(downloadPrivateObjectBytes(backend, target, { fetch: fetcher })).rejects.toThrow(/budget/);
    await expect(downloadPrivateObjectBytes(backend, target, { signal: AbortSignal.abort(), fetch: fetcher })).rejects.toThrow(/budget/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps upstream stream failures private even when cancellation also fails", async () => {
    const stream = new ReadableStream({ start(controller) { controller.error(new Error("upstream private document path")); } });
    await expect(downloadPrivateObjectBytes(backend, target, { signal, fetch: async () => new Response(stream) })).rejects.toThrow(/^private-file-storage-unavailable$/);
  });

  it.each([403, 200])("preserves the safe rejection when a refused response cannot be cancelled", async (status) => {
    const stream = new ReadableStream({ cancel() { throw new Error("upstream private transport detail"); } });
    await expect(downloadPrivateObjectBytes(backend, target, { signal, fetch: async () => new Response(stream, {
      status, headers: { "content-length": "6" },
    }) })).rejects.toThrow(status === 403 ? /^private-file-storage-unavailable$/ : /^private-file-storage-size$/);
  });

  it("cancels a stalled body on abort without leaking cancellation errors", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream({ cancel() { throw new Error("upstream private cancellation detail"); } });
    const pending = downloadPrivateObjectBytes(backend, target, {
      signal: controller.signal, fetch: async () => new Response(stream),
    });
    await Promise.resolve(); // Let the fetch resolve and the body reader start.
    controller.abort();
    await expect(pending).rejects.toThrow(/^private-file-storage-budget$/);
  });

  // The coverage ratchet pins these branches deterministically: a transport
  // failure, an abort that lands while the request is in flight, the loopback
  // http origin the local stack uses, and the public /contribute bucket.
  it("hides a transport failure behind the fixed unavailable code", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("connect ECONNREFUSED 10.0.0.1:443 private detail"); });
    await expect(downloadPrivateObjectBytes(backend, target, { signal, fetch: fetcher })).rejects.toThrow(/^private-file-storage-unavailable$/);
  });

  it("refuses with the budget code when the signal aborts while the request is in flight", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => {
      controller.abort();
      return new Response(new ReadableStream({ cancel }), { headers: { "content-length": "5" } });
    });
    await expect(downloadPrivateObjectBytes(backend, target, { signal: controller.signal, fetch: fetcher })).rejects.toThrow(/^private-file-storage-budget$/);
    expect(cancel).toHaveBeenCalled();
  });

  it("accepts the loopback http origin of the local stack and refuses any other http origin", async () => {
    const fetcher = vi.fn(async () => new Response("hello"));
    await expect(downloadPrivateObjectBytes({ ...backend, url: "http://127.0.0.1:54321" }, target, { signal, fetch: fetcher }))
      .resolves.toEqual(Buffer.from("hello"));
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:54321/storage/v1/object/authenticated/case-files/owner/case/file/notes.txt");
    await expect(downloadPrivateObjectBytes({ ...backend, url: "http://project.supabase.co" }, target, { signal, fetch: fetcher }))
      .rejects.toThrow(/^private-file-storage-target$/);
  });

  // REQ-UG-UNION-DOCUMENT-INTAKE-PAGE-20261022: the public /contribute
  // bucket is readable here, for targets its inspection lease names.
  it("reads the union-document-contributions bucket and still refuses an unknown one", async () => {
    const fetcher = vi.fn(async () => new Response("hello"));
    const contribution = { bucketId: "union-document-contributions", objectName: "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", sizeBytes: 5 };
    await expect(downloadPrivateObjectBytes(backend, contribution, { signal, fetch: fetcher })).resolves.toEqual(Buffer.from("hello"));
    expect(fetcher.mock.calls[0][0]).toBe(`https://project.supabase.co/storage/v1/object/authenticated/union-document-contributions/${contribution.objectName}`);
    await expect(downloadPrivateObjectBytes(backend, { ...contribution, bucketId: "union-documents" }, { signal, fetch: fetcher }))
      .rejects.toThrow(/^private-file-storage-target$/);
  });
});
