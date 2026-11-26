// @vitest-environment node
// #8725 step 1: when HarfBuzz cannot load, the shaper resolves to null (the
// copy then falls back to the unshaped font) and a copy a minute later tries again.
import { describe, expect, it, vi } from "vitest";

vi.mock("harfbuzzjs", () => ({
  Blob: class { constructor() { throw new Error("wasm unavailable"); } },
  Face: class {},
  Font: class {},
}));

const { filingShaper } = await import("../api/_lib/filingShaper.js");

describe("text shaper that cannot load", () => {
  it("resolves to null, logs, waits a minute and then tries again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(await filingShaper()).toBeNull();
    expect(error).toHaveBeenCalledWith("[form-filing] text shaper unavailable", { error: expect.stringContaining("wasm unavailable") });
    // #8737 re-review P3-2: copies within the minute go unshaped with no new load.
    now.mockReturnValue(1_059_999);
    expect(await filingShaper()).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_060_000);
    expect(await filingShaper()).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
    now.mockRestore();
    error.mockRestore();
  });
});
