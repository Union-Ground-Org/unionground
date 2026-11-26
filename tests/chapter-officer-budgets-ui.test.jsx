import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChapterBudgetPanel } from "../src/components/ChapterBudgetPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { loadChapterBudgets, saveChapterBudget } from "../src/lib/memberApi.js";
import { expectHeldWriteFocus, expectPendingFocus } from "./helpers/busyWriteFocus.js";
const scope = {organizationId:"org-a",chapterId:"chapter-a"};
const budget = {id:"budget-1",revision:1,title:"October budget",period_start:"2026-10-01",period_end:"2026-10-31",notes:"Committee notes",items:[{name:"Room",planned:125.25,actual:99.50}]};
function clientFor(access={canRead:true,canAssign:false,members:[]}, rows=[budget]) {
  return {rpc:vi.fn(async (name) => {
    if (name === "get_chapter_budget_access") return {data:access,error:null};
    if (name === "list_chapter_budgets") return {data:rows,error:null};
    return {data:{saved:true},error:null};
  })};
}
function panel(client,lang="en",bound=scope) {
  return <LanguageProvider lang={lang}><ChapterBudgetPanel key={`${bound.identityId || "member-a"}:${bound.organizationId}:${bound.chapterId}`} client={client} scope={bound} /></LanguageProvider>;
}
describe("chapter budgets", () => {
  it("hides Treasurer authority under Member while retaining explicit legacy budget delegation", async () => {
    const client=clientFor({canRead:true,canAssign:true,legacyRead:false,members:[]});
    const view=render(<LanguageProvider lang="en"><ChapterBudgetPanel client={client} scope={scope} canAuthor={false}/></LanguageProvider>);
    await waitFor(()=>expect(view.container).toBeEmptyDOMElement());
    expect(client.rpc.mock.calls.map(([name])=>name)).toEqual(["get_chapter_budget_access"]);
    view.rerender(<LanguageProvider lang="en"><ChapterBudgetPanel client={client} scope={scope} canAuthor/></LanguageProvider>);
    expect(await screen.findByText("October budget")).toBeInTheDocument();
    view.unmount();
    const delegated=clientFor({canRead:true,canAssign:false,legacyRead:true,members:[]});
    render(<LanguageProvider lang="en"><ChapterBudgetPanel client={delegated} scope={scope} canAuthor={false}/></LanguageProvider>);
    expect(await screen.findByText("October budget")).toBeInTheDocument();
  });
  it("hides the budget surface and never reads finances for a non-officer", async () => {
    const client=clientFor({canRead:false,canAssign:false,members:[]}); render(panel(client));
    await waitFor(()=>expect(screen.queryByRole("region",{name:"Chapter budgets"})).not.toBeInTheDocument());
    expect(client.rpc.mock.calls.map(([name])=>name)).toEqual(["get_chapter_budget_access"]);
  });
  it.each(["PGRST202", "42883"])("hides an unavailable access probe (%s) until the hosted migration lands", async (code) => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code, message: "function unavailable" } }) };
    const view = render(panel(client));
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["get_chapter_budget_access"]);
  });
  it("reports a refused access probe without requesting financial contents", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "step-up required" } }) };
    render(panel(client));
    expect(await screen.findByRole("alert")).toHaveTextContent("Budget access or this change could not be confirmed");
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["get_chapter_budget_access"]);
  });
  it("does not hide a missing-function error from the financial list after a successful probe", async () => {
    const client = clientFor();
    const baseline = client.rpc.getMockImplementation();
    client.rpc.mockImplementation((name, args) => name === "list_chapter_budgets"
      ? { data: null, error: { code: "PGRST202", message: "function unavailable" } } : baseline(name, args));
    render(panel(client));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
  it.each([
    ["en", "$99.50", "$1,250.00"],
    ["es", "99,50 US$", "1250,00 US$"],
  ])("formats USD amounts with cents in %s", async (lang, planned, actual) => {
    render(panel(clientFor(undefined, [{ ...budget, items: [{ name: "Hall", planned: 99.5, actual: 1250 }] }]), lang));
    const line = (await screen.findByText("Hall")).closest("li");
    expect(line).toHaveTextContent(planned);
    expect(line).toHaveTextContent(actual);
  });
  it("shows saved budget contents and Spanish controls", async () => {
    render(panel(clientFor(),"es"));
    expect(await screen.findByText("October budget")).toBeInTheDocument();
    expect(screen.getByText("Committee notes")).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Nuevo presupuesto"})).toBeInTheDocument();
    expect(screen.getByText(/Planificado \(USD\): 125,25/)).toBeInTheDocument();
  });
  it("saves a period, notes and ordered line items through the scope-bound RPC", async () => {
    const client=clientFor(); render(panel(client));
    fireEvent.click(await screen.findByRole("button",{name:"New budget"}));
    fireEvent.change(screen.getByRole("textbox",{name:"Budget name"}),{target:{value:" November "}});
    fireEvent.change(screen.getByLabelText("Period starts"),{target:{value:"2026-11-01"}});
    fireEvent.change(screen.getByLabelText("Period ends"),{target:{value:"2026-11-30"}});
    fireEvent.change(screen.getByRole("textbox",{name:"Notes"}),{target:{value:"Approved plan"}});
    fireEvent.change(screen.getByRole("textbox",{name:"Line item name"}),{target:{value:"Room"}});
    fireEvent.change(screen.getByRole("spinbutton",{name:"Planned (USD)"}),{target:{value:"150.25"}});
    fireEvent.change(screen.getByRole("spinbutton",{name:"Actual (USD)"}),{target:{value:"0"}});
    fireEvent.click(screen.getByRole("button",{name:"Add line item"}));
    const second=screen.getByRole("group",{name:"Line item 2"});
    fireEvent.change(within(second).getByRole("textbox",{name:"Line item name"}),{target:{value:"Postage"}});
    fireEvent.click(screen.getByRole("button",{name:"Save budget"}));
    await waitFor(()=>expect(client.rpc).toHaveBeenCalledWith("save_chapter_budget",expect.objectContaining({p_expected_org:"org-a",p_expected_chapter:"chapter-a",p_id:null,p_revision:0,p_title:"November",p_notes:"Approved plan",p_period_start:"2026-11-01",p_period_end:"2026-11-30",p_items:[{name:"Room",planned:150.25,actual:0},{name:"Postage",planned:0,actual:0}]})));
    await waitFor(()=>expect(screen.queryByRole("form",{name:"Budget editor"})).not.toBeInTheDocument());
  });
  it("disables duplicate submissions and keeps the draft after a stale edit is refused", async () => {
    let resolveWrite; const client=clientFor(); const baseline=client.rpc.getMockImplementation();
    client.rpc.mockImplementation((name,args)=>name === "save_chapter_budget" ? new Promise(resolve=>{resolveWrite=resolve;}) : baseline(name,args));
    render(panel(client)); fireEvent.click(await screen.findByRole("button",{name:"Edit October budget"}));
    fireEvent.change(screen.getByRole("textbox",{name:"Notes"}),{target:{value:"Keep this draft"}});
    fireEvent.click(screen.getByRole("button",{name:"Save budget"}));
    // Unavailable through its busy fieldset, still focusable (#8435).
    expect(screen.getByRole("button",{name:"Save budget"}).closest('[aria-disabled="true"]')).not.toBeNull();
    await act(async ()=>resolveWrite({data:null,error:{code:"PT409",message:"budget conflict"}}));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your draft is kept");
    expect(screen.getByRole("textbox",{name:"Notes"})).toHaveValue("Keep this draft");
    expect(client.rpc.mock.calls.filter(([name])=>name === "save_chapter_budget")).toHaveLength(1);
  });
  it("keeps the complete unsaved draft across a refresh, then clears it on cancel", async () => {
    const client = clientFor(); render(panel(client));
    fireEvent.click(await screen.findByRole("button", { name: "Edit October budget" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Budget name" }), { target: { value: "Unsaved budget" } });
    fireEvent.change(screen.getByLabelText("Period starts"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("Period ends"), { target: { value: "2026-11-30" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "Unsaved notes" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Line item name" }), { target: { value: "Unsaved room" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Planned (USD)" }), { target: { value: "321.45" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Actual (USD)" }), { target: { value: "123.45" } });
    fireEvent.click(screen.getByRole("button", { name: "Add line item" }));
    const second = screen.getByRole("group", { name: "Line item 2" });
    fireEvent.change(within(second).getByRole("textbox", { name: "Line item name" }), { target: { value: "Unsaved postage" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh budgets" }));
    // Refresh removes the read surface while permissions are revalidated.
    expect(screen.queryByRole("form", { name: "Budget editor" })).not.toBeInTheDocument();
    await screen.findByRole("form", { name: "Budget editor" });
    expect(screen.getByRole("textbox", { name: "Budget name" })).toHaveValue("Unsaved budget");
    expect(screen.getByLabelText("Period starts")).toHaveValue("2026-11-01");
    expect(screen.getByLabelText("Period ends")).toHaveValue("2026-11-30");
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("Unsaved notes");
    const first = screen.getByRole("group", { name: "Line item 1" });
    expect(within(first).getByRole("textbox", { name: "Line item name" })).toHaveValue("Unsaved room");
    expect(within(first).getByRole("spinbutton", { name: "Planned (USD)" })).toHaveValue(321.45);
    expect(within(first).getByRole("spinbutton", { name: "Actual (USD)" })).toHaveValue(123.45);
    expect(within(screen.getByRole("group", { name: "Line item 2" })).getByRole("textbox", { name: "Line item name" })).toHaveValue("Unsaved postage");
    expect(client.rpc.mock.calls.filter(([name]) => name === "list_chapter_budgets")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "New budget" }));
    expect(screen.getByRole("textbox", { name: "Budget name" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("");
    expect(screen.getAllByRole("textbox", { name: "Line item name" })).toHaveLength(1);
  });
  it.each([
    ["identity", { ...scope, identityId: "member-b" }],
    ["organization", { ...scope, organizationId: "org-b" }],
    ["chapter", { ...scope, chapterId: "chapter-b" }],
  ])("clears an unsaved draft when the parent changes %s", async (_label, nextScope) => {
    const client = clientFor(); const view = render(panel(client));
    fireEvent.click(await screen.findByRole("button", { name: "Edit October budget" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: "Private draft" } });
    view.rerender(panel(client, "en", nextScope));
    await screen.findByRole("button", { name: "New budget" });
    expect(screen.queryByRole("form", { name: "Budget editor" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit October budget" }));
    expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue("Committee notes");
  });
  it("lets an admin assign and revoke explicit offices without reading budgets", async () => {
    let office=null;
    const client={rpc:vi.fn(async (name,args)=> {
      if (name === "get_chapter_budget_access") return {data:{canRead:false,canAssign:true,members:[{id:"person-1",name:"Sam",office}]},error:null};
      if (name === "set_chapter_budget_office") office=args.p_office;
      return {data:{saved:true},error:null};
    })};
    render(panel(client)); fireEvent.click(await screen.findByText("Budget office access"));
    fireEvent.change(await screen.findByRole("combobox",{name:"Budget office for Sam"}),{target:{value:"secretary_treasurer"}});
    fireEvent.click(screen.getByRole("button",{name:"Save budget office for Sam"}));
    await waitFor(()=>expect(client.rpc).toHaveBeenCalledWith("set_chapter_budget_office",{p_expected_org:"org-a",p_expected_chapter:"chapter-a",p_user_id:"person-1",p_office:"secretary_treasurer"}));
    // Refresh is pending, not disabled, while the save reloads (record 8435, a review note): wait for its busy state to clear.
    await waitFor(()=>{ const refresh=screen.getByRole("button",{name:"Refresh budgets"}); expect(refresh).toBeEnabled(); expect(refresh).not.toHaveAttribute("aria-disabled"); });
    fireEvent.click(screen.getByText("Budget office access"));
    const select=screen.getByRole("combobox",{name:"Budget office for Sam"});
    expect(select).toHaveValue("secretary_treasurer");
    fireEvent.change(select,{target:{value:""}});
    fireEvent.click(screen.getByRole("button",{name:"Save budget office for Sam"}));
    await waitFor(()=>expect(client.rpc).toHaveBeenCalledWith("set_chapter_budget_office",expect.objectContaining({p_user_id:"person-1",p_office:null})));
    expect(client.rpc.mock.calls.some(([name])=>name === "list_chapter_budgets")).toBe(false);
    expect(screen.queryByRole("button",{name:"New budget"})).not.toBeInTheDocument();
  });
  it("uses a twenty-row page and sentinel without leaving older budgets unreachable", async () => {
    const rows=Array.from({length:21},(_,i)=>({...budget,id:`b-${i}`,title:`Budget ${i}`}));
    const client=clientFor(undefined,rows); render(panel(client));
    await screen.findByText("Budget 0"); expect(screen.queryByText("Budget 20")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"Next page"}));
    await waitFor(()=>expect(client.rpc).toHaveBeenCalledWith("list_chapter_budgets",{p_expected_org:"org-a",p_expected_chapter:"chapter-a",p_page:1}));
  });
  it("returns to the first page after creating a budget from a later page", async () => {
    const rows=Array.from({length:21},(_,i)=>({...budget,id:`b-${i}`,title:`Budget ${i}`}));
    const client=clientFor(undefined,rows); render(panel(client));
    await screen.findByText("Budget 0");
    fireEvent.click(screen.getByRole("button",{name:"Next page"}));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Previous page"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button",{name:"New budget"}));
    fireEvent.change(screen.getByRole("textbox",{name:"Budget name"}),{target:{value:"New budget"}});
    fireEvent.change(screen.getByLabelText("Period starts"),{target:{value:"2026-11-01"}});
    fireEvent.change(screen.getByLabelText("Period ends"),{target:{value:"2026-11-30"}});
    fireEvent.change(screen.getByRole("textbox",{name:"Line item name"}),{target:{value:"Room"}});
    client.rpc.mockClear();
    fireEvent.click(screen.getByRole("button",{name:"Save budget"}));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Previous page"})).toBeDisabled());
    await waitFor(()=>expect(client.rpc).toHaveBeenLastCalledWith("list_chapter_budgets",{p_expected_org:"org-a",p_expected_chapter:"chapter-a",p_page:0}));
  });
  it("retires pending financial reads and drafts when the identity scope changes", async () => {
    let resolveOld; const client=clientFor(); const baseline=client.rpc.getMockImplementation();
    client.rpc.mockImplementation((name,args)=>name === "list_chapter_budgets" && args.p_expected_chapter === "chapter-a" ? new Promise(resolve=>{resolveOld=resolve;}) : baseline(name,args));
    const view=render(panel(client)); await waitFor(()=>expect(resolveOld).toBeDefined());
    view.rerender(panel(client,"en",{organizationId:"org-b",chapterId:"chapter-b"}));
    await screen.findByText("October budget");
    await act(async ()=>resolveOld({data:[{...budget,title:"Old tenant financial content"}],error:null}));
    expect(screen.queryByText("Old tenant financial content")).not.toBeInTheDocument();
  });
  it("passes scope and revisions and propagates database read refusals", async () => {
    const client={rpc:vi.fn().mockResolvedValue({data:null,error:{code:"42501",message:"budget office required"}})};
    await expect(loadChapterBudgets(client,scope)).rejects.toMatchObject({code:"42501"});
    client.rpc.mockResolvedValue({data:budget,error:null}); await saveChapterBudget(client,scope,budget);
    expect(client.rpc).toHaveBeenLastCalledWith("save_chapter_budget",expect.objectContaining({p_id:"budget-1",p_revision:1,p_expected_org:"org-a",p_expected_chapter:"chapter-a"}));
  });
});

describe("chapter budget saves keep focus while they run (#8435)", () => {
  // The pagers keep every hold Main gave them. Both are pending
  // (focusable, refusing activation) while a save runs, and the budget list's
  // pager is natively unavailable while a budget editor is open. (A reload
  // clears the panel, so no pager is on screen while it loads.)
  it("holds both pagers while a save runs, and the budget pager natively while an editor is open", async () => {
    const rows=Array.from({length:21},(_,i)=>({...budget,id:`b-${i}`,title:`Budget ${i}`}));
    const members=Array.from({length:21},(_,i)=>({id:`person-${i}`,name:`Member ${i}`,office:null}));
    let releaseSave=null;
    const client={rpc:vi.fn(async (name) => {
      if (name === "get_chapter_budget_access") return {data:{canRead:true,canAssign:true,members},error:null};
      if (name === "list_chapter_budgets") return {data:rows,error:null};
      if (name === "set_chapter_budget_office") return new Promise((resolve) => { releaseSave = () => resolve({data:{saved:true},error:null}); });
      return {data:{saved:true},error:null};
    })};
    render(panel(client));
    await screen.findByText("Budget 0");
    const budgetNext = () => screen.getAllByRole("button",{name:"Next page"}).at(-1);
    fireEvent.click(screen.getByRole("button",{name:"New budget"}));
    expect(budgetNext()).toBeDisabled();
    fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
    expect(budgetNext()).toBeEnabled();

    fireEvent.click(screen.getByText("Budget office access"));
    fireEvent.change(screen.getByRole("combobox",{name:"Budget office for Member 0"}),{target:{value:"secretary_treasurer"}});
    fireEvent.click(screen.getByRole("button",{name:"Save budget office for Member 0"}));
    const [memberNext, listNext] = screen.getAllByRole("button",{name:"Next page"});
    await waitFor(()=>expect(memberNext).toHaveAttribute("aria-disabled","true"));
    expect(listNext).toHaveAttribute("aria-disabled","true");
    await expectPendingFocus(listNext);
    const lists=client.rpc.mock.calls.filter(([name])=>name === "list_chapter_budgets").length;
    fireEvent.click(listNext);
    fireEvent.click(memberNext);
    expect(client.rpc.mock.calls.filter(([name])=>name === "list_chapter_budgets")).toHaveLength(lists);
    await act(async()=>{ releaseSave(); });
  });
  it("keeps Save budget focused while the budget is saved, and saves it once", async () => {
    const client = clientFor();
    render(panel(client));
    fireEvent.click(await screen.findByRole("button", { name: "Edit October budget" }));
    const saves = () => client.rpc.mock.calls.filter(([name]) => name === "save_chapter_budget").length;
    await expectHeldWriteFocus(client.rpc, screen.getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(saves()).toBe(1));
  });
});
