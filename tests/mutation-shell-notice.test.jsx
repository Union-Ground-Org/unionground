import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionToast, mutationFailureNotice } from "../src/App.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError, submitForm } from "../src/lib/memberApi.js";
import { t } from "../src/lib/i18n.js";

afterEach(cleanup);

// Execute the production callbacks and mutation catch, then render their real
// shell toast. This catches a missing fallback at any of the JSX call sites.
const source = readFileSync("src/App.jsx", "utf8");
const start = source.indexOf("  async function mutate(");
const mutation = source.slice(start, source.indexOf("\n  function handlePlanAction", start));
const callbacks = new Map();
function collect(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "JSXAttribute" && ["onSave", "onCreateCase", "onUpdateCase", "onAddCaseUpdate"].includes(node.name.name)) {
    const expression = node.value?.expression;
    if (expression?.type === "ArrowFunctionExpression" && expression.body?.callee?.name === "mutate") {
      const text = source.slice(expression.start, expression.end);
      if (node.name.name !== "onSave" || text.includes("updateMemberProfile")) callbacks.set(node.name.name, text);
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") collect(value);
  }
}
collect(parse(source, { sourceType: "module", plugins: ["jsx"] }));

function productionMutation(lang, notice) {
  const tr = key => t(lang, key);
  // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
  const create = new Function("memberOperation", "demoActive", "sessionRef", "isOfflineError", "isStepUpRequired", "setNotice", "mutationFailureNotice", "tr", `${mutation}; return mutate;`);
  return create({ run: fn => fn(), wait: value => value, assertCurrent: () => {} }, false,
    { current: { user: { id: "member" } } }, () => false, () => false, notice, mutationFailureNotice, tr);
}

it.each(["en", "es"].flatMap(lang => ["onSave", "onCreateCase", "onUpdateCase", "onAddCaseUpdate"].map(name => [lang, name])))(
  "keeps raw policy text out of the actual %s %s shell notice", async (lang, name) => {
  const tr = key => t(lang, key);
  const notice = vi.fn();
  const mutate = productionMutation(lang, notice);
  const raw = new MemberApiError("Save profile", { message: "new row violates row-level security policy for table member_profiles" });
  const refuse = async () => { throw raw; };
  expect(callbacks.has(name)).toBe(true);
  // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
  const callback = new Function("mutate", "memberMutationResources", "supabase", "session", "tr", "updateMemberProfile", "createMemberCase", "updateMemberCase", "addCaseUpdate", "setData", `const sessionDataClient = supabase; return (${callbacks.get(name)});`)(
    mutate, () => [], {}, { user: { id: "member" } }, tr, refuse, refuse, refuse, refuse, () => {});
  await expect(callback("case-or-fields", {})).rejects.toBe(raw);
  expect(notice).toHaveBeenLastCalledWith(tr("toast.saveFailed"));
  render(<LanguageProvider lang={lang}><ActionToast notice={notice.mock.calls.at(-1)[0]} onDismiss={() => {}} /></LanguageProvider>);
  expect(screen.getByRole("status")).toHaveTextContent(tr("toast.saveFailed"));
  expect(document.body).not.toHaveTextContent(/row-level security|member_profiles|Save profile/);
});

it.each(["en", "es"])("preserves actionable translated refusals in %s", (lang) => {
  const tr = key => t(lang, key);
  for (const [code, key] of [["23514", "rpcError.checkViolation"], ["42501", "rpcError.notPermitted"],
    ["40001", "rpcError.conflict"], ["PT409", "rpcError.conflict"]]) {
    expect(mutationFailureNotice(tr, new MemberApiError("Save", { code, message: "private SQL" }), "toast.saveFailed")).toBe(tr(key));
    expect(mutationFailureNotice(tr, new MemberApiError("Save", { code, message: "private SQL" }), null)).toBe(tr(key));
  }
  expect(mutationFailureNotice(tr, { code: "57014", message: "private SQL" }, "toast.saveFailed")).toBe(tr("error.serviceBusy"));
  expect(mutationFailureNotice(tr, { details: "scan_code_used", message: "private SQL" }, "toast.saveFailed")).toBe(tr("rpcError.scan_code_used"));
});

