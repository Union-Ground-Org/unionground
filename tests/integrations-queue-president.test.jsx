import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createActor } from "../src/features/integrations/authorization.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { IntegrationControlPlane } from "../src/features/integrations/IntegrationControlPlane.jsx";
import { createSupabaseIntegrationStore } from "../src/lib/mi1FeatureWiring.js";

function officer(hat) {
  return createActor({ userId: `officer-${hat}`, selectedOrganizationId: "organization-a",
    roles: [hat], selectedHat: hat, mfaSatisfied: true });
}

// Match the existing RPC boundary: the catalog synthesizes unset providers,
// but enqueue_integration_job requires a persisted organization integration.
function fixture({ configured = false, queueError = null } = {}) {
  let providers = configured ? [{ id: "sms", provider: "twilio", status: "requested" }] : [];
  const jobs = [];
  const rpc = vi.fn(async (name, args) => {
    if (name === "get_scim_control") return { data: { enabled: false, tokens: [], chapters: [], groups: [], users: {}, attention: [] } };
    if (name === "get_sso_control") return { data: { enabled: false, domains: [] } };
    if (name === "list_organization_integrations") return { data: providers };
    if (name === "list_integration_job_page") return { data: { items: [...jobs] } };
    if (name === "upsert_organization_integration") {
      providers = [...providers, { id: args.p_provider, provider: args.p_provider, status: "requested" }];
      return { data: providers };
    }
    if (name === "enqueue_integration_job") {
      if (queueError) return { error: queueError };
      if (!providers.some(row => row.provider === args.p_provider)) {
        return { error: { code: "P0002", message: "not found" } };
      }
      jobs.push({ id: `job-${jobs.length + 1}`, provider: args.p_provider,
        jobKind: args.p_job_kind, status: "queued" });
      return { data: [...jobs] };
    }
    return { data: [] };
  });
  return { store: createSupabaseIntegrationStore({ rpc }), rpc, jobs };
}

describe("readiness-check outcome for Admin and President hats", () => {
  it.each(["admin", "vp"])("%s sees its authorized queued job and confirmation", async hat => {
    const { store, jobs } = fixture({ configured: true });
    render(<IntegrationControlPlane store={store} actor={officer(hat)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Queue SMS readiness check" }));
    expect(await screen.findByText("SMS readiness check queued.")).toHaveAttribute("role", "status");
    expect(await screen.findByText("Readiness check · Waiting to run")).toBeInTheDocument();
    expect(jobs).toHaveLength(1);
    expect(screen.getByText("Admins and Campaign chairs can queue readiness checks with an active organization account and two-step sign-in turned on.")).toBeInTheDocument();
  });

  it.each(["admin", "vp"])("%s gets a named setup refusal in an idle queue, then can queue after setup", async hat => {
    const { store, jobs } = fixture();
    render(<IntegrationControlPlane store={store} actor={officer(hat)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Queue SMS readiness check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SMS (Twilio) has no setup request yet. In Connections, choose Request setup on SMS (Twilio), then queue the readiness check.");
    expect(jobs).toHaveLength(0);
    await store.requestActivation(officer(hat), { provider: "twilio" });
    fireEvent.click(screen.getByRole("button", { name: "Queue SMS readiness check" }));
    expect(await screen.findByText("SMS readiness check queued.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(jobs).toHaveLength(1);
  });

  it("renders the queued confirmation in the language chosen after the press", async () => {
    const { store } = fixture({ configured: true });
    const view = render(<LanguageProvider lang="en"><IntegrationControlPlane store={store} actor={officer("vp")} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Queue SMS readiness check" }));
    expect(await screen.findByText("SMS readiness check queued.")).toBeInTheDocument();
    view.rerender(<LanguageProvider lang="es"><IntegrationControlPlane store={store} actor={officer("vp")} /></LanguageProvider>);
    expect(await screen.findByText("Comprobación de SMS agregada a la cola.")).toHaveAttribute("role", "status");
    expect(screen.queryByText("SMS readiness check queued.")).not.toBeInTheDocument();
  });

  it.each(["admin", "vp"])("%s sees a server authorization refusal and can retry", async hat => {
    const { store } = fixture({ configured: true, queueError: { code: "42501", message: "not authorized" } });
    render(<IntegrationControlPlane store={store} actor={officer(hat)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Queue SMS readiness check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You are not authorized to change this organization's integrations.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Queue SMS readiness check" })).toBeEnabled());
    expect(screen.queryByText("SMS readiness check queued.")).not.toBeInTheDocument();
  });

  it("two officers queue distinct jobs once SMS setup exists", async () => {
    const { store, jobs } = fixture({ configured: true });
    const results = await Promise.all(["admin", "vp"].map(hat => store.enqueueJob(officer(hat), { provider: "twilio", kind: "provider_health" })));
    expect(results.every(result => result.ok)).toBe(true);
    expect(jobs).toHaveLength(2);
  });

  it("a President requesting another provider must wait for SMS setup, not another officer's queue job", async () => {
    const { store, jobs } = fixture();
    await store.requestActivation(officer("vp"), { provider: "google_calendar" });
    expect(await store.enqueueJob(officer("vp"), { provider: "twilio", kind: "provider_health" }))
      .toEqual({ ok: false, reason: "readiness_setup_required" });
    expect(jobs).toHaveLength(0);
    await store.requestActivation(officer("admin"), { provider: "twilio" });
    expect((await store.enqueueJob(officer("vp"), { provider: "twilio", kind: "provider_health" })).ok).toBe(true);
    expect(jobs).toHaveLength(1);
  });

  it.each(["admin", "vp"])("%s without MFA is refused before an RPC", async hat => {
    const { store, rpc } = fixture({ configured: true });
    const actor = { ...officer(hat), mfaSatisfied: false };
    expect(await store.enqueueJob(actor, { provider: "twilio", kind: "provider_health" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
