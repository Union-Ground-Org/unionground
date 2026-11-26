// BUG-UG-FORM-FILE-WITH-UNFINISHED-SAFETY-CHECK-CANNOT-BE-REMOVED-20261112 (#8569):
// a form-file removal that still fails reads as a plain catalogue sentence with a
// retry, never the raw server or Storage text it used to print.
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionToast, mutationFailureNotice } from "../src/App.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { MemberApiError } from "../src/lib/memberApiError.js";
import { removeMemberFormFile } from "../src/lib/memberApi.js";

const KEY = "toast.formFileRemoveFailed";
const RAW = [
  "form-file-removal-unavailable",
  "not-authorized",
  "attachment bytes still exist",
  "The service is currently unavailable",
];

describe("form-file removal failure message", () => {
  it.each(RAW)("replaces the raw %s text with the catalogue sentence in English and Spanish", (message) => {
    const error = new MemberApiError("Remove form file", { message });
    const en = mutationFailureNotice((key, vars) => t("en", key, vars), error, KEY);
    const es = mutationFailureNotice((key, vars) => t("es", key, vars), error, KEY);
    expect(en).toBe("The supporting file could not be removed. Try again.");
    expect(es).toBe("No se pudo eliminar el archivo de respaldo. Vuelve a intentarlo.");
    for (const text of [en, es]) {
      expect(text).not.toContain(message);
      expect(text).not.toContain("Remove form file");
    }
  });

  it("shows the sentence to the member in the action toast", () => {
    const notice = mutationFailureNotice((key, vars) => t("en", key, vars), new MemberApiError("Remove form file", { message: "attachment bytes still exist" }), KEY);
    render(<LanguageProvider lang="en"><ActionToast notice={notice} onDismiss={() => {}} /></LanguageProvider>);
    expect(screen.getByText("The supporting file could not be removed. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/attachment bytes still exist/)).not.toBeInTheDocument();
  });

  it("is the failure key the form-file removal handler passes", () => {
    const source = readFileSync("src/App.jsx", "utf8");
    const handler = source.slice(source.indexOf("function handleRemoveFormFile(row)"), source.indexOf("async function handleDownloadForm("));
    expect(handler).toContain('"toast.formFileRemoveFailed"');
  });
});
