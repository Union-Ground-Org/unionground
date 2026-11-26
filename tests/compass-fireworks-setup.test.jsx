import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FireworksConnector, attestationState, replacementModel } from "../src/features/integrations/FireworksConnector.jsx";
import { createActor } from "../src/features/integrations/authorization.js";
import { createSupabaseIntegrationStore } from "../src/lib/mi1FeatureWiring.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const actor = createActor({ userId: "operator-a", selectedOrganizationId: "org-a", roles: ["admin"], mfaSatisfied: true });
const model = "accounts/fireworks/models/synthetic-test-model";
const key = "synthetic-fixture-credential-only";
const status = { primary: "union-ground-mesh", fallback: "union-ground-fireworks", model, enabled: false, configured: false, canManage: true };
const live = { ...status, enabled: true, configured: true };
function setup({ result = { ok: true, data: live }, platform = status, connectors = [], lang = "en", persistenceKind = "supabase" } = {}) {
  const store = { persistenceKind, getCompassPlatformAi: vi.fn(async () => ({ ok: true, data: platform })),
    enableFireworksConnector: vi.fn(async () => result), disableFireworksConnector: vi.fn(async () => result), adoptFireworksConnector: vi.fn(async () => result),
    renewFireworksAttestation: vi.fn(async () => result) };
  const onRefresh = vi.fn(async () => {});
  const view = render(<LanguageProvider lang={lang}><FireworksConnector store={store} actor={actor} connectors={connectors} onRefresh={onRefresh} /></LanguageProvider>);
  return { store, onRefresh, ...view };
}
async function draft() {
  fireEvent.change(await screen.findByLabelText("Fireworks model identifier"), { target: { value: model } });
  fireEvent.change(screen.getByLabelText("Platform Fireworks API key"), { target: { value: key } });
  fireEvent.click(screen.getByRole("checkbox"));
}

