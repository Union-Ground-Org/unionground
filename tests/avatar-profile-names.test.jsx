import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaneHeader } from "../src/components/PlaneHeader.jsx";
import { ScreenHeader } from "../src/components/Primitives.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MobileCardNav } from "../src/components/MobileCardNav.jsx";

describe.each([
  ["screen header", ScreenHeader],
  ["staff plane header", PlaneHeader],
])("%s profile name", (_name, Header) => {
  it.each([["en", "Profile"], ["es", "Perfil"]])("starts with the visible initials in %s and opens the profile", (lang, label) => {
    const profile = vi.fn();
    const { rerender } = render(
      <LanguageProvider lang={lang}>
        <Header title="Chapter desk" initials="DF" onProfile={profile} />
      </LanguageProvider>,
    );
    const avatar = screen.getByRole("button", { name: `DF ${label}` });
    expect(avatar).toHaveTextContent(/^DF$/);
    fireEvent.click(avatar);
    expect(profile).toHaveBeenCalledTimes(1);

    rerender(
      <LanguageProvider lang={lang}>
        <Header title="Chapter desk" initials="NB" onProfile={profile} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("button", { name: `NB ${label}` })).toHaveTextContent(/^NB$/);
    expect(screen.queryByRole("button", { name: `DF ${label}` })).not.toBeInTheDocument();
  });
});

describe("small-screen navigation profile name", () => {
  it.each([["en", "Profile"], ["es", "Perfil"]])("keeps the visible initials first in %s as the person changes", (lang, label) => {
    const profile = vi.fn();
    const nav = (memberName) => <LanguageProvider lang={lang}><MobileCardNav initialPanel="features" memberName={memberName} onProfile={profile} onNavigate={() => {}}><p>Home</p></MobileCardNav></LanguageProvider>;
    const { rerender } = render(nav("Marcus Greene"));
    const avatar = screen.getByRole("button", { name: `MG ${label}` });
    expect(avatar).toHaveTextContent(/^MG$/);
    fireEvent.click(avatar);
    expect(profile).toHaveBeenCalledTimes(1);
    rerender(nav("Dylan Kowalski"));
    expect(screen.getByRole("button", { name: `DK ${label}` })).toHaveTextContent(/^DK$/);
    rerender(nav(null));
    expect(document.querySelector(".card-nav__avatar")).toHaveAccessibleName(label);
  });
});
