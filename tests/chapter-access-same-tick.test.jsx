import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ChapterAccessPanel } from "../src/features/chapterAccess/ChapterAccessPanel.jsx";
import { expectOneWriteForSameTickDouble } from "./helpers/sameTickActivation.js";

vi.mock("../src/lib/chapterAccessApi.js", async (original) => ({ ...(await original()), createChapterAccessApi: (client) => client?.access || null }));
vi.mock("../src/lib/unitSettings.js", async (original) => ({ ...(await original()), createUnitSettingsApi: (client) => client?.unitSettings || null }));

// a review note (a) and 272 (1): the chapter access slice of record #8435
// (#8793). Two submissions of the Give access form inside one React update,
// before the busy state renders, grant the role once; only the panel's
// runBusyWrite lock ("access") can refuse the second. In
// tests/chapter-access-ui.test.jsx the Treasurer grant (a second submission
// while the first is held) already pins the same lock; its capability-switch
// case still passes with the lock removed. This case pins the same-tick path.
const workspace = () => ({
  policy: { steward_grievances: true, steward_breadth: "chapter" },
  members: [{ id: "m", name: "Fictional Mira" }], units: [], committees: [], grants: [],
  roles: [{ role: "secretary", capability: "records" }], settings: [],
  grantableRoles: ["secretary"], hasMoreMembers: false, hasMoreUnits: false, hasMoreCommittees: false,
});

describe("chapter access writes, two activations in one React update", () => {
  it("gives access once", async () => {
    const api = { load: vi.fn(async () => workspace()), setPolicy: vi.fn(async () => {}), setRole: vi.fn(async () => {}), setMember: vi.fn(async () => {}), saveCommittee: vi.fn(async () => {}), setCapability: vi.fn(async () => {}) };
    render(<LanguageProvider lang="en"><ChapterAccessPanel client={{ access: api }} chapterId="ch" /></LanguageProvider>);
    await screen.findByLabelText("Access role");
    const form = screen.getByRole("button", { name: "Give access" }).closest("form");
    await expectOneWriteForSameTickDouble(api.setRole, () => fireEvent.submit(form));
  });
});