describe("Fireworks platform setup", () => {
  it("requires acknowledgement and clears the password before awaiting a central mutation", async () => {
    const { store, onRefresh } = setup();
    expect(await screen.findByRole("button", { name: "Enable platform failover" })).toBeDisabled();
    await draft();
    let release;
    store.enableFireworksConnector.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    fireEvent.submit(screen.getByRole("button", { name: "Enable platform failover" }).closest("form"));
    expect(store.enableFireworksConnector).toHaveBeenCalledWith(actor, { model, apiKey: key, termsAcknowledged: true });
    expect(screen.getByLabelText("Platform Fireworks API key")).toHaveValue("");
    fireEvent.submit(screen.getByRole("button", { name: "Saving…" }).closest("form"));
    expect(store.enableFireworksConnector).toHaveBeenCalledTimes(1);
    release({ ok: true, data: { ...status, enabled: true, attestationExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    // The saved state is the card now: status, attestation and the renew
    // control replace the key form, so nothing about the key stays on screen.
    expect(screen.getByTestId("fireworks-status")).toHaveTextContent("Enabled");
    expect(screen.getByText(/^Attested until /)).toBeVisible();
    expect(screen.queryByLabelText("Platform Fireworks API key")).not.toBeInTheDocument();
    // The only checkbox left is the renewal confirmation, cleared by the save.
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Renew attestation (90 days)" })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(key);
  });
  it("shows a bounded MFA refusal and never reflects the submitted key", async () => {
    const { onRefresh } = setup({ result: { ok: false, reason: "mfa_required", error: key } });
    await draft(); fireEvent.click(screen.getByRole("button", { name: "Enable platform failover" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Verify your second factor");
    expect(document.body).not.toHaveTextContent(key);
    expect(screen.getByLabelText("Platform Fireworks API key")).toHaveValue("");
    expect(onRefresh).not.toHaveBeenCalled();
  });
  it("shows organization admins managed status without any credential or enable controls", async () => {
    setup({ platform: { ...status, enabled: true, canManage: false } });
    expect(await screen.findByText(`Fireworks failover is enabled: ${model}`)).toBeVisible();
    expect(screen.queryByLabelText("Platform Fireworks API key")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/Organizations need no provider account or key/)).toBeVisible();
  });
  it("adopts only an explicitly selected existing connector after platform acknowledgement", async () => {
    const { store } = setup({ connectors: [{ provider: "ai_connector_fireworks", status: "connected", model }] });
    const button = await screen.findByRole("button", { name: "Use existing secured key for platform failover" });
    expect(button).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(button);
    await waitFor(() => expect(store.adoptFireworksConnector).toHaveBeenCalledWith(actor, { termsAcknowledged: true }));
    expect(store.enableFireworksConnector).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText("Platform Fireworks API key")).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent(key);
  });
  it("allows a platform operator to disable the central fallback", async () => {
    const { store } = setup({ platform: { ...status, enabled: true }, result: { ok: true, data: status } });
    fireEvent.click(await screen.findByRole("button", { name: "Disable platform failover" }));
    await waitFor(() => expect(store.disableFireworksConnector).toHaveBeenCalledWith(actor));
    expect(screen.queryByRole("button", { name: "Disable platform failover" })).not.toBeInTheDocument();
  });
  it("accepts no credential when configuration cannot be read", async () => {
    const { store } = setup({ platform: null });
    await waitFor(() => expect(store.getCompassPlatformAi).toHaveBeenCalled());
    expect(screen.queryByLabelText("Platform Fireworks API key")).not.toBeInTheDocument();
  });
  it("localizes the platform setup and private-content acknowledgement", async () => {
    setup({ lang: "es" });
    expect(await screen.findByRole("button", { name: "Habilitar el respaldo de la plataforma" })).toBeDisabled();
    expect(screen.getByRole("checkbox")).toHaveAccessibleName(/contenido privado aislado por organización/);
  });
  it("shows the saved state as a status block and keeps the key form behind Replace key", async () => {
    const expires = new Date(Date.now() + 30 * 86_400_000).toISOString();
    setup({ platform: { ...live, attestationExpiresAt: expires } });
    expect(await screen.findByTestId("fireworks-status")).toHaveTextContent("Platform failoverEnabled");
    expect(screen.getByText(`Fireworks failover is enabled: ${model}`)).toBeVisible();
    expect(screen.getByText(/^Attested until /)).toHaveTextContent(new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(new Date(expires)));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Platform Fireworks API key")).not.toBeInTheDocument();
    // Renewal waits for the operator's own re-confirmation of both provider controls.
    expect(screen.getByRole("button", { name: "Renew attestation (90 days)" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /zero data retention is in force and prompt training is disallowed/ }));
    expect(screen.getByRole("button", { name: "Renew attestation (90 days)" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(screen.getByLabelText("Platform Fireworks API key")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Renew attestation (90 days)" })).not.toBeInTheDocument();
    // Opening the key form does not carry the renewal confirmation into the setup acknowledgement.
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    // An abandoned model edit does not survive the cancel into the next open.
    fireEvent.change(screen.getByLabelText("Fireworks model identifier"), { target: { value: "accounts/fireworks/models/abandoned-edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Keep the current key" }));
    expect(screen.queryByLabelText("Platform Fireworks API key")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Renew attestation (90 days)" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(screen.getByLabelText("Fireworks model identifier")).toHaveValue(model);
  });
  it("offers Muse Spark Open when the key is replaced on a row still set to the retired gpt-oss-120b", async () => {
    const retired = "accounts/fireworks/models/gpt-oss-120b";
    expect(replacementModel(retired)).toBe("accounts/fireworks/models/muse-spark-open");
    expect(replacementModel(model)).toBe(model);
    // First setup: the seeded singleton row still names the retired model, and
    // the loaded status must not overwrite the replacement (a review finding).
    const first = setup({ platform: { ...status, model: retired } });
    expect(await screen.findByLabelText("Fireworks model identifier")).toHaveValue("accounts/fireworks/models/muse-spark-open");
    first.unmount();
    setup({ platform: { ...live, model: retired, attestationExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
    fireEvent.click(await screen.findByRole("button", { name: "Replace key" }));
    expect(screen.getByLabelText("Fireworks model identifier")).toHaveValue("accounts/fireworks/models/muse-spark-open");
  });
  it("shows Not enabled with the open form before setup, and warns inside the last week or after expiry", async () => {
    setup();
    expect(await screen.findByTestId("fireworks-status")).toHaveTextContent("Not enabled");
    expect(screen.getByLabelText("Platform Fireworks API key")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Replace key" })).not.toBeInTheDocument();
    expect(attestationState(new Date(Date.now() + 3 * 86_400_000).toISOString()).kind).toBe("expiring");
    expect(attestationState(new Date(Date.now() - 1000).toISOString()).kind).toBe("expired");
    expect(attestationState(null).kind).toBe("missing");
    expect(attestationState(new Date(Date.now() + 30 * 86_400_000).toISOString()).kind).toBe("valid");
  });
  it.each([
    ["expiring", 2 * 86_400_000, /^The Fireworks attestation expires /],
    ["expired", -86_400_000, /^The Fireworks attestation expired /],
  ])("renders the %s attestation as an alert and keeps the renewal control", async (label, offset, pattern) => {
    // The server reports an expired attestation as enabled=false while the
    // key stays on record (configured=true); the card must not fall back to
    // key entry at exactly the moment renewal is the fix.
    setup({ platform: { ...live, enabled: label !== "expired", attestationExpiresAt: new Date(Date.now() + offset).toISOString() } });
    expect(await screen.findByRole("alert")).toHaveTextContent(pattern);
    expect(screen.getByTestId("fireworks-status")).toHaveTextContent(label === "expired" ? "Not enabled" : "Enabled");
    // The model the confirmation refers to stays on the card either way: in the
    // enabled line while authorized, on its own line once the attestation lapsed.
    expect(screen.getByText(label === "expired" ? `Configured model: ${model}` : `Fireworks failover is enabled: ${model}`)).toBeVisible();
    expect(screen.queryByText(label === "expired" ? `Fireworks failover is enabled: ${model}` : `Configured model: ${model}`)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Renew attestation (90 days)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeVisible();
    expect(screen.queryByLabelText("Platform Fireworks API key")).not.toBeInTheDocument();
  });
  it("never sends the provider-control confirmations without the operator's own acknowledgement", async () => {
    const { store } = setup({ platform: { ...live, enabled: false, attestationExpiresAt: new Date(Date.now() - 86_400_000).toISOString() } });
    const renew = await screen.findByRole("button", { name: "Renew attestation (90 days)" });
    expect(renew).toBeDisabled();
    fireEvent.click(renew);
    expect(store.renewFireworksAttestation).not.toHaveBeenCalled();
    expect(screen.getByText(/Fireworks failover is not enabled/)).toBeVisible();
  });
  it("treats an older status read without the configured flag as configured when it is enabled", async () => {
    setup({ platform: { ...status, enabled: true, attestationExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
    expect(await screen.findByRole("button", { name: "Renew attestation (90 days)" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Platform Fireworks API key")).not.toBeInTheDocument();
  });
  it("renews the attestation for 90 days without opening the key form and shows the new expiry", async () => {
    const renewed = new Date(Date.now() + 90 * 86_400_000).toISOString();
    const { store, onRefresh } = setup({ platform: { ...live, attestationExpiresAt: new Date(Date.now() + 86_400_000).toISOString() },
      result: { ok: true, data: { ...live, attestationExpiresAt: renewed } } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/expires/);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Renew attestation (90 days)" }));
    await waitFor(() => expect(store.renewFireworksAttestation).toHaveBeenCalledWith(actor, { days: 90, termsAcknowledged: true }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByText(/renewed for 90 days/)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/^Attested until /)).toHaveTextContent(new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(new Date(renewed)));
    expect(screen.queryByLabelText("Platform Fireworks API key")).not.toBeInTheDocument();
    // The confirmation is spent by the renewal; the next one needs a fresh acknowledgement.
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Renew attestation (90 days)" })).toBeDisabled();
  });
  it("localizes the status block, attestation line and renewal control", async () => {
    setup({ lang: "es", platform: { ...live, attestationExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } });
    expect(await screen.findByTestId("fireworks-status")).toHaveTextContent("Respaldo de la plataformaHabilitado");
    expect(screen.getByText(/^Certificado hasta el /)).toBeVisible();
    expect(screen.getByRole("button", { name: "Renovar la certificación (90 días)" })).toBeVisible();
    expect(screen.getByRole("checkbox")).toHaveAccessibleName(/retención cero de datos está vigente/);
    expect(screen.getByRole("button", { name: "Reemplazar la clave" })).toBeVisible();
  });
  it("sends only configuration to the platform RPC; operator authority belongs to the authenticated server", async () => {
    const rpc = vi.fn(async () => ({ data: status, error: null }));
    const store = createSupabaseIntegrationStore({ rpc });
    const fields = { model, apiKey: key, termsAcknowledged: true };
    expect(await store.enableFireworksConnector(actor, { ...fields, termsAcknowledged: false })).toMatchObject({ ok: false });
    expect(await store.enableFireworksConnector(actor, { ...fields, model: "https://other.example/model" })).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(await store.enableFireworksConnector(actor, fields)).toMatchObject({ ok: true });
    expect(rpc).toHaveBeenLastCalledWith("configure_compass_platform_fireworks", { p_model: model, p_api_key: key, p_terms_acknowledged: true });
    await store.disableFireworksConnector(actor);
    expect(rpc).toHaveBeenLastCalledWith("disable_compass_platform_fireworks", {});
    await store.adoptFireworksConnector(actor, { termsAcknowledged: true });
    expect(rpc).toHaveBeenLastCalledWith("adopt_compass_platform_fireworks", { p_organization_id: "org-a", p_terms_acknowledged: true });
    expect(await store.renewFireworksAttestation(actor, { days: 90 })).toMatchObject({ ok: false });
    expect(await store.renewFireworksAttestation(actor, { days: 91, termsAcknowledged: true })).toMatchObject({ ok: false });
    expect(await store.renewFireworksAttestation(actor, { days: 0, termsAcknowledged: true })).toMatchObject({ ok: false });
    expect(await store.renewFireworksAttestation(actor, { termsAcknowledged: true })).toMatchObject({ ok: true });
    // A day count, never a client-clock instant: the server computes the
    // expiry, so a fast browser clock cannot push it past the 90-day bound.
    expect(rpc).toHaveBeenLastCalledWith("renew_compass_platform_fireworks_attestation",
      { p_days: 90, p_confirm_zero_data_retention: true, p_confirm_disallow_prompt_training: true });
  });
});

// Each Fireworks control keeps keyboard focus while its own
// change runs, is announced unavailable, and refuses a second press.
describe("Fireworks platform setup while a change runs", () => {
  const attested = () => ({ ...live, attestationExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  it("keeps Renew focused and pending while the renewal runs, with every card control pending", async () => {
    const { store } = setup({ platform: attested() });
    const renew = await screen.findByRole("button", { name: "Renew attestation (90 days)" });
    fireEvent.click(screen.getByRole("checkbox"));
    await expectHeldWriteFocus(store.renewFireworksAttestation, renew, () => {
      fireEvent.click(renew);
      if (store.renewFireworksAttestation.mock.calls.length !== 1) return;
      for (const name of ["Replace key", "Disable platform failover"]) {
        const control = screen.getByRole("button", { name });
        expect(control).toBeEnabled();
        expect(control).toHaveAttribute("aria-disabled", "true");
      }
      expect(screen.getByRole("checkbox")).toBeEnabled();
      expect(screen.getByRole("checkbox")).toHaveAttribute("aria-disabled", "true");
    });
    await waitFor(() => expect(screen.getByText(/renewed for 90 days/)).toBeVisible());
  });
  it("keeps Disable focused and pending while the change runs", async () => {
    const { store } = setup({ platform: attested() });
    const disable = await screen.findByRole("button", { name: "Disable platform failover" });
    await expectHeldWriteFocus(store.disableFireworksConnector, disable);
    expect(store.disableFireworksConnector).toHaveBeenCalledOnce();
  });
  it("keeps Enable focused inside the pending key form while the key is saved", async () => {
    const { store } = setup();
    await draft();
    const enable = screen.getByRole("button", { name: "Enable platform failover" });
    await expectHeldWriteFocus(store.enableFireworksConnector, enable);
    expect(store.enableFireworksConnector).toHaveBeenCalledOnce();
  });
  it("keeps the existing-key adoption focused and pending while it runs", async () => {
    const { store } = setup({ connectors: [{ provider: "ai_connector_fireworks", status: "connected", model }] });
    const adopt = await screen.findByRole("button", { name: "Use existing secured key for platform failover" });
    fireEvent.click(screen.getByRole("checkbox"));
    await expectHeldWriteFocus(store.adoptFireworksConnector, adopt);
    expect(store.adoptFireworksConnector).toHaveBeenCalledOnce();
  });
});
