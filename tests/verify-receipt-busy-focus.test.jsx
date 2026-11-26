// #9914 (carved from #8435): on the ballot receipt lookup page the submit
// button was natively disabled while its own lookup ran, so a keyboard user who
// pressed it lost focus to the page. It is now a pending control, and a lookup
// in flight refuses a second one. Fictional code only.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const lookup = vi.hoisted(() => ({ verify: null }));

vi.mock("../src/lib/supabase.js", async (original) => ({ ...(await original()), hasAppBackend: true, appSupabase: {} }));
vi.mock("../src/lib/memberApi.js", async (original) => ({ ...(await original()), verifyBallotReceipt: (...args) => lookup.verify(...args) }));

const { VerifyReceiptView } = await import("../src/views/VerifyReceiptView.jsx");

describe("ballot receipt lookup page", () => {
  it("keeps focus on the submit button while the lookup runs, and a second press of the button looks nothing up", async () => {
    lookup.verify = vi.fn().mockResolvedValue({ found: false });
    render(<VerifyReceiptView />);
    const form = document.querySelector("form.vrx-form");
    const field = within(form).getByRole("textbox");
    fireEvent.change(field, { target: { value: "SG-1111-2222" } });
    const submit = within(form).getByRole("button");
    await expectHeldWriteFocus(lookup.verify, submit, () => fireEvent.click(submit));
    expect(lookup.verify).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox")).toHaveValue("SG-1111-2222");
  });

  it("refuses a duplicate form submit while a lookup runs", async () => {
    let release;
    lookup.verify = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    render(<VerifyReceiptView />);
    const form = document.querySelector("form.vrx-form");
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "SG-1111-2222" } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(lookup.verify).toHaveBeenCalledTimes(1);
    release({ found: false });
  });
});
