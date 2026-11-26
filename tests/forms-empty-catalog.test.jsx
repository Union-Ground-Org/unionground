import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildSearchIndex } from "../src/lib/searchIndex.js";

it("does not resurrect static start tiles or search results for an empty authoritative catalog", () => {
  const data = { member: { initials: "FT" }, forms: [], formTemplates: [], formTemplateVersions: [] };
  render(<LanguageProvider lang="en"><FormsView data={data} desktop /></LanguageProvider>);
  expect(screen.queryByRole("button", { name: /Workplace issue report/ })).not.toBeInTheDocument();
  expect(buildSearchIndex(data).filter((entry) => entry.type === "template")).toEqual([]);
});

it("retains the static preview when no authoritative catalog was supplied", () => {
  const data = { member: { initials: "FT" }, forms: [] };
  render(<LanguageProvider lang="en"><FormsView data={data} desktop /></LanguageProvider>);
  expect(screen.getByRole("button", { name: /Workplace issue report/ })).toBeInTheDocument();
  expect(buildSearchIndex(data).filter((entry) => entry.type === "template")).toHaveLength(7);
});
