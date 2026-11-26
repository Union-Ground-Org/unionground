import { describe, expect, it, vi } from "vitest";
import { cosignInvitePreview, inviteCosigner, isCosignChangedSincePreview, respondToCosign, withdrawCosign } from "../src/lib/memberApi.js";

describe("alliance co-signers api", () => {
  it("inviteCosigner trims the email and maps params to the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "invited" }, error: null });
    const result = await inviteCosigner({ rpc }, "form-1", "  Ally@Example.org  ");
    expect(result).toEqual({ status: "invited" });
    expect(rpc).toHaveBeenCalledWith("invite_cosigner", { p_form_id: "form-1", p_email: "Ally@Example.org" });
  });

  it("inviteCosigner surfaces a labeled error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "you cannot invite yourself" } });
    await expect(inviteCosigner({ rpc }, "form-1", "me@example.org")).rejects.toThrow(/Co-signer: you cannot invite yourself/);
  });

  it("respondToCosign sends signature and consent only for explicit acceptance", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "accepted" }, error: null });
    const strokes = [[{ x: 10, y: 10 }, { x: 900, y: 900 }]];
    await respondToCosign({ rpc }, "form-2", true, strokes, true);
    expect(rpc).toHaveBeenCalledWith("respond_to_cosign", {
      p_form_id: "form-2", p_accept: true, p_strokes: strokes, p_consent: true,
    });
    await respondToCosign({ rpc }, "form-2", false);
    expect(rpc).toHaveBeenCalledWith("respond_to_cosign", {
      p_form_id: "form-2", p_accept: false, p_strokes: null, p_consent: false,
    });
  });

  it("respondToCosign names the previewed version on an accept only (#8703)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "accepted" }, error: null });
    const strokes = [[{ x: 10, y: 10 }, { x: 900, y: 900 }]];
    await respondToCosign({ rpc }, "form-2", true, strokes, true, "digest-2");
    expect(rpc).toHaveBeenLastCalledWith("respond_to_cosign", {
      p_form_id: "form-2", p_accept: true, p_strokes: strokes, p_consent: true, p_expected_digest: "digest-2",
    });
    await respondToCosign({ rpc }, "form-2", false, null, false, "digest-2");
    expect(rpc).toHaveBeenLastCalledWith("respond_to_cosign", {
      p_form_id: "form-2", p_accept: false, p_strokes: null, p_consent: false,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("respondToCosign never drops an issued digest, and never retries a refusal", async () => {
    const strokes = [[{ x: 10, y: 10 }, { x: 900, y: 900 }]];
    // Gate stage 173 (r1s2, r2s2): a PGRST202 can be a stale schema cache in
    // front of the new function, so a retry without the digest could co-sign
    // unchecked. The accept fails instead and nothing is sent again.
    const missing = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 })
      .mockResolvedValueOnce({ data: { status: "accepted" }, error: null });
    await expect(respondToCosign({ rpc: missing }, "form-5", true, strokes, true, "digest-5")).rejects.toThrow(/Co-signer: Could not find the function/);
    expect(missing).toHaveBeenCalledTimes(1);
    expect(missing.mock.calls[0][1]).toHaveProperty("p_expected_digest", "digest-5");
    // A server before the migration issues no digest; the accept goes as before.
    const old = vi.fn().mockResolvedValue({ data: { status: "accepted" }, error: null });
    await respondToCosign({ rpc: old }, "form-7", true, strokes, true, null);
    expect(old.mock.calls[0][1]).not.toHaveProperty("p_expected_digest");

    const refused = vi.fn().mockResolvedValue({
      data: null, status: 409,
      error: { code: "PT409", message: "form changed since the co-sign preview", details: "cosign_changed_since_preview" },
    });
    const error = await respondToCosign({ rpc: refused }, "form-6", true, strokes, true, "digest-6").catch((caught) => caught);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(isCosignChangedSincePreview(error)).toBe(true);
    expect(isCosignChangedSincePreview({ details: "form_changed_since_review" })).toBe(false);
  });

  it("withdrawCosign maps the form id and labels errors", async () => {
    const ok = vi.fn().mockResolvedValue({ data: { status: "withdrawn" }, error: null });
    expect(await withdrawCosign({ rpc: ok }, "form-3")).toEqual({ status: "withdrawn" });
    expect(ok).toHaveBeenCalledWith("withdraw_cosign", { p_form_id: "form-3" });
    const bad = vi.fn().mockResolvedValue({ data: null, error: { message: "no active co-signature" } });
    await expect(withdrawCosign({ rpc: bad }, "form-3")).rejects.toThrow(/Co-signer: no active co-signature/);
  });

  it("cosignInvitePreview returns the summary-only payload", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { summary: "Short issue", filerName: "A member" }, error: null });
    const preview = await cosignInvitePreview({ rpc }, "form-4");
    expect(preview).toEqual({ summary: "Short issue", filerName: "A member" });
    expect(rpc).toHaveBeenCalledWith("cosign_invite_preview", { p_form_id: "form-4" });
  });
});
