import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnouncementReaderSession, AnnouncementSettingsSession, PlatformAnnouncements } from "../src/features/platformAnnouncements/PlatformAnnouncements.jsx";
import { PlatformAnnouncementPublisher } from "../src/features/platformAnnouncements/PlatformAnnouncementPublisher.jsx";
import { announcementScope, createAnnouncementApi } from "../src/features/platformAnnouncements/api.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const item = { id:"delivery-a", announcementId:"post-a", revision:1, title:"Product update", body:"<img src=x onerror=alert(1)> https://example.test", publishedAt:"2026-10-29T14:00:00-04:00", expiresAt:"2099-10-29T14:00:00-04:00" };
const feed = (extra = {}) => ({ items:[item], generation:1, hidden:false, ...extra });
const denied = () => Promise.reject(Object.assign(new Error("unavailable"),{denied:true}));
const api = (extra = {}) => ({ feed:vi.fn().mockResolvedValue(feed()), settings:vi.fn(denied), preference:vi.fn().mockResolvedValue({hidden:true}), ...extra });
const session = (id = "session-a", user = "member-a") => ({ user:{id:user}, access_token:`header.${btoa(JSON.stringify({session_id:id}))}.signature` });

describe("private platform announcement consumers", () => {
  it("renders a distinct text-only source without messaging, tracking or link actions", async () => {
    const transport = api();
    const { container } = render(<AnnouncementReaderSession api={transport} locale="en" />);
    expect(await screen.findByText(item.body)).toBeInTheDocument();
    expect(container.querySelector("article")).toHaveAttribute("data-source-type","platform-announcement");
    expect(container.querySelector("img,a,textarea")).toBeNull();
    expect(screen.queryByRole("button",{name:/reply|reaction|task|save message/i})).toBeNull();
    expect(container.firstChild).toHaveClass("ph-no-capture");
  });
  it("keeps personal hiding reversible and presents Spanish consumer copy", async () => {
    const transport = api({ feed:vi.fn().mockResolvedValueOnce(feed()).mockResolvedValueOnce(feed({items:[],hidden:true})).mockResolvedValue(feed()) });
    render(<AnnouncementReaderSession api={transport} locale="es" />);
    await screen.findByText(item.title);
    fireEvent.click(screen.getByRole("button",{name:"Ocultar estas novedades"}));
    expect(await screen.findByText("Has ocultado las novedades del producto.")).toBeInTheDocument();
    expect(screen.queryByText(item.body)).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Mostrar estas novedades"}));
    await screen.findByText(item.title);
    expect(transport.preference.mock.calls).toEqual([[true],[false]]);
    expect(transport.feed).toHaveBeenCalledWith("es",null);
  });
  it("clears on blur and failed authorization refresh, without rendering error payloads", async () => {
    const transport = api();
    render(<AnnouncementReaderSession api={transport} locale="en" />);
    await screen.findByText(item.title);
    fireEvent(window,new Event("blur"));
    expect(screen.queryByText(item.title)).toBeNull();
    transport.feed.mockRejectedValueOnce(new Error("secret body and recipient"));
    fireEvent(window,new Event("focus"));
    await screen.findByText("Updates are unavailable. Refresh to try again.");
    expect(screen.queryByText(/secret body/)).toBeNull();
  });
  it.each([
    ["en", "Updates are hidden while this window is in the background."],
    ["es", "Las novedades se ocultan mientras esta ventana está en segundo plano."],
  ])("identifies the privacy clear and restores updates on focus (%s)", async (locale, notice) => {
    render(<AnnouncementReaderSession api={api()} locale={locale} />);
    await screen.findByText(item.title);
    fireEvent(window, new Event("blur"));
    expect(screen.getByRole("status")).toHaveTextContent(notice);
    expect(screen.queryByText(item.title)).toBeNull();
    fireEvent(window, new Event("focus"));
    await screen.findByText(item.title);
    expect(screen.queryByText(notice)).toBeNull();
  });
  it("expires cached content without a polling loop", async () => {
    vi.useFakeTimers();
    const transport = api();
    render(<AnnouncementReaderSession api={transport} locale="en" />);
    await act(async () => {});
    expect(screen.getByText(item.title)).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(30_001); });
    expect(screen.queryByText(item.title)).toBeNull();
    expect(transport.feed).toHaveBeenCalledTimes(1);
  });
  it("drops an old session's delayed result when the workspace changes", async () => {
    let finish;
    const oldClient = { rpc:vi.fn().mockImplementation(() => new Promise(resolve => { finish=resolve; })) };
    const nextClient = { rpc:vi.fn().mockResolvedValue({data:feed({items:[{...item,title:"Next workspace"}]}),error:null}) };
    const makeClient = vi.fn().mockReturnValueOnce(oldClient).mockReturnValue(nextClient);
    const context = {session:session(),organizationId:"org-a",chapterId:"a",hat:"member",createClient:makeClient};
    const result = render(<PlatformAnnouncements context={context} />);
    result.rerender(<PlatformAnnouncements context={{...context,organizationId:"org-b",chapterId:"b"}} />);
    await screen.findByText("Next workspace");
    await act(async () => { finish({data:feed(),error:null}); });
    expect(screen.queryByText(item.title)).toBeNull();
  });
  it("keys every tenant, user, session, chapter, hat and language boundary", () => {
    const base={session:session(),organizationId:"org-a",chapterId:"a",hat:"member",locale:"en"};
    const key=announcementScope(base);
    for(const change of [{organizationId:"b"},{chapterId:"b"},{hat:"admin"},{locale:"es"},{session:session("session-b")},{session:session("session-a","other-member")}]) expect(announcementScope({...base,...change})).not.toBe(key);
    expect(announcementScope({...base,session:null})).toBeNull();
  });
  it("records consent with the displayed token and confirms organization-wide revoke", async () => {
    const transport=api({ settings:vi.fn().mockResolvedValue({enabled:false,generation:0}), workspace:vi.fn(denied),
      follow:vi.fn().mockResolvedValueOnce({enabled:true,generation:1}).mockResolvedValue({enabled:false,generation:2}) });
    render(<AnnouncementSettingsSession api={transport} locale="en" />);
    fireEvent.click(await screen.findByRole("button",{name:"Follow product updates"}));
    fireEvent.click(await screen.findByRole("button",{name:"Stop following"}));
    expect(transport.follow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button",{name:"Stop following for everyone"}));
    await screen.findByRole("button",{name:"Follow product updates"});
    expect(transport.follow.mock.calls).toEqual([[true,0],[false,1]]);
  });
  it("refreshes consent after a conflict rather than resending a stale enable", async () => {
    const transport=api({ settings:vi.fn().mockResolvedValueOnce({enabled:false,generation:0}).mockResolvedValue({enabled:false,generation:2}), workspace:vi.fn(denied), follow:vi.fn().mockRejectedValue(new Error("conflict")) });
    render(<AnnouncementSettingsSession api={transport} locale="en" />);
    fireEvent.click(await screen.findByRole("button",{name:"Follow product updates"}));
    await screen.findByRole("alert");
    expect(transport.follow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button",{name:"Follow product updates"}));
    await waitFor(()=>expect(transport.follow).toHaveBeenLastCalledWith(true,2));
  });
  it("binds every client RPC to the expected organization and strips unapproved feed fields", async () => {
    const client={rpc:vi.fn().mockResolvedValue({data:feed({items:[{...item,memberList:["forbidden"],reads:12}]}),error:null})};
    const result=await createAnnouncementApi(client,"org-a").feed("es");
    expect(client.rpc).toHaveBeenCalledWith("platform_announcement_request",expect.objectContaining({p_organization_id:"org-a",p_action:"list_my_platform_announcements",p_args:expect.objectContaining({p_locale:"es",p_limit:20})}));
    expect(result.items[0]).not.toHaveProperty("memberList"); expect(result.items[0]).not.toHaveProperty("reads");
  });
  it("keeps publisher post, audit and organization-status pages bounded and separate", async () => {
    const initial={posts:[],audit:[],hasMorePosts:true,nextPostId:"older-post",hasMoreAudit:true,nextAuditBefore:"45"};
    const transport={workspace:vi.fn().mockResolvedValue(initial),followers:vi.fn().mockResolvedValue({items:[{organizationId:"a",name:"Fictional follower",status:"active"}]})};
    render(<PlatformAnnouncementPublisher api={transport} locale="es" initial={initial} />);
    fireEvent.click(screen.getByRole("button",{name:"Más publicaciones"}));
    await waitFor(()=>expect(transport.workspace).toHaveBeenCalledWith("older-post",null));
    fireEvent.click(screen.getByRole("button",{name:"Eventos anteriores"}));
    await waitFor(()=>expect(transport.workspace).toHaveBeenCalledWith("older-post","45"));
    expect(screen.getByRole("textbox",{name:"Título en español"})).toHaveAttribute("maxLength","120");
  });
  it("requires editorial review before the publisher can publish and withdraw", async () => {
    let state="draft";
    const workspace=()=>({posts:[{id:"post",revision:1,title_en:"Release",title_es:"Novedad",body_en:"Product content",body_es:"Novedades",state,expires_at:item.expiresAt}],audit:[]});
    const transport={workspace:vi.fn().mockImplementation(async()=>workspace()),transition:vi.fn().mockImplementation(async action=>{state=({review:"reviewed",publish:"published",withdraw:"withdrawn"})[action];}),followers:vi.fn()};
    render(<PlatformAnnouncementPublisher api={transport} locale="en" initial={workspace()} />);
    expect(screen.getByRole("button",{name:"Review"})).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(screen.getByRole("button",{name:"Review"}));
    fireEvent.click(await screen.findByRole("button",{name:"Publish"}));
    await screen.findByText("Published");fireEvent.click(screen.getByRole("button",{name:"Withdraw"}));
    await screen.findByText("Withdrawn");
    expect(transport.transition.mock.calls).toEqual([["review","post",1],["publish","post",1],["withdraw","post",1]]);
    expect(transport.followers).not.toHaveBeenCalled();
  });
});

