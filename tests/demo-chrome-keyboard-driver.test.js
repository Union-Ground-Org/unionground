// @vitest-environment node
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeKeyboardHatActivation } from "../scripts/verify-demo-chrome-covenant.mjs";

let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

// A real browser fixture: pointer selection remains working in every mutant.
// The driver must start with the focus Escape left, never repair it by focus().
async function fixture(mutation = "") {
  const page = await browser.newPage();
  await page.route("http://covenant.test/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><nav class="desktop-rail"></nav>
      <button class="demo-hat-selector__trigger">Steward</button>
      <script>
        const mutation = ${JSON.stringify(mutation)};
        const labels = ['Member', 'Steward', 'Coordinator', 'Advisor', 'Admin', 'President'];
        const trigger = document.querySelector('button');
        function open() {
          const menu = document.createElement('div');
          menu.className = 'demo-hat-selector__menu';
          menu.innerHTML = labels.map((label, i) => '<button class="demo-hat-selector__option" role="menuitemradio" aria-checked="' + (i === 1) + '" tabindex="' + (i === 1 ? 0 : -1) + '">' + label + '</button>').join('');
          document.body.append(menu);
          const options = [...menu.children];
          function move(i) { options.forEach((o, n) => o.tabIndex = n === i ? 0 : -1); options[i].focus(); }
          options.forEach((option, index) => {
            option.onclick = () => {
              trigger.textContent = option.textContent;
              history.pushState({}, '', '/m/' + option.textContent.toLowerCase());
              menu.remove(); trigger.focus();
            };
            option.onkeydown = (event) => {
              if (['Enter', ' '].includes(event.key) && mutation === event.key) { event.preventDefault(); return; }
              if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
                event.preventDefault();
                if (mutation !== 'arrows') move((index + (event.key === 'ArrowDown' ? 1 : 5)) % 6);
              }
            };
          });
          if (mutation !== 'open-focus') move(1);
        }
        trigger.onclick = open;
        trigger.onkeydown = (event) => { if (mutation === 'trigger' && ['Enter', ' '].includes(event.key)) event.preventDefault(); };
        if (mutation !== 'escape-focus') trigger.focus();
      </script>`,
  }));
  await page.goto("http://covenant.test/m/steward");
  return page;
}

async function observe(page, activationKey) {
  return observeKeyboardHatActivation(page, { activationKey, timeoutMs: 500 });
}

describe("covenant keyboard activation driver", () => {
  for (const activationKey of ["Enter", "Space"]) {
    it(`reopens, traverses both arrow directions and activates with ${activationKey}`, async () => {
      const page = await fixture();
      try {
        const result = await observe(page, activationKey);
        expect(result.afterRetoggle).toMatchObject({ menuVisible: true, introVisible: false });
        expect(result.keyboard.activationKey).toBe(activationKey);
        expect(result.keyboard.focusedLabels).toEqual(["Steward", "Coordinator", "Steward", "Coordinator"]);
        expect(result.afterCoordinator).toMatchObject({ selected: true, path: "/m/coordinator", hatMenuCount: 0 });
      } finally { await page.close(); }
    });

    it(`rejects pointer-working but ${activationKey}-inert menu options`, async () => {
      const page = await fixture(activationKey === "Space" ? " " : activationKey);
      try {
        await expect(observe(page, activationKey)).rejects.toThrow();
        await page.getByRole("menuitemradio", { name: "Coordinator", exact: true }).click();
        expect(new URL(page.url()).pathname).toBe("/m/coordinator");
      } finally { await page.close(); }
    });
  }

  for (const mutation of ["escape-focus", "open-focus", "arrows", "trigger"]) {
    it(`refuses ${mutation} failure instead of manufacturing keyboard reachability`, async () => {
      const page = await fixture(mutation);
      try { await expect(observe(page, "Enter")).rejects.toThrow(); }
      finally { await page.close(); }
    });
  }
});
