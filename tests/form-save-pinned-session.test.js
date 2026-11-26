// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { discardFormDraft, saveFormDraft } from "../src/lib/memberApi.js";

// REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111, #8966
// held-commit review: a form save is bound to the member it was started for.
// The shared client reads the session again inside every request (and waits on
// the cross-tab auth lock to do it), so a sign-in as someone else during that
// wait must neither send the answers nor send them under the other member.

const A = { user: { id: "member-a" }, access_token: "token-a" };
const B = { user: { id: "member-b" }, access_token: "token-b" };
const asA = { asUser: { userId: "member-a", accessToken: "token-a" } };

// A client like supabase-js: a request that carries no Authorization header
// takes the bearer of whatever session the client reads when it is sent.
function sharedClient(initial) {
  let current = initial;
  const sent = [];
  const client = {
    switchTo: (session) => { current = session; },
    sent,
    auth: { getSession: vi.fn(async () => ({ data: { session: current } })) },
    rpc: vi.fn((name, args) => {
      const headers = {};
      const builder = {
        setHeader(key, value) { headers[key] = value; return builder; },
        then(resolve, reject) {
          // The send happens now; a switch planted for this moment lands first.
          if (client.onSend) client.onSend();
          sent.push({ name, args, authorization: headers.Authorization ?? `Bearer ${current.access_token}` });
          return Promise.resolve({ data: "form-1", error: null }).then(resolve, reject);
        },
      };
      return builder;
    }),
  };
  return client;
}

const ordinary = { templateKey: "grievance", answers: { summary: "Member A's own words" }, step: 0, baseAnswers: {} };
const sealed = { templateKey: "fmla_self", answers: { condition: "Member A's medical answer" }, step: 0, formId: "fmla-a" };

afterEach(() => { vi.unstubAllGlobals(); });

describe("a form save started for member A", () => {
  it("sends nothing when member B is signed in by the time the save reads the session", async () => {
    const client = sharedClient(B);
    await expect(saveFormDraft(client, ordinary, asA)).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.sent).toEqual([]);
  });

  it("goes out with member A's token even when member B signs in while it is being sent", async () => {
    const client = sharedClient(A);
    client.onSend = () => client.switchTo(B);
    await saveFormDraft(client, ordinary, asA);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].authorization).toBe("Bearer token-a");
  });

  it("posts no sealed answers when member B is signed in by the time the save reads the session", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: { formId: "fmla-a", dataVersion: "v2" } }) }));
    vi.stubGlobal("fetch", fetch);
    const client = sharedClient(B);
    await expect(saveFormDraft(client, sealed, asA)).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts sealed answers with member A's token", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: { formId: "fmla-a", dataVersion: "v2" } }) }));
    vi.stubGlobal("fetch", fetch);
    const client = sharedClient(A);
    await saveFormDraft(client, sealed, asA);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer token-a");
  });

  // #8966 r9s1/r11s1/r12s2: member A's token was refreshed while the save
  // waited (an offline replay); it goes out with A's fresh token, never the
  // expired copy pinned when it was queued.
  it("goes out with member A's refreshed token when A's session was refreshed meanwhile", async () => {
    const client = sharedClient({ user: { id: "member-a" }, access_token: "token-a-refreshed" });
    await saveFormDraft(client, ordinary, asA);
    expect(client.sent[0].authorization).toBe("Bearer token-a-refreshed");
    await discardFormDraft(client, "grv-a", asA);
    expect(client.sent[1]).toMatchObject({ name: "discard_form_draft", authorization: "Bearer token-a-refreshed" });
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ data: { formId: "fmla-a", dataVersion: "v2" } }) }));
    vi.stubGlobal("fetch", fetch);
    await saveFormDraft(client, sealed, asA);
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer token-a-refreshed");
  });

  it("refuses a save pinned to no signed-in member", async () => {
    const client = sharedClient(A);
    await expect(saveFormDraft(client, ordinary, { asUser: { userId: null, accessToken: null } })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe("a draft discard started for member A", () => {
  it("sends nothing when member B is signed in by the time it reads the session", async () => {
    const client = sharedClient(B);
    await expect(discardFormDraft(client, "grv-a", asA)).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("goes out with member A's token even when member B signs in while it is being sent", async () => {
    const client = sharedClient(A);
    client.onSend = () => client.switchTo(B);
    await discardFormDraft(client, "grv-a", asA);
    expect(client.sent[0]).toMatchObject({ name: "discard_form_draft", authorization: "Bearer token-a" });
  });
});
