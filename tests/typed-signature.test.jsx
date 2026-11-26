// REQ-UG-FORMS-COMPLETE-A-FORM-WITHOUT-DRAWING-A-SIGNATURE-20261113 (#8701):
// a member who cannot draw signs by typing their full name and ticking the
// consent box, as a filer and as a co-signer; reviewers see it marked typed.
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormFilingControls } from "../src/components/FormFilingControls.jsx";
import { EMPTY_SIGNATURE, SignatureChoice } from "../src/components/SignatureChoice.jsx";
import { FilerSignatureKindNote, cosignerNamesWithKind } from "../src/components/SignatureKindNote.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { respondToCosign, signMemberForm } from "../src/lib/memberApi.js";
import {
  normalizeTypedSignature, signatureIsReady, signatureRpcArgs, typedSignatureProblem,
} from "../src/lib/typedSignature.js";
import { useState } from "react";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const translate = (lang) => (key, vars = {}) => Object.entries(vars)
  .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), catalogue[lang][key] ?? key);
const filingT = (lang) => (key, vars) => translate(lang)(`forms.filing.${key}`, vars);

const TYPED_KEYS = [
  "forms.filing.signatureWay", "forms.filing.signatureWayDraw", "forms.filing.signatureWayType",
  "forms.filing.typedName", "forms.filing.typedNameHint", "forms.filing.typedNameHidden",
  "forms.filing.typedNameLength", "forms.filing.typedNameLetter", "forms.filing.typedConsent",
  "forms.cosign.typedNameHint", "forms.cosign.typedConsent", "steward.signedTyped", "steward.cosignerTyped",
];

describe("typed signature rule (client mirror of private.normalize_form_typed_signature)", () => {
  it("normalizes to NFC with inner whitespace collapsed and trimmed", () => {
    expect(normalizeTypedSignature("  José   Núñez \n")).toBe("José Núñez");
  });

  it("refuses hidden and control characters, bad lengths and names without a letter", () => {
    expect(typedSignatureProblem("Ana\u202eMar\u00eda")).toBe("hidden");
    expect(typedSignatureProblem("Ana\u200bMar\u00eda")).toBe("hidden");
    expect(typedSignatureProblem("Ana\tMaría")).toBe("hidden");
    expect(typedSignatureProblem("   ")).toBe("length");
    expect(typedSignatureProblem("A")).toBe("length");
    expect(typedSignatureProblem("a".repeat(121))).toBe("length");
    expect(typedSignatureProblem("12 34")).toBe("letter");
    expect(typedSignatureProblem("李小龍")).toBe("");
    expect(typedSignatureProblem("Lee")).toBe("");
    expect(typedSignatureProblem("a".repeat(120))).toBe("");
  });

  it("is ready only for drawn strokes or a valid typed name", () => {
    expect(signatureIsReady([])).toBe(false);
    expect(signatureIsReady([[{ x: 1, y: 1 }, { x: 2, y: 2 }]])).toBe(true);
    expect(signatureIsReady({ kind: "drawn", strokes: [] })).toBe(false);
    expect(signatureIsReady({ kind: "typed", name: "A" })).toBe(false);
    expect(signatureIsReady({ kind: "typed", name: "Ana Pérez" })).toBe(true);
  });

  it("sends a drawn signature exactly as before and a typed one with null strokes", () => {
    const strokes = [[{ x: 1, y: 1 }, { x: 2, y: 2 }]];
    expect(signatureRpcArgs(strokes)).toEqual({ p_strokes: strokes });
    expect(signatureRpcArgs({ kind: "drawn", strokes })).toEqual({ p_strokes: strokes });
    expect(signatureRpcArgs({ kind: "typed", name: " Ana  Pérez " })).toEqual({ p_strokes: null, p_typed_name: "Ana Pérez" });
  });
});