// Record 8435: the publisher's controls stay focusable while its write runs.
describe("announcement publisher keeps focus while it writes", () => {
  it("keeps Review focused while the post is reviewed, and reviews it once", async () => {
    const initial = { posts: [{ id: "post", revision: 1, title_en: "Release", title_es: "Novedad", body_en: "Product content", body_es: "Novedades", state: "draft", expires_at: "2026-12-31T12:00:00.000Z" }], audit: [] };
    const transport = { workspace: vi.fn().mockResolvedValue(initial), transition: vi.fn(async () => {}), followers: vi.fn() };
    render(<PlatformAnnouncementPublisher api={transport} locale="en" initial={initial} />);
    fireEvent.click(screen.getByRole("checkbox"));
    await expectHeldWriteFocus(transport.transition, screen.getByRole("button", { name: "Review" }));
    expect(transport.transition).toHaveBeenCalledTimes(1);
  });

  it("edits, saves, corrects, refreshes and pages, reporting a refused save", async () => {
    const draft = { id: "post", revision: 2, title_en: "Release", title_es: "Novedad", body_en: "Product content", body_es: "Novedades", state: "draft", expires_at: "2026-12-31T12:00:00.000Z", supersedes_id: null };
    const published = { ...draft, id: "live", revision: 1, state: "published", title_en: "Live update" };
    const initial = { posts: [draft, published], audit: [], hasMorePosts: true, nextPostId: "older", hasMoreAudit: false };
    const rows = Array.from({ length: 20 }, (_, i) => ({ organizationId: `org-${i}`, name: `Fictional org ${i}`, status: i % 2 ? "active" : "revoked" }));
    const transport = {
      workspace: vi.fn().mockResolvedValue(initial),
      save: vi.fn().mockResolvedValueOnce({ id: "post", revision: 3 }).mockRejectedValueOnce(new Error("refused")),
      transition: vi.fn(),
      followers: vi.fn().mockResolvedValueOnce({ items: rows }).mockResolvedValueOnce({ items: rows.slice(0, 1) }),
    };
    render(<PlatformAnnouncementPublisher api={transport} locale="en" initial={initial} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit draft" })[0]);
    expect(screen.getByRole("textbox", { name: "English title" })).toHaveValue("Release");
    fireEvent.change(screen.getByRole("textbox", { name: "English title" }), { target: { value: "Release notes" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Spanish title" }), { target: { value: "Notas" } });
    fireEvent.change(screen.getByRole("textbox", { name: "English body" }), { target: { value: "Body" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Spanish body" }), { target: { value: "Cuerpo" } });
    fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "2026-12-30T10:00" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save draft" }).closest("form"));
    await waitFor(() => expect(transport.save).toHaveBeenCalledWith(expect.objectContaining({ p_id: "post", p_expected_revision: 2, p_title_en: "Release notes" })));
    await waitFor(() => expect(transport.workspace).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Create correction" }));
    expect(screen.getByRole("textbox", { name: "English title" })).toHaveValue("Live update");
    fireEvent.submit(screen.getByRole("button", { name: "Save draft" }).closest("form"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(transport.save).toHaveBeenLastCalledWith(expect.objectContaining({ p_id: null, p_supersedes_id: "live" }));
    fireEvent.click(screen.getByRole("button", { name: "New update" }));
    expect(screen.getByRole("textbox", { name: "English title" })).toHaveValue("");
    fireEvent.click(await screen.findByRole("button", { name: "More posts" }));
    await waitFor(() => expect(transport.workspace).toHaveBeenCalledWith("older", null));
    fireEvent.click(await screen.findByRole("button", { name: "Newest updates" }));
    await waitFor(() => expect(transport.workspace).toHaveBeenCalledWith(null, null));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh updates" }));
    expect(await screen.findByText(/Fictional org 0 · Not following/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More organizations" }));
    await waitFor(() => expect(transport.followers).toHaveBeenLastCalledWith("org-19"));
  });
});

// Record 8435, slice 7: platform update writes keep focus under pending and
// send once from one tick; the reader's own preference mark outlives a feed
// reset, so Hide never reads ready while it would refuse.
describe("platform update writes while they run (record 8435)", () => {
  it("hides once when Hide these updates is activated twice in one tick", async () => {
    const transport = api();
    render(<AnnouncementReaderSession api={transport} locale="en" />);
    // The feed's first read must answer first: Hide reads pending while it loads.
    await screen.findByText(item.title);
    const hide = screen.getByRole("button", { name: "Hide these updates" });
    await act(async () => { fireEvent.click(hide); fireEvent.click(hide); });
    expect(transport.preference).toHaveBeenCalledTimes(1);
  });

  it("keeps Hide pending through a blur while the preference is still saving, and refuses it", async () => {
    let release;
    const transport = api({ preference: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    render(<AnnouncementReaderSession api={transport} locale="en" />);
    await screen.findByText(item.title);
    fireEvent.click(screen.getByRole("button", { name: "Hide these updates" }));
    fireEvent(window, new Event("blur"));
    expect(screen.queryByText(item.title)).toBeNull();
    const hide = screen.getByRole("button", { name: "Hide these updates" });
    expect(hide).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(hide);
    expect(transport.preference).toHaveBeenCalledTimes(1);
    await act(async () => { release({ hidden: true }); });
    await waitFor(() => expect(screen.getAllByRole("button")[1]).not.toHaveAttribute("aria-disabled", "true"));
  });

  it("hides one update for the organization when its button is activated twice in one tick", async () => {
    const transport = api({ settings: vi.fn().mockResolvedValue({ enabled: true, generation: 0 }), hideLocal: vi.fn(async () => {}) });
    render(<AnnouncementReaderSession api={transport} locale="en" />);
    const hide = await screen.findByRole("button", { name: "Hide for this organization" });
    await act(async () => { fireEvent.click(hide); fireEvent.click(hide); });
    expect(transport.hideLocal).toHaveBeenCalledTimes(1);
  });

  it("follows once when Follow product updates is activated twice in one tick, keeping it focused", async () => {
    const transport = api({ settings: vi.fn().mockResolvedValue({ enabled: false, generation: 0 }), workspace: vi.fn(denied), follow: vi.fn(async () => ({ enabled: true, generation: 1 })) });
    render(<AnnouncementSettingsSession api={transport} locale="en" />);
    const follow = await screen.findByRole("button", { name: "Follow product updates" });
    await act(async () => { fireEvent.click(follow); fireEvent.click(follow); });
    expect(transport.follow).toHaveBeenCalledTimes(1);
    cleanup();
    const again = api({ settings: vi.fn().mockResolvedValue({ enabled: false, generation: 0 }), workspace: vi.fn(denied), follow: vi.fn(async () => ({ enabled: true, generation: 1 })) });
    render(<AnnouncementSettingsSession api={again} locale="en" />);
    await expectHeldWriteFocus(again.follow, await screen.findByRole("button", { name: "Follow product updates" }));
  });
});

// #8984 review P1 (record 8435): an update shown again by a refresh while its
// organization hide is still running reads pending, as its lock holds; once
// that hide settles it reads ready and sends.
it("keeps a re-shown update's Hide for this organization pending while its first hide runs, then sends", async () => {
  const releases = [];
  const transport = api({ settings: vi.fn().mockResolvedValue({ enabled: true, generation: 0 }), hideLocal: vi.fn(() => new Promise((resolve) => releases.push(resolve))) });
  render(<AnnouncementReaderSession api={transport} locale="en" />);
  fireEvent.click(await screen.findByRole("button", { name: "Hide for this organization" }));
  expect(transport.hideLocal).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(item.title)).toBeNull();
  fireEvent(window, new Event("focus"));
  const again = await screen.findByRole("button", { name: "Hide for this organization" });
  expect(again).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(again);
  expect(transport.hideLocal).toHaveBeenCalledTimes(1);
  await act(async () => { releases[0](); });
  const ready = await screen.findByRole("button", { name: "Hide for this organization" });
  await waitFor(() => expect(ready).not.toHaveAttribute("aria-disabled", "true"));
  fireEvent.click(ready);
  expect(transport.hideLocal).toHaveBeenCalledTimes(2);
  await act(async () => { releases[1]?.(); });
});

// #8984 delta review P1 (record 8435): an organization hide that settles after
// its reader left (an unmount, another organization) reads nothing more for
// the organization left; one that settles in the same reader still refreshes.
describe("an organization hide answering late (record 8435)", () => {
  const admin = (extra = {}) => api({ settings: vi.fn().mockResolvedValue({ enabled: true, generation: 0 }), ...extra });

  it("refreshes the same reader's feed once when its hide settles", async () => {
    let release;
    const transport = admin({ hideLocal: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    render(<AnnouncementReaderSession api={transport} locale="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Hide for this organization" }));
    const reads = transport.feed.mock.calls.length;
    await act(async () => { release(); });
    await waitFor(() => expect(transport.feed).toHaveBeenCalledTimes(reads + 1));
  });

  it("reads nothing more when its hide settles after the reader unmounted", async () => {
    let release;
    const transport = admin({ hideLocal: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    const view = render(<AnnouncementReaderSession api={transport} locale="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Hide for this organization" }));
    view.unmount();
    const reads = transport.feed.mock.calls.length;
    await act(async () => { release(); });
    expect(transport.feed).toHaveBeenCalledTimes(reads);
  });

  it("reads nothing more for the organization left when its hide settles after a switch", async () => {
    let release;
    const action = (args) => args.p_action;
    const answer = (data) => Promise.resolve({ data, error: null });
    const oldClient = { rpc: vi.fn((_name, args) => {
      if (action(args) === "hide_organization_platform_announcement") return new Promise((resolve) => { release = () => resolve({ data: {}, error: null }); });
      if (action(args) === "get_platform_announcement_follow_settings") return answer({ enabled: true, generation: 0 });
      return answer(feed());
    }) };
    const nextClient = { rpc: vi.fn((_name, args) => answer(action(args) === "list_my_platform_announcements" ? feed({ items: [{ ...item, title: "Next workspace" }] }) : { enabled: true, generation: 0 })) };
    const makeClient = vi.fn().mockReturnValueOnce(oldClient).mockReturnValue(nextClient);
    const context = { session: session(), organizationId: "org-a", chapterId: "a", hat: "admin", createClient: makeClient };
    const view = render(<PlatformAnnouncements context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: "Hide for this organization" }));
    view.rerender(<PlatformAnnouncements context={{ ...context, organizationId: "org-b", chapterId: "b" }} />);
    await screen.findByText("Next workspace");
    const oldReads = () => oldClient.rpc.mock.calls.filter(([, args]) => action(args) === "list_my_platform_announcements").length;
    const before = oldReads();
    await act(async () => { release(); });
    expect(oldReads()).toBe(before);
  });

  it("reads nothing more when a personal Hide settles after the reader unmounted", async () => {
    let release;
    const transport = api({ preference: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    const view = render(<AnnouncementReaderSession api={transport} locale="en" />);
    await screen.findByText(item.title);
    fireEvent.click(screen.getByRole("button", { name: "Hide these updates" }));
    view.unmount();
    const reads = transport.feed.mock.calls.length;
    await act(async () => { release({ hidden: true }); });
    expect(transport.feed).toHaveBeenCalledTimes(reads);
  });

  it("reloads nothing when a refused Follow settles after the settings panel unmounted", async () => {
    let refuse;
    const transport = api({ settings: vi.fn().mockResolvedValue({ enabled: false, generation: 0 }), workspace: vi.fn(denied), follow: vi.fn(() => new Promise((_resolve, reject) => { refuse = () => reject(new Error("conflict")); })) });
    const view = render(<AnnouncementSettingsSession api={transport} locale="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Follow product updates" }));
    view.unmount();
    const reads = transport.settings.mock.calls.length;
    await act(async () => { refuse(); });
    expect(transport.settings).toHaveBeenCalledTimes(reads);
  });
});

// #8984 delta review 2 P1 (record 8435): a same-login token renewal builds a
// new api but keeps the reader mounted, so a hide that settles after it still
// reports its refusal and refreshes.
it("still reports a refused organization hide and refreshes after a same-session token renewal", async () => {
  let refuse;
  const action = (args) => args.p_action;
  const reads = [];
  const clientFor = (label) => ({ rpc: vi.fn((_name, args) => {
    if (action(args) === "hide_organization_platform_announcement") return new Promise((resolve) => { refuse = () => resolve({ data: null, error: { code: "500" } }); });
    if (action(args) === "get_platform_announcement_follow_settings") return Promise.resolve({ data: { enabled: true, generation: 0 }, error: null });
    if (action(args) === "list_my_platform_announcements") reads.push(label);
    return Promise.resolve({ data: feed(), error: null });
  }) });
  const makeClient = vi.fn().mockReturnValueOnce(clientFor("first")).mockReturnValue(clientFor("renewed"));
  const first = session();
  const renewed = { ...first, access_token: `${first.access_token}-renewed` };
  const context = { session: first, organizationId: "org-a", chapterId: "a", hat: "admin", createClient: makeClient };
  const view = render(<PlatformAnnouncements context={context} />);
  fireEvent.click(await screen.findByRole("button", { name: "Hide for this organization" }));
  view.rerender(<PlatformAnnouncements context={{ ...context, session: renewed }} />);
  expect(makeClient).toHaveBeenCalledTimes(2);
  const before = reads.length;
  await act(async () => { refuse(); });
  await waitFor(() => expect(reads.length).toBe(before + 1));
  // Record #9465 (W7-26): a refused hide says the choice was not saved, not that updates are unavailable.
  expect(screen.getByRole("alert")).toHaveTextContent("Your choice was not saved. Try again.");
  expect(screen.getByRole("status")).not.toHaveTextContent("Updates are unavailable.");
});

// Record #9469: a failed Follow re-reads only the settings, so the publisher
// stays mounted with its unsaved draft, and the line says the choice was not
// saved rather than that updates are unavailable.
describe("a failed follow keeps the publisher draft (#9469)", () => {
  const initial = { posts: [], audit: [], hasMorePosts: false, nextPostId: null, hasMoreAudit: false, nextAuditBefore: null };
  it.each([
    ["the settings re-read answers", { enabled: false, generation: 2 }],
  ])("keeps the typed draft when %s", async (_name, reread) => {
    const settings = vi.fn().mockResolvedValueOnce({ enabled: false, generation: 0 });
    settings.mockResolvedValue(reread);
    const transport = api({ settings, workspace: vi.fn().mockResolvedValue(initial), follow: vi.fn().mockRejectedValue(new Error("offline")) });
    render(<AnnouncementSettingsSession api={transport} locale="en" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "English title" }), { target: { value: "Unsent update" } });
    fireEvent.click(screen.getByRole("button", { name: "Follow product updates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your choice was not saved. Try again.");
    expect(screen.queryByText("Updates are unavailable. Refresh to try again.")).toBeNull();
    expect(screen.getByRole("textbox", { name: "English title" })).toHaveValue("Unsent update");
    expect(transport.workspace).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Follow product updates" })).toBeInTheDocument();
  });
  // A lost answer is not a refusal: the re-read decides the line.
  function lostAnswer(reads, locale = "en") {
    const settings = vi.fn().mockResolvedValueOnce({ enabled: false, generation: 0 });
    for (const read of reads) if (read) settings.mockResolvedValueOnce(read); else settings.mockRejectedValueOnce(new Error("offline"));
    const transport = api({ settings, workspace: vi.fn().mockResolvedValue(initial), follow: vi.fn().mockRejectedValue(new Error("offline")) });
    render(<AnnouncementSettingsSession api={transport} locale={locale} />);
    return transport;
  }
  const following = { enabled: true, generation: 1 };
  it("says saved when the re-read shows the new choice", async () => {
    lostAnswer([following]);
    fireEvent.click(await screen.findByRole("button", { name: "Follow product updates" }));
    expect(await screen.findByText("Preference saved.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop following" })).toBeInTheDocument();
  });
  it("holds the control when the re-read fails too, and checks before the next follow", async () => {
    const transport = lostAnswer([null, null, following]);
    fireEvent.change(await screen.findByRole("textbox", { name: "English title" }), { target: { value: "Unsent update" } });
    fireEvent.click(screen.getByRole("button", { name: "Follow product updates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We could not confirm whether your choice was saved.");
    expect(screen.queryByRole("button", { name: "Follow product updates" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check follow status" }));
    await waitFor(() => expect(transport.settings).toHaveBeenCalledTimes(3));
    fireEvent.click(await screen.findByRole("button", { name: "Check follow status" }));
    expect(await screen.findByText("Your organization is following product updates.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop following" })).toBeInTheDocument();
    expect(transport.follow).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "English title" })).toHaveValue("Unsent update");
  });
  it("says the choice could not be confirmed in Spanish", async () => {
    lostAnswer([null], "es");
    fireEvent.click(await screen.findByRole("button", { name: "Seguir las novedades del producto" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos confirmar si se guardó tu elección.");
    expect(screen.getByRole("button", { name: "Revisar el estado de seguimiento" })).toBeInTheDocument();
  });
  it("drops a settings re-read that answers after the session changed", async () => {
    let answer;
    const settings = vi.fn().mockResolvedValueOnce({ enabled: false, generation: 0 }).mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const transport = api({ settings, workspace: vi.fn().mockResolvedValue(initial), follow: vi.fn().mockRejectedValue(new Error("offline")) });
    const view = render(<AnnouncementSettingsSession api={transport} locale="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Follow product updates" }));
    await waitFor(() => expect(settings).toHaveBeenCalledTimes(2));
    const next = api({ settings: vi.fn().mockResolvedValue({ enabled: true, generation: 5 }), workspace: vi.fn().mockResolvedValue(initial) });
    view.rerender(<AnnouncementSettingsSession api={next} locale="en" />);
    expect(await screen.findByRole("button", { name: "Stop following" })).toBeInTheDocument();
    await act(async () => { answer({ enabled: false, generation: 1 }); });
    expect(screen.getByRole("button", { name: "Stop following" })).toBeInTheDocument();
    expect(screen.queryByText("Your choice was not saved. Try again.")).toBeNull();
  });
  it("leaves a follow failure that lands after the session changed to the new session", async () => {
    let reject;
    const settings = vi.fn().mockResolvedValue({ enabled: false, generation: 0 });
    const transport = api({ settings, workspace: vi.fn().mockResolvedValue(initial), follow: vi.fn(() => new Promise((_, fail) => { reject = fail; })) });
    const view = render(<AnnouncementSettingsSession api={transport} locale="en" />);
    fireEvent.click(await screen.findByRole("button", { name: "Follow product updates" }));
    const next = api({ settings: vi.fn().mockResolvedValue({ enabled: false, generation: 5 }), workspace: vi.fn().mockResolvedValue(initial) });
    view.rerender(<AnnouncementSettingsSession api={next} locale="en" />);
    await waitFor(() => expect(next.settings).toHaveBeenCalledTimes(1));
    await act(async () => { reject(new Error("offline")); });
    expect(settings).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Your choice was not saved. Try again.")).toBeNull();
  });
});
