import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChapterRail } from "../src/components/ChapterRail.jsx";
import { ProfileDialog } from "../src/components/Dialogs.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// REQ-UG-CHAPTER-RAIL-COLLAPSED-BY-DEFAULT-MENU-TOGGLE-20261103: the
// chapter rail opens collapsed, and the profile menu's labelled switch keeps it
// expanded on later loads for this member on this device (session in demo).

const member = { firstName: "Rae", fullName: "Rae Harbor", initials: "RH", roleLine: "Library assistant", sinceYear: 2019 };
const chapters = [{ id: "wor", name: "Cedar Ridge Care Services", abbreviation: "WD", category: null, memberCount: null, staffCount: null }];
const LIVE_KEY = "sg:member:member-1:chapter-rail:expanded-by-default";
const DEMO_KEY = "sg:demo:chapter-rail:expanded-by-default";

// The profile dialog is modal, so the rail behind it is outside the
// accessibility tree while it is open; read the rail's state directly.
const chapterRail = () => document.querySelector("nav.chapter-rail");

function renderShell({ owner = { memberId: "member-1", demo: false }, lang = "en" } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <ChapterRail chapters={chapters} selectedId="wor" onSelect={() => {}} memberId={owner?.memberId ?? null} demo={owner?.demo ?? false} />
      <ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} chapterRailOwner={owner} />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("Open Campaigns by default (profile menu)", () => {
  it.each([
    ["en", "Profile", "Edit profile", "Open Campaigns by default", "the Campaigns button"],
    ["es", "Perfil", "Editar perfil", "Abrir Campañas de forma predeterminada", "el botón Campañas"],
  ])("names the profile, edit section and Campaigns preference in %s", (lang, title, editTitle, preference, controlName) => {
    renderShell({ lang });
    const dialog = screen.getByRole("dialog", { name: title });
    expect(dialog).toHaveTextContent(member.fullName);
    expect(screen.getByRole("heading", { name: editTitle })).toBeVisible();
    expect(screen.getByRole("form", { name: editTitle })).toContainElement(screen.getByDisplayValue(member.fullName));
    expect(screen.getByRole("switch", { name: preference })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("profile-chapter-rail")).toHaveTextContent(controlName);
  });

  it.each(["en", "es"])("is a labelled switch that announces its state and applies to the open rail (%s)", (lang) => {
    const { unmount } = renderShell({ lang });
    const rail = chapterRail();
    const toggle = screen.getByRole("switch", { name: catalogue[lang]["chapterRail.keepExpanded"] });
    expect(screen.getByTestId("profile-chapter-rail")).toHaveTextContent(catalogue[lang]["chapterRail.keepExpandedSub"]);
    expect(rail).toHaveAttribute("data-collapsed", "true");
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(rail).toHaveAttribute("data-collapsed", "false");
    expect(window.localStorage.getItem(LIVE_KEY)).toBe("true");
    unmount();

    // A later load opens expanded, and switching off restores the default.
    renderShell({ lang });
    const reloaded = screen.getByRole("switch", { name: catalogue[lang]["chapterRail.keepExpanded"] });
    expect(reloaded).toHaveAttribute("aria-checked", "true");
    expect(chapterRail()).toHaveAttribute("data-collapsed", "false");
    fireEvent.click(reloaded);
    expect(reloaded).toHaveAttribute("aria-checked", "false");
    expect(chapterRail()).toHaveAttribute("data-collapsed", "true");
    expect(window.localStorage.getItem(LIVE_KEY)).toBe("false");
  });

  it("leaves the switch alone when the in-rail button expands for this visit", () => {
    renderShell();
    const railButton = chapterRail().querySelector(".chapter-rail__collapse");
    expect(railButton).toHaveAccessibleName("Expand campaigns");
    fireEvent.click(railButton);
    expect(chapterRail()).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("switch", { name: "Open Campaigns by default" })).toHaveAttribute("aria-checked", "false");
    expect(window.localStorage.getItem(LIVE_KEY)).toBeNull();
  });

  it("keeps the demo choice in session storage only", () => {
    renderShell({ owner: { memberId: null, demo: true } });
    fireEvent.click(screen.getByRole("switch", { name: "Open Campaigns by default" }));
    expect(chapterRail()).toHaveAttribute("data-collapsed", "false");
    expect(window.sessionStorage.getItem(DEMO_KEY)).toBe("true");
    expect(window.localStorage.length).toBe(0);
  });

  it("offers no switch where no campaign rail is drawn or no worker owns the choice", () => {
    render(<LanguageProvider lang="en"><ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} /></LanguageProvider>);
    expect(screen.queryByRole("switch", { name: "Open Campaigns by default" })).toBeNull();
    render(<LanguageProvider lang="en"><ProfileDialog member={member} onClose={vi.fn()} onSave={vi.fn()} chapterRailOwner={{ memberId: null, demo: false }} /></LanguageProvider>);
    expect(screen.queryByRole("switch", { name: "Open Campaigns by default" })).toBeNull();
  });
});
