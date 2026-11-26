// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 72: the
// structure wizard said "Fix the highlighted fields before you check or
// create." with nothing highlighted. The reason now names every blocking
// field, says when the list is simply empty, and a flagged field carries
// aria-invalid with the visible error style. All values are fictional.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SetupReviewPage } from "../src/features/orgSetup/SetupReviewPage.jsx";
import { getOrganizationCatalogPlacement, importOrganizationStructure } from "../src/features/orgSetup/setupApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ORG = "a1b2c3d4-0000-4000-8000-000000000001";
const MISSING = { code: "PGRST202", message: "Could not find the function" };

function client() {
  return { async rpc() { return { data: null, error: MISSING }; } };
}

function renderPage(lang = "en", fullName = "") {
  const rpc = client();
  const api = {
    importOrganizationStructure: (hat, payload, dryRun) => importOrganizationStructure(rpc, hat, payload, dryRun),
    getOrganizationCatalogPlacement: (organizationId) => getOrganizationCatalogPlacement(rpc, organizationId),
  };
  render(
    <LanguageProvider lang={lang}>
      <SetupReviewPage api={api} data={{ member: { organizationId: ORG, fullName } }} organization={{ chapters: [] }} catalogClient={client()} />
    </LanguageProvider>,
  );
}

function reason() {
  const create = screen.getByRole("button", { name: /^(Create|Crear) / });
  return document.getElementById(create.getAttribute("aria-describedby"));
}

afterEach(cleanup);

describe("structure wizard blocking reason", () => {
  it("names the blocking fields on a blank form instead of pointing at highlights", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("radio", { name: "Build my own" }));
    expect(reason()).toHaveTextContent("Fix these before you check or create: Organization name at the top of your chart, Your name, and Authority.");
    expect(document.body.textContent).not.toContain("highlighted");
  });

  it("says the list is empty once the fields are filled, and the Check button points at it", async () => {
    renderPage("en", "Example Admin");
    fireEvent.click(await screen.findByRole("radio", { name: "Build my own" }));
    fireEvent.change(screen.getByLabelText("Organization name at the top of your chart"), { target: { value: "Example Workers Local 1" } });
    fireEvent.change(screen.getByLabelText("Authority"), { target: { value: "The members elected me president" } });
    const check = screen.getByRole("button", { name: "Check 0 items" });
    expect(check).toBeDisabled();
    expect(document.getElementById(check.getAttribute("aria-describedby"))).toHaveTextContent("Add at least one campaign or office before you check or create.");
  });

  it("marks a flagged row and attestation field invalid and names them", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("radio", { name: "Build my own" }));
    fireEvent.change(screen.getByLabelText("Organization name at the top of your chart"), { target: { value: "Example Workers Local 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a campaign or office" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "North Chapter" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.change(screen.getByDisplayValue("North Chapter"), { target: { value: "" } });
    expect(screen.getByLabelText("Authority")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Your name")).toHaveAttribute("aria-invalid", "true");
    expect(document.querySelector(".xus-input[aria-invalid='true'][id^='setup-row-']")).not.toBeNull();
    expect(reason()).toHaveTextContent("Fix these before you check or create: the campaign and office names marked in the list, Your name, and Authority.");
    expect(screen.getByRole("button", { name: "Check 1 items" })).toHaveAttribute("aria-describedby", reason().id);
  });

  it("names the blocking fields in Spanish", async () => {
    renderPage("es");
    fireEvent.click(await screen.findByRole("radio", { name: "Crear la mía desde cero" }));
    expect(reason().textContent).toMatch(/^Corrige esto antes de revisar o crear: Nombre de la organización en la parte superior de tu organigrama, Tu nombre y Autoridad\.$/);
  });

  it("gives a flagged field the visible error style", () => {
    const css = readFileSync("src/features/orgSetup/setupReview.css", "utf8");
    expect(css).toMatch(/#admin-setup-review \.xus-input\[aria-invalid="true"\] \{\s*border-color: var\(--destructive\);/);
  });
});