describe("memberApi signing calls", () => {
  const client = () => ({ rpc: vi.fn().mockResolvedValue({ data: { ok: true }, error: null }) });

  it("keeps the drawn sign_member_form call shape and adds the typed name only when typed", async () => {
    const strokes = [[{ x: 1, y: 1 }, { x: 2, y: 2 }]];
    const drawn = client();
    await signMemberForm(drawn, "form-1", strokes, true);
    expect(drawn.rpc).toHaveBeenCalledWith("sign_member_form", { p_form_id: "form-1", p_strokes: strokes, p_consent: true });
    const typed = client();
    await signMemberForm(typed, "form-1", { kind: "typed", name: "Ana Pérez" }, true);
    expect(typed.rpc).toHaveBeenCalledWith("sign_member_form", {
      p_form_id: "form-1", p_strokes: null, p_typed_name: "Ana Pérez", p_consent: true,
    });
  });

  it("sends the reviewed answers and attachments with a typed signature, and goes once without them before that migration", async () => {
    const typed = client();
    const review = { templateKey: "grievance", answers: { summary: "x" }, dataVersion: null, attachmentIds: ["file-1"] };
    await signMemberForm(typed, "form-1", { kind: "typed", name: "Ana Pérez" }, true, review);
    expect(typed.rpc).toHaveBeenCalledWith("sign_member_form", {
      p_form_id: "form-1", p_strokes: null, p_typed_name: "Ana Pérez", p_consent: true,
      p_expected: { answers: { summary: "x" }, attachmentIds: ["file-1"] },
    });
    const older = { rpc: vi.fn()
      .mockResolvedValueOnce({ data: null, status: 404, error: { code: "PGRST202", message: "no function" } })
      .mockResolvedValueOnce({ data: { ok: true }, error: null }) };
    await signMemberForm(older, "form-1", { kind: "typed", name: "Ana Pérez" }, true, review);
    // The fallback drops only the review; the typed name is never turned into a drawing.
    expect(older.rpc).toHaveBeenLastCalledWith("sign_member_form", {
      p_form_id: "form-1", p_strokes: null, p_typed_name: "Ana Pérez", p_consent: true,
    });
  });

  it("surfaces the changed-since-review refusal for a typed signature without retrying it", async () => {
    const refused = { rpc: vi.fn().mockResolvedValue({ data: null, status: 409, error: { code: "PT409", message: "form changed since review", details: "form_changed_since_review" } }) };
    const error = await signMemberForm(refused, "form-1", { kind: "typed", name: "Ana Pérez" }, true, { templateKey: "fmla_self", dataVersion: "v1", attachmentIds: [] }).catch((failure) => failure);
    expect(error?.details).toBe("form_changed_since_review");
    expect(refused.rpc).toHaveBeenCalledTimes(1);
  });

  it("lets a co-signer accept by typing and still declines without any signature", async () => {
    const typed = client();
    await respondToCosign(typed, "form-1", true, { kind: "typed", name: "Ana Pérez" }, true);
    expect(typed.rpc).toHaveBeenCalledWith("respond_to_cosign", {
      p_form_id: "form-1", p_accept: true, p_strokes: null, p_typed_name: "Ana Pérez", p_consent: true,
    });
    const declined = client();
    await respondToCosign(declined, "form-1", false, { kind: "typed", name: "Ana Pérez" }, true);
    expect(declined.rpc).toHaveBeenCalledWith("respond_to_cosign", {
      p_form_id: "form-1", p_accept: false, p_strokes: null, p_consent: false,
    });
  });
});

