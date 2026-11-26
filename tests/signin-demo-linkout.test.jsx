import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { DEFAULT_DEMO_ORIGIN } from "../src/lib/demoOrigin.js";
import { catalogue } from "../src/lib/i18n.js";
import { routeSignInOptions } from "./helpers/signInOptionsFetch.js";
import { SAMPLE_ORIGIN } from "./helpers/fictional-provider.js";

// The official service's hosts are not in this edition; the fictional provider stands in.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const client = { auth: { setSession: vi.fn() } };
const show = (lang, props = {}) => render(<LanguageProvider lang={lang}><AuthScreen client={client} lang={lang} {...props} /></LanguageProvider>);

beforeEach(() => {
  vi.stubGlobal("fetch", routeSignInOptions(vi.fn(async () => new Response("{}", { status: 401 })), { google: false, apple: false }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sign-in screen link out to the demo host", () => {
  it.each(["en", "es"])("links to a configured demo with the sign-in card wording (%s)", (lang) => {
    show(lang, { demoOriginHref: DEFAULT_DEMO_ORIGIN });
    const link = screen.getByRole("link", { name: catalogue[lang]["auth.sampleTour"] });
    expect(link).toHaveAttribute("href", SAMPLE_ORIGIN);
    expect(link).not.toHaveAttribute("target");
    expect(link.closest(".auth-card")).not.toBeNull();
    expect(link.closest("form")).toBeNull();
  });

  it("shows no link without a demo host", () => {
    show("en");
    expect(screen.queryByRole("link", { name: catalogue.en["auth.sampleTour"] })).toBeNull();
    expect(document.querySelector(".sgauth-tour")).toBeNull();
  });

  it("keeps the demo host's in-place entry instead of the link", () => {
    const onDemo = vi.fn();
    show("en", { demoOriginHref: DEFAULT_DEMO_ORIGIN, onDemo });
    expect(screen.queryByRole("link", { name: catalogue.en["auth.sampleTour"] })).toBeNull();
    expect(screen.getByRole("button", { name: catalogue.en["auth.demo"] })).toBeInTheDocument();
  });

  it("names no union and no host in the prompt", () => {
    for (const lang of ["en", "es"]) expect(catalogue[lang]["auth.sampleTour"]).not.toMatch(/509|demo host|origin|origen/i);
  });

  it("passes the demo host to the sign-in screen only off the demo surface and outside the preview harness", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toMatch(/<AuthScreen client=\{supabase\}[^\n]*onDemo=\{sampleLive \? enterSampleDemo : allowDemoCta \? enterDemo : undefined\} demoOriginHref=\{demo \|\| allowDemoCta \? undefined : sampleTourHref\(\)\}/);
  });
});
