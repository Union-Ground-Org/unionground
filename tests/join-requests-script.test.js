// @vitest-environment node
// scripts/join-requests.mjs: the owner's command to read and work request-to-
// join rows (REQ-UG-REQUEST-TO-JOIN-PAGE-20261017). The network is
// faked; nothing leaves the process.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRequest, parseArgs, readConfig, run } from "../scripts/join-requests.mjs";
import { keyFingerprint } from "../scripts/lib/supabase-server-key.mjs";

const ENV = { VITE_SUPABASE_URL: "https://project.example.invalid", SUPABASE_SERVICE_ROLE_KEY: "service-key-fixture" };
const KEY_LINE = `Server key: SUPABASE_SERVICE_ROLE_KEY from the environment, fingerprint ${keyFingerprint("service-key-fixture")}.`;
const ID = "11111111-1111-4111-8111-111111111111";
const REQUEST = {
  id: ID, email: "president@example.invalid", organizationName: "Example Workers Local 12", role: "officer",
  sizeBand: "500-1999", state: "MA", phone: "(617) 555-0100", note: "Three sites.\nStarting in January.",
  campaignCode: "flyer-ma", status: "new", consentAt: "2026-10-17T22:30:00Z", lastSubmittedAt: "2026-10-17T22:30:00Z",
  createdAt: "2026-10-17T22:30:00Z",
};

