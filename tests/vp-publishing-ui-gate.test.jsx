import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { STAFF_TOOL_ROLES } from "../src/lib/staffPlanes.js";

// REQ-UNION-BASE-PRESIDENT-STAFF-PUBLISHING-RLS-20260807: which hats see the
// space/document/record publishing controls. The owner granted vp the matching
// database writes, so the contract is "every staff plane — vp included — gets
// the controls, an ordinary member gets none". A President-only account must
// never again render a button the database refuses.

const product = {
  spaces: [], documents: [], records: [], intake: [],
  handshakes: [], governance: [], partnerOrgs: [],
};

const baseData = {
  member: { id: "user-1", initials: "PV", fullName: "President Voice" },
  roles: [],
  conversations: [],
  broadcasts: [],
  product,
};

const renderHub = (roles) => render(
  <LanguageProvider lang="en">
    <ProductHubView
      data={{ ...baseData, roles }}
      onSendPost={vi.fn()}
      onCreateTask={vi.fn()}
      onCreateSpace={vi.fn()}
      onCreateThread={vi.fn()}
      onCreateDocument={vi.fn()}
      onCreateRecord={vi.fn()}
      onCreateHandshake={vi.fn()}
      onCreateGovernance={vi.fn()}
      focus={null}
    />
  </LanguageProvider>,
);

const publishingControls = [
  { tab: "Library", action: "New document" },
  { tab: "The record", action: "Add to record" },
];

describe("publishing-control hat gate", () => {
  for (const role of STAFF_TOOL_ROLES) {
    it(`renders the space/document/record publishing controls for the ${role} hat`, () => {
      renderHub([role]);
      expect(screen.getByRole("button", { name: "New space" })).toBeInTheDocument();
      for (const { tab, action } of publishingControls) {
        fireEvent.click(screen.getByRole("button", { name: tab }));
        expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
      }
    });
  }

  it("renders no publishing controls for an ordinary member", () => {
    renderHub([]);
    expect(screen.queryByRole("button", { name: "New space" })).not.toBeInTheDocument();
    for (const { tab, action } of publishingControls) {
      fireEvent.click(screen.getByRole("button", { name: tab }));
      expect(screen.queryByRole("button", { name: action })).not.toBeInTheDocument();
    }
  });
});
