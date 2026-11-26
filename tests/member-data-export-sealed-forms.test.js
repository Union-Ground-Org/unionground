// @vitest-environment node
//
// REQ-UG-MEMBER-EXPORT-SEALED-FMLA-ANSWERS-20261022 (#5767): the
// member's data export carries the opened answers of their own sealed FMLA
// forms; the SQL export keeps the marker, and a form that cannot be opened is
// unavailable, never empty.
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateMemberDataExport } from "../src/lib/memberApi.js";

const SEALED_ID = "11111111-1111-4111-8111-111111111111";
const BROKEN_ID = "22222222-2222-4222-8222-222222222222";
const STALE_ID = "33333333-3333-4333-8333-333333333333";
const PLAIN_ID = "44444444-4444-4444-8444-444444444444";
const marker = (dataVersion) => ({ sealed: true, filled: ["reason"], dataVersion });
const exported = () => ({
  schemaVersion: 1,
  forms: [
    { id: SEALED_ID, templateKey: "fmla_self", status: "submitted", answers: marker("v-sealed") },
    { id: BROKEN_ID, templateKey: "fmla_family", status: "draft", answers: marker("v-broken") },
    { id: STALE_ID, templateKey: "fmla_self", status: "draft", answers: marker("v-old") },
    { id: PLAIN_ID, templateKey: "grievance", status: "submitted", answers: { sealed: true, summary: "an ordinary field named sealed" } },
  ],
});
const client = () => ({
  rpc: vi.fn(async () => ({ data: exported(), error: null })),
  auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "member-token" } } })) },
});
const apiReply = (body, ok = true) => vi.fn(async () => ({ ok, json: async () => body }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("member data export with sealed FMLA forms", () => {
  it("opens the member's own sealed answers, marks the rest unavailable and leaves other forms untouched", async () => {
    const fetchMock = apiReply({ data: [
      { id: SEALED_ID, answers: { reason: "Synthetic leave reason" }, dataVersion: "v-sealed" },
      { id: BROKEN_ID, answers: {}, contentError: "sensitive-content-unavailable" },
      { id: STALE_ID, answers: { reason: "Saved after the snapshot" }, dataVersion: "v-new" },
    ] });
    vi.stubGlobal("fetch", fetchMock);
    const db = client();
    const result = await generateMemberDataExport(db);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("get_member_data_export");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/sensitive-content$/u);
    expect(init.headers.Authorization).toBe("Bearer member-token");
    expect(JSON.parse(init.body)).toEqual({ operation: "get_my_sealed_form_answers", args: {} });
    const byId = new Map(result.forms.map((form) => [form.id, form]));
    expect(byId.get(SEALED_ID)).toMatchObject({ answers: { reason: "Synthetic leave reason" }, sealed: true });
    expect(byId.get(SEALED_ID).answersUnavailable).toBeUndefined();
    // Unopenable, or saved again after the SQL snapshot: unavailable, not empty.
    for (const id of [BROKEN_ID, STALE_ID]) expect(byId.get(id)).toMatchObject({ answers: {}, sealed: true, answersUnavailable: true });
    expect(JSON.stringify(result)).not.toMatch(/Saved after the snapshot/u);
    expect(byId.get(PLAIN_ID)).toEqual(exported().forms[3]);
    expect(result.schemaVersion).toBe(1);
  });

  it("marks every sealed form unavailable when the API refuses, and never calls it without a sealed form", async () => {
    vi.stubGlobal("fetch", apiReply({ error: "sensitive-data-key-or-backfill-unavailable" }, false));
    const result = await generateMemberDataExport(client());
    expect(result.forms.filter((form) => form.answersUnavailable).map((form) => form.id)).toEqual([SEALED_ID, BROKEN_ID, STALE_ID]);
    expect(result.forms.every((form) => form.id === PLAIN_ID || Object.keys(form.answers).length === 0)).toBe(true);

    const fetchMock = apiReply({ data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const plain = client();
    plain.rpc.mockResolvedValueOnce({ data: { schemaVersion: 1, forms: [exported().forms[3]] }, error: null });
    expect((await generateMemberDataExport(plain)).forms).toEqual([exported().forms[3]]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
