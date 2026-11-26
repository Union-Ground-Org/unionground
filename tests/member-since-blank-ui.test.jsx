// BUG-UG-MEMBER-SINCE-WRONG-FOR-NEW-ACCOUNTS-20261003: a member whose
// union join year is unknown shows no "Member since" line, can leave the year
// blank on their member card, and a year they enter is saved as entered.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileDialog } from "../src/components/Dialogs.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { updateMemberProfile } from "../src/lib/memberApi.js";
import { TodayView } from "../src/views/TodayView.jsx";

afterEach(cleanup);

const card = { firstName: "Renata", fullName: "Renata Silva", initials: "RS", roleLine: "Member" };

function renderCard(sinceYear, onSave = vi.fn().mockResolvedValue(undefined)) {
  render(
    <LanguageProvider lang="en">
      <ProfileDialog member={{ ...card, sinceYear }} onClose={vi.fn()} onSave={onSave} />
    </LanguageProvider>,
  );
  return onSave;
}

describe("member card join year", () => {
  it("lets a member with no known join year save the card with the year left blank", async () => {
    const onSave = renderCard(null);
    const year = screen.getByLabelText("With the campaign since");
    expect(year).toHaveValue(null);
    expect(year).not.toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ fullName: "Renata Silva", sinceYear: null })));
  });

  it("saves the join year the member enters", async () => {
    const onSave = renderCard(null);
    fireEvent.change(screen.getByLabelText("With the campaign since"), { target: { value: "2015" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ sinceYear: 2015 })));
  });

  it("keeps an existing year on the card", () => {
    renderCard(2019);
    expect(screen.getByLabelText("With the campaign since")).toHaveValue(2019);
  });

  it("writes null for a blank year and the number for an entered one", async () => {
    const update = vi.fn();
    const client = { rpc: vi.fn(async (_name, args) => { expect(args.p_expected_user_id).toBe("user-1"); update(args.p_fields); return { data: null, error: null }; }) };
    const fields = { firstName: "Renata", fullName: "Renata Silva", initials: "rs", roleLine: "Member" };
    await updateMemberProfile(client, "user-1", { ...fields, sinceYear: null });
    await updateMemberProfile(client, "user-1", { ...fields, sinceYear: "" });
    await updateMemberProfile(client, "user-1", { ...fields, sinceYear: 2015 });
    expect(update.mock.calls.map(([payload]) => payload.member_since)).toEqual([null, null, 2015]);
  });
});

describe("Home identity line", () => {
  function home(sinceYear, desktop) {
    const data = { ...fallbackData, member: { ...fallbackData.member, sinceYear } };
    render(<LanguageProvider lang="en"><TodayView data={data} desktop={desktop} onPlanAction={() => {}} /></LanguageProvider>);
  }

  it.each([[true], [false]])("omits Member since when the join year is unknown (desktop %s)", (desktop) => {
    home(null, desktop);
    expect(screen.queryByText(/With the campaign since|Member since/)).not.toBeInTheDocument();
  });

  // Union Ground's Home identity line names the worker's role line only;
  // the join year lives on the worker card, never on Home, even when known.
  it.each([[true], [false]])("keeps a known join year off Home (desktop %s)", (desktop) => {
    home(2019, desktop);
    expect(screen.getAllByText(new RegExp(fallbackData.member.roleLine)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/With the campaign since|Member since|2019/)).not.toBeInTheDocument();
  });
});