it.each(["en", "es"])("announces a translated fallback for an unknown refusal in %s", async (lang) => {
  const notice = vi.fn();
  const raw = new MemberApiError("Save", { code: "P0001", message: "Private database failure" });
  await expect(productionMutation(lang, notice)([], async () => { throw raw; }, "saved")).rejects.toBe(raw);
  render(<LanguageProvider lang={lang}><ActionToast notice={notice.mock.calls.at(-1)[0]} onDismiss={() => {}} /></LanguageProvider>);
  expect(screen.getByRole("status")).toHaveTextContent(t(lang, "toast.saveFailed"));
  expect(document.body).not.toHaveTextContent(raw.message);
});

it.each([
  ["en", "Your form was not submitted. Wait for each attachment safety check to finish before submitting."],
  ["es", "Tu formulario no se envió. Espera a que termine la revisión de seguridad de cada archivo adjunto antes de enviarlo."],
])("keeps actionable form-submission guidance in %s", async (lang, expected) => {
  const notice = vi.fn();
  const raw = new MemberApiError("Form", { code: "22023", message: "wait for every attachment inspection to finish" });
  await expect(productionMutation(lang, notice)([], async () => { throw raw; }, "saved")).rejects.toBe(raw);
  render(<LanguageProvider lang={lang}><ActionToast notice={notice.mock.calls.at(-1)[0]} onDismiss={() => {}} /></LanguageProvider>);
  expect(screen.getByRole("status")).toHaveTextContent(expected);
  expect(document.body).not.toHaveTextContent(raw.message);
});

const authNoticeCopy = [
  ["en", "Sign in and complete the second verification step to continue."],
  ["es", "Inicia sesión y completa el segundo paso de verificación para continuar."],
];
const authRefusal = { code: "42501", message: "authentication required" };
it.each(authNoticeCopy.flatMap(([lang, expected]) => [
  [lang, "bare", authRefusal, expected],
  [lang, "wrapped", new MemberApiError("Form", authRefusal), expected],
  [lang, "message only", { ...authRefusal, message: "Save profile: authentication required" }, expected],
]))("announces the sign-in requirement for an exact %s %s 42501", async (lang, _shape, error, expected) => {
  const notice = vi.fn();
  await expect(productionMutation(lang, notice)([], async () => { throw error; }, "saved")).rejects.toBe(error);
  expect(notice).toHaveBeenLastCalledWith(expected);
});

it.each([
  ["wait for attachment deletion to finish", "Wait for the attachment to finish being deleted, then submit again.",
    "Espera a que termine de eliminarse el archivo adjunto y vuelve a enviar el formulario."],
  ["wait for every attachment upload to finish", "Wait for all attachments to finish uploading, then submit again.",
    "Espera a que terminen de cargarse todos los archivos adjuntos y vuelve a enviar el formulario."],
  ["draw and save a current signature before submitting", "Draw and save your signature for this version of the form before submitting.",
    "Dibuja y guarda tu firma para esta versión del formulario antes de enviarlo."],
  ["form incomplete: private_field_key", "Fill in the missing required answer before submitting.",
    "Completa la respuesta obligatoria que falta antes de enviar el formulario."],
])("announces the submit_form refusal for %s in both languages", async (message, en, es) => {
  for (const [lang, expected] of [["en", en], ["es", es]]) {
    const notice = vi.fn();
    const rpc = vi.fn().mockResolvedValue({ error: { code: "22023", message } });
    const submit = () => submitForm({ rpc }, "form-id");
    await expect(productionMutation(lang, notice)([], submit, "saved")).rejects.toMatchObject({ code: "22023", label: "Form" });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("submit_form", { p_form_id: "form-id" });
    const { unmount } = render(<LanguageProvider lang={lang}><ActionToast notice={notice.mock.calls.at(-1)[0]} onDismiss={() => {}} /></LanguageProvider>);
    expect(screen.getByRole("status")).toHaveTextContent(expected);
    expect(screen.getByRole("status")).not.toHaveTextContent(message);
    unmount();
  }
});

it.each([
  [new MemberApiError("Form", { code: "42501", message: "authentication required for this operation" }), "rpcError.notPermitted"],
  [{ code: "22023", message: "authentication required" }, "toast.saveFailed"],
  [new MemberApiError("Form", { code: "22023", message: "wait for every attachment upload to finish first" }), "toast.saveFailed"],
  [new MemberApiError("Form", { code: "22023", message: "draft form incomplete: private_field_key" }), "toast.saveFailed"],
  [new MemberApiError("Other", { code: "22023", message: "form incomplete: private_field_key" }), "toast.saveFailed"],
])("keeps the narrow refusal matching for %o", (error, key) => {
  expect(mutationFailureNotice(key => key, error)).toBe(key);
});