describe("SignatureChoice", () => {
  function Harness({ lang = "en" }) {
    const [value, setValue] = useState(EMPTY_SIGNATURE);
    const t = filingT(lang);
    return (
      <SignatureChoice
        value={value}
        onChange={setValue}
        labels={{
          legend: t("signatureWay"), draw: t("signatureWayDraw"), type: t("signatureWayType"),
          nameLabel: t("typedName"), nameHint: t("typedNameHint"),
          problems: { hidden: t("typedNameHidden"), length: t("typedNameLength"), letter: t("typedNameLetter") },
        }}
        padProps={{ label: t("signature"), instructions: t("signatureInstructions"), clearLabel: t("clearSignature"), emptyStatus: t("emptySignature") }}
      />
    );
  }

  it("is a labelled radio group that starts on drawing, with one tab stop and the typed name labelled and described", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "How do you want to sign?" });
    const draw = within(group).getByRole("radio", { name: "Draw my signature" });
    const type = within(group).getByRole("radio", { name: "Type my full name" });
    expect(draw).toBeChecked();
    // One shared name makes the two a native radio group: one Tab stop, arrow keys move.
    expect(draw.name).toBeTruthy();
    expect(type.name).toBe(draw.name);
    expect(screen.getByLabelText("Draw your signature")).toBeInTheDocument();

    fireEvent.click(type);
    expect(type).toBeChecked();
    expect(screen.queryByLabelText("Draw your signature")).toBeNull();
    const name = screen.getByRole("textbox", { name: "Your full name" });
    expect(name).toHaveAttribute("autocomplete", "name");
    expect(name).toHaveAccessibleDescription(catalogue.en["forms.filing.typedNameHint"]);
    fireEvent.change(name, { target: { value: "Ana Pérez" } });
    expect(name).toHaveValue("Ana Pérez");
    expect(name).not.toHaveAttribute("aria-invalid");
  });

  it("announces what is wrong with a typed name through the field's description, in Spanish too", () => {
    render(<Harness lang="es" />);
    fireEvent.click(screen.getByRole("radio", { name: "Escribir mi nombre completo" }));
    const name = screen.getByRole("textbox", { name: "Tu nombre completo" });
    fireEvent.change(name, { target: { value: "12" } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(`${catalogue.es["forms.filing.typedNameHint"]} ${catalogue.es["forms.filing.typedNameLetter"]}`);
    fireEvent.change(name, { target: { value: "Ana" } });
    expect(name).not.toHaveAttribute("aria-invalid");
  });

  it("keeps the typed name while the member switches ways", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "Type my full name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your full name" }), { target: { value: "Ana" } });
    fireEvent.click(screen.getByRole("radio", { name: "Draw my signature" }));
    fireEvent.click(screen.getByRole("radio", { name: "Type my full name" }));
    expect(screen.getByRole("textbox", { name: "Your full name" })).toHaveValue("Ana");
  });
});

describe("FormFilingControls typed signing", () => {
  it("saves a typed name with consent and uses the typed consent sentence", async () => {
    const onSaveSignature = vi.fn().mockResolvedValue({ signedAt: "now" });
    render(<FormFilingControls t={filingT("en")} editable files={[]} onSaveSignature={onSaveSignature} />);
    const save = screen.getByRole("button", { name: catalogue.en["forms.filing.saveSignature"] });
    fireEvent.click(screen.getByRole("radio", { name: "Type my full name" }));
    const consent = screen.getByRole("checkbox", { name: catalogue.en["forms.filing.typedConsent"] });
    fireEvent.change(screen.getByRole("textbox", { name: "Your full name" }), { target: { value: "Ana Pérez" } });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(catalogue.en["forms.filing.signatureTickBox"])).toBeInTheDocument();
    fireEvent.click(consent);
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(onSaveSignature).toHaveBeenCalledWith({ kind: "typed", strokes: [], name: "Ana Pérez" }, true, []));
    expect(await screen.findByText(catalogue.en["forms.filing.signatureSaved"])).toHaveAttribute("role", "status");
  });

  it("passes the attachments on screen with a typed name and explains a changed-since-review refusal", async () => {
    const onSaveSignature = vi.fn().mockRejectedValue(Object.assign(new Error("form changed since review"), { details: "form_changed_since_review" }));
    render(<FormFilingControls t={filingT("es")} editable files={[{ id: "file-1", filename: "nota.pdf", sizeBytes: 10 }]} onSaveSignature={onSaveSignature} />);
    fireEvent.click(screen.getByRole("radio", { name: "Escribir mi nombre completo" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Tu nombre completo" }), { target: { value: "Ana Pérez" } });
    fireEvent.click(screen.getByRole("checkbox", { name: catalogue.es["forms.filing.typedConsent"] }));
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["forms.filing.saveSignature"] }));
    await waitFor(() => expect(onSaveSignature).toHaveBeenCalledWith({ kind: "typed", strokes: [], name: "Ana Pérez" }, true, ["file-1"]));
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.es["forms.filing.changedSinceReview"]);
    expect(screen.queryByText(catalogue.es["forms.filing.signatureSaved"])).toBeNull();
  });

  it("keeps the drawn consent sentence and refuses an invalid typed name", () => {
    const onSaveSignature = vi.fn();
    render(<FormFilingControls t={filingT("en")} editable files={[]} onSaveSignature={onSaveSignature} />);
    expect(screen.getByRole("checkbox", { name: catalogue.en["forms.filing.consent"] })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Type my full name" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your full name" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: catalogue.en["forms.filing.saveSignature"] })).toHaveAttribute("aria-disabled", "true");
    expect(onSaveSignature).not.toHaveBeenCalled();
  });
});

