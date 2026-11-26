// @vitest-environment node

import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CovenantAssertionError,
  runCovenantCaseWithRetry,
} from "../scripts/lib/demo-chrome-covenant.mjs";

const controlsPath = new URL("../scripts/lib/visual-audit-hat-control.mjs", import.meta.url);

describe("live SAMPLE visual-audit hat control", () => {
  let browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, BROWSER_HOOK_TIMEOUT);

  afterAll(async () => {
    await browser?.close();
  });

  it("waits through delayed real control markup after a persona repaint", async () => {
    const controls = await import(controlsPath.href);
    const page = await browser.newPage();
    try {
      await page.setContent(`<main id="shell"><script>
        setTimeout(() => {
          document.querySelector('#shell').innerHTML = '<button class="demo-hat-selector__trigger">Coordinador</button>';
        }, 60);
      </script></main>`);
      const select = page.locator("select.demo-hat-selector__select").first();
      const selected = await controls.waitForVisibleSelectedHatControl({
        select,
        selectedOption: select.locator("option:checked"),
        hat: "coordinator",
        expandedOption: page.locator("button.desktop-rail__hat-option").filter({ hasText: /^Coordinador$/ }).first(),
        trigger: page.locator("button.demo-hat-selector__trigger").first(),
        label: "Coordinador",
        timeoutMs: 2_000,
        retryDelayMs: 20,
        waitForRetry: (delayMs) => page.waitForTimeout(delayMs),
      });
      expect(selected).toEqual({
        shape: "top-trigger", selected: true, label: "Coordinador", value: null,
      });
    } finally {
      await page.close();
    }
  });

  it("rejects a wrong selected hat from real control markup after the bound", async () => {
    const controls = await import(controlsPath.href);
    const page = await browser.newPage();
    try {
      await page.setContent('<button class="demo-hat-selector__trigger">Member</button>');
      const select = page.locator("select.demo-hat-selector__select").first();
      await expect(controls.waitForVisibleSelectedHatControl({
        select,
        selectedOption: select.locator("option:checked"),
        hat: "coordinator",
        expandedOption: page.locator("button.desktop-rail__hat-option").first(),
        trigger: page.locator("button.demo-hat-selector__trigger").first(),
        label: "Coordinator",
        attempts: 2,
        retryDelayMs: 1,
        waitForRetry: (delayMs) => page.waitForTimeout(delayMs),
      })).rejects.toThrow(/Hat mismatch.*Member/);
    } finally {
      await page.close();
    }
  });

  it.each(["net::ERR_FAILED", "Target closed"])(
    "never retries an actual hat mismatch containing transport text: %s",
    async (observedLabel) => {
      const controls = await import(controlsPath.href);
      const hidden = { async isVisible() { return false; } };
      let attempts = 0;
      let retries = 0;
      await expect(runCovenantCaseWithRetry(async () => {
        attempts += 1;
        return controls.waitForVisibleSelectedHatControl({
          select: hidden,
          expandedOption: hidden,
          hat: "coordinator",
          label: "Coordinator",
          attempts: 1,
          trigger: {
            async isVisible() { return true; },
            async innerText() { return attempts === 1 ? observedLabel : "Coordinator"; },
          },
        });
      }, { onRetry: () => { retries += 1; } })).rejects.toBeInstanceOf(CovenantAssertionError);
      expect({ attempts, retries }).toEqual({ attempts: 1, retries: 0 });
    },
  );

  it("waits through the live persona repaint and accepts the returning top trigger", async () => {
    const controls = await import(controlsPath.href);
    let visible = false;
    let waits = 0;
    const hidden = { async isVisible() { return false; } };
    const selected = await controls.waitForVisibleSelectedHatControl({
      select: hidden,
      selectedOption: hidden,
      hat: "coordinator",
      expandedOption: hidden,
      trigger: {
        async isVisible() { return visible; },
        async innerText() { return "Coordinator"; },
      },
      label: "Coordinator",
      attempts: 3,
      waitForRetry: async () => { waits += 1; visible = true; },
    });
    expect(selected).toEqual({
      shape: "top-trigger", selected: true, label: "Coordinator", value: null,
    });
    expect(waits).toBe(1);
  });

  it("resolves selected hats across select and expanded-option control shapes", async () => {
    const controls = await import(controlsPath.href);
    const hidden = { async isVisible() { return false; } };
    const phone = await controls.observeVisibleSelectedHatControl({
      select: { async isVisible() { return true; }, async inputValue() { return "member"; } },
      selectedOption: { async textContent() { return "Miembro"; } },
      hat: "member",
      expandedOption: hidden,
      trigger: hidden,
      label: "Miembro",
    });
    expect(phone).toEqual({ shape: "phone-select", selected: true, label: "Miembro", value: "member" });

    const expanded = await controls.observeVisibleSelectedHatControl({
      select: hidden,
      selectedOption: hidden,
      hat: "coordinator",
      expandedOption: {
        async isVisible() { return true; },
        async innerText() { return "Coordinador"; },
        async getAttribute(name) { return name === "aria-pressed" ? "true" : null; },
      },
      trigger: hidden,
      label: "Coordinador",
    });
    expect(expanded).toEqual({
      shape: "expanded-option", selected: true, label: "Coordinador", value: null,
    });

    // The phone selector wins whenever it is visible, even while desktop
    // chrome is also mounted, and it reports the value it actually holds — a
    // disagreement has to surface as a mismatch rather than be resolved from
    // the other shape's label.
    const phoneWinsOverDesktop = await controls.observeVisibleSelectedHatControl({
      select: { async isVisible() { return true; }, async inputValue() { return "steward"; } },
      selectedOption: { async textContent() { return " Delegado "; } },
      hat: "coordinator",
      expandedOption: {
        async isVisible() { return true; },
        async innerText() { return "Coordinador"; },
        async getAttribute() { return "true"; },
      },
      trigger: { async isVisible() { return true; }, async innerText() { return "Coordinador"; } },
      label: "Coordinador",
    });
    expect(phoneWinsOverDesktop).toEqual({
      shape: "phone-select", selected: false, label: "Delegado", value: "steward",
    });

    // An expanded rail option carries its selection in aria-pressed. The right
    // label with the pressed state absent is not a selected hat.
    const expandedUnpressed = await controls.observeVisibleSelectedHatControl({
      select: hidden,
      selectedOption: hidden,
      hat: "coordinator",
      expandedOption: {
        async isVisible() { return true; },
        async innerText() { return "Coordinador"; },
        async getAttribute() { return null; },
      },
      trigger: { async isVisible() { return true; }, async innerText() { return "Coordinador"; } },
      label: "Coordinador",
    });
    expect(expandedUnpressed).toEqual({
      shape: "expanded-option", selected: false, label: "Coordinador", value: null,
    });

    // The desktop popover publishes its selection only as the trigger's own
    // label, so that label is the whole observation for this shape.
    const collapsedTrigger = await controls.observeVisibleSelectedHatControl({
      select: hidden,
      selectedOption: hidden,
      hat: "vp",
      expandedOption: hidden,
      trigger: { async isVisible() { return true; }, async innerText() { return " Presidente \n"; } },
      label: "Presidente",
    });
    expect(collapsedTrigger).toEqual({
      shape: "top-trigger", selected: true, label: "Presidente", value: null,
    });

    // No control mounted at all is its own answer: not a selected hat, and not
    // a shape the caller may report.
    const nothingMounted = await controls.observeVisibleSelectedHatControl({
      select: hidden,
      selectedOption: hidden,
      hat: "member",
      expandedOption: hidden,
      trigger: hidden,
      label: "Miembro",
    });
    expect(nothingMounted).toEqual({ shape: null, selected: false, label: null, value: null });
  });

  it("rechecks the phone selector while desktop controls have not mounted", async () => {
    const controls = await import(controlsPath.href);

    expect(controls.selectVisibleHatControl).toBeTypeOf("function");

    let phoneVisible = false;
    let phoneSelections = 0;
    let retryWaits = 0;
    let triggerClicks = 0;
    let selectionBoundaries = 0;
    const hiddenControl = {
      async isVisible() {
        return false;
      },
      async click() {
        throw new Error("a hidden desktop control must not be clicked");
      },
    };

    const selectedControl = await controls.selectVisibleHatControl({
      select: {
        async isVisible() {
          return phoneVisible;
        },
        async selectOption(value) {
          expect(value).toBe("member");
          phoneSelections += 1;
        },
      },
      hat: "member",
      expandedOption: hiddenControl,
      option: hiddenControl,
      trigger: {
        async isVisible() {
          return false;
        },
        async click() {
          triggerClicks += 1;
        },
      },
      attempts: 3,
      beforeSelectionAttempt: async () => {
        selectionBoundaries += 1;
      },
      waitForRetry: async () => {
        expect(selectionBoundaries).toBe(0);
        retryWaits += 1;
        phoneVisible = true;
      },
    });

    expect(selectedControl).toBe("phone-select");
    expect({ phoneSelections, retryWaits, triggerClicks, selectionBoundaries }).toEqual({
      phoneSelections: 1,
      retryWaits: 1,
      triggerClicks: 0,
      selectionBoundaries: 1,
    });
  });

  it("rechecks every control when a visible phone selector detaches before selection", async () => {
    const controls = await import(controlsPath.href);
    let selectionAttempts = 0;
    let retryWaits = 0;
    let selectionStarts = 0;
    let selectionFailures = 0;
    const hiddenControl = {
      async isVisible() {
        return false;
      },
    };

    const selectedControl = await controls.selectVisibleHatControl({
      select: {
        async isVisible() {
          return true;
        },
        async selectOption(value) {
          expect(value).toBe("member");
          selectionAttempts += 1;
          if (selectionAttempts === 1) throw new Error("selector detached during SAMPLE repaint");
        },
      },
      hat: "member",
      expandedOption: hiddenControl,
      option: hiddenControl,
      trigger: hiddenControl,
      attempts: 3,
      beforeSelectionAttempt: async () => {
        selectionStarts += 1;
      },
      afterSelectionAttemptFailure: async () => {
        selectionFailures += 1;
      },
      waitForRetry: async () => {
        retryWaits += 1;
      },
    });

    expect(selectedControl).toBe("phone-select");
    expect({ selectionAttempts, retryWaits, selectionStarts, selectionFailures }).toEqual({
      selectionAttempts: 2,
      retryWaits: 1,
      selectionStarts: 2,
      selectionFailures: 1,
    });
  });

  it("bounds the final desktop option action by the requested wait timeout", async () => {
    const controls = await import(controlsPath.href);
    let finalClickTimeout;
    const option = {
      async isVisible() {
        return false;
      },
      async waitFor() {
        throw new Error("option stayed hidden");
      },
      async click(options) {
        finalClickTimeout = options?.timeout;
        throw new Error("option stayed hidden");
      },
    };

    await expect(controls.clickVisibleTopHatOption({
      option,
      trigger: { async click() {} },
      attempts: 1,
      waitTimeoutMs: 25,
    })).rejects.toThrow("option stayed hidden");

    expect(finalClickTimeout).toBe(25);
  });

  it("reopens the desktop menu when the first trigger click loses the auto-open race", async () => {
    let controls;
    try {
      controls = await import(controlsPath.href);
    } catch {
      controls = null;
    }

    expect(controls?.clickVisibleTopHatOption).toBeTypeOf("function");

    let optionVisible = false;
    let optionClicks = 0;
    let triggerClicks = 0;
    const option = {
      async isVisible() {
        return optionVisible;
      },
      async waitFor({ state, timeout }) {
        expect(state).toBe("visible");
        expect(timeout).toBe(25);
        if (!optionVisible) throw new Error("option stayed hidden");
      },
      async click() {
        if (!optionVisible) throw new Error("cannot click a hidden option");
        optionClicks += 1;
      },
    };
    const trigger = {
      async click() {
        triggerClicks += 1;
        // The first click lands after the product's asynchronous auto-open
        // and toggles the menu closed. A retry must open it again.
        optionVisible = triggerClicks > 1;
      },
    };

    await controls.clickVisibleTopHatOption({
      option,
      trigger,
      attempts: 3,
      waitTimeoutMs: 25,
    });

    expect({ triggerClicks, optionClicks, optionVisible }).toEqual({
      triggerClicks: 2,
      optionClicks: 1,
      optionVisible: true,
    });
  });
});
