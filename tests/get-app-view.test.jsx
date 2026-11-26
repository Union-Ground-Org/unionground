import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GetAppView } from "../src/views/GetAppView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { APP_DOWNLOADS, appDownloadUrl, getAppPageUrl } from "../src/lib/appDownloads.js";
import { makeQrMatrix, qrSvgPath } from "../src/lib/qrCode.js";

function renderPage({ lang = "en", downloads } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <GetAppView origin="https://app.example.org" downloads={downloads} />
    </LanguageProvider>,
  );
}

describe("app download table", () => {
  it("lists no phone app until a production-backed build is downloadable", () => {
    expect(APP_DOWNLOADS).toEqual({ ios: null, android: null });
    expect(appDownloadUrl("ios")).toBeNull();
    expect(appDownloadUrl("android")).toBeNull();
  });

  it("accepts only https store links for the matching platform", () => {
    const downloads = {
      ios: "https://testflight.apple.com/join/example",
      android: "https://play.google.com/store/apps/details?id=org.example.storefixture",
    };
    expect(appDownloadUrl("ios", downloads)).toBe(downloads.ios);
    expect(appDownloadUrl("android", downloads)).toBe(downloads.android);
    expect(appDownloadUrl("ios", { ios: "http://apps.apple.com/app/x" })).toBeNull();
    expect(appDownloadUrl("ios", { ios: "https://play.google.com/store/apps/x" })).toBeNull();
    expect(appDownloadUrl("android", { android: "https://example.com/union.apk" })).toBeNull();
    expect(appDownloadUrl("android", { android: "not a url" })).toBeNull();
  });

  it("points the QR code at the origin's /get-app page", () => {
    expect(getAppPageUrl("https://app.example.org")).toBe("https://app.example.org/get-app");
  });

  it("stays outside the paths the native apps claim as app links", () => {
    const config = readFileSync(resolve(process.cwd(), "apps/mobile/app.config.ts"), "utf8");
    const claimed = [...config.matchAll(/pathPrefix: '([^']+)'/g)].map((match) => match[1]);
    expect(claimed.length).toBeGreaterThan(0);
    const path = new URL(getAppPageUrl("https://app.example.org")).pathname;
    for (const prefix of claimed) expect(path.startsWith(prefix), prefix).toBe(false);
  });
});

describe("Get Union Ground page", () => {
  it("offers the website and says honestly that the phone apps are not downloadable yet", () => {
    const { container } = renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Get Union Ground" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in on the website" })).toHaveAttribute("href", "/auth");
    expect(screen.queryByRole("link", { name: "Get the app" })).toBeNull();
    for (const name of ["iPhone", "Android"]) {
      const item = screen.getByRole("heading", { level: 2, name }).closest("li");
      expect(within(item).getByText(/isn't available to download yet/)).toBeInTheDocument();
    }
    expect(container.querySelector("main")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Request an invite" })).toHaveAttribute("href", "/request-invite");
    expect(container.textContent).not.toMatch(/509|SEIU/i);
  });

  it("links each configured phone app", () => {
    renderPage({ downloads: { ios: "https://testflight.apple.com/join/example", android: null } });
    const links = screen.getAllByRole("link", { name: "Get the app" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://testflight.apple.com/join/example");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("draws a QR code for its own /get-app address", () => {
    renderPage();
    const qr = screen.getByRole("img", { name: "QR code that opens this page" });
    expect(qr.querySelector("path").getAttribute("d"))
      .toBe(qrSvgPath(makeQrMatrix("https://app.example.org/get-app")));
  });

  it("renders in Spanish", () => {
    renderPage({ lang: "es" });
    expect(screen.getByRole("heading", { level: 1, name: "Obtén Union Ground" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Entrar en el sitio web" })).toHaveAttribute("href", "/auth");
  });
});
