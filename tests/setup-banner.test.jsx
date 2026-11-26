// REQ-UG-UNION-CATALOG-SETUP-REVIEW-PREFILL-20260925: the admin overview's
// "Set up your organization's structure" banner (shown while the organization
// has at most one chapter, dismissible per organization in this browser) and
// the today view's two-step notice for a creator whose staff hats are paused.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { SetupBanner, setupBannerKey } from "../src/features/orgSetup/SetupBanner.jsx";
import { SetupTwoStepNotice } from "../src/features/orgSetup/SetupTwoStepNotice.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ORG = "a1b2c3d4-0000-4000-8000-000000000001";
const one = { chapters: [{ id: "example-main", name: "Main Chapter" }] };

function renderBanner(props, { navigate } = {}) {
  const banner = <SetupBanner organizationId={ORG} organization={one} {...props} />;
  return render(<LanguageProvider lang="en">
    {navigate ? <WorkspacePages view="admin" hat="admin" location={window.location.href} navigate={navigate}>{banner}</WorkspacePages> : banner}
  </LanguageProvider>);
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("setup banner", () => {
  it("shows for an organization with at most one chapter and links to the setup page", () => {
    window.history.replaceState({}, "", "/m/admin");
    const navigate = vi.fn();
    renderBanner({}, { navigate });
    expect(screen.getByText("Set up your organization's structure. Nothing is created until you confirm.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Start setup" });
    expect(link).toHaveAttribute("href", "/m/admin/setup-review");
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith("admin", "/m/admin/setup-review", null, { replace: false });
  });

  it("leaves the plain link alone outside a workspace", () => {
    renderBanner({ organization: { chapters: [] } });
    const link = screen.getByRole("link", { name: "Start setup" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.addEventListener("click", (event) => event.preventDefault());
    link.dispatchEvent(click);
    expect(link).toHaveAttribute("href", "/m/admin/setup-review");
  });

  it("stays hidden for a populated organization, without an organization, or without structure data", () => {
    const { rerender } = renderBanner({ organization: { chapters: [{ name: "A" }, { name: "B" }] } });
    expect(screen.queryByText(/Set up your organization's structure/)).toBeNull();
    rerender(<LanguageProvider lang="en"><SetupBanner organizationId={null} organization={one} /></LanguageProvider>);
    expect(screen.queryByText(/Set up your organization's structure/)).toBeNull();
    rerender(<LanguageProvider lang="en"><SetupBanner organizationId={ORG} organization={null} /></LanguageProvider>);
    expect(screen.queryByText(/Set up your organization's structure/)).toBeNull();
  });

  it("remembers a dismissal per organization as a boolean only", () => {
    const { unmount } = renderBanner({});
    fireEvent.click(screen.getByRole("button", { name: "Hide this" }));
    expect(screen.queryByText(/Set up your organization's structure/)).toBeNull();
    expect(window.localStorage.getItem(setupBannerKey(ORG))).toBe("true");
    unmount();
    renderBanner({});
    expect(screen.queryByText(/Set up your organization's structure/)).toBeNull();
    renderBanner({ organizationId: "b9c8d7e6-0000-4000-8000-000000000002" });
    expect(screen.getByText(/Set up your organization's structure/)).toBeInTheDocument();
  });

  it("still hides when storage refuses", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    renderBanner({});
    fireEvent.click(screen.getByRole("button", { name: "Hide this" }));
    expect(screen.queryByText(/Set up your organization's structure/)).toBeNull();
  });
});

describe("two-step notice", () => {
  function renderNotice(staffMfa, lang = "en") {
    return render(<LanguageProvider lang={lang}><SetupTwoStepNotice staffMfa={staffMfa} /></LanguageProvider>);
  }

  it("shows only when staff hats are paused for someone who holds one", () => {
    renderNotice({ blocked: true, holdsStaffRole: true });
    expect(screen.getByText(/Turn on two-step sign-in in Settings/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/m/settings/security");
  });

  it("stays hidden otherwise", () => {
    const { container, rerender } = renderNotice(null);
    expect(container).toBeEmptyDOMElement();
    for (const staffMfa of [{ blocked: false, holdsStaffRole: true }, { blocked: true, holdsStaffRole: false }]) {
      rerender(<LanguageProvider lang="en"><SetupTwoStepNotice staffMfa={staffMfa} /></LanguageProvider>);
      expect(container).toBeEmptyDOMElement();
    }
  });

  it("speaks Spanish", () => {
    renderNotice({ blocked: true, holdsStaffRole: true }, "es");
    expect(screen.getByRole("link", { name: "Abrir Configuración" })).toBeInTheDocument();
  });
});