function fakeNetwork(rpc = {}) {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers: init?.headers, body });
    const name = String(url).split("/rpc/")[1];
    return new Response(JSON.stringify(rpc[name] ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("join-requests command", () => {
  it("prints a request with no size or state plainly", () => {
    expect(formatRequest({ ...REQUEST, sizeBand: null, state: null })[1])
      .toBe("  Organization: Example Workers Local 12  (officer, size not given, state not given)");
  });

  it("parses commands and flags, refuses stray arguments, and needs the Supabase URL", () => {
    expect(parseArgs(["list", "--status", "new", "--actor", "Riley"])).toEqual({ command: "list", flags: { status: "new", actor: "Riley" } });
    expect(parseArgs(["list", "--dry-run"])).toEqual({ command: "list", flags: { dryRun: true } });
    // A flag never swallows another flag, so a dry run cannot become a real status change.
    expect(() => parseArgs(["status", "--id", "x", "--to", "closed", "--actor", "--dry-run"])).toThrow("unexpected argument: --actor");
    expect(() => parseArgs(["list", "--status", "--dry-run"])).toThrow("unexpected argument: --status");
    expect(() => parseArgs(["list", "stray"])).toThrow("unexpected argument");
    expect(() => parseArgs(["list", "--status"])).toThrow("unexpected argument");
    expect(readConfig(ENV)).toEqual({ supabaseUrl: "https://project.example.invalid", serviceKey: "service-key-fixture", serviceKeyName: "" });
    expect(() => readConfig({})).toThrow("missing environment: SUPABASE_URL or VITE_SUPABASE_URL");
    expect(readConfig({ SUPABASE_URL: "https://x.invalid/", SUPABASE_SERVICE_ROLE_KEY: "k" }).supabaseUrl).toBe("https://x.invalid");
  });

  it("lists requests through list_join_requests with the actor and prints each one without the key", async () => {
    const calls = fakeNetwork({ list_join_requests: { status: "new", rowCount: 1, requests: [REQUEST], hasMore: false, cursorSubmittedAt: REQUEST.lastSubmittedAt, cursorId: ID } });
    const lines = [];
    expect(await run(["list", "--status", "new", "--actor", "Riley"], ENV, (line) => lines.push(line))).toBe(0);
    expect(calls).toEqual([expect.objectContaining({
      url: "https://project.example.invalid/rest/v1/rpc/list_join_requests",
      body: { p_status: "new", p_actor: "Riley", p_before: null, p_before_id: null },
    })]);
    expect(lines.join("\n")).not.toContain("More requests exist");
    expect(calls[0].headers.Authorization).toBe("Bearer service-key-fixture");
    expect(lines[0]).toBe(KEY_LINE);
    expect(lines[1]).toBe("1 request with status new (read recorded for Riley).");
    expect(lines.slice(2)).toEqual(formatRequest(REQUEST));
    expect(lines.join("\n")).toContain("Example Workers Local 12  (officer, 500-1,999 members, MA)");
    expect(lines.join("\n")).toContain("Note: Three sites. / Starting in January.");
    expect(lines.join("\n")).toContain("6:30 PM ET");
    expect(lines.join("\n")).not.toContain("service-key-fixture");
  });

  it("defaults the actor to the operating-system user and sends no filter without --status", async () => {
    const calls = fakeNetwork({ list_join_requests: { status: null, rowCount: 0, requests: [] } });
    const lines = [];
    expect(await run(["list"], ENV, (line) => lines.push(line))).toBe(0);
    expect(calls[0].body.p_status).toBeNull();
    expect(calls[0].body.p_actor.length).toBeGreaterThanOrEqual(2);
    expect(lines).toEqual([KEY_LINE, `0 requests (read recorded for ${calls[0].body.p_actor}).`]);
    await expect(run(["list", "--status", "answered"], ENV, () => {})).rejects.toThrow("--status must be new, contacted or closed");
    await expect(run(["list", "--actor", "x"], ENV, () => {})).rejects.toThrow("--actor must be 2-80 characters");
    await expect(run(["list", "--before", "yesterday", "--before-id", ID], ENV, () => {})).rejects.toThrow("--before must be the timestamp printed by a previous page");
    await expect(run(["list", "--before", "2026-10-18T00:00:00Z"], ENV, () => {})).rejects.toThrow("--before and --before-id go together");
    await expect(run(["list", "--before", "2026-10-18T00:00:00Z", "--before-id", "nope"], ENV, () => {})).rejects.toThrow("--before-id must be the request id printed by a previous page");
  });

  it("reads the next page with the two-part cursor forwarded verbatim and says when an older page exists", async () => {
    // Microseconds survive: the cursor is never re-parsed through Date.
    const cursor = "2026-10-17T22:30:00.123900+00:00";
    const calls = fakeNetwork({ list_join_requests: { status: null, rowCount: 1, requests: [REQUEST], hasMore: true, cursorSubmittedAt: cursor, cursorId: ID } });
    const lines = [];
    expect(await run(["list", "--before", "2026-10-18T00:00:00.000456+00:00", "--before-id", ID, "--actor", "Riley"], ENV, (line) => lines.push(line))).toBe(0);
    expect(calls[0].body).toEqual({ p_status: null, p_actor: "Riley", p_before: "2026-10-18T00:00:00.000456+00:00", p_before_id: ID });
    expect(lines[1]).toBe("1 request before 2026-10-18T00:00:00.000456+00:00 (read recorded for Riley).");
    expect(lines.at(-1)).toBe(`More requests exist. Read the next page with --before ${cursor} --before-id ${ID}`);
  });

  it("changes a status through set_join_request_status and reports refusals without changing anything", async () => {
    const calls = fakeNetwork({ set_join_request_status: { updated: true, id: ID, from: "new", status: "contacted" } });
    const lines = [];
    expect(await run(["status", "--id", ID, "--to", "contacted", "--actor", "Riley"], ENV, (line) => lines.push(line))).toBe(0);
    expect(calls[0]).toMatchObject({ url: "https://project.example.invalid/rest/v1/rpc/set_join_request_status", body: { p_id: ID, p_status: "contacted", p_actor: "Riley" } });
    expect(lines).toEqual([KEY_LINE, `Request ${ID}: new -> contacted (recorded for Riley).`]);

    fakeNetwork({ set_join_request_status: { updated: false, refusal: "unchanged", status: "contacted" } });
    lines.length = 0;
    expect(await run(["status", "--id", ID, "--to", "contacted", "--actor", "Riley"], ENV, (line) => lines.push(line))).toBe(2);
    expect(lines).toEqual([KEY_LINE, `Request ${ID} is already contacted. Nothing changed.`]);

    fakeNetwork({ set_join_request_status: { updated: false, refusal: "not-found" } });
    lines.length = 0;
    expect(await run(["status", "--id", ID, "--to", "closed", "--actor", "Riley"], ENV, (line) => lines.push(line))).toBe(2);
    expect(lines).toEqual([KEY_LINE, `Refused: no request to join has id ${ID}. Nothing changed.`]);

    await expect(run(["status", "--id", "nope", "--to", "closed"], ENV, () => {})).rejects.toThrow("--id must be the request id printed by list");
    await expect(run(["status", "--id", ID, "--to", "done"], ENV, () => {})).rejects.toThrow("--to must be new, contacted or closed");
    await expect(run(["delete"], ENV, () => {})).rejects.toThrow("usage: join-requests.mjs list|status");
  });

  it("a dry run resolves the key from the Management API and reads or records nothing", async () => {
    const secret = "sb_secret_fictionalExampleKey0001";
    const management = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ type: "secret", name: "union_base_vercel_20261016", api_key: secret }] }));
    const calls = fakeNetwork();
    const hosted = { SUPABASE_URL: "https://productionprojectref.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "" };
    const keySource = { token: () => "management-token-fixture", fetchImpl: management };
    const lines = [];
    expect(await run(["list", "--actor", "Riley", "--dry-run"], hosted, (line) => lines.push(line), keySource)).toBe(0);
    expect(await run(["status", "--id", ID, "--to", "closed", "--actor", "Riley", "--dry-run"], hosted, (line) => lines.push(line), keySource)).toBe(0);
    expect(lines).toEqual([
      `Server key: secret key "union_base_vercel_20261016" from the Management API for project productionprojectref, fingerprint ${keyFingerprint(secret)}.`,
      "Dry run: would list requests to join. Nothing was read or recorded.",
      `Server key: secret key "union_base_vercel_20261016" from the Management API for project productionprojectref, fingerprint ${keyFingerprint(secret)}.`,
      `Dry run: would set request ${ID} to closed. Nothing changed.`,
    ]);
    expect(calls).toEqual([]);
    await expect(run(["list", "--actor", "Riley"], { SUPABASE_URL: "https://project.example.invalid" }, () => {}))
      .rejects.toThrow("supabase-server-key: no-key-source");
  });
});
