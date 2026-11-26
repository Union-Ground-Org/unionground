import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";

function renderAuth(lang, props = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <AuthScreen client={{ auth: {} }} lang={lang} {...props} />
    </LanguageProvider>,
  );
}

describe("auth-free demo entry", () => {
  it("shows the demo button only when onDemo is provided and invokes it", () => {
    const onDemo = vi.fn();
    renderAuth("en", { onDemo });
    const button = screen.getByRole("button", { name: "Explore the demo\u00a0— no account needed" });
    fireEvent.click(button);
    expect(onDemo).toHaveBeenCalledOnce();
  });

  it("hides the demo button when onDemo is absent", () => {
    renderAuth("en");
    expect(screen.queryByRole("button", { name: /Explore the demo/ })).toBeNull();
  });

  it("links the SAMPLE tour origin when demo entry is not allowed on this host", () => {
    renderAuth("en", { demoOriginHref: SAMPLE_ORIGIN });
    // The link reads auth.sampleTour ("Explore the demo" since T4's account pass).
    const tour = screen.getByRole("link", { name: "Explore the demo" });
    expect(tour).toHaveAttribute("href", SAMPLE_ORIGIN);
    expect(screen.queryByRole("button", { name: /Explore the demo/ })).toBeNull();
  });

  it.each(["en", "es"])("offers no retired preview tour when demo entry is not allowed (%s)", (lang) => {
    renderAuth(lang);
    expect(screen.queryByRole("link", { name: /preview tour|recorrido de vista previa/i })).toBeNull();
    expect(document.querySelector(`a[href="${SAMPLE_ORIGIN}"]`)).toBeNull();
    expect(screen.queryByRole("button", { name: /Explore the demo|Explora la demostraci/ })).toBeNull();
  });

  it("localizes the demo entry copy to Spanish", () => {
    renderAuth("es", { onDemo: vi.fn() });
    expect(screen.getByRole("button", { name: "Explora la demostración\u00a0— sin cuenta" })).toBeInTheDocument();
  });

  it("keeps self-service help available without signing in and publishes no mailbox", () => {
    // Union Ground publishes no support address, so the sign-in screen
    // offers password reset and invitation requests instead of a mailto link.
    renderAuth("en");
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute("href", "/reset-password");
    expect(screen.getByRole("link", { name: "Request an invite" })).toHaveAttribute("href", "/request-invite");
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});
