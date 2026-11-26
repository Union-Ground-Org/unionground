// BUG-UG-SPACE-MENTION-PICKER-RETURNS-NOBODY-20261006, owner ruling of
// October 7, 2026 (option 1): list_channel_mention_candidates and its "never a
// member directory" rule stay as they are. An empty picker says that only people
// who can read this space appear, and a poster who already manages the space's
// members (staff, private space: the space card's Manage members gate) is offered
// that existing control, opened over the thread so a typed reply survives.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { MentionPicker } from "../src/features/messaging/ChannelControls.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";

const t = (key, vars) => translate("en", key, vars);
const WHO = "Only people who can read this space appear here.";
// For a caller without a staff role the server also
// requires a post in the space or a roster steward seat, so the copy says so.
// The read requirement covers stewards too, as in
// list_channel_mention_candidates, so the sentence states it once for both.
// Round 3: the caller is never listed and a deleted post does not count, so
// it says "other people" and "with a post in it".
const WHO_MEMBER = "Only other people who can read this space appear here: those with a post in it, and campaign committee members.";

afterEach(cleanup);

describe("the mention picker with nobody to offer", () => {
  it("describes the narrower list a member gets", async () => {
    render(<MentionPicker t={t} api={{ mentionCandidates: vi.fn().mockResolvedValue([]) }} spaceId="s1" onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(await screen.findByRole("status")).toHaveTextContent(WHO_MEMBER);
  });

  it("says who appears, and with a search also that nobody matches, without offering to add people", async () => {
    render(<MentionPicker t={t} api={{ mentionCandidates: vi.fn().mockResolvedValue([]) }} spaceId="s1" onPick={vi.fn()} staffScope />);
    fireEvent.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(await screen.findByRole("status")).toHaveTextContent(WHO);
    expect(screen.getByRole("status")).not.toHaveTextContent("No one in this channel matches.");
    fireEvent.change(screen.getByLabelText("Find a person to mention"), { target: { value: "Teo" } });
    expect(await screen.findByText(`No one in this channel matches. ${WHO}`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add people to the space" })).toBeNull();
  });

  it("offers Add people to the space only when given a way in, and closes itself on the way", async () => {
    const onAddPeople = vi.fn();
    render(<MentionPicker t={t} api={{ mentionCandidates: vi.fn().mockResolvedValue([]) }} spaceId="s1" onPick={vi.fn()} onAddPeople={onAddPeople} staffScope />);
    fireEvent.click(screen.getByRole("button", { name: "Mention someone" }));
    const add = await screen.findByRole("button", { name: "Add people to the space" });
    // A search miss is not a membership problem, so the offer steps aside.
    fireEvent.change(screen.getByLabelText("Find a person to mention"), { target: { value: "ivera" } });
    expect(await screen.findByText(`No one in this channel matches. ${WHO}`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add people to the space" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Find a person to mention"), { target: { value: "" } });
    fireEvent.click(await screen.findByRole("button", { name: "Add people to the space" }));
    expect(add).toBeDefined();
    expect(onAddPeople).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Find a person to mention")).toBeNull();
  });

  it("never offers it while someone can be mentioned", async () => {
    render(<MentionPicker t={t} api={{ mentionCandidates: vi.fn().mockResolvedValue([{ id: "u1", name: "Ana Diaz", initials: "AD" }]) }} spaceId="s1" onPick={vi.fn()} onAddPeople={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(await screen.findByRole("button", { name: "Mention Ana Diaz" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add people to the space" })).toBeNull();
  });

  it("says it in Spanish", () => {
    expect(translate("es", "channelControls.mentionWhoAppears")).toBe("Aquí solo aparecen las personas que pueden leer este espacio.");
    expect(translate("es", "channelControls.mentionAddPeople")).toBe("Agregar personas al espacio");
    expect(translate("es", "channelControls.mentionWhoAppearsMember")).toBe("Aquí solo aparecen otras personas que pueden leer este espacio: quienes tienen una publicación en él y los miembros del comité de la campaña.");
  });
});

describe("the chapter hub thread", () => {
  const thread = { id: "thread-1", title: "Night crew seniority", kind: "issue", status: "open", space_id: "space-1", posts: [] };
  function hub({ roles, visibility }) {
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_my_channel_controls") return { data: { available: true, organizationId: "org", switches: { mentions: true }, spaces: {} }, error: null };
      if (name === "list_channel_mention_candidates") return { data: [], error: null };
      return { data: null, error: null };
    }) };
    const onListSpaceMembers = vi.fn().mockResolvedValue([{ userId: "user-1", fullName: "Shanice Odum", initials: "SO", role: "creator" }]);
    const data = {
      member: { id: "user-1", initials: "SO", fullName: "Shanice Odum", organizationId: "org", chapterId: "ch" },
      roles, conversations: [], broadcasts: [],
      product: { spaces: [{ id: "space-1", name: "Night crew", description: "", visibility, threads: [thread] }], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] },
    };
    render(<LanguageProvider lang="en"><ProductHubView data={data} onSendPost={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} channelControlsClient={client} onListSpaceMembers={onListSpaceMembers} onSearchSpaceMembers={vi.fn().mockResolvedValue([])} onSetSpaceMember={vi.fn()} /></LanguageProvider>);
    return onListSpaceMembers;
  }
  async function openEmptyPicker(who = WHO) {
    fireEvent.click(screen.getByRole("button", { name: /Night crew seniority/ }));
    const dialog = await screen.findByRole("dialog", { name: "Night crew seniority" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reply" }), { target: { value: "Draft for Teo" } });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Mention someone" }));
    expect(await within(dialog).findByRole("status")).toHaveTextContent(who);
    return dialog;
  }

  it("opens the space's existing members control over the thread for staff in a private space, keeping the reply", async () => {
    const onListSpaceMembers = hub({ roles: ["steward"], visibility: "private" });
    const dialog = await openEmptyPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add people to the space" }));
    const members = await screen.findByRole("dialog", { name: "Night crew" });
    expect(onListSpaceMembers).toHaveBeenCalledWith("space-1");
    fireEvent.click(within(members).getByRole("button", { name: "Close" }));
    const back = await screen.findByRole("dialog", { name: "Night crew seniority" });
    expect(within(back).getByRole("textbox", { name: "Reply" })).toHaveValue("Draft for Teo");
    // The caret goes back to the reply being written, not to the page body.
    await waitFor(() => expect(within(back).getByRole("textbox", { name: "Reply" })).toHaveFocus());
  });

  it.each([
    ["a member in a private space", ["member"], "private"],
    ["staff in a chapter-wide space", ["steward"], "chapter"],
  ])("offers nothing to add for %s", async (_label, roles, visibility) => {
    hub({ roles, visibility });
    const dialog = await openEmptyPicker(roles.includes("steward") ? WHO : WHO_MEMBER);
    expect(within(dialog).queryByRole("button", { name: "Add people to the space" })).toBeNull();
  });
});
