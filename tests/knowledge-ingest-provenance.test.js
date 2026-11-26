// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ingest, installIngestBackend, resetIngestBackend } from "./helpers/knowledge-ingest.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

afterEach(resetIngestBackend);

it("does not mistake an unclassified provenance 404 for an unapplied migration", async () => {
  const calls = installIngestBackend({}, { ok: false, status: 404, text: async () => JSON.stringify({ message: "Unavailable" }) });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await ingest()).toMatchObject({ statusCode: 422, body: { error: "knowledge-ingest-failed" } });
  const writes = calls.filter(call => call.name === "replace_knowledge_source_chunks");
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ p_chunks: [], p_error_code: "knowledge-ingest-failed" });
  expect(warning).not.toHaveBeenCalled();
});
