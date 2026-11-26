import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CrashScreenContent } from "../src/components/CrashScreen.jsx";

// UX-UG-TOP-LEVEL-CRASH-SCREEN-LANGUAGE-AND-RELOAD-20260920. The top-level
// crash screen was English-only with no way to reload but the browser's own
// control. It now follows the saved language and offers a reload button.
function fakeWindow({ stored = null, device = "en-US", storageThrows = false } = {}) {
  return {
    localStorage: {
      getItem: (key) => {
        if (storageThrows) throw new DOMException("The operation is insecure.", "SecurityError");
        return key === "sg-lang" ? stored : null;
      },
    },
    navigator: { language: device },
    location: { reload: vi.fn() },
  };
}

describe("top-level crash screen", () => {
  it.each([
    ["en", { stored: "en", device: "es-US" }, "This screen stopped working", "Reload page"],
    ["es", { stored: "es", device: "en-US" }, "Esta pantalla dejó de funcionar", "Recargar la página"],
    ["es (device)", { stored: null, device: "es-MX" }, "Esta pantalla dejó de funcionar", "Recargar la página"],
    ["en (unsupported saved language)", { stored: "fr", device: "fr-FR" }, "This screen stopped working", "Reload page"],
    ["es (blocked storage, device)", { storageThrows: true, device: "es-US" }, "Esta pantalla dejó de funcionar", "Recargar la página"],
    ["en (blocked storage)", { storageThrows: true, device: "en-GB" }, "This screen stopped working", "Reload page"],
  ])("reads the %s copy and reloads on request", (_label, prefs, heading, reload) => {
    const win = fakeWindow(prefs);
    render(<CrashScreenContent win={win} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(heading);
    fireEvent.click(screen.getByRole("button", { name: reload }));
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("reads the real window when main.jsx renders it without one injected", () => {
    const previous = window.location;
    const reload = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...previous, reload } });
    window.localStorage.setItem("sg-lang", "es");
    try {
      render(<CrashScreenContent />);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Esta pantalla dejó de funcionar");
      expect(screen.getByText("No se perdió nada de lo que ya habías guardado. Vuelve a cargar para regresar a tu espacio; si sigue ocurriendo, cuéntale a un miembro del comité o a un organizador qué estabas haciendo.")).toHaveAttribute("lang", "es");
      // Union Ground reports errors nowhere (no telemetry is configured), so
      // the screen never claims the error was reported.
      expect(screen.queryByText(/Se informó del error/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Recargar la página" }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      window.localStorage.removeItem("sg-lang");
      Object.defineProperty(window, "location", { configurable: true, value: previous });
    }
  });

  it("stays in English and makes reload a no-op without a browser window", () => {
    vi.stubGlobal("window", undefined);
    let tree;
    try {
      tree = CrashScreenContent({});
    } finally {
      vi.unstubAllGlobals();
    }
    const [heading, body, button] = tree.props.children;
    expect(heading.props).toMatchObject({ lang: "en", children: "This screen stopped working" });
    expect(body.props).toMatchObject({ lang: "en", children: "Nothing you already saved was lost. Reload to get back to your workspace; if it keeps happening, tell a committee member or organizer what you were doing." });
    expect(body.props.children).not.toMatch(/reported/i);
    expect(button.props).toMatchObject({ lang: "en", type: "button", children: "Reload page" });
    expect(() => button.props.onClick()).not.toThrow();
  });

  it("does not throw when the injected window cannot reload", () => {
    const win = fakeWindow({ stored: "en" });
    delete win.location;
    render(<CrashScreenContent win={win} />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Reload page" }))).not.toThrow();
  });

  it("is the fallback main.jsx renders inside its alert landmark", () => {
    const src = readFileSync(resolve(process.cwd(), "src/main.jsx"), "utf8");
    expect(src).toMatch(/<main role="alert" className="loading-screen">\s*<CrashScreenContent \/>\s*<\/main>/);
    expect(src).not.toMatch(/Something went wrong/);
  });
});
