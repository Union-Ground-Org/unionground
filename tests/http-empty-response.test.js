// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { supabaseRpc } from "../api/_lib/http.js";

const URL = "https://project.supabase.co";
const KEY = ["sb", "publishable", "fixture"].join("_");

afterEach(() => {
  vi.restoreAllMocks();
});

// api/_lib/http.js:55 and :62 are a matched pair and only make sense together:
// 204 is the ONE status that legitimately carries no body, and every other
// empty body is a malformed response that must fail loudly. Asserting either
// one alone would let the other be deleted, so they are pinned side by side.
describe("supabaseRpc empty-body handling", () => {
  function respond({ status, ok = true, body = "" }) {
    const text = vi.fn().mockResolvedValue(body);
    global.fetch = vi.fn().mockResolvedValueOnce({ ok, status, text });
    return text;
  }

  // The guard exists because a 200 with no body would otherwise become `null`,
  // and `null` is a legitimate value on this path: the claim RPC returns it for
  // "no work to do". The dispatcher would then report a healthy tick over a
  // queue it never touched, and the guide and calendar routes would each map
  // the same empty response onto a different, wrong status code.
  it("fails a 200 with an empty body rather than letting it impersonate a void call", async () => {
    respond({ status: 200, body: "" });
    await expect(supabaseRpc(URL, KEY, KEY, "claim_notification_deliveries")).rejects.toThrow(
      "claim_notification_deliveries-empty-response",
    );
  });

  // A `RETURNS void` function answers 204, and response.json() throws on empty
  // input — so callers that ignore the return value would read a successful
  // write as a failure. 204 must resolve to null WITHOUT the body being read.
  it("returns null for a 204 without touching the body", async () => {
    const text = respond({ status: 204 });
    await expect(supabaseRpc(URL, KEY, KEY, "release_member_ai_request")).resolves.toBeNull();
    expect(text).not.toHaveBeenCalled();
  });

  // The control: without this case the two assertions above would still pass if
  // supabaseRpc rejected every response it was given.
  it("parses a 200 that does carry a body", async () => {
    respond({ status: 200, body: JSON.stringify({ claimed: 3 }) });
    await expect(supabaseRpc(URL, KEY, KEY, "claim_notification_deliveries")).resolves.toEqual({ claimed: 3 });
  });

  // A null-returning RPC answers 200 with the four-character body "null", which
  // is a real result and must not be confused with the empty-body failure.
  it("distinguishes a JSON null result from an empty body", async () => {
    respond({ status: 200, body: "null" });
    await expect(supabaseRpc(URL, KEY, KEY, "reserve_member_ai_request")).resolves.toBeNull();
  });

  // Union Ground's http.js now reads a non-OK body, best effort, for the
  // PostgREST code that separates a missing function from a route that
  // matched nothing. An empty or unreadable body must still never replace
  // the named, status-carrying error the caller is owed.
  it("throws a named, status-carrying error on a non-OK response whatever the body", async () => {
    const text = respond({ status: 503, ok: false, body: "" });
    await expect(supabaseRpc(URL, KEY, KEY, "get_member_guide_context")).rejects.toMatchObject({
      message: "get_member_guide_context-failed",
      status: 503,
      code: null,
    });
    expect(text).toHaveBeenCalledTimes(1);

    respond({ status: 404, ok: false, body: JSON.stringify({ code: "PGRST202" }) });
    await expect(supabaseRpc(URL, KEY, KEY, "get_member_guide_context")).rejects.toMatchObject({
      message: "get_member_guide_context-failed",
      status: 404,
      code: "PGRST202",
    });

    respond({ status: 500, ok: false, body: "<html>not json</html>" });
    await expect(supabaseRpc(URL, KEY, KEY, "get_member_guide_context")).rejects.toMatchObject({
      message: "get_member_guide_context-failed",
      status: 500,
      code: null,
    });
  });
});
