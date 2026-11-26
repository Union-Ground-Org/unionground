// REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030:
// units and worksites inside a chapter with headcounts, inviting straight into
// a chapter or unit, one Save for the organization's words, and the local's
// profile.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChapterUnitsCard, LocalProfileCard } from "../src/features/orgSetup/ChapterUnitsCard.jsx";
import { CHAPTER_SETUP_CHANGED_EVENT } from "../src/lib/onboardingGuide.js";
import {
  deleteChapterUnit, listChapterUnits, loadLocalProfile, normalizeLocalProfile, normalizeUnits,
  saveChapterUnit, saveLocalProfile, unitsForChapter,
} from "../src/features/orgSetup/unitsApi.js";
import { inviteMember } from "../src/lib/adminInvitationApi.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";
import { AdminView } from "../src/views/AdminView.jsx";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { ORG_START_MILESTONES, orgStartGuide } from "../src/features/onboardingGuideEngine/orgStart.js";

const CHAPTERS = [{ id: "fleet", name: "Fleet Maintenance" }, { id: "ops", name: "Operations" }];
const GARAGE = { id: "6a1f2c43-1d2e-4c5b-9a8f-0b1c2d3e4f50", chapterId: "fleet", chapterName: "Fleet Maintenance", name: "Garage 4", kind: "worksite", headcount: 38 };
const NIGHTS = { id: "7b2f3d54-2e3f-4d6c-8b9a-1c2d3e4f5061", chapterId: "fleet", chapterName: "Fleet Maintenance", name: "Night crew", kind: "unit", headcount: null };

function inEnglish(node) {
  return render(<LanguageProvider lang="en">{node}</LanguageProvider>);
}