describe("reviewer view of a typed signature", () => {
  it("names the typed filer signature next to the account name, never for a drawn one", () => {
    const t = translate("en");
    const { rerender } = render(<FilerSignatureKindNote status={{ filerSigned: true, filerSignatureKind: "typed", filerTypedName: "Ana M. Pérez" }} accountName="Ana Pérez" t={t} />);
    expect(screen.getByRole("note")).toHaveTextContent("Signed by typing a name, not drawn: “Ana M. Pérez” (account name: Ana Pérez).");
    rerender(<FilerSignatureKindNote status={{ filerSigned: true, filerSignatureKind: "drawn", filerTypedName: null }} accountName="Ana Pérez" t={t} />);
    expect(screen.queryByRole("note")).toBeNull();
    rerender(<FilerSignatureKindNote status={{ filerSigned: false, filerSignatureKind: "typed", filerTypedName: "Ana" }} accountName="Ana Pérez" t={t} />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("marks typed co-signers in the co-signed line, in English and Spanish", () => {
    const cosigners = [{ id: "c1", name: "José Ramos" }, { id: "c2", name: "Lee Park" }];
    const status = { cosignatures: [{ cosignerId: "c1", kind: "typed", typedName: "José A. Ramos" }, { cosignerId: "c2", kind: "drawn", typedName: null }] };
    expect(cosignerNamesWithKind(cosigners, status, translate("en"))).toBe("José Ramos (typed “José A. Ramos”), Lee Park");
    expect(cosignerNamesWithKind(cosigners, status, translate("es"))).toBe("José Ramos (escribió «José A. Ramos»), Lee Park");
    expect(cosignerNamesWithKind(cosigners, null, translate("en"))).toBe("José Ramos, Lee Park");
  });

  it("is wired into the steward's form review", () => {
    const source = readFileSync("src/views/StewardView.jsx", "utf8");
    expect(source).toContain("<FilerSignatureKindNote status={filingReadiness.status} accountName={item.memberName} t={t} />");
    expect(source).toContain("cosignerNamesWithKind(item.cosigners, filingReadiness?.status, t)");
  });
});

describe("typed signature copy", () => {
  it("has every new string in English and Spanish, and no submit hint that only says draw", () => {
    for (const key of TYPED_KEYS) {
      expect(catalogue.en[key], key).toBeTruthy();
      expect(catalogue.es[key], key).toBeTruthy();
      expect(catalogue.es[key], key).not.toBe(catalogue.en[key]);
    }
    expect(catalogue.en["forms.filing.signatureRequired"]).toMatch(/typing your name/);
    expect(catalogue.es["forms.filing.signatureRequired"]).toMatch(/escribiendo tu nombre/);
    expect(catalogue.en["forms.cosign.signLead"]).toMatch(/typing your own full name/);
    expect(catalogue.es["forms.cosign.signLead"]).toMatch(/escribiendo tu propio nombre/);
  });
});

// Record 8435: while the signature saves, the typed name and the way choice
// stay focusable as pending controls and refuse changes, as Main's disabled
// controls refused them; nothing typed is lost either way.
describe("FormFilingControls signature while it saves", () => {
  it("keeps the focused typed name in place, pending and unchanged while the signature saves", async () => {
    const onSaveSignature = vi.fn().mockResolvedValue({ signedAt: "now" });
    render(<FormFilingControls t={filingT("en")} editable files={[]} onSaveSignature={onSaveSignature} />);
    fireEvent.click(screen.getByRole("radio", { name: "Type my full name" }));
    const name = screen.getByRole("textbox", { name: "Your full name" });
    fireEvent.change(name, { target: { value: "Ana Pérez" } });
    fireEvent.click(screen.getByRole("checkbox", { name: catalogue.en["forms.filing.typedConsent"] }));
    const save = screen.getByRole("button", { name: catalogue.en["forms.filing.saveSignature"] });
    await expectHeldWriteFocus(onSaveSignature, name, () => {
      fireEvent.click(save);
      if (onSaveSignature.mock.calls.length === 1) {
        fireEvent.change(name, { target: { value: "Someone Else" } });
        expect(name).toHaveValue("Ana Pérez");
        const ways = screen.getByRole("radio", { name: "Type my full name" }).closest("fieldset");
        expect(ways).toHaveAttribute("aria-disabled", "true");
        expect(ways).not.toBeDisabled();
      }
    });
    expect(onSaveSignature).toHaveBeenCalledWith({ kind: "typed", strokes: [], name: "Ana Pérez" }, true, []);
  });
});
