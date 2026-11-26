// REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117 (#9038):
// a public-page section is drawn only when /api/public-sections names it. It
// reads held while the read runs and after a failed read, and one read serves
// every section on the page.
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetReleasedPublicSections, loadReleasedPublicSections, usePublicSectionReleased } from "../src/lib/publicSections.js";

function Section({ name }) {
  return <p data-testid={name}>{usePublicSectionReleased(name) ? "released" : "held"}</p>;
}

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(() => forgetReleasedPublicSections());
afterEach(() => { vi.unstubAllGlobals(); forgetReleasedPublicSections(); });

describe("public page sections on the web", () => {
  it("loads the released names from the route, keeping only the known sections", async () => {
    const fetchMock = vi.fn(async () => reply({ released: ["unions_map_3d", "sign_in_design_9", "sign_in_design_3"] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadReleasedPublicSections()).resolves.toEqual(["sign_in_design_3", "unions_map_3d"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/public-sections", expect.objectContaining({ cache: "no-store" }));
  });

  it("names nothing when the answer is not a list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ released: "sign_in_design_2" })));
    await expect(loadReleasedPublicSections()).resolves.toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => reply(null)));
    await expect(loadReleasedPublicSections()).resolves.toEqual([]);
  });

  it("sets nothing on a section that left the page before the answer, released or failed", async () => {
    let resolve;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const page = render(<Section name="sign_in_design_3" />);
    page.unmount();
    await act(async () => { resolve(reply({ released: ["sign_in_design_3"] })); });
    forgetReleasedPublicSections();
    let reject;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((_done, fail) => { reject = fail; })));
    const next = render(<Section name="sign_in_design_3" />);
    next.unmount();
    await act(async () => { reject(new TypeError("offline")); });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("refuses a failed answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ released: [] }, 503)));
    await expect(loadReleasedPublicSections()).rejects.toThrow("public-sections-unavailable");
  });

  it("reads held until the answer arrives, then shows only the released section, from one read", async () => {
    let resolve;
    const fetchMock = vi.fn(() => new Promise((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<><Section name="sign_in_design_2" /><Section name="unions_map_3d" /></>);
    expect(screen.getByTestId("sign_in_design_2").textContent).toBe("held");
    expect(screen.getByTestId("unions_map_3d").textContent).toBe("held");
    await act(async () => { resolve(reply({ released: ["sign_in_design_2"] })); });
    expect(screen.getByTestId("sign_in_design_2").textContent).toBe("released");
    expect(screen.getByTestId("unions_map_3d").textContent).toBe("held");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stays held after a failed read, and reads again on the next page", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    const first = render(<Section name="sign_in_design_4" />);
    await act(async () => {});
    expect(screen.getByTestId("sign_in_design_4").textContent).toBe("held");
    first.unmount();
    fetchMock.mockImplementation(async () => reply({ released: ["sign_in_design_4"] }));
    render(<Section name="sign_in_design_4" />);
    await act(async () => {});
    expect(screen.getByTestId("sign_in_design_4").textContent).toBe("released");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a held section off the page while the read is slow, after it fails, and when it names others", async () => {
    function Page() {
      const design2 = usePublicSectionReleased("sign_in_design_2");
      return <main><h1>Sign in</h1>{design2 ? <section aria-label="Design 2">Design 2</section> : null}</main>;
    }
    let resolve;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
    const slow = render(<Page />);
    await act(async () => {});
    expect(screen.queryByLabelText("Design 2")).toBeNull();
    await act(async () => { resolve(reply({ released: [] }, 503)); });
    expect(screen.queryByLabelText("Design 2")).toBeNull();
    slow.unmount();
    forgetReleasedPublicSections();
    vi.stubGlobal("fetch", vi.fn(async () => reply({ released: ["sign_in_design_3", "unions_map_3d"] })));
    render(<Page />);
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByLabelText("Design 2")).toBeNull();
  });

  it("reads false at once when the section changes, until that section's own answer arrives (ledger 477)", async () => {
    let resolve;
    vi.stubGlobal("fetch", vi.fn(async () => reply({ released: ["sign_in_design_2"] })));
    const view = render(<Section name="sign_in_design_2" />);
    await act(async () => {});
    expect(screen.getByTestId("sign_in_design_2").textContent).toBe("released");
    // A fresh read for the next section that has not answered yet: the old
    // section's true must not carry over to the new one, not even for a render.
    forgetReleasedPublicSections();
    vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
    view.rerender(<Section name="sign_in_design_3" />);
    expect(screen.getByTestId("sign_in_design_3").textContent).toBe("held");
    await act(async () => { resolve(reply({ released: ["sign_in_design_2"] })); });
    expect(screen.getByTestId("sign_in_design_3").textContent).toBe("held");
    // Back to a released section, and away to no section at all.
    view.rerender(<Section name="sign_in_design_2" />);
    await act(async () => {});
    expect(screen.getByTestId("sign_in_design_2").textContent).toBe("released");
    view.rerender(<Section name={null} />);
    expect(view.container.textContent).toBe("held");
  });

  it("shows a section held again once the read is forgotten, as the sign-in page does on each visit (ledger 475)", async () => {
    const fetchMock = vi.fn(async () => reply({ released: ["sign_in_design_4"] }));
    vi.stubGlobal("fetch", fetchMock);
    const first = render(<Section name="sign_in_design_4" />);
    await act(async () => {});
    expect(screen.getByTestId("sign_in_design_4").textContent).toBe("released");
    first.unmount();
    // Held again on the server. Without forgetting, the page would keep the
    // read it made earlier in this session.
    fetchMock.mockImplementation(async () => reply({ released: [] }));
    const kept = render(<Section name="sign_in_design_4" />);
    await act(async () => {});
    expect(screen.getByTestId("sign_in_design_4").textContent).toBe("released");
    kept.unmount();
    forgetReleasedPublicSections();
    render(<Section name="sign_in_design_4" />);
    await act(async () => {});
    expect(screen.getByTestId("sign_in_design_4").textContent).toBe("held");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never asks for a name it does not know", async () => {
    const fetchMock = vi.fn(async () => reply({ released: ["sign_in_design_9"] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Section name="sign_in_design_9" />);
    await act(async () => {});
    expect(screen.getByTestId("sign_in_design_9").textContent).toBe("held");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