describe("units API", () => {
  it("normalizes rows and drops malformed ones", () => {
    expect(normalizeUnits([GARAGE, { id: 1 }, null, { ...NIGHTS, kind: "x", headcount: -3 }])).toEqual([
      GARAGE,
      { ...NIGHTS, kind: "unit", headcount: null },
    ]);
    expect(normalizeUnits("nope")).toEqual([]);
    expect(normalizeLocalProfile(null)).toBeNull();
    expect(normalizeLocalProfile({ employer: " ", timeZone: "America/New_York", units: [GARAGE], canEdit: true }))
      .toMatchObject({ employer: null, timeZone: "America/New_York", units: [GARAGE], canEdit: true });
    expect(unitsForChapter([GARAGE, { ...NIGHTS, chapterId: "ops" }], "fleet")).toEqual([GARAGE]);
    expect(unitsForChapter(null, "fleet")).toEqual([]);
  });

  it("calls one RPC per action and wraps errors", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [GARAGE], error: null });
    const client = { rpc };
    expect(await listChapterUnits(client)).toEqual([GARAGE]);
    await saveChapterUnit(client, { chapterId: "fleet", name: "  Garage 4 ", kind: "worksite", headcount: 38 });
    expect(rpc).toHaveBeenLastCalledWith("save_chapter_unit", { p_unit_id: null, p_chapter_id: "fleet", p_name: "Garage 4", p_kind: "worksite", p_headcount: 38 });
    await saveChapterUnit(client, { id: GARAGE.id, chapterId: "fleet", name: "Garage 4", kind: "other", headcount: 1.5 });
    expect(rpc).toHaveBeenLastCalledWith("save_chapter_unit", { p_unit_id: GARAGE.id, p_chapter_id: "fleet", p_name: "Garage 4", p_kind: "unit", p_headcount: null });
    await deleteChapterUnit(client, GARAGE.id);
    expect(rpc).toHaveBeenLastCalledWith("delete_chapter_unit", { p_unit_id: GARAGE.id });
    rpc.mockResolvedValue({ data: { employer: "Port Kinsey Transit", units: [], canEdit: false }, error: null });
    expect(await loadLocalProfile(client)).toMatchObject({ employer: "Port Kinsey Transit", canEdit: false });
    await saveLocalProfile(client, { employer: " Port Kinsey Transit ", phone: "" });
    expect(rpc).toHaveBeenLastCalledWith("save_organization_local_profile", { p_profile: expect.objectContaining({ employer: "Port Kinsey Transit", phone: null, timeZone: null }) });
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "admin role required" } });
    await expect(listChapterUnits(client)).rejects.toMatchObject({ code: "42501" });
  });

  it("sends a unit only on an ordinary invitation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accepted: true }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const session = { access_token: "token" };
      await inviteMember(session, { email: "pete@example.org", fullName: "Pete Halvorsen", chapterId: "fleet", unitId: GARAGE.id, locale: "en" });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ unitId: GARAGE.id });
      await inviteMember(session, { email: "pete@example.org", chapterId: "fleet", unitId: GARAGE.id, formerMember: true, locale: "en" });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("unitId");
      await inviteMember(session, { email: "pete@example.org", fullName: "Pete", chapterId: "fleet", unitId: GARAGE.id, source: "roster", locale: "en" });
      expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty("unitId");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Units and worksites card", () => {
  it.each([
    ["en", "Enter a whole headcount from 0 to 1,000,000."],
    ["es", "Ingresa un número entero de personas entre 0 y 1.000.000."],
  ])("explains an invalid headcount before Save (%s)", async (lang, reason) => {
    const units = api();
    const { container } = render(<LanguageProvider lang={lang}><ChapterUnitsCard api={units} chapters={CHAPTERS} /></LanguageProvider>);
    await screen.findByText("Garage 4");
    const form = container.querySelector("#admin-units form");
    const headcount = within(form).getByRole("spinbutton");
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "Dispatch" } });
    const save = form.querySelector('button[type="submit"]');
    for (const value of ["12.5", "-3", "1000001"]) {
      fireEvent.input(headcount, { target: { value } });
      expect(headcount).toHaveAttribute("aria-invalid", "true");
      expect(headcount).toHaveAccessibleDescription(expect.stringContaining(reason));
      expect(save).toHaveAccessibleDescription(reason);
      fireEvent.click(save);
      expect(within(form).getByRole("alert")).toHaveTextContent(reason);
    }
    fireEvent.input(headcount, { target: { value: "12" } });
    // A browser can expose an empty value and badInput for a draft such as a comma-separated number.
    const validity = vi.spyOn(headcount, "validity", "get").mockReturnValue({ badInput: true });
    fireEvent.input(headcount, { target: { value: "" } });
    expectRefusedEveryWay(save, reason, () => units.saveChapterUnit.mock.calls.length > 0);
    const previousAlert = within(form).getByRole("alert");
    fireEvent.submit(form);
    expect(within(form).getByRole("alert")).not.toBe(previousAlert);
    validity.mockRestore();
    fireEvent.input(headcount, { target: { value: "" } });
    expect(headcount).not.toHaveAttribute("aria-invalid");
    fireEvent.click(save);
    await waitFor(() => expect(units.saveChapterUnit).toHaveBeenCalledExactlyOnceWith({
      id: null, chapterId: "fleet", name: "Dispatch", kind: "unit", headcount: null,
    }));
  });

  it.each([
    ["en", "Choose a campaign first."],
    ["es", "Elige primero una campaña."],
  ])("explains a missing campaign after the campaign list refreshes (%s)", async (lang, reason) => {
    const units = api();
    const card = (chapters) => <LanguageProvider lang={lang}><ChapterUnitsCard api={units} chapters={chapters} /></LanguageProvider>;
    const { container, rerender } = render(card(CHAPTERS));
    await screen.findByText("Garage 4");
    const form = container.querySelector("#admin-units form");
    const chapter = within(form).getAllByRole("combobox")[0];
    const save = form.querySelector('button[type="submit"]');
    fireEvent.change(chapter, { target: { value: "ops" } });
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "Dispatch" } });
    rerender(card([CHAPTERS[0]]));
    expect(chapter).toHaveValue("");
    expectRefusedEveryWay(save, reason, () => units.saveChapterUnit.mock.calls.length > 0);
    fireEvent.change(chapter, { target: { value: "fleet" } });
    expect(save).not.toHaveAttribute("aria-disabled");
    expect(save).not.toHaveAccessibleDescription();
    expect(within(form).queryByRole("alert")).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(units.saveChapterUnit).toHaveBeenCalledExactlyOnceWith({
      id: null, chapterId: "fleet", name: "Dispatch", kind: "unit", headcount: null,
    }));
  });

  function api(overrides = {}) {
    return {
      listChapterUnits: vi.fn().mockResolvedValue([GARAGE, NIGHTS]),
      saveChapterUnit: vi.fn().mockResolvedValue([GARAGE, NIGHTS]),
      deleteChapterUnit: vi.fn().mockResolvedValue([NIGHTS]),
      ...overrides,
    };
  }

  it("lists units inside their campaign with headcounts and a total", async () => {
    const onUnitsChange = vi.fn();
    inEnglish(<ChapterUnitsCard api={api()} chapters={CHAPTERS} onUnitsChange={onUnitsChange} />);
    const chapter = await screen.findByRole("region", { name: "Fleet Maintenance" });
    expect(within(chapter).getByText("Garage 4")).toBeInTheDocument();
    expect(within(chapter).getByText("38 people")).toBeInTheDocument();
    expect(within(chapter).getByText("Headcount not set")).toBeInTheDocument();
    expect(within(chapter).getByText("Worksite")).toBeInTheDocument();
    expect(screen.getByText("38 people counted across units and worksites")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Operations" })).not.toBeInTheDocument();
    expect(onUnitsChange).toHaveBeenCalledWith([GARAGE, NIGHTS]);
  });

  it("adds a unit to the chosen campaign, then edits and removes one", async () => {
    const units = api();
    const onNotice = vi.fn();
    inEnglish(<ChapterUnitsCard api={units} chapters={CHAPTERS} onNotice={onNotice} />);
    await screen.findByText("Garage 4");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "ops" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dispatch desk" } });
    fireEvent.input(screen.getByLabelText("Headcount"), { target: { value: "-1" } });
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.input(screen.getByLabelText("Headcount"), { target: { value: "12" } });
    fireEvent.click(save);
    await waitFor(() => expect(units.saveChapterUnit).toHaveBeenCalledWith({ id: null, chapterId: "ops", name: "Dispatch desk", kind: "unit", headcount: 12 }));
    expect(onNotice).toHaveBeenCalledWith("Unit or worksite saved.");

    fireEvent.click(screen.getByRole("button", { name: "Edit Garage 4" }));
    expect(screen.getByRole("heading", { name: "Edit unit or worksite" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Garage 4");
    fireEvent.input(screen.getByLabelText("Headcount"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(units.saveChapterUnit).toHaveBeenLastCalledWith({ id: GARAGE.id, chapterId: "fleet", name: "Garage 4", kind: "worksite", headcount: null }));

    fireEvent.click(screen.getByRole("button", { name: "Remove Garage 4" }));
    const confirm = screen.getByRole("group", { name: /Remove Garage 4\?/ });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: /Remove Garage 4\?/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Garage 4" }));
    fireEvent.click(within(screen.getByRole("group", { name: /Remove Garage 4\?/ })).getByRole("button", { name: "Yes, remove" }));
    await waitFor(() => expect(units.deleteChapterUnit).toHaveBeenCalledWith(GARAGE.id));
    await waitFor(() => expect(screen.queryByText("Garage 4")).not.toBeInTheDocument());
  });

  // Save and Yes, remove keep focus while their write runs, and a
  // second activation in the same tick writes nothing more for that unit.
  it("keeps Save focused while a unit is saved, and saves it once", async () => {
    const units = api({ saveChapterUnit: vi.fn(async () => [GARAGE, NIGHTS]) });
    inEnglish(<ChapterUnitsCard api={units} chapters={CHAPTERS} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Garage 4" }));
    await expectHeldWriteFocus(units.saveChapterUnit, screen.getByRole("button", { name: "Save" }));
    expect(units.saveChapterUnit).toHaveBeenCalledTimes(1);
  });

  it("keeps Yes, remove focused while a unit is removed, and removes it once", async () => {
    const units = api({ deleteChapterUnit: vi.fn(async () => [NIGHTS]) });
    inEnglish(<ChapterUnitsCard api={units} chapters={CHAPTERS} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Garage 4" }));
    const confirm = screen.getByRole("group", { name: /Remove Garage 4\?/ });
    await expectHeldWriteFocus(units.deleteChapterUnit, within(confirm).getByRole("button", { name: "Yes, remove" }));
    expect(units.deleteChapterUnit).toHaveBeenCalledExactlyOnceWith(GARAGE.id);
  });

  it("writes once for a unit when Save or Yes, remove is activated twice in one tick", async () => {
    const units = api({ saveChapterUnit: vi.fn(async () => [GARAGE, NIGHTS]), deleteChapterUnit: vi.fn(async () => [NIGHTS]) });
    inEnglish(<ChapterUnitsCard api={units} chapters={CHAPTERS} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Garage 4" }));
    const save = screen.getByRole("button", { name: "Save" });
    await expectOneWriteFromOneTick(units.saveChapterUnit, [() => fireEvent.click(save), () => fireEvent.click(save)]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove Garage 4" })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Garage 4" }));
    const remove = within(screen.getByRole("group", { name: /Remove Garage 4\?/ })).getByRole("button", { name: "Yes, remove" });
    await expectOneWriteFromOneTick(units.deleteChapterUnit, [() => fireEvent.click(remove), () => fireEvent.click(remove)]);
  });

  it("names a duplicate, a failed save, a failed remove and a failed read", async () => {
    const units = api({
      saveChapterUnit: vi.fn().mockRejectedValueOnce({ code: "23505" }).mockRejectedValueOnce(new Error("down")),
      deleteChapterUnit: vi.fn().mockRejectedValue(new Error("down")),
    });
    inEnglish(<ChapterUnitsCard api={units} chapters={CHAPTERS} />);
    await screen.findByText("Garage 4");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Garage 4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This campaign already has a unit or worksite with that name.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That change could not be saved. Try again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Night crew" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));
    await waitFor(() => expect(units.deleteChapterUnit).toHaveBeenCalled());
    expect(screen.getByText("Night crew")).toBeInTheDocument();
  });

  it("names a unit an open Committee member invitation still reserves, on a move and on a removal (#7663)", async () => {
    const reserved = { code: "23514", message: "Save unit: unit is reserved by an open steward invitation: revoke the invitation or resend it with another unit before moving the unit" };
    const units = api({ saveChapterUnit: vi.fn().mockRejectedValue(reserved), deleteChapterUnit: vi.fn().mockRejectedValue({ ...reserved, message: "Delete unit: unit is reserved by an open steward invitation: revoke the invitation or resend it with another unit first" }) });
    inEnglish(<ChapterUnitsCard api={units} chapters={CHAPTERS} />);
    await screen.findByText("Garage 4");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Garage 5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const text = "An open Committee member invitation still needs this unit. Revoke that invitation, or resend it with another unit, first.";
    expect(await screen.findByText(text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Night crew" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));
    await waitFor(() => expect(units.deleteChapterUnit).toHaveBeenCalled());
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("says when units cannot be read, shows an empty state, and hides without an API", async () => {
    const { unmount } = inEnglish(<ChapterUnitsCard api={api({ listChapterUnits: vi.fn().mockRejectedValue(new Error("x")) })} chapters={CHAPTERS} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Units and worksites could not be loaded.");
    unmount();
    const empty = inEnglish(<ChapterUnitsCard api={api({ listChapterUnits: vi.fn().mockResolvedValue([]) })} chapters={CHAPTERS} />);
    expect(await screen.findByText("No units or worksites yet.")).toBeInTheDocument();
    empty.unmount();
    const { container } = inEnglish(<ChapterUnitsCard api={{}} chapters={CHAPTERS} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Local profile card", () => {
  const profile = {
    officeAddress: "12 Harbor St", phone: "555 0100", officeHours: "Mon–Fri 9–5", employer: "Port Kinsey Transit",
    contractStartsOn: "2024-07-01", contractEndsOn: "2027-06-30", boardSchedule: "Second Tuesday, 6 PM", timeZone: "America/New_York",
    units: [GARAGE], canEdit: true,
  };

  it("edits and saves every field and lists unit headcounts", async () => {
    const saveLocal = vi.fn().mockImplementation(async (fields) => ({ ...profile, ...fields }));
    const onNotice = vi.fn();
    inEnglish(<LocalProfileCard api={{ loadLocalProfile: vi.fn().mockResolvedValue(profile), saveLocalProfile: saveLocal }} onNotice={onNotice} />);
    expect(await screen.findByLabelText("Employer")).toHaveValue("Port Kinsey Transit");
    expect(screen.getByLabelText("Office address")).toHaveValue("12 Harbor St");
    expect(screen.getByText("Garage 4 · Fleet Maintenance · 38 people")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Contract expires"), { target: { value: "2023-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("The contract cannot expire before it starts.");
    expect(screen.getByRole("button", { name: "Save local profile" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Contract expires"), { target: { value: "2028-06-30" } });
    fireEvent.change(screen.getByLabelText("Board meeting schedule"), { target: { value: "First Monday" } });
    fireEvent.click(screen.getByRole("button", { name: "Save local profile" }));
    await waitFor(() => expect(saveLocal).toHaveBeenCalledWith(expect.objectContaining({ contractEndsOn: "2028-06-30", boardSchedule: "First Monday", timeZone: "America/New_York" })));
    expect(onNotice).toHaveBeenCalledWith("Local profile saved.");
  });

  // Save local profile keeps focus while it saves, and a second
  // activation in the same tick sends no second save.
  it("keeps Save local profile focused while it saves, and saves once in one tick", async () => {
    const saveLocal = vi.fn(async (fields) => ({ ...profile, ...fields }));
    inEnglish(<LocalProfileCard api={{ loadLocalProfile: vi.fn().mockResolvedValue(profile), saveLocalProfile: saveLocal }} />);
    await screen.findByLabelText("Employer");
    await expectHeldWriteFocus(saveLocal, screen.getByRole("button", { name: "Save local profile" }));
    expect(saveLocal).toHaveBeenCalledTimes(1);
    const save = screen.getByRole("button", { name: "Save local profile" });
    await waitFor(() => expect(save).not.toHaveAttribute("aria-disabled"));
    await expectOneWriteFromOneTick(saveLocal, [() => fireEvent.click(save), () => fireEvent.click(save)]);
  });

  it("shows the Units card's latest headcounts instead of its own first read", async () => {
    const { rerender } = inEnglish(<LocalProfileCard api={{ loadLocalProfile: vi.fn().mockResolvedValue(profile) }} units={null} />);
    expect(await screen.findByText("Garage 4 · Fleet Maintenance · 38 people")).toBeInTheDocument();
    rerender(<LanguageProvider lang="en"><LocalProfileCard api={{ loadLocalProfile: vi.fn().mockResolvedValue(profile) }} units={[{ ...GARAGE, headcount: 50 }]} /></LanguageProvider>);
    expect(screen.getByText("Garage 4 · Fleet Maintenance · 50 people")).toBeInTheDocument();
    expect(screen.queryByText(/38 people/)).not.toBeInTheDocument();
  });

  it("says a refused save failed, reads only for non-admins, and reports an unreadable profile", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("22023"));
    const { unmount } = inEnglish(<LocalProfileCard api={{ loadLocalProfile: vi.fn().mockResolvedValue(profile), saveLocalProfile: failing }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Save local profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The local profile could not be saved.");
    unmount();
    const reader = inEnglish(<LocalProfileCard api={{ loadLocalProfile: vi.fn().mockResolvedValue({ ...profile, employer: null, units: [], canEdit: false }) }} />);
    expect(await screen.findByText("Not set")).toBeInTheDocument();
    expect(screen.getByText("12 Harbor St")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("No units or worksites yet.")).toBeInTheDocument();
    reader.unmount();
    const broken = inEnglish(<LocalProfileCard api={{ loadLocalProfile: vi.fn().mockRejectedValue(new Error("x")) }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The local profile could not be loaded.");
    broken.unmount();
    const { container } = inEnglish(<LocalProfileCard api={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("organization words in the labels card", () => {
  const configuration = { settings: [], labelKeys: ["nav.home", "nav.myChapter"], labelOverrides: { "term.chapter": "Shop" } };

  it("lists the campaign and worksite words first and saves every change with one Save", async () => {
    const updateOrganizationLabel = vi.fn().mockResolvedValue({ updated: true });
    const reload = vi.fn();
    const onNotice = vi.fn();
    const { container } = inEnglish(<AdminSecurityConfiguration configuration={configuration} failedLoginInbox={null}
      api={{ updateOrganizationLabel, updateOrganizationSetting: vi.fn() }} reload={reload} onNotice={onNotice} />);
    const labels = within(container.querySelector("#admin-labels"));
    expect(labels.getByRole("heading", { name: "Words used everywhere" })).toBeInTheDocument();
    const textboxes = labels.getAllByRole("textbox");
    expect(textboxes[0]).toHaveValue("Shop");
    expect(textboxes).toHaveLength(6);
    const worksite = labels.getByRole("textbox", { name: "worksite" });
    fireEvent.change(worksite, { target: { value: "<garage>" } });
    expect(worksite).toHaveAttribute("aria-invalid", "true");
    expect(worksite).toHaveAccessibleDescription("Start with a letter. Use letters, spaces, hyphens, apostrophes or ampersands, up to 30 characters.");
    expectRefusedEveryWay(labels.getByRole("button", { name: "Save labels" }), "Fix the highlighted labels before saving.", () => updateOrganizationLabel.mock.calls.length > 0);
    fireEvent.change(labels.getByRole("textbox", { name: "worksite" }), { target: { value: "Garage" } });
    fireEvent.change(labels.getByRole("textbox", { name: "Home" }), { target: { value: "Start" } });
    fireEvent.click(labels.getByRole("button", { name: "Save labels" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Organization labels saved."));
    expect(updateOrganizationLabel.mock.calls).toEqual([["term.worksite", "Garage"], ["nav.home", "Start"]]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("explains the invalid term beside its Spanish field and Save", () => {
    const updateOrganizationLabel = vi.fn();
    const { container } = render(<LanguageProvider lang="es">
      <AdminSecurityConfiguration configuration={configuration} failedLoginInbox={null}
        api={{ updateOrganizationLabel, updateOrganizationSetting: vi.fn() }} reload={vi.fn()} onNotice={vi.fn()} />
    </LanguageProvider>);
    const labels = within(container.querySelector("#admin-labels"));
    const field = within(container.querySelector('[data-label-key="term.worksite"]')).getByRole("textbox");
    const validTerm = within(container.querySelector('[data-label-key="term.chapter"]')).getByRole("textbox");
    fireEvent.change(field, { target: { value: "Taller 2" } });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription("Empieza con una letra. Usa letras, espacios, guiones, apóstrofos o el signo &, hasta 30 caracteres.");
    expect(validTerm).toHaveAccessibleDescription("Empieza con una letra. Usa letras, espacios, guiones, apóstrofos o el signo &, hasta 30 caracteres.");
    const save = labels.getByRole("button", { name: "Guardar etiquetas" });
    expectRefusedEveryWay(save, "Corrige las etiquetas marcadas antes de guardar.", () => updateOrganizationLabel.mock.calls.length > 0);
    fireEvent.change(field, { target: { value: "Taller & Garaje" } });
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(save).not.toHaveAttribute("aria-disabled");
  });

  it("stops writing as soon as a write answers without a result (a superseded session)", async () => {
    const updateOrganizationLabel = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ updated: true });
    const onNotice = vi.fn();
    const reload = vi.fn();
    const { container } = inEnglish(<AdminSecurityConfiguration configuration={configuration} failedLoginInbox={null}
      api={{ updateOrganizationLabel, updateOrganizationSetting: vi.fn() }} reload={reload} onNotice={onNotice} />);
    const labels = within(container.querySelector("#admin-labels"));
    fireEvent.change(labels.getByRole("textbox", { name: "worksite" }), { target: { value: "Garage" } });
    fireEvent.change(labels.getByRole("textbox", { name: "Home" }), { target: { value: "Start" } });
    fireEvent.click(labels.getByRole("button", { name: "Save labels" }));
    await waitFor(() => expect(updateOrganizationLabel).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateOrganizationLabel).toHaveBeenCalledTimes(1);
    expect(onNotice).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps the drafts and says so when a save fails", async () => {
    const updateOrganizationLabel = vi.fn().mockRejectedValue(new Error("22023"));
    const { container } = inEnglish(<AdminSecurityConfiguration configuration={configuration} failedLoginInbox={null}
      api={{ updateOrganizationLabel, updateOrganizationSetting: vi.fn() }} reload={vi.fn()} onNotice={vi.fn()} />);
    const labels = within(container.querySelector("#admin-labels"));
    fireEvent.change(labels.getByRole("textbox", { name: "campaigns" }), { target: { value: "Shops" } });
    fireEvent.click(labels.getByRole("button", { name: "Save labels" }));
    expect(await labels.findByRole("alert")).toBeInTheDocument();
    expect(labels.getByRole("textbox", { name: "campaigns" })).toHaveValue("Shops");
  });
});

describe("one unit list across the Organization page", () => {

  it("lets a save win over the Units card's own slower first read", async () => {
    let finishFirstRead;
    const units = {
      listChapterUnits: vi.fn().mockReturnValueOnce(new Promise((resolve) => { finishFirstRead = resolve; })),
      saveChapterUnit: vi.fn().mockResolvedValue([GARAGE, { ...NIGHTS, chapterId: "ops", name: "Dispatch" }]),
      deleteChapterUnit: vi.fn(),
    };
    inEnglish(<ChapterUnitsCard api={units} chapters={CHAPTERS} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dispatch" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Dispatch")).toBeInTheDocument();
    finishFirstRead([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText("Dispatch")).toBeInTheDocument();
    expect(screen.queryByText("No units or worksites yet.")).not.toBeInTheDocument();
  });
});

describe("org-start guide structure step", () => {
  it("opens the Organization page, where units and worksites are set up, before Feature switches", () => {
    expect(ORG_START_MILESTONES.find((entry) => entry.id === "structure").opens.map((entry) => entry.path)).toEqual(["/m/admin/organization", "/m/admin/configuration"]);
    const payload = { state: "active", organizationName: "Port Kinsey", viewer: { isAdmin: true }, milestones: [] };
    const structure = orgStartGuide(payload, { reachable: () => true }).view.milestones.find((entry) => entry.id === "structure");
    expect(structure.open.path).toBe("/m/admin/organization");
  });

  // REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109: a landed unit write tells
  // the staff guide to read the units step's facts again; a failed one does not.
  it("announces a campaign setup change after a unit is saved or removed, and not after a failure", async () => {
    const heard = vi.fn();
    window.addEventListener(CHAPTER_SETUP_CHANGED_EVENT, heard);
    try {
      const units = {
        listChapterUnits: vi.fn().mockResolvedValue([GARAGE, NIGHTS]),
        saveChapterUnit: vi.fn().mockResolvedValue([GARAGE, NIGHTS]),
        deleteChapterUnit: vi.fn().mockResolvedValue([NIGHTS]),
      };
      inEnglish(<ChapterUnitsCard api={units} chapters={CHAPTERS} />);
      await screen.findByText("Garage 4");
      fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "ops" } });
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dispatch desk" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
      units.saveChapterUnit.mockRejectedValueOnce(new Error("down"));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Second desk" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(units.saveChapterUnit).toHaveBeenCalledTimes(2));
      expect(heard).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Remove Garage 4" }));
      fireEvent.click(within(screen.getByRole("group", { name: /Remove Garage 4\?/ })).getByRole("button", { name: "Yes, remove" }));
      await waitFor(() => expect(units.deleteChapterUnit).toHaveBeenCalledWith(GARAGE.id));
      await waitFor(() => expect(heard).toHaveBeenCalledTimes(2));
    } finally {
      window.removeEventListener(CHAPTER_SETUP_CHANGED_EVENT, heard);
    }
  });
});

