// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ingest, installIngestBackend, resetIngestBackend } from "./helpers/knowledge-ingest.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

afterEach(resetIngestBackend);

it.each([undefined, "not-a-file-id"])("refuses an authorized target with invalid inspection identity %s", async fileId => {
  const calls = installIngestBackend({ fileId });
  expect(await ingest()).toMatchObject({ statusCode: 422, body: { error: "knowledge-verdict-unavailable" } });
  expect(calls.map(call => call.name)).toEqual(["authorize_knowledge_ingest", "replace_knowledge_source_chunks"]);
  expect(calls[1].body).toMatchObject({ p_chunks: [], p_error_code: "knowledge-verdict-unavailable" });
});
