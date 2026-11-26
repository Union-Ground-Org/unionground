import { createElement as h } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { isServiceBusyError, rpcErrorText } from "../src/lib/rpcErrorText.js";
import { approveAndOpenFormCase, approveForm, formApprovalExpectation, formSignatureExpectation, getFormFilingStatus, isFormChangedSinceReview, isFormSavedElsewhere, openFormAsCase, readStoredFormDraft, returnForm, saveFormDraft, signMemberForm, stewardStartFormReview, submitForm } from "../src/lib/memberApi.js";

describe("forms api", () => {
  // #8935: a replayed save refused as saved elsewhere reads the stored draft.
  it("readStoredFormDraft reads the named form, or the newest open one of the template, for the member", async () => {
    const calls = [];
    const client = (answer) => ({ from: (table) => {
      calls.push(["from", table]);
      const query = {};
      for (const method of ["select", "eq", "in", "order"]) query[method] = (...args) => { calls.push([method, ...args]); return query; };
      query.limit = async (...args) => { calls.push(["limit", ...args]); return answer; };
      return query;
    } });
    expect(await readStoredFormDraft(client({ data: [{ id: "form-1", answers: { summary: "B" }, revision: 4 }], error: null }), { userId: "m-1", templateKey: "grievance", formId: "form-1" }))
      .toEqual({ id: "form-1", answers: { summary: "B" }, revision: 4, settingsScope: {}, organizationId: null });
    expect(calls).toEqual([["from", "member_forms"], ["select", "id,answers,revision,settings_scope,organization_id"], ["eq", "user_id", "m-1"], ["eq", "template_key", "grievance"], ["eq", "id", "form-1"], ["limit", 1]]);
    calls.length = 0;
    expect(await readStoredFormDraft(client({ data: [{ id: "form-2", answers: null }], error: null }), { userId: "m-1", templateKey: "grievance" }))
      .toEqual({ id: "form-2", answers: {}, revision: null, settingsScope: {}, organizationId: null });
    expect(await readStoredFormDraft(client({ data: [{ id: "form-3", answers: {}, revision: 1, organization_id: "org-1", settings_scope: { chapterId: "c-1", unitId: "u-1" } }], error: null }), { userId: "m-1", templateKey: "grievance" }))
      .toEqual({ id: "form-3", answers: {}, revision: 1, settingsScope: { chapterId: "c-1", unitId: "u-1" }, organizationId: "org-1" });
    expect(calls).toContainEqual(["in", "status", ["draft", "returned"]]);
    expect(await readStoredFormDraft(client({ data: [], error: null }), { userId: "m-1", templateKey: "grievance" })).toBeNull();
    expect(await readStoredFormDraft(client({ data: null, error: null }), { userId: "m-1", templateKey: "grievance" })).toBeNull();
    expect(await readStoredFormDraft(client({ data: [], error: null }), { userId: "", templateKey: "grievance" })).toBeNull();
    await expect(readStoredFormDraft(client({ data: null, error: { message: "denied" } }), { userId: "m-1", templateKey: "grievance" })).rejects.toThrow(/denied/);
  });
  // #9092: a save based on a revision goes through save_member_form_draft
  // (or its unit companion) and answers {formId, revision}; one without a
  // revision, an outbox entry queued before revisions, keeps save_form_draft.
  it("saveFormDraft sends a revision-based save to save_member_form_draft, naming the form or null", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { formId: "form-1", revision: 3 }, error: null });
    expect(await saveFormDraft({ rpc }, { templateKey: "grievance", answers: { summary: "x" }, step: 1, formId: "form-1", baseRevision: 2, baseAnswers: { summary: "ignored" } }))
      .toEqual({ formId: "form-1", revision: 3 });
    expect(rpc).toHaveBeenLastCalledWith("save_member_form_draft", { p_template_key: "grievance", p_answers: { summary: "x" }, p_step: 1, p_expected_form_id: "form-1", p_base_revision: 2 });
    await saveFormDraft({ rpc }, { templateKey: "grievance", answers: {}, step: 0, baseRevision: 0 });
    expect(rpc).toHaveBeenLastCalledWith("save_member_form_draft", { p_template_key: "grievance", p_answers: {}, p_step: 0, p_expected_form_id: null, p_base_revision: 0 });
    await saveFormDraft({ rpc }, { templateKey: "grievance", answers: {}, step: 0, formId: "form-1", baseRevision: 1, unitId: "unit-1", actorId: "m-1", chapterId: "ch-1", organizationId: "org-1" });
    expect(rpc).toHaveBeenLastCalledWith("save_unit_member_form_draft", { p_template_key: "grievance", p_answers: {}, p_step: 0, p_expected_form_id: "form-1", p_base_revision: 1,
      p_unit: "unit-1", p_actor: "m-1", p_chapter: "ch-1", p_organization: "org-1" });
    expect(rpc).toHaveBeenCalledTimes(3);
    for (const baseRevision of [undefined, null, "2", 1.5]) {
      rpc.mockClear();
      await saveFormDraft({ rpc }, { templateKey: "grievance", answers: {}, step: 0, formId: "form-1", baseRevision });
      expect(rpc.mock.calls[0][0], String(baseRevision)).toBe("save_form_draft");
    }
  });
  it("saveFormDraft keeps a refused revision-based save a refusal, sent once", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PT409", message: "form changed elsewhere", details: "form_saved_elsewhere" }, status: 409 });
    await expect(saveFormDraft({ rpc }, { templateKey: "grievance", answers: {}, step: 0, formId: "form-1", baseRevision: 2 })).rejects.toSatisfy(isFormSavedElsewhere);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("saveFormDraft passes template/answers/step and returns id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "form-1", error: null });
    const id = await saveFormDraft({ rpc }, { templateKey: "grievance", answers: { summary: "x" }, step: 1 });
    expect(id).toBe("form-1");
    expect(rpc).toHaveBeenCalledWith("save_form_draft", { p_template_key: "grievance", p_answers: { summary: "x" }, p_step: 1 });
  });
  it("saveFormDraft names the lane's form, and never resends without it", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "form-1", error: null });
    expect(await saveFormDraft({ rpc }, { templateKey: "grievance", answers: { summary: "x" }, step: 1, formId: "form-1" })).toBe("form-1");
    expect(rpc).toHaveBeenCalledWith("save_form_draft", { p_template_key: "grievance", p_answers: { summary: "x" }, p_step: 1, p_expected_form_id: "form-1" });
    // BUG-UG-FORM-SAVE-RESENT-WITH-FEWER-ARGUMENTS-UNDER-ANOTHER-ACCOUNT-20261115:
    // a missing function is a failed save; the resend that dropped the form id
    // ran as whoever was signed in by then.
    const older = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 })
      .mockResolvedValue({ data: "form-other", error: null });
    const failed = await saveFormDraft({ rpc: older }, { templateKey: "grievance", answers: {}, step: 0, formId: "form-1" }).catch((error) => error);
    expect(failed.code).toBe("PGRST202");
    expect(older).toHaveBeenCalledTimes(1);
    // A form submitted elsewhere is refused once, never retried into a new draft.
    const closed = vi.fn().mockResolvedValue({ data: null, status: 409, error: { code: "PT409", message: "form no longer editable", details: "form_not_editable" } });
    const refused = await saveFormDraft({ rpc: closed }, { templateKey: "grievance", answers: {}, step: 0, formId: "form-1" }).catch((error) => error);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(refused.details).toBe("form_not_editable");
  });
  it("submitForm names what the submitter reviewed, and goes once without it before the migration", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "submitted" }, error: null });
    await submitForm({ rpc }, "form-1", { templateKey: "fmla_self", answers: { start_date: "2027-01-01" }, dataVersion: "v2", attachmentIds: ["file-1"] });
    expect(rpc).toHaveBeenCalledWith("submit_form", { p_form_id: "form-1", p_expected: { dataVersion: "v2", attachmentIds: ["file-1"] } });
    const older = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 })
      .mockResolvedValueOnce({ data: { status: "submitted" }, error: null });
    expect(await submitForm({ rpc: older }, "form-1", { templateKey: "grievance", answers: { summary: "x" }, attachmentIds: [] })).toEqual({ status: "submitted" });
    expect(older).toHaveBeenLastCalledWith("submit_form", { p_form_id: "form-1" });
    const changed = vi.fn().mockResolvedValue({ data: null, status: 409, error: { code: "PT409", message: "form changed since review", details: "form_changed_since_review" } });
    const refused = await submitForm({ rpc: changed }, "form-1", { templateKey: "grievance", answers: {}, attachmentIds: [] }).catch((error) => error);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(isFormChangedSinceReview(refused)).toBe(true);
  });
  it("saveFormDraft names the answers it was based on, and is sent once whatever a missing function answers", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "form-1", error: null });
    await saveFormDraft({ rpc }, { templateKey: "grievance", answers: { summary: "new" }, step: 1, formId: "form-1", baseAnswers: { summary: "old" } });
    expect(rpc).toHaveBeenCalledWith("save_form_draft", { p_template_key: "grievance", p_answers: { summary: "new" }, p_step: 1, p_expected_form_id: "form-1", p_base_answers: { summary: "old" } });
    for (const missing of [
      { data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 },
      { data: null, error: { code: "42883", message: "function does not exist" }, status: 404 },
      { data: null, error: { code: "PGRST000", message: "not found" }, status: 404 },
    ]) {
      for (const formId of ["form-1", null]) {
        const older = vi.fn().mockResolvedValueOnce(missing).mockResolvedValue({ data: "form-other", error: null });
        const failed = await saveFormDraft({ rpc: older }, { templateKey: "grievance", answers: { summary: "A's answers" }, step: 0, formId, baseAnswers: {} }).catch((error) => error);
        expect(failed.code).toBe(missing.error.code);
        expect(isServiceBusyError(failed) || missing.error.code === "PGRST000").toBe(true);
        expect(older).toHaveBeenCalledTimes(1);
        expect(Object.keys(older.mock.calls[0][1]).sort().join(",")).toBe(formId
          ? "p_answers,p_base_answers,p_expected_form_id,p_step,p_template_key" : "p_answers,p_base_answers,p_step,p_template_key");
      }
    }
    const elsewhere = vi.fn().mockResolvedValue({ data: null, status: 409, error: { code: "PT409", message: "form changed elsewhere", details: "form_saved_elsewhere" } });
    const refused = await saveFormDraft({ rpc: elsewhere }, { templateKey: "grievance", answers: {}, step: 0, formId: "form-1", baseAnswers: {} }).catch((error) => error);
    expect(elsewhere).toHaveBeenCalledTimes(1);
    expect(isFormSavedElsewhere(refused)).toBe(true);
    expect(isFormSavedElsewhere({ details: "form_not_editable" })).toBe(false);
  });
  // #8949 round 1 (r1s1, r2s1): the replay's save and its recovery read are
  // pinned to the member who queued it. Once another member is signed in they
  // send nothing; otherwise they carry the pinned member's current token.
  it("a pinned revision save and the pinned recovery read send nothing for another member, and carry the member's token", async () => {
    const asUser = { userId: "member-a", accessToken: "token-a-old" };
    const signedIn = (userId, token) => ({ getSession: vi.fn(async () => ({ data: { session: { user: { id: userId }, access_token: token } } })) });
    const rpc = vi.fn();
    const from = vi.fn();
    const fields = { templateKey: "grievance", answers: { summary: "A's answers" }, step: 0, formId: "form-1", baseRevision: 2 };
    await expect(saveFormDraft({ rpc, auth: signedIn("member-b", "token-b") }, fields, { asUser })).rejects.toMatchObject({ code: "SESSION_CHANGED" });
    await expect(readStoredFormDraft({ from, auth: signedIn("member-b", "token-b") }, { userId: "member-a", templateKey: "grievance", formId: "form-1" }, { asUser }))
      .rejects.toMatchObject({ code: "SESSION_CHANGED" });
    expect(rpc).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    const headers = [];
    const pinnedAnswer = (answer) => ({ setHeader: (name, value) => { headers.push([name, value]); return Promise.resolve(answer); } });
    rpc.mockReturnValue(pinnedAnswer({ data: { formId: "form-1", revision: 3 }, error: null }));
    expect(await saveFormDraft({ rpc, auth: signedIn("member-a", "token-a-now") }, fields, { asUser })).toEqual({ formId: "form-1", revision: 3 });
    expect(rpc).toHaveBeenCalledWith("save_member_form_draft", expect.objectContaining({ p_expected_form_id: "form-1", p_base_revision: 2 }));
    const query = {};
    for (const method of ["select", "eq", "in", "order"]) query[method] = () => query;
    query.limit = () => pinnedAnswer({ data: [{ id: "form-1", answers: { summary: "A's answers" }, revision: 3 }], error: null });
    expect(await readStoredFormDraft({ from: () => query, auth: signedIn("member-a", "token-a-now") }, { userId: "member-a", templateKey: "grievance", formId: "form-1" }, { asUser }))
      .toEqual({ id: "form-1", answers: { summary: "A's answers" }, revision: 3, settingsScope: {}, organizationId: null });
    expect(headers).toEqual([["Authorization", "Bearer token-a-now"], ["Authorization", "Bearer token-a-now"]]);
  });
  it("a unit save names its base too, and is never resent with fewer arguments", async () => {
    const unit = { unitId: "unit-1", actorId: "member-1", chapterId: "chapter-1", organizationId: "org-1" };
    const rpc = vi.fn().mockResolvedValue({ data: "form-1", error: null });
    await saveFormDraft({ rpc }, { templateKey: "grievance", answers: { summary: "new" }, step: 1, formId: "form-1", baseAnswers: { summary: "old" }, ...unit });
    expect(rpc).toHaveBeenCalledWith("save_unit_form_draft", { p_template_key: "grievance", p_answers: { summary: "new" }, p_step: 1,
      p_expected_form_id: "form-1", p_base_answers: { summary: "old" }, p_unit: "unit-1", p_actor: "member-1", p_chapter: "chapter-1", p_organization: "org-1" });
    const missing = { data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 };
    const older = vi.fn().mockResolvedValueOnce(missing).mockResolvedValue({ data: "form-other", error: null });
    expect((await saveFormDraft({ rpc: older }, { templateKey: "grievance", answers: {}, step: 0, formId: "form-1", baseAnswers: {}, ...unit }).catch((error) => error)).code).toBe("PGRST202");
    expect(older.mock.calls.map(([name, args]) => `${name}:${"p_base_answers" in args}`)).toEqual(["save_unit_form_draft:true"]);
    const elsewhere = vi.fn().mockResolvedValue({ data: null, status: 409, error: { code: "PT409", message: "form changed elsewhere", details: "form_saved_elsewhere" } });
    const refused = await saveFormDraft({ rpc: elsewhere }, { templateKey: "grievance", answers: {}, step: 0, formId: "form-1", baseAnswers: {}, ...unit }).catch((error) => error);
    expect(elsewhere).toHaveBeenCalledTimes(1);
    expect(isFormSavedElsewhere(refused)).toBe(true);
  });
  it("submitForm returns the payload and throws a labeled error", async () => {
    const ok = vi.fn().mockResolvedValue({ data: { status: "submitted", awardedPoints: 15 }, error: null });
    expect(await submitForm({ rpc: ok }, "form-1")).toEqual({ status: "submitted", awardedPoints: 15 });
    const bad = vi.fn().mockResolvedValue({ data: null, error: { message: "form not submittable" } });
    await expect(submitForm({ rpc: bad }, "form-1")).rejects.toThrow(/Form: form not submittable/);
  });
  it("signMemberForm sends normalized strokes and explicit consent", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { signedAt: "now" }, error: null });
    const strokes = [[{ x: 10, y: 20 }, { x: 900, y: 800 }]];
    expect(await signMemberForm({ rpc }, "form-1", strokes, true)).toEqual({ signedAt: "now" });
    expect(rpc).toHaveBeenCalledWith("sign_member_form", {
      p_form_id: "form-1", p_strokes: strokes, p_consent: true,
    });
  });
  it("signMemberForm names what the signer reviewed, and goes once without it before the migration", async () => {
    const strokes = [[{ x: 1, y: 2 }, { x: 3, y: 4 }]];
    const rpc = vi.fn().mockResolvedValue({ data: { signedAt: "now" }, error: null });
    await signMemberForm({ rpc }, "form-1", strokes, true, { templateKey: "grievance", answers: { summary: "x" }, dataVersion: null, attachmentIds: ["file-1"] });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("sign_member_form", {
      p_form_id: "form-1", p_strokes: strokes, p_consent: true, p_expected: { answers: { summary: "x" }, attachmentIds: ["file-1"] },
    });
    const older = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 })
      .mockResolvedValueOnce({ data: { signedAt: "now" }, error: null });
    expect(await signMemberForm({ rpc: older }, "form-1", strokes, true, { templateKey: "grievance", answers: {} })).toEqual({ signedAt: "now" });
    expect(older).toHaveBeenLastCalledWith("sign_member_form", { p_form_id: "form-1", p_strokes: strokes, p_consent: true });
  });
  it("a sealed form is named by its version, never by its plaintext answers", () => {
    expect(formSignatureExpectation({ templateKey: "fmla_self", answers: { start_date: "2027-01-01" }, dataVersion: "v2", attachmentIds: [] }))
      .toEqual({ dataVersion: "v2", attachmentIds: [] });
    expect(formSignatureExpectation({ templateKey: "fmla_family", answers: { leave: "x" } })).toEqual({ dataVersion: null });
    expect(formSignatureExpectation({ templateKey: "grievance", answers: { summary: "x" } })).toEqual({ answers: { summary: "x" } });
    expect(formSignatureExpectation(null)).toBeNull();
  });
  it("signMemberForm surfaces the changed-since-review refusal without retrying it", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, status: 409, error: { code: "PT409", message: "form changed since review", details: "form_changed_since_review" } });
    const refused = await signMemberForm({ rpc }, "form-1", [[{ x: 1, y: 2 }]], true, { templateKey: "fmla_self", dataVersion: "v1" }).catch((error) => error);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(isFormChangedSinceReview(refused)).toBe(true);
    expect(isFormChangedSinceReview({ details: "event_changed" })).toBe(false);
    expect(isFormChangedSinceReview(null)).toBe(false);
  });
  it("approveForm and approveAndOpenFormCase name what the steward reviewed, and are never resent without it (#8960)", async () => {
    const review = { templateKey: "fmla_self", answers: { start_date: "2027-01-01" }, dataVersion: "v3", attachmentIds: ["file-1"], cosignerIds: ["cs-1"] };
    const rpc = vi.fn().mockResolvedValue({ data: { status: "approved" }, error: null });
    await approveForm({ rpc }, "form-1", " ok ", review);
    expect(rpc).toHaveBeenCalledWith("approve_form", { p_form_id: "form-1", p_note: "ok", p_expected: { dataVersion: "v3", attachmentIds: ["file-1"], cosignerIds: ["cs-1"] } });
    await approveAndOpenFormCase({ rpc }, "form-1", "", { templateKey: "grievance", answers: { summary: "x" }, attachmentIds: [] });
    expect(rpc).toHaveBeenLastCalledWith("approve_and_open_case", { p_form_id: "form-1", p_note: null, p_expected: { answers: { summary: "x" }, attachmentIds: [], cosignerIds: [] } });
    for (const approve of [approveForm, approveAndOpenFormCase]) {
      const older = vi.fn()
        .mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" }, status: 404 })
        .mockResolvedValue({ data: { status: "approved" }, error: null });
      const refusal = await approve({ rpc: older }, "form-1", "", review).catch((error) => error);
      expect(refusal.code).toBe("PGRST202");
      expect(older).toHaveBeenCalledTimes(1);
      expect(older.mock.calls[0][1]).toHaveProperty("p_expected");
    }
    expect(formApprovalExpectation(null)).toBeNull();
  });
  it("never sends an approval that names nothing the steward saw", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "approved" }, error: null });
    await expect(approveForm({ rpc }, "form-1", "", null)).rejects.toThrow("approval-review-required");
    await expect(approveAndOpenFormCase({ rpc }, "form-1", "")).rejects.toThrow("approval-review-required");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("getFormFilingStatus uses the server-authoritative readiness RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { filerSigned: true, attachments: [] }, error: null });
    expect(await getFormFilingStatus({ rpc }, "form-1")).toEqual({ filerSigned: true, attachments: [] });
    expect(rpc).toHaveBeenCalledWith("get_form_filing_status", { p_form_id: "form-1" });
  });
  it("steward review writers map params to the review RPCs", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    await stewardStartFormReview({ rpc }, "f-1");
    expect(rpc).toHaveBeenCalledWith("steward_start_review", { p_form_id: "f-1" });
    const review = { templateKey: "grievance", answers: { summary: "x" }, attachmentIds: [], cosignerIds: [] };
    const p_expected = { answers: { summary: "x" }, attachmentIds: [], cosignerIds: [] };
    await approveForm({ rpc }, "f-1", "  looks solid  ", review);
    expect(rpc).toHaveBeenCalledWith("approve_form", { p_form_id: "f-1", p_note: "looks solid", p_expected });
    await approveForm({ rpc }, "f-1", "   ", review);
    expect(rpc).toHaveBeenCalledWith("approve_form", { p_form_id: "f-1", p_note: null, p_expected });
    await returnForm({ rpc }, "f-1", " needs dates ");
    expect(rpc).toHaveBeenCalledWith("return_form", { p_form_id: "f-1", p_note: "needs dates" });
    await openFormAsCase({ rpc }, "f-1");
    expect(rpc).toHaveBeenCalledWith("open_form_as_case", { p_form_id: "f-1" });
    await approveAndOpenFormCase({ rpc }, "f-1", " ship it ", review);
    expect(rpc).toHaveBeenCalledWith("approve_and_open_case", { p_form_id: "f-1", p_note: "ship it", p_expected });
    await approveAndOpenFormCase({ rpc }, "f-1", "", review);
    expect(rpc).toHaveBeenCalledWith("approve_and_open_case", { p_form_id: "f-1", p_note: null, p_expected });
  });

  // When the function is truly missing, the member reads one plain sentence,
  // the editor keeps every answer typed, and the save is sent once.
  it("keeps the typed answers and says the service is busy when the save function is missing", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function public.save_form_draft" }, status: 404 });
    const client = { rpc };
    const shown = [];
    const onSaveDraft = (fields) => saveFormDraft(client, fields).catch((error) => {
      shown.push(rpcErrorText((key) => key, error, "toast.error"));
      throw error;
    });
    render(h(LanguageProvider, { lang: "en" }, h(FormsView, {
      data: { member: { id: "missing-fn-member" }, forms: [{ id: "grv-1", templateKey: "grievance", status: "draft", step: 0, answers: { summary: "Saved" }, cosigners: [] }] },
      onSaveDraft, onSubmit: vi.fn(),
    })));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "Typed while the function was missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Your latest answers could not be saved/)).toBeInTheDocument();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(shown).toEqual(["error.serviceBusy"]);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByDisplayValue("Typed while the function was missing")).toBeInTheDocument());
  });
});
