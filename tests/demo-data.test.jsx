import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { demoData, loadDemoData, primeDemoData } from "../src/data/demoData.js";
import { primeDemoHat } from "./helpers/demoHat.js";

// The demo fixtures are ~490 lines of seeded people, cases and staff desks that
// only the auth-free tour uses. They reach the browser through a dynamic
// import so Rollup emits them as their own chunk and a signed-in member never
// downloads them — `npm run build` puts them in assets/fallback-*.js, not in
// the entry bundle.
//
// tests/setup.js primes the cache so the rest of the suite keeps its
// synchronous first render. This file drops the cache on purpose, so it is the
// one place the real asynchronous boot is exercised.
beforeEach(() => {
  primeDemoHat("member");
  window.history.replaceState({}, "", "/m?demo=1");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
  primeDemoData(fallbackData);
});

// This file is the only one that boots the app with a cold fixture cache, so
// every first paint here waits on a real dynamic import. Under the full CI
// suite that import has been measured past testing-library's 1s default, so
// the cold-boot queries get an explicit budget instead of the default.
const CHUNK_BOOT = { timeout: 8000 };

describe("demo fixture loading", () => {
  it("refuses automatic fixture creation and accepts explicit isolated unit data", async () => {
    primeDemoData(null);
    expect(demoData()).toBeNull();
    await expect(loadDemoData()).rejects.toThrow('retired');
    primeDemoData(fallbackData);
    expect(await loadDemoData()).toBe(fallbackData);
  });

  it("paints explicitly injected unit data under the StrictMode lifecycle", async () => {
    render(<StrictMode><App /></StrictMode>);
    // A fresh Union Ground preview wears Worker (DEFAULT_SAMPLE_HAT), so the
    // explicit fixture paints the worker's Home and never a staff desk.
    expect(await screen.findByRole("heading", { name: /Good \w+, Darnell/ }, CHUNK_BOOT)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Committee desk|Casework desk/ })).not.toBeInTheDocument();
    // The Home ballot hero renders the fixture's open campaign question, which
    // proves the plan items landed too.
    expect(screen.getByRole("heading", { name: /Should Harborview Care United file the representation petition/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Switch role" }), { target: { value: "steward" } });
    expect(await screen.findByRole("heading", { name: /Committee desk/ }, CHUNK_BOOT)).toBeInTheDocument();
  });

  it("keeps the seeded signature and bilingual schema in a cold-demo filing download", async () => {
    window.history.replaceState({}, "", "/m/forms?demo=1");
    let downloaded = null;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((file) => { downloaded = file; return "blob:demo-filing"; }),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      // No StrictMode: App unmount cleanup would wipe the Member prime and
      // bounce /m/forms off the steward desk.
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Download filing copy" }, CHUNK_BOOT));
      await waitFor(() => expect(downloaded).toBeInstanceOf(File));
      const bytes = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.readAsArrayBuffer(downloaded);
      });
      const pdf = String.fromCharCode(...bytes);
      expect(pdf).toContain("Alternative work arrangement");
      expect(pdf).toContain("Requested arrangement: Telework Tue/Thu");
      expect(pdf).toContain("Filer signature - Darnell Foster");
      expect(pdf).not.toContain("Filer signature - unsigned");
      expect(click).toHaveBeenCalled();
    } finally {
      if (originalCreateObjectURL) Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
      else delete URL.createObjectURL;
      if (originalRevokeObjectURL) Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
      else delete URL.revokeObjectURL;
    }
  });
});
