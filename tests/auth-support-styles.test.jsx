import { chromium } from "@playwright/test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MfaChallenge } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { PasswordResetView } from "../src/views/PasswordResetView.jsx";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";

const css = ["sg-tokens.css", "styles.css"].map((name) => readFileSync(`src/${name}`, "utf8")).join("\n");
const ticket = `t1.${"A".repeat(16)}.${"b".repeat(120)}`;
let browser;
beforeAll(async () => { browser = await chromium.launch(); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });
afterEach(() => { cleanup(); sessionStorage.clear(); });

async function markup(lang, state) {
  if (state === "mfa") return render(<LanguageProvider lang={lang}><MfaChallenge client={{ auth: {} }} /></LanguageProvider>).container.innerHTML;
  const fetcher = vi.fn(async () => ({
    ok: state === "sent",
    status: state === "sent" ? 200 : state === "expired" ? 400 : 503,
    json: async () => state === "sent" ? { accepted: true } : { error: state === "expired" ? "link-invalid" : "unavailable" },
  }));
  const { container } = render(<LanguageProvider lang={lang}><PasswordResetView fetcher={fetcher} readToken={() => ["link-failed", "expired"].includes(state) ? ticket : null} /></LanguageProvider>);
  if (["request-failed", "sent"].includes(state)) {
    await waitFor(() => expect(container.querySelector("input[name=email]")).not.toBeNull());
    fireEvent.change(container.querySelector("input[name=email]"), { target: { value: "pat.rivera@tamarack.example" } });
    fireEvent.submit(container.querySelector("form"));
  }
  await waitFor(() => expect(container.querySelector('[tabindex="-1"]')).not.toBeNull());
  return container.innerHTML;
}

describe.each(["en", "es"])("auth support styles (%s)", (lang) => {
  it.each(["mfa", "request-failed", "link-failed", "sent", "expired"])("uses product links and a spaced message ring on %s", async (state) => {
    const html = await markup(lang, state);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    try {
      await page.setContent(`<html lang="${lang}"><body>${html}</body></html>`);
      await page.addStyleTag({ content: css });
      // Measure the pressed state without following Back to sign in or mailto.
      await page.evaluate(() => document.addEventListener("click", (event) => event.preventDefault()));
      const links = page.locator('.auth-card a:not(.auth-submit)');
      // With no operator support contact configured, the two-step challenge and
      // the failed or expired link states carry no product link besides the
      // button link; the others always offer Back to sign in.
      if (["request-failed", "sent"].includes(state)) expect(await links.count()).toBeGreaterThan(0);
      for (const link of await links.all()) {
        for (const interaction of ["default", "hover", "focus", "active"]) {
          if (interaction === "hover") await link.hover();
          if (interaction === "focus") await link.focus();
          if (interaction === "active") await page.mouse.down();
          const colors = await link.evaluate((node) => {
            const probe = document.createElement("span");
            probe.style.color = "var(--primary)";
            node.parentElement.append(probe);
            const primary = getComputedStyle(probe).color;
            probe.remove();
            return { actual: getComputedStyle(node).color, primary };
          });
          expect(colors.actual, `${state}/${interaction}`).toBe(colors.primary);
          expect(colors.actual).not.toBe("rgb(0, 0, 238)");
          if (interaction === "active") await page.mouse.up();
        }
      }
      const buttonLink = page.locator("a.auth-submit");
      if (await buttonLink.count() && await links.count()) {
        expect(await buttonLink.first().evaluate((node) => getComputedStyle(node).color)).not.toBe(await links.first().evaluate((node) => getComputedStyle(node).color));
      }
      if (state !== "mfa") {
        const message = page.locator('.auth-card [tabindex="-1"]').first();
        await message.focus();
        const ring = await message.evaluate((node) => {
          const style = getComputedStyle(node);
          return { width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset), style: style.outlineStyle };
        });
        expect(ring.style).toBe("solid");
        expect(ring.width).toBeGreaterThanOrEqual(2);
        expect(ring.offset).toBeGreaterThanOrEqual(2);
      }
    } finally { await page.close(); }
  });
});
