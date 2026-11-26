import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

afterEach(cleanup);

describe.each(["en", "es"])("sign-in card copy (%s)", (lang) => {
  const copy = catalogue[lang];
  const client = { auth: { setSession: vi.fn() } };
  const show = (props = {}) => render(<LanguageProvider lang={lang}><AuthScreen client={client} lang={lang} {...props} /></LanguageProvider>);

  it("names the password method once and shows its fields directly", () => {
    show();
    const card = screen.getByRole("region", { name: copy["auth.passwordTitle"] });
    expect(within(card).getByRole("heading", { level: 1 })).toHaveTextContent(copy["auth.passwordTitle"]);
    expect(within(card).getAllByText(copy["auth.passwordBlurb"])).toHaveLength(1);
    expect(within(card).getByLabelText(copy["auth.email"])).toBeVisible();
    expect(within(card).getByLabelText(copy["auth.password"])).toBeVisible();
    expect(within(card).queryByRole("button", { name: copy["auth.otherMethods"] })).toBeNull();
  });

  it("offers the named demo separately from the password form when available", () => {
    const onDemo = vi.fn();
    show({ onDemo });
    const demo = screen.getByRole("button", { name: copy["auth.demo"] });
    expect(screen.getByLabelText(copy["auth.password"])).toBeVisible();
    expect(demo.closest("form")).toBeNull();
    fireEvent.click(demo);
    expect(onDemo).toHaveBeenCalledTimes(1);
  });
});
