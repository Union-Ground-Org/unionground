import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MAX_STROKES } from "../src/components/SignaturePad.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FormsView } from "../src/views/FormsView.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const member = { initials: "MV" };

function renderForms(data, props = {}, lang = "en") {
  return render(
    <LanguageProvider lang={lang}>
      <FormsView
        data={data}
        onProfile={vi.fn()}
        onAssistant={vi.fn()}
        onSaveDraft={props.onSaveDraft || vi.fn().mockResolvedValue("form-x")}
        onSubmit={props.onSubmit || vi.fn().mockResolvedValue(null)}
        onInviteCosigner={props.onInviteCosigner || vi.fn().mockResolvedValue({ status: "invited" })}
        onRespondCosign={props.onRespondCosign || vi.fn().mockResolvedValue({ status: "accepted" })}
        onWithdrawCosign={props.onWithdrawCosign || vi.fn().mockResolvedValue({ status: "withdrawn" })}
      />
    </LanguageProvider>,
  );
}

describe("alliance co-sign requests inbox", () => {
  // Each request owns its pending state, including when another
  // response starts or settles. Exercise the real view and shared controls.
  it.each(["en", "es"].flatMap((lang) => ["decline", "withdraw"].flatMap((kind) =>
    [0, 1].map((first) => ({ lang, kind, first })),
  )))("keeps concurrent $kind rows pending in $lang, settling row $first first", async ({ lang, kind, first }) => {
    const copy = catalogue[lang];
    const settle = [];
    const respond = vi.fn(() => new Promise((resolve) => settle.push(resolve)));
    const requests = ["row-A", "row-B"].map((formId) => ({
      formId, status: kind === "withdraw" ? "accepted" : "invited", filerName: formId, summary: formId,
    }));
    renderForms({ member, forms: [], cosignRequests: requests }, {
      onRespondCosign: respond, onWithdrawCosign: respond,
    }, lang);
    const rows = requests.map((req) => screen.getByText(req.formId, { exact: false, selector: ".mforms-row-title" }).closest("article"));
    const actions = rows.map((row) => within(row).getByRole("button", { name: copy[`forms.cosign.${kind}`] }));
    fireEvent.click(actions[0]);
    fireEvent.click(actions[1]);
    expect(respond).toHaveBeenCalledTimes(2);
    // A third response is refused, and Accept must not open a dialog on A.
    fireEvent.click(actions[0]);
    if (kind === "decline") fireEvent.click(within(rows[0]).getByRole("button", { name: copy["forms.cosign.accept"] }));
    expect(respond).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
    for (const row of rows) {
      for (const button of within(row).getAllByRole("button")) {
        expect(button).toHaveAttribute("aria-busy", "true");
        expect(button).toHaveAttribute("aria-disabled", "true");
        expect(button).toBeEnabled();
      }
    }
    await act(async () => settle[first]({ status: kind === "withdraw" ? "withdrawn" : "declined" }));
    expect(rows[first]).not.toBeInTheDocument();
    expect(actions[1 - first]).toHaveAttribute("aria-busy", "true");
    fireEvent.click(actions[1 - first]);
    expect(respond).toHaveBeenCalledTimes(2);
    await act(async () => settle[1 - first]({ status: kind === "withdraw" ? "withdrawn" : "declined" }));
    // Out-of-order completions must not resurrect the already completed row.
    expect(screen.queryByText(copy["forms.cosign.title"])).toBeNull();
  });

  it.each([0, 1])("releases only the failed row for retry while row %i is still pending", async (pendingRow) => {
    const failRow = 1 - pendingRow;
    const responses = [];
    const onRespondCosign = vi.fn(() => new Promise((resolve, reject) => responses.push({ resolve, reject })));
    renderForms({ member, forms: [], cosignRequests: ["row-A", "row-B"].map((formId) => ({ formId, status: "invited", filerName: formId })) }, { onRespondCosign });
    const declines = screen.getAllByRole("button", { name: "Decline" });
    const accepts = screen.getAllByRole("button", { name: "Accept" });
    fireEvent.click(declines[0]);
    fireEvent.click(declines[1]);
    await act(async () => responses[failRow].reject(new Error("Try again")));
    expect(declines[failRow]).not.toHaveAttribute("aria-busy");
    expect(accepts[failRow]).not.toHaveAttribute("aria-disabled");
    expect(declines[pendingRow]).toHaveAttribute("aria-busy", "true");
    fireEvent.click(accepts[pendingRow]);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(declines[failRow]);
    expect(onRespondCosign).toHaveBeenCalledTimes(3);
    expect(declines[failRow]).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      responses[pendingRow].resolve({ status: "declined" });
      responses[2].resolve({ status: "declined" });
    });
    expect(screen.queryByText("Co-sign requests")).toBeNull();
  });

  it("allows closing an idle signing dialog while another row responds", async () => {
    let finish;
    const onRespondCosign = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    renderForms({ member, forms: [], cosignRequests: ["row-A", "row-B"].map((formId) => ({ formId, status: "invited", filerName: formId })) }, { onRespondCosign });
    fireEvent.click(screen.getAllByRole("button", { name: "Decline" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[1]);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getAllByRole("button", { name: "Decline" })[0]).toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[1]);
    expect(screen.getByRole("dialog", { name: "Sign this co-signature" })).toBeInTheDocument();
    await act(async () => finish({ status: "declined" }));
  });

  it.each([0, 1])("keeps signing pending across another row's completion (settle %i first)", async (first) => {
    const settle = [];
    const onRespondCosign = vi.fn(() => new Promise((resolve) => settle.push(resolve)));
    renderForms({ member, forms: [], cosignRequests: ["row-A", "row-B"].map((formId) => ({
      formId, status: "invited", filerName: formId, reviewDigest: `digest-${formId}`,
    })) }, { onRespondCosign });
    fireEvent.click(screen.getAllByRole("button", { name: "Decline" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[1]);
    fireEvent.click(screen.getByRole("radio", { name: catalogue.en["forms.filing.signatureWayType"] }));
    fireEvent.change(screen.getByRole("textbox", { name: catalogue.en["forms.filing.typedName"] }), { target: { value: "Jordan Mills" } });
    const consent = screen.getByRole("checkbox");
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole("button", { name: "Sign and accept" }));
    expect(onRespondCosign).toHaveBeenCalledTimes(2);
    await act(async () => settle[first]({ status: first === 0 ? "declined" : "accepted" }));
    if (first === 0) {
      expect(consent).toHaveAttribute("aria-busy", "true");
      const sign = screen.getByRole("button", { name: catalogue.en["forms.cosign.signing"] });
      expect(sign).toHaveAttribute("aria-busy", "true");
      fireEvent.click(sign);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    } else {
      expect(screen.getByRole("button", { name: "Decline" })).toHaveAttribute("aria-busy", "true");
    }
    expect(onRespondCosign).toHaveBeenCalledTimes(2);
    await act(async () => settle[1 - first]({ status: first === 0 ? "accepted" : "declined" }));
    expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("accepts only after the invitee draws and explicitly consents", async () => {
    const onRespondCosign = vi.fn().mockResolvedValue({ status: "accepted" });
    renderForms(
      { member, forms: [], cosignRequests: [{ formId: "f-1", status: "invited", filerName: "Jordan Mills", summary: "Mandatory overtime", invitedAt: "2026-07-21T15:00:00Z", reviewDigest: "digest-1" }] },
      { onRespondCosign },
    );
    expect(screen.getByText("Co-sign requests")).toBeInTheDocument();
    expect(screen.getByText(/Jordan Mills invited you to co-sign/)).toBeInTheDocument();
    expect(screen.getByText(/Mandatory overtime/)).toBeInTheDocument();
    const opener = screen.getByRole("button", { name: "Accept" });
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Sign this co-signature" });
    expect(dialog).toHaveTextContent("Mandatory overtime");
    // The prototype modal opens on its close button.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    const canvas = screen.getByLabelText("Draw your co-signature");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 90, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("checkbox", { name: /intend this drawing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign and accept" }));
    await waitFor(() => expect(onRespondCosign).toHaveBeenCalledWith("f-1", true, expect.any(Array), true, "digest-1"));
    const withdraw = await screen.findByRole("button", { name: "Withdraw" });
    await waitFor(() => expect(document.activeElement).toBe(withdraw));
  });

  it("traps dialog focus and returns it to the request action after Escape", async () => {
    renderForms({ member, forms: [], cosignRequests: [{ formId: "f-focus", status: "invited", filerName: "Jordan Mills", summary: "OT", invitedAt: "x" }] });
    const opener = screen.getByRole("button", { name: "Accept" });
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Sign this co-signature" });
    const close = screen.getByRole("button", { name: "Close" });
    // #9460: a held Sign and accept stays focusable, so it closes the tab order.
    const sign = screen.getByRole("button", { name: "Sign and accept" });
    // The prototype modal opens on its close button.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(sign);
    sign.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sign this co-signature" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("declines a request and removes it from the list", async () => {
    const onRespondCosign = vi.fn().mockResolvedValue({ status: "declined" });
    renderForms(
      { member, forms: [], cosignRequests: [{ formId: "f-2", status: "invited", filerName: "Jordan Mills", summary: "OT", invitedAt: "x" }] },
      { onRespondCosign },
    );
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(onRespondCosign).toHaveBeenCalledWith("f-2", false, null, false, null));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Decline" })).toBeNull());
  });

  it.each(["en", "es"])("announces the co-sign pad cap notice in %s", (lang) => {
    const copy = catalogue[lang];
    renderForms(
      { member, forms: [], cosignRequests: [{ formId: "f-cap", status: "invited", filerName: "Jordan Mills", summary: "OT", invitedAt: "x" }] },
      {},
      lang,
    );
    fireEvent.click(screen.getByRole("button", { name: copy["forms.cosign.accept"] }));
    const canvas = screen.getByLabelText(copy["forms.cosign.signature"]);
    for (let i = 0; i < MAX_STROKES; i += 1) {
      fireEvent.keyDown(canvas, { key: " " });
      fireEvent.keyDown(canvas, { key: " " });
    }
    fireEvent.keyDown(canvas, { key: " " });
    expect(screen.getByRole("note")).toHaveTextContent(copy["forms.cosign.signatureCapReached"]);
  });

  it("shows a re-affirm CTA after the grievance was edited", () => {
    renderForms({ member, forms: [], cosignRequests: [{ formId: "f-3", status: "reaffirm_needed", filerName: "Jordan Mills", summary: "OT", invitedAt: "x" }] });
    expect(screen.getByText(/edited an issue you co-signed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-affirm" })).toBeInTheDocument();
  });

  it("withdraws an accepted co-signature", async () => {
    const onWithdrawCosign = vi.fn().mockResolvedValue({ status: "withdrawn" });
    renderForms(
      { member, forms: [], cosignRequests: [{ formId: "f-4", status: "accepted", filerName: "Jordan Mills", summary: "OT", invitedAt: "x" }] },
      { onWithdrawCosign },
    );
    const pageHeading = screen.getByRole("heading", { name: "Forms" });
    expect(screen.getByText(/You co-signed Jordan Mills/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(onWithdrawCosign).toHaveBeenCalledWith("f-4"));
    await waitFor(() => expect(document.activeElement).toBe(pageHeading));
  });

  it.each([
    ["en", "Review issue"],
    ["es", "Revisar asunto"],
  ])("shows an accepted grievance read-only in %s", (lang, reviewLabel) => {
    const grievance = {
      id: "f-readable",
      templateKey: "alliance_grievance",
      templateVersion: 1,
      status: "submitted",
      answers: { summary: "Unsafe staffing", narrative: "Two units were left uncovered." },
    };
    renderForms({
      member,
      forms: [],
      cosignRequests: [{ formId: grievance.id, status: "accepted", filerName: "Jordan Mills", summary: "Unsafe staffing", invitedAt: "x", grievance }],
    }, {}, lang);
    fireEvent.click(screen.getByText(reviewLabel));
    expect(screen.getByRole("region", { name: lang === "es" ? "Detalles de la queja cofirmada" : "Co-signed grievance details" })).toHaveTextContent("Two units were left uncovered.");
    expect(screen.queryByRole("button", { name: /submit|enviar/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/member email|correo electrónico del miembro/i)).not.toBeInTheDocument();
  });

  it("keeps pre-accept and reaffirm-needed requests summary-only", () => {
    const grievance = { id: "f-hidden", templateKey: "alliance_grievance", templateVersion: 1, answers: { narrative: "Private narrative" } };
    renderForms({ member, forms: [], cosignRequests: [
      { formId: "f-invited", status: "invited", filerName: "Jordan Mills", summary: "Summary", grievance },
      { formId: "f-reaffirm", status: "reaffirm_needed", filerName: "Jordan Mills", summary: "Summary", grievance },
    ] });
    expect(screen.queryByText("Review issue")).not.toBeInTheDocument();
    expect(screen.queryByText("Private narrative")).not.toBeInTheDocument();
  });

  it("distinguishes an accepted grievance whose details are unavailable", () => {
    renderForms({ member, forms: [], cosignRequests: [
      { formId: "f-unavailable", status: "accepted", filerName: "Jordan Mills", summary: "Summary", grievance: null },
    ] });
    expect(screen.getByRole("status")).toHaveTextContent("The grievance details couldn't be loaded. Try again shortly.");
  });

  // #8703: the filer changed the grievance after this preview; nothing was
  // co-signed. The dialog closes, the row says so over the re-read preview,
  // nothing is retried, and the next accept names the new preview.
  it.each(["en", "es"])("explains a grievance changed since its preview and signs only the re-read one in %s", async (lang) => {
    const copy = catalogue[lang];
    const refusal = Object.assign(new Error("Co-signer: form changed since the co-sign preview"), { code: "PT409", details: "cosign_changed_since_preview" });
    const onRespondCosign = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValueOnce({ status: "accepted" });
    const request = { formId: "f-changed", status: "invited", filerName: "Jordan Mills", summary: "Mandatory overtime", invitedAt: "x", reviewDigest: "digest-old" };
    const props = { onRespondCosign };
    const view = renderForms({ member, forms: [], cosignRequests: [request] }, props, lang);
    const sign = () => {
      fireEvent.click(screen.getByRole("button", { name: copy["forms.cosign.accept"] }));
      const canvas = screen.getByLabelText(copy["forms.cosign.signature"]);
      fireEvent.keyDown(canvas, { key: " " });
      fireEvent.keyDown(canvas, { key: "ArrowRight" });
      fireEvent.keyDown(canvas, { key: " " });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: copy["forms.cosign.signAccept"] }));
    };
    sign();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onRespondCosign).toHaveBeenCalledTimes(1);
    expect(onRespondCosign).toHaveBeenLastCalledWith("f-changed", true, expect.any(Array), true, "digest-old");
    expect(screen.getByRole("alert")).toHaveTextContent(copy["forms.cosign.changedSincePreview"].replace("{name}", "Jordan Mills"));
    // Still a pending request, not shown as co-signed.
    expect(screen.getByRole("button", { name: copy["forms.cosign.accept"] })).toBeInTheDocument();

    // The app re-reads the requests: the current preview replaces the old one.
    view.rerender(
      <LanguageProvider lang={lang}>
        <FormsView
          data={{ member, forms: [], cosignRequests: [{ ...request, summary: "Mandatory overtime on weekends", reviewDigest: "digest-new" }] }}
          onProfile={vi.fn()} onAssistant={vi.fn()} onSaveDraft={vi.fn()} onSubmit={vi.fn()}
          onInviteCosigner={vi.fn()} onRespondCosign={onRespondCosign} onWithdrawCosign={vi.fn()}
        />
      </LanguageProvider>,
    );
    expect(screen.getByText(/Mandatory overtime on weekends/)).toBeInTheDocument();
    expect(onRespondCosign).toHaveBeenCalledTimes(1);
    sign();
    await waitFor(() => expect(onRespondCosign).toHaveBeenCalledTimes(2));
    expect(onRespondCosign).toHaveBeenLastCalledWith("f-changed", true, expect.any(Array), true, "digest-new");
    expect(await screen.findByRole("button", { name: copy["forms.cosign.withdraw"] })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("signs from the latest loaded preview when the requests refresh while the dialog is open", async () => {
    const onRespondCosign = vi.fn().mockResolvedValue({ status: "accepted" });
    const request = { formId: "f-live", status: "invited", filerName: "Jordan Mills", summary: "Old issue", invitedAt: "x", reviewDigest: "digest-a" };
    const view = renderForms({ member, forms: [], cosignRequests: [request] }, { onRespondCosign });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    view.rerender(
      <LanguageProvider lang="en">
        <FormsView
          data={{ member, forms: [], cosignRequests: [{ ...request, summary: "New issue", reviewDigest: "digest-b" }] }}
          onProfile={vi.fn()} onAssistant={vi.fn()} onSaveDraft={vi.fn()} onSubmit={vi.fn()}
          onInviteCosigner={vi.fn()} onRespondCosign={onRespondCosign} onWithdrawCosign={vi.fn()}
        />
      </LanguageProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Sign this co-signature" });
    expect(dialog).toHaveTextContent("New issue");
    expect(dialog).not.toHaveTextContent("Old issue");
    const canvas = screen.getByLabelText("Draw your co-signature");
    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: " " });
    fireEvent.click(screen.getByRole("checkbox", { name: /intend this drawing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sign and accept" }));
    await waitFor(() => expect(onRespondCosign).toHaveBeenCalledWith("f-live", true, expect.any(Array), true, "digest-b"));
  });

  it("hides the section entirely when there are no requests", () => {
    renderForms({ member, forms: [], cosignRequests: [] });
    expect(screen.queryByText("Co-sign requests")).toBeNull();
  });
});

describe("alliance co-signer invite panel (filer)", () => {
  const allianceForm = {
    id: "ally-1",
    templateKey: "alliance_grievance",
    status: "draft",
    step: 2, // opens directly on the review step, where the panel lives
    reviewNote: "",
    answers: { summary: "Unsafe staffing", incident_date: "2026-07-15", narrative: "n", affected: "a", remedy: "r" },
    cosigners: [{ id: "cs-1", email: "ava@example.org", status: "accepted" }],
  };

  it("lists existing co-signers and invites a new one with a normalized email", async () => {
    const onInviteCosigner = vi.fn().mockResolvedValue({ status: "invited" });
    renderForms({ member, forms: [allianceForm], cosignRequests: [] }, { onInviteCosigner });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    // The accepted co-signer triggers the pre-edit warning; consent through it.
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));

    expect(screen.getByText("Co-signers")).toBeInTheDocument();
    expect(screen.getByText("ava@example.org")).toBeInTheDocument();

    const input = screen.getByLabelText("Member email");
    fireEvent.change(input, { target: { value: "  New.Ally@Example.org " } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(onInviteCosigner).toHaveBeenCalledWith("ally-1", "new.ally@example.org"));
    expect(await screen.findByText("new.ally@example.org")).toBeInTheDocument();
  });

  // The RESUMED path above was the only one covered, which is why this shipped.
  // A FRESH alliance draft opens with form === null, so FormEditor used to hand
  // CosignerPanel a brand-new [] on every render — and the invite handler makes
  // the parent re-render, so the panel wiped the "Invited" row it had just
  // added and showed "No co-signers yet" right after a SUCCESSFUL invite.
  it("keeps the invited row on a fresh draft when the parent re-renders", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue("fresh-ally-1");
    const onInviteCosigner = vi.fn().mockResolvedValue({ status: "invited" });

    const data = { member, forms: [], cosignRequests: [] };
    const view = renderForms(data, { onSaveDraft, onInviteCosigner });
    // What App does after a successful invite: mutate → refresh() → setData,
    // which hands FormsView a brand-new data object.
    const parentRefresh = () => view.rerender(
      <LanguageProvider lang="en">
        <FormsView
          data={{ ...data, forms: [] }}
          onProfile={vi.fn()}
          onAssistant={vi.fn()}
          onSaveDraft={onSaveDraft}
          onSubmit={vi.fn().mockResolvedValue(null)}
          onInviteCosigner={onInviteCosigner}
          onRespondCosign={vi.fn()}
          onWithdrawCosign={vi.fn()}
        />
      </LanguageProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Group workplace issue/ }));
    fireEvent.change(screen.getByLabelText("Shared issue"), { target: { value: "Mandatory overtime" } });
    fireEvent.change(screen.getByLabelText("Date of incident"), { target: { value: "2026-07-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText("What happened"), { target: { value: "n" } });
    fireEvent.change(screen.getByLabelText("Affected workers"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("Desired remedy"), { target: { value: "r" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    // The panel appears once the fresh draft has a persisted id.
    const input = await screen.findByLabelText("Member email");
    fireEvent.change(input, { target: { value: "ally@example.org" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));

    await waitFor(() => expect(onInviteCosigner).toHaveBeenCalledWith("fresh-ally-1", "ally@example.org"));
    expect(await screen.findByText("ally@example.org")).toBeInTheDocument();

    parentRefresh();
    expect(screen.getByText("ally@example.org")).toBeInTheDocument();
    expect(screen.getByText("Invited")).toBeInTheDocument();
    expect(screen.queryByText("No co-signers yet.")).toBeNull();
  });

  it("blocks an invalid email client-side without calling the handler", () => {
    const onInviteCosigner = vi.fn().mockResolvedValue({ status: "invited" });
    renderForms({ member, forms: [allianceForm], cosignRequests: [] }, { onInviteCosigner });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    // The accepted co-signer triggers the pre-edit warning; consent through it.
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));

    fireEvent.change(screen.getByLabelText("Member email"), { target: { value: "notanemail" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(onInviteCosigner).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address.");
  });
});

// E1 card layer (review v5). The member surface is the .m-card CSS class now,
// not a spread style object. `{...undefined}` is legal JavaScript, so dropping
// `className={CARD_CLASS}` — or typoing the constant — strips the background,
// border, radius and shadow with no error and no lint warning. The plane half
// already has this guard in vp/admin/advisor-view.test.jsx; these three cases
// cover all FIVE of FormsView's .m-card sites (wave 2c: the three mforms-shell
// hub sections, plus the editor's co-signer panel and flush review list), each
// anchored on a distinct consumer so a surviving card cannot mask another's
// regression. Scope note: the wave-2c WorkloadView rebuild moved its eleven
// former .m-card sites onto the mwl-* namespace, so FormsView and the staff
// planes are now the whole .m-card population.
describe("member card surface (E1 card layer)", () => {
  const submitted = { id: "f-sub", templateKey: "grievance", status: "submitted", answers: {}, reviewNote: "" };
  const draft = { id: "f-draft", templateKey: "grievance", status: "draft", step: 0, answers: { summary: "Unsafe staffing" }, reviewNote: "" };

  it("keeps .m-card on the hub shells and the anon-review promise in the header sub", () => {
    renderForms({ member, forms: [submitted], cosignRequests: [] });

    // Wave 2c: the gold anon-review banner card is GONE — its promise moved
    // into the in-page header's sub line. Pinned at the banner's strength:
    // the exact copy, on the exact element, inside the page header, so the
    // steward-review promise cannot quietly drop out of the hub. The wording
    // stopped claiming an employer pipeline (none exists): submissions go
    // only to the steward's review inbox.
    const sub = screen.getByText(
      "Guided editors · drafts save automatically · submissions go only to the committee for review",
    );
    expect(sub.classList.contains("mforms-sub")).toBe(true);
    expect(sub.closest("header.mforms-ph")).not.toBeNull();

    // The card layer moved from per-tile to the shell: start tiles are
    // .mforms-tile buttons INSIDE the .m-card start shell (the tile class now
    // carries the tap/hover state layer the old is-tappable provided).
    const tile = screen.getByRole("button", { name: /Workplace issue report/ });
    expect(tile.classList.contains("mforms-tile")).toBe(true);
    const startShell = tile.closest(".m-card");
    expect(startShell).not.toBeNull();
    expect(startShell.classList.contains("mforms-shell")).toBe(true);

    // The submitted list is its own .m-card shell, not the start shell's.
    const submittedCard = screen.getByText("Submitted — in review").closest(".m-card");
    expect(submittedCard).not.toBeNull();
    expect(submittedCard).not.toBe(startShell);
  });

  it("keeps .m-card on the co-sign request card and the in-progress card", () => {
    renderForms({
      member,
      forms: [draft],
      cosignRequests: [{ formId: "f-1", status: "invited", filerName: "Jordan Mills", summary: "Mandatory overtime", invitedAt: "x" }],
    });

    const cosignCard = screen.getByText(/Jordan Mills invited you to co-sign/).closest(".m-card");
    expect(cosignCard).not.toBeNull();

    const inProgressCard = screen.getByRole("button", { name: "Resume draft" }).closest(".m-card");
    expect(inProgressCard).not.toBeNull();
    expect(inProgressCard).not.toBe(cosignCard);

    // Wave 2c inverse of the co-class rule: every hub shell is .mforms-shell
    // ON an .m-card (the sheet's selector is the compound .m-card.mforms-shell)
    // — a bare .mforms-shell lays its rows out on an unstyled block with no
    // error anywhere. This render owns exactly two shells: start + co-sign.
    const shells = document.querySelectorAll(".mforms-shell");
    expect(shells.length).toBe(2);
    shells.forEach((el) => expect(el.classList.contains("m-card")).toBe(true));
  });

  // The last two of this view's five .m-card sites live inside the editor, so
  // the hub-only renders above cannot reach them.
  it("keeps .m-card on the editor's co-signer panel and the flush review list", () => {
    renderForms({
      member,
      forms: [{
        id: "ally-1",
        templateKey: "alliance_grievance",
        status: "draft",
        step: 2, // the review step, where both surfaces live
        reviewNote: "",
        answers: { summary: "Unsafe staffing", incident_date: "2026-07-15", narrative: "n", affected: "a", remedy: "r" },
        cosigners: [{ id: "cs-1", email: "ava@example.org", status: "accepted" }],
      }],
      cosignRequests: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    // The accepted co-signer triggers the pre-edit warning; consent through it.
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));

    const panelCard = screen.getByText("Co-signers").closest(".m-card");
    expect(panelCard).not.toBeNull();

    const reviewCard = screen.getByText("Unsafe staffing").closest(".m-card");
    expect(reviewCard).not.toBeNull();
    expect(reviewCard.classList.contains("m-card--flush")).toBe(true);
    expect(reviewCard).not.toBe(panelCard);

    // Every variant is a co-class, never a replacement — a bare .m-card--flush
    // renders its accent on an unstyled block. This invariant moved here with
    // the modifiers themselves: since wave 2c the hub shells carry none, so
    // the editor's --flush is the render where a bare modifier would hide.
    const modified = document.querySelectorAll("[class*='m-card--']");
    expect(modified.length).toBeGreaterThan(0);
    modified.forEach((el) => expect(el.classList.contains("m-card")).toBe(true));
  });
});

describe("submitted form readback", () => {
  it.each(["submitted", "in_review", "approved"])("renders %s answers read-only", (status) => {
    renderForms({ member, forms: [{
      id: `f-${status}`,
      templateKey: "alliance_grievance",
      templateVersion: 1,
      status,
      answers: { summary: "Unsafe staffing", narrative: "Two units were left uncovered." },
      reviewNote: status === "approved" ? "Approved for filing" : "",
    }], cosignRequests: [] });
    fireEvent.click(screen.getByText("Read submitted form"));
    expect(screen.getByRole("region", { name: "Submitted form answers" })).toHaveTextContent("Two units were left uncovered.");
    expect(screen.queryByRole("button", { name: /submit for review/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resume draft/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Member email")).not.toBeInTheDocument();
  });

  it("localizes the readback disclosure in Spanish", () => {
    const data = { member, forms: [{ id: "f-es", templateKey: "grievance", templateVersion: 1, status: "submitted", answers: { summary: "Turno inseguro" }, reviewNote: "" }], cosignRequests: [] };
    render(
      <LanguageProvider lang="es">
        <FormsView data={data} onSaveDraft={vi.fn()} onSubmit={vi.fn()} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByText("Leer formulario enviado"));
    expect(screen.getByRole("region", { name: "Respuestas del formulario enviado" })).toHaveTextContent("Turno inseguro");
  });

  it("reports a missing pinned template without crashing or exposing a broken reader", () => {
    renderForms({ member, forms: [{ id: "f-missing", templateKey: "retired_custom_form", templateVersion: 4, status: "submitted", answers: { private: "value" }, reviewNote: "" }], cosignRequests: [] });
    expect(screen.getByRole("status")).toHaveTextContent("This submitted form can't be displayed until its template is available.");
    expect(screen.queryByText("Read submitted form")).not.toBeInTheDocument();
    expect(screen.queryByText("value")).not.toBeInTheDocument();
  });
});

// The D4 pre-edit warning: editing an alliance draft that already has ACCEPTED
// co-signers first asks for consent, because saving changed answers resets
// those co-signatures to "reaffirm_needed" and notifies the co-signers.
describe("co-signed draft pre-edit warning", () => {
  const cosigned = {
    id: "ally-w",
    templateKey: "alliance_grievance",
    status: "draft",
    step: 2,
    reviewNote: "",
    answers: { summary: "Unsafe staffing", incident_date: "2026-07-15", narrative: "n", affected: "a", remedy: "r" },
    cosigners: [{ id: "cs-1", email: "ava@example.org", status: "accepted" }],
  };

  it("pauses on an alertdialog before opening the editor", () => {
    renderForms({ member, forms: [cosigned], cosignRequests: [] });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/put on hold/);
    // Editor is NOT open yet.
    expect(screen.queryByText("Co-signers")).toBeNull();
  });

  it("keeps the signatures intact when the member backs out", () => {
    renderForms({ member, forms: [cosigned], cosignRequests: [] });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep it as signed" }));
    // It leaves with the prototype modal's 200 ms scrim fade.
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop[data-state='closing']"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Co-signers")).toBeNull();
    // Back on the hub.
    expect(screen.getByRole("button", { name: "Resume draft" })).toBeInTheDocument();
  });

  it("opens the editor on explicit consent", () => {
    renderForms({ member, forms: [cosigned], cosignRequests: [] });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("Co-signers")).toBeInTheDocument();
  });

  // The warning is a modal in the prototype's
  // manner: the page is isolated, Tab stays inside, the scrim keeps the
  // answers as signed, and focus goes back to the control that opened it.
  it("isolates the page, traps Tab, dismisses from its scrim and returns focus to its opener", () => {
    renderForms({ member, forms: [cosigned], cosignRequests: [] });
    const resume = screen.getByRole("button", { name: "Resume draft" });
    resume.focus();
    fireEvent.click(resume);
    const dialog = screen.getByRole("alertdialog");
    const keep = screen.getByRole("button", { name: "Keep it as signed" });
    const edit = screen.getByRole("button", { name: "Edit anyway" });
    expect(keep).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    edit.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(keep).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(edit).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Enter" });
    fireEvent.mouseDown(dialog);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.mouseDown(dialog.parentElement);
    // The scrim fades for 200 ms with focus still inside, then it goes.
    expect(dialog.parentElement).toHaveAttribute("data-state", "closing");
    expect(edit).toHaveFocus();
    fireEvent.transitionEnd(dialog.parentElement);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(resume).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  // The warning leaves with
  // the 200 ms scrim fade, and nothing answered mid-fade counts.
  it("ignores Edit, Escape and the scrim while it fades, and goes on the fallback timer", async () => {
    renderForms({ member, forms: [cosigned], cosignRequests: [] });
    const resume = screen.getByRole("button", { name: "Resume draft" });
    resume.focus();
    fireEvent.click(resume);
    const keep = screen.getByRole("button", { name: "Keep it as signed" });
    const layer = document.querySelector(".dialog-backdrop");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(layer).toHaveAttribute("data-state", "closing");
    expect(keep).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(layer);
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));
    expect(screen.queryByText("Co-signers")).toBeNull();
    await waitFor(() => expect(document.querySelector(".dialog-backdrop")).toBeNull());
    expect(resume).toHaveFocus();
    expect(screen.queryByText("Co-signers")).toBeNull();
  });

  it("closes at once under reduced motion", () => {
    const realMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    try {
      renderForms({ member, forms: [cosigned], cosignRequests: [] });
      const resume = screen.getByRole("button", { name: "Resume draft" });
      resume.focus();
      fireEvent.click(resume);
      fireEvent.click(screen.getByRole("button", { name: "Keep it as signed" }));
      expect(document.querySelector(".dialog-backdrop")).toBeNull();
      expect(resume).toHaveFocus();
    } finally {
      window.matchMedia = realMatchMedia;
    }
  });

  it("does not warn when no co-signer has accepted", () => {
    const invitedOnly = { ...cosigned, id: "ally-i", cosigners: [{ id: "cs-2", email: "b@example.org", status: "invited" }] };
    renderForms({ member, forms: [invitedOnly], cosignRequests: [] });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("Co-signers")).toBeInTheDocument();
  });

  it("does not warn on a plain grievance draft", () => {
    const plain = { id: "g-1", templateKey: "grievance", status: "draft", step: 0, answers: { summary: "x" }, reviewNote: "" };
    renderForms({ member, forms: [plain], cosignRequests: [] });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

// SOL-20260813-06: loadMemberApp bounds the member_forms walk and sets
// formsTruncated when the archive did not all fit; the hub discloses it
// instead of silently rendering a partial list as the complete one.
describe("bounded forms archive disclosure (SOL-20260813-06)", () => {
  it("shows the truncation notice with the loaded count in English", () => {
    const forms = [{ id: "g-1", templateKey: "grievance", status: "submitted", step: 3, answers: {}, reviewNote: "" }];
    renderForms({ member, forms, formsTruncated: true, cosignRequests: [] });
    expect(screen.getByRole("note")).toHaveTextContent(
      "You have more forms than fit here — showing your 1 most recently updated forms.",
    );
  });

  it("shows the truncation notice in Spanish", () => {
    const forms = [{ id: "g-1", templateKey: "grievance", status: "submitted", step: 3, answers: {}, reviewNote: "" }];
    renderForms({ member, forms, formsTruncated: true, cosignRequests: [] }, {}, "es");
    expect(screen.getByRole("note")).toHaveTextContent(
      "Tienes más formularios de los que caben aquí — mostrando tus 1 formularios actualizados más recientemente.",
    );
  });

  it("renders no notice when the archive was not truncated", () => {
    const forms = [{ id: "g-1", templateKey: "grievance", status: "submitted", step: 3, answers: {}, reviewNote: "" }];
    renderForms({ member, forms, cosignRequests: [] });
    expect(screen.queryByRole("note")).toBeNull();
  });
});

// The co-sign row actions, the signing dialog and the invite
// stay focusable as pending controls while their own write runs, refuse a
// second activation, and each write takes a synchronous lock. Each test turns
// the browser's focus fixup on (expectHeldWriteFocus).
describe("co-sign controls keep focus while their own writes run", () => {
  const invited = { formId: "f-held", status: "invited", filerName: "Jordan Mills", summary: "OT", invitedAt: "x", reviewDigest: "digest-held" };

  it("keeps Decline focused while it declines, and one tick declines once", async () => {
    const onRespondCosign = vi.fn().mockResolvedValue({ status: "declined" });
    renderForms({ member, forms: [], cosignRequests: [invited] }, { onRespondCosign });
    const decline = screen.getByRole("button", { name: "Decline" });
    const accept = screen.getByRole("button", { name: "Accept" });
    await expectHeldWriteFocus(onRespondCosign, decline, () => {
      fireEvent.click(decline);
      if (onRespondCosign.mock.calls.length === 1) {
        expect(accept).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(accept);
        expect(screen.queryByRole("dialog", { name: "Sign this co-signature" })).toBeNull();
      }
    });
    expect(onRespondCosign).toHaveBeenCalledWith("f-held", false, null, false, null);
  });

  it("starts one decline from two presses in one tick", async () => {
    const onRespondCosign = vi.fn().mockResolvedValue({ status: "declined" });
    renderForms({ member, forms: [], cosignRequests: [invited] }, { onRespondCosign });
    const decline = screen.getByRole("button", { name: "Decline" });
    await expectOneWriteFromOneTick(onRespondCosign, [() => fireEvent.click(decline), () => fireEvent.click(decline)]);
  });

  it("keeps Sign and accept focused, with consent and Cancel held, while the signature is sent", async () => {
    const onRespondCosign = vi.fn().mockResolvedValue({ status: "accepted" });
    renderForms({ member, forms: [], cosignRequests: [invited] }, { onRespondCosign });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    const canvas = screen.getByLabelText("Draw your co-signature");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 90, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    const consent = screen.getByRole("checkbox", { name: /intend this drawing/ });
    fireEvent.click(consent);
    const sign = screen.getByRole("button", { name: "Sign and accept" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await expectHeldWriteFocus(onRespondCosign, sign, () => {
      fireEvent.click(sign);
      if (onRespondCosign.mock.calls.length === 1) {
        expect(consent).toHaveAttribute("aria-disabled", "true");
        expect(consent).toBeEnabled();
        expect(cancel).toHaveAttribute("aria-disabled", "true");
        fireEvent.click(cancel);
        expect(screen.getByRole("dialog", { name: "Sign this co-signature" })).toBeInTheDocument();
      }
    });
    expect(onRespondCosign).toHaveBeenCalledWith("f-held", true, expect.any(Array), true, "digest-held");
  });

  it("keeps Send invite focused while it sends, then moves focus to the emptied email field", async () => {
    const onInviteCosigner = vi.fn().mockResolvedValue({ status: "invited" });
    const allianceForm = {
      id: "ally-held", templateKey: "alliance_grievance", status: "draft", step: 2, reviewNote: "",
      answers: { summary: "Unsafe staffing", incident_date: "2026-07-15", narrative: "n", affected: "a", remedy: "r" },
      cosigners: [],
    };
    renderForms({ member, forms: [allianceForm], cosignRequests: [] }, { onInviteCosigner });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    const input = screen.getByLabelText("Member email");
    fireEvent.change(input, { target: { value: "new.ally@example.org" } });
    const invite = screen.getByRole("button", { name: "Send invite" });
    await expectHeldWriteFocus(onInviteCosigner, invite);
    expect(onInviteCosigner).toHaveBeenCalledWith("ally-held", "new.ally@example.org");
    await waitFor(() => expect(input).toHaveValue(""));
    expect(invite).toBeDisabled();
    expect(input).toHaveFocus();
  });
});
