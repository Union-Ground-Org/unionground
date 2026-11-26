// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ingest, installIngestBackend, resetIngestBackend } from "./helpers/knowledge-ingest.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

afterEach(resetIngestBackend);

it("does not begin an authorization or privileged read after its operation budget expires", async () => {
  const calls = installIngestBackend();
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(49_600);
  expect(await ingest()).toMatchObject({ statusCode: 403, body: { error: "not authorized" } });
  expect(calls).toEqual([]);
});
