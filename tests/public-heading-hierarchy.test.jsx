import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ContactView } from "../src/views/ContactView.jsx";
import { LegalView } from "../src/views/LegalView.jsx";
import { VerifyReceiptView } from "../src/views/VerifyReceiptView.jsx";

function expectSingleTopLevelHeading(container) {
  const headings = container.querySelectorAll("h1");
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveTextContent(/\S/);
}

describe("public page heading hierarchy", () => {
  it.each(["privacy", "terms", "accessibility", "accessibilityStatement", "aiDisclosure", "retention", "deletionRequest"])(
    "gives the %s document exactly one h1",
    (page) => {
      const { container } = render(
        <LanguageProvider lang="en"><LegalView page={page} /></LanguageProvider>,
      );
      expectSingleTopLevelHeading(container);
    },
  );

  it("gives the contact page exactly one h1", () => {
    const { container } = render(
      <LanguageProvider lang="en"><ContactView /></LanguageProvider>,
    );
    expectSingleTopLevelHeading(container);
  });

  it("gives the receipt verification page exactly one h1", () => {
    const { container } = render(<VerifyReceiptView />);
    expectSingleTopLevelHeading(container);
  });
});
