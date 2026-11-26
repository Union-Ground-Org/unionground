// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001 (inventory A1): the
// integration store's provider turn-off / request-again write and the chapter
// controls write, proved against a recording RPC client.
import { describe, expect, it } from "vitest";
import {
  buildMi1FeatureActor,
  createSupabaseIntegrationStore,
  createUnsetIntegrationStore,
} from "../src/lib/mi1FeatureWiring.js";

const ORG = "11111111-1111-4111-8111-111111111111";

function recordingClient({ error = null, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      if (throws) throw new Error("network down");
      return error ? { data: null, error } : { data: { provider: args?.p_provider, status: args?.p_status }, error: null };
    },
  };
}

const admin = () => buildMi1FeatureActor({
  userId: "admin-a",
  organizationId: ORG,
  roles: ["admin"],
  mfaSatisfied: true,
  selectedHat: "admin",
});

const member = () => buildMi1FeatureActor({
  userId: "member-a",
  organizationId: ORG,
  roles: ["member"],
  mfaSatisfied: true,
  selectedHat: "member",
});

describe("integration provider status and chapter controls wiring", () => {
  it("turns a provider off and requests it again through the status RPC only", async () => {
    const client = recordingClient();
    const store = createSupabaseIntegrationStore(client);
    expect(await store.setProviderStatus(admin(), { provider: "twilio", status: "disabled" }))
      .toEqual({ ok: true, data: { provider: "twilio", status: "disabled" } });
    expect(await store.setProviderStatus(admin(), { provider: "twilio", status: "requested" }))
      .toEqual({ ok: true, data: { provider: "twilio", status: "requested" } });
    expect(client.calls).toEqual([
      { name: "set_organization_integration_status", args: { p_provider: "twilio", p_status: "disabled" } },
      { name: "set_organization_integration_status", args: { p_provider: "twilio", p_status: "requested" } },
    ]);
  });

  it("refuses a status write for a non-manager, an unknown provider or an activating status", async () => {
    const client = recordingClient();
    const store = createSupabaseIntegrationStore(client);
    expect(await store.setProviderStatus(member(), { provider: "twilio", status: "disabled" }))
      .toEqual({ ok: false, reason: "unauthorized" });
    expect(await store.setProviderStatus(admin(), { provider: "not-a-provider", status: "disabled" }))
      .toEqual({ ok: false, reason: "invalid_input" });
    expect(await store.setProviderStatus(admin(), { provider: "twilio", status: "active" }))
      .toEqual({ ok: false, reason: "invalid_input" });
    expect(await store.setProviderStatus(admin())).toEqual({ ok: false, reason: "invalid_input" });
    expect(client.calls).toEqual([]);
  });

  it("reports an unreachable backend instead of a silent success", async () => {
    const store = createSupabaseIntegrationStore(recordingClient({ throws: true }));
    expect(await store.setProviderStatus(admin(), { provider: "twilio", status: "disabled" }))
      .toEqual({ ok: false, reason: "persistence_unavailable" });
    const unset = createSupabaseIntegrationStore(null);
    expect(await unset.setProviderStatus(admin(), { provider: "twilio", status: "disabled" }))
      .toEqual({ ok: false, reason: "persistence_unavailable" });
  });

  it("turns chapter controls off with the same write that turns them on", async () => {
    const client = recordingClient();
    const store = createSupabaseIntegrationStore(client);
    expect((await store.configureProvider(admin(), { provider: "twilio", allowChapterOverrides: false })).ok).toBe(true);
    expect(client.calls).toEqual([{
      name: "set_integration_chapter_controls",
      args: { p_provider: "twilio", p_enabled: false, p_allowed_chapter_override_keys: [] },
    }]);
    expect(await store.configureProvider(member(), { provider: "twilio" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await store.configureProvider(admin(), { provider: "scim" })).toEqual({ ok: false, reason: "scim_setup_on_scim_tab" });
    expect(await store.configureProvider(admin(), { provider: "nope" })).toEqual({ ok: false, reason: "unknown_provider" });
    expect(await store.setChapterOverride(member(), { provider: "twilio", chapterId: "chapter-a" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(client.calls).toHaveLength(1);
  });

  it("refuses the status write while persistence is unset", () => {
    const store = createUnsetIntegrationStore();
    const result = store.setProviderStatus(admin(), { provider: "twilio", status: "disabled" });
    expect(result.ok).toBe(false);
  });
});
