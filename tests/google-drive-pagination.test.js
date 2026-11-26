// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { listGoogleDriveFiles } from "../api/_lib/googleDrive.js";

const input = { accessToken: "fixture-access", rootFolderId: "authorized-folder" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.useRealTimers());

describe("complete bounded Drive folder listings", () => {
  it("includes the 101st file and preserves the authorized folder and projection on every page", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply({
        files: Array.from({ length: 100 }, (_, index) => ({ id: `recent-${index}`, name: "Recent evidence" })),
        nextPageToken: "older-page",
      }))
      .mockResolvedValueOnce(reply({ files: [{
        id: "older-file-101", name: "x".repeat(250), mimeType: "text/plain", size: "12",
        modifiedTime: "2026-10-01", webViewLink: "javascript:bad", privateField: "omit",
      }] }));
    const files = await listGoogleDriveFiles({ ...input, fetchImpl });
    expect(files).toHaveLength(101);
    expect(files[100]).toEqual({
      id: "older-file-101", name: "x".repeat(200), mimeType: "text/plain", size: 12,
      modifiedTime: "2026-10-01", webViewLink: null,
    });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get("pageToken")))
      .toEqual([null, "older-page"]);
    for (const [url] of fetchImpl.mock.calls) {
      const params = new URL(url).searchParams;
      expect(params.get("q")).toBe("'authorized-folder' in parents and trashed=false");
      expect(params.get("fields")).toBe("nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,webViewLink)");
      expect(params.get("orderBy")).toBe("modifiedTime desc");
      expect(params.get("pageSize")).toBe("100");
    }
  });

  it("continues through empty provider pages even when files is omitted", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply({ files: [], nextPageToken: "empty-page" }))
      .mockResolvedValueOnce(reply({ nextPageToken: "last-page" }))
      .mockResolvedValueOnce(reply({ files: [{ id: "reachable" }] }));
    expect(await listGoogleDriveFiles({ ...input, fetchImpl })).toEqual([expect.objectContaining({ id: "reachable" })]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([["same", "same"], ["one", "two", "one"]])("refuses repeated continuation tokens: %j", async (...tokens) => {
    const fetchImpl = vi.fn();
    for (const token of tokens) fetchImpl.mockResolvedValueOnce(reply({ files: [], nextPageToken: token }));
    await expect(listGoogleDriveFiles({ ...input, fetchImpl }))
      .rejects.toMatchObject({ message: "google-drive-list-incomplete", status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(tokens.length);
  });

  it("refuses a folder still incomplete after 20 pages instead of returning a partial array", async () => {
    const fetchImpl = vi.fn(async () => reply({ files: [{ id: "file" }], nextPageToken: `page-${fetchImpl.mock.calls.length}` }));
    await expect(listGoogleDriveFiles({ ...input, fetchImpl }))
      .rejects.toMatchObject({ message: "google-drive-list-incomplete", status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(20);
  });

  it("refuses more than 2000 files without exposing a partial list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply({ files: Array.from({ length: 2001 }, () => ({ id: "file" })) }));
    await expect(listGoogleDriveFiles({ ...input, fetchImpl }))
      .rejects.toMatchObject({ message: "google-drive-list-incomplete", status: 502 });
  });

  it.each([
    null, [], { files: "not-an-array" }, { files: [], incompleteSearch: true },
    { files: [], nextPageToken: 123 }, { files: [], nextPageToken: "x".repeat(4097) },
  ])("refuses invalid or explicitly incomplete provider results: %j", async body => {
    await expect(listGoogleDriveFiles({ ...input, fetchImpl: vi.fn().mockResolvedValue(reply(body)) }))
      .rejects.toMatchObject({ message: "google-drive-list-incomplete", status: 502 });
  });

  it("refuses malformed JSON instead of presenting an empty complete folder", async () => {
    await expect(listGoogleDriveFiles({ ...input, fetchImpl: vi.fn().mockResolvedValue(new Response("{bad")) }))
      .rejects.toMatchObject({ message: "google-drive-list-incomplete", status: 502 });
  });

  it("fails the entire listing when a later provider page fails", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply({ files: [{ id: "first-page" }], nextPageToken: "second" }))
      .mockResolvedValueOnce(reply({ error: { status: "UNAVAILABLE" } }, 503));
    await expect(listGoogleDriveFiles({ ...input, fetchImpl }))
      .rejects.toMatchObject({ message: "google-drive-list-failed", status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(["headers", "body"])("bounds stalled %s by the shared 15-second listing deadline", async stage => {
    vi.useFakeTimers();
    const stalled = new Promise(() => {});
    const fetchImpl = vi.fn(() => stage === "headers" ? stalled : Promise.resolve({ ok: true, text: () => stalled }));
    const checked = expect(listGoogleDriveFiles({ ...input, fetchImpl }))
      .rejects.toMatchObject({ message: "google-drive-list-timeout", status: 504 });
    await vi.advanceTimersByTimeAsync(15_000);
    await checked;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not restart the deadline on the next page", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(reply({ files: [], nextPageToken: "second" })), 10_000)))
      .mockImplementationOnce(() => new Promise(() => {}));
    const checked = expect(listGoogleDriveFiles({ ...input, fetchImpl }))
      .rejects.toMatchObject({ message: "google-drive-list-timeout", status: 504 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].signal).toBe(fetchImpl.mock.calls[0][1].signal);
    await vi.advanceTimersByTimeAsync(5_000);
    await checked;
    expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(true);
  });

  it("clears the deadline after a complete folder response", async () => {
    vi.useFakeTimers();
    expect(await listGoogleDriveFiles({ ...input, fetchImpl: vi.fn().mockResolvedValue(reply({ files: [] })) })).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
