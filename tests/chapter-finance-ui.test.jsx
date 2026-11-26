import {act,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {afterEach,describe,it,expect,vi} from "vitest";
import {LanguageProvider} from "../src/lib/LanguageContext.jsx";
import {ChapterFinancePanel} from "../src/features/finance/ChapterFinancePanel.jsx";
import {loadChapterBudgets} from "../src/lib/memberApi.js";
import {expectHeldWriteFocus} from "./helpers/busyWriteFocus.js";
vi.mock("../src/lib/chapterFinanceApi.js",()=>({createChapterFinanceApi:client=>client?.finance||null}));
vi.mock("../src/lib/memberApi.js",()=>({loadChapterBudgets:vi.fn(async()=>[{id:"b",title:"Operating budget"}])}));
const scope={organizationId:"org",chapterId:"campaign"};
const workspace=()=>({organizationId:"org",chapterId:"campaign",canRecords:true,canDocuments:true,canPublish:true,canRoster:true,documents:[],requests:[]});
const makeApi=(data=workspace())=>({load:vi.fn(async()=>structuredClone(data)),members:vi.fn(async()=>[{id:"peer",name:"Fictional Mira"}]),saveDocument:vi.fn(async()=>{}),submit:vi.fn(async()=>{}),decide:vi.fn(async()=>{})});
const wrap=(api,lang="en",props={})=><LanguageProvider lang={lang}><ChapterFinancePanel client={api?{finance:api}:null} scope={scope} memberId="my-id" canAuthor {...props}/></LanguageProvider>;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
afterEach(()=>vi.mocked(loadChapterBudgets).mockReset().mockResolvedValue([{id:"b",title:"Operating budget"}]));
describe("chapter financial duties",()=>{
  it("loads fresh budget choices on opening and pages to older budgets",async()=>{
    const budgets=Array.from({length:22},(_,i)=>({id:"b"+i,title:"Budget "+i}));
    vi.mocked(loadChapterBudgets).mockImplementation(async(_client,_scope,page)=>budgets.slice(page*20,page*20+21));
    const api=makeApi();render(wrap(api));
    const add=await screen.findByRole("button",{name:"New financial document"});
    fireEvent.click(add);fireEvent.change(screen.getByLabelText("Document type"),{target:{value:"budget"}});
    await screen.findByRole("option",{name:"Budget 0"});expect(screen.queryByRole("option",{name:"Budget 20"})).toBeNull();
    const pager=screen.getByRole("navigation",{name:"Budget snapshot"});fireEvent.click(within(pager).getByRole("button",{name:"Next"}));
    await screen.findByRole("option",{name:"Budget 21"});fireEvent.change(screen.getByRole("combobox",{name:"Budget snapshot",exact:true}),{target:{value:"b21"}});
    fireEvent.submit(screen.getByRole("button",{name:"Save financial document"}).closest("form"));
    await waitFor(()=>expect(api.saveDocument).toHaveBeenCalledWith(expect.objectContaining({budgetId:"b21"})));
    await screen.findByRole("button",{name:"New financial document"});
    budgets.unshift({id:"new",title:"Newly saved budget"});
    fireEvent.click(screen.getByRole("button",{name:"New financial document"}));fireEvent.change(screen.getByLabelText("Document type"),{target:{value:"budget"}});
    await screen.findByRole("option",{name:"Newly saved budget"});
    fireEvent.click(screen.getByRole("button",{name:"Refresh budget choices"}));await screen.findByRole("option",{name:"Newly saved budget"});
  });
  it("keeps the editor through failed budget reads and ignores stale budget results",async()=>{
    vi.mocked(loadChapterBudgets).mockResolvedValueOnce(null);
    render(wrap(makeApi()));fireEvent.click(await screen.findByRole("button",{name:"New financial document"}));
    fireEvent.change(screen.getByLabelText("Document type"),{target:{value:"budget"}});
    await screen.findByText("Budget choices could not be loaded. Refresh to try again.");
    fireEvent.click(screen.getByRole("button",{name:"Refresh budget choices"}));await screen.findByRole("option",{name:"Operating budget"});
    const pending=deferred();vi.mocked(loadChapterBudgets).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button",{name:"Refresh budget choices"}));fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
    await act(async()=>pending.resolve([{id:"stale",title:"Late budget"}]));expect(screen.queryByRole("option",{name:"Late budget"})).toBeNull();
    const failed=deferred();vi.mocked(loadChapterBudgets).mockReturnValueOnce(failed.promise);
    fireEvent.click(screen.getByRole("button",{name:"New financial document"}));fireEvent.change(screen.getByLabelText("Document type"),{target:{value:"budget"}});
    fireEvent.click(screen.getByRole("button",{name:"Cancel"}));await act(async()=>failed.reject(new Error("late failure")));
    expect(screen.queryByText("Budget choices could not be loaded. Refresh to try again.")).toBeNull();
  });
  it("ignores late roster results and errors after the client changes",async()=>{
    const names=deferred(),old=makeApi();old.members.mockReturnValue(names.promise);
    const view=render(wrap(old));await waitFor(()=>expect(old.members).toHaveBeenCalled());
    const next=makeApi({...workspace(),canRoster:false});view.rerender(wrap(next));
    await screen.findByRole("button",{name:"Submit request"});
    await act(async()=>names.resolve([{id:"old",name:"Previous chapter member"}]));
    expect(screen.queryByText("Previous chapter member")).toBeNull();
    const failed=deferred(),third=makeApi();third.members.mockReturnValue(failed.promise);
    view.rerender(wrap(third));await waitFor(()=>expect(third.members).toHaveBeenCalled());
    view.unmount();await act(async()=>failed.reject(new Error("late roster error")));
  });
  it("ignores late read and mutation failures and refuses a duplicate pending submission",async()=>{
    const read=deferred(),old=makeApi();old.load.mockReturnValue(read.promise);
    const view=render(wrap(old));view.unmount();await act(async()=>read.reject(new Error("late read error")));
    const write=deferred(),api=makeApi();api.submit.mockReturnValue(write.promise);
    const active=render(wrap(api));const form=(await screen.findByRole("button",{name:"Submit request"})).closest("form");
    fireEvent.submit(form);fireEvent.submit(form);expect(api.submit).toHaveBeenCalledTimes(1);
    active.unmount();await act(async()=>write.reject(new Error("late write error")));
  });
  it("withholds budget edits when financial-record authority is switched off",async()=>{
    const api=makeApi({...workspace(),canRecords:false,documents:[{id:"b",kind:"budget",title:"Published budget",status:"published",body:"Plan"}]});
    render(wrap(api));await screen.findByText("Published budget");
    expect(screen.queryByRole("button",{name:"Edit financial document"})).toBeNull();
  });
  it("keeps the Member presentation to published reports and own requests even when the account also holds Treasurer",async()=>{
    const api=makeApi({...workspace(),documents:[{id:"draft",title:"Private draft",kind:"financial_report",status:"draft",body:"Draft"},{id:"published",title:"Published report",kind:"financial_report",status:"published",body:"Reviewed"}],requests:[{id:"own",subject_id:"my-id",title:"Own expense",kind:"expense",amount:5,status:"pending",description:"Own request",decision_note:""},{id:"peer",subject_id:"peer",title:"Other member expense",kind:"expense",amount:10,status:"pending",description:"Private",decision_note:""}]});
    render(wrap(api,"en",{canAuthor:false}));await screen.findByText("Published report");
    expect(screen.getByText("Own expense")).toBeInTheDocument();expect(screen.queryByText("Private draft")).toBeNull();expect(screen.queryByText("Other member expense")).toBeNull();expect(screen.queryByRole("button",{name:"New financial document"})).toBeNull();expect(api.members).not.toHaveBeenCalled();
  });
  it("shows member publication and private own-request controls without staff actions",async()=>{
    const api=makeApi({...workspace(),canRecords:false,canDocuments:false,canPublish:false,canRoster:false});
    render(wrap(api));await screen.findByText("No financial reports on this page.");
    expect(screen.queryByRole("button",{name:"New financial document"})).toBeNull();expect(screen.queryByLabelText("Worker")).toBeNull();
    const form=screen.getByRole("button",{name:"Submit request"}).closest("form");
    fireEvent.change(within(form).getByLabelText("Title"),{target:{value:"Supplies"}});fireEvent.change(within(form).getByLabelText("Purpose and details"),{target:{value:"Meeting supplies"}});fireEvent.change(within(form).getByLabelText("Amount (USD)"),{target:{value:"12.25"}});
    fireEvent.submit(form);await waitFor(()=>expect(api.submit).toHaveBeenCalledWith({subjectId:"my-id",kind:"expense",title:"Supplies",description:"Meeting supplies",amount:"12.25"}));
    expect(api.members).not.toHaveBeenCalled();
  });
  it("creates financial reports and reviewed budget snapshots, edits and archives",async()=>{
    const data=workspace(),api=makeApi(data);render(wrap(api));
    fireEvent.click(await screen.findByRole("button",{name:"New financial document"}));
    fireEvent.change(screen.getByLabelText("Document type"),{target:{value:"budget"}});await screen.findByRole("option",{name:"Operating budget"});fireEvent.change(screen.getByRole("combobox",{name:"Budget snapshot",exact:true}),{target:{value:"b"}});
    fireEvent.change(screen.getAllByLabelText("Title")[0],{target:{value:"Budget report"}});fireEvent.change(screen.getByLabelText("Report or notice"),{target:{value:"Reviewed snapshot"}});fireEvent.change(screen.getByLabelText("Publication"),{target:{value:"published"}});
    fireEvent.submit(screen.getByRole("button",{name:"Save financial document"}).closest("form"));
    await waitFor(()=>expect(api.saveDocument).toHaveBeenCalledWith(expect.objectContaining({kind:"budget",budgetId:"b",status:"published"})));
    await act(async()=>{});
    data.documents=[{id:"doc",revision:2,kind:"financial_report",title:"Quarterly report",body:"Report body",status:"published"}];
    fireEvent.click(screen.getByRole("button",{name:"New financial document"}));fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
    // A successful request refreshes the workspace and renders the new list.
    fireEvent.submit(screen.getByRole("button",{name:"Submit request"}).closest("form"));
    fireEvent.click(await screen.findByRole("button",{name:"Edit financial document"}));
    fireEvent.change(screen.getByLabelText("Publication"),{target:{value:"archived"}});fireEvent.submit(screen.getByRole("button",{name:"Save financial document"}).closest("form"));
    await waitFor(()=>expect(api.saveDocument).toHaveBeenLastCalledWith(expect.objectContaining({id:"doc",revision:2,status:"archived"})));
  });
  it("attributes an expense to a name-only roster and records a private decision",async()=>{
    const api=makeApi({...workspace(),requests:[{id:"r",revision:1,kind:"reimbursement",title:"Receipt",amount:12.25,status:"pending",description:"Supplies",decision_note:"",subject_name:"Fictional Mira"}]});
    render(wrap(api));await screen.findByRole("option",{name:"Fictional Mira"});
    expect(screen.getByText("For Fictional Mira")).toBeInTheDocument();
    const form=screen.getByRole("button",{name:"Submit request"}).closest("form");fireEvent.change(within(form).getByLabelText("Worker"),{target:{value:"peer"}});fireEvent.change(within(form).getByLabelText("Request type"),{target:{value:"reimbursement"}});fireEvent.submit(form);
    await waitFor(()=>expect(api.submit).toHaveBeenCalledWith(expect.objectContaining({subjectId:"peer",kind:"reimbursement"})));await act(async()=>{});
    const decision=screen.getByRole("button",{name:"Record decision"}).closest("form");fireEvent.change(within(decision).getByLabelText("Decision"),{target:{value:"declined"}});fireEvent.change(within(decision).getByLabelText("Decision reason"),{target:{value:"Missing receipt"}});fireEvent.submit(decision);
    await waitFor(()=>expect(api.decide).toHaveBeenCalledWith(expect.objectContaining({id:"r"}),"declined","Missing receipt"));
  });
  it("renders published snapshot figures and final decisions without edit authority",async()=>{
    const api=makeApi({...workspace(),canRecords:false,canDocuments:false,canPublish:false,canRoster:false,documents:[{id:"d",title:"Budget",kind:"budget",status:"published",body:"Plan",budget_snapshot:{periodStart:"2026-10-01",periodEnd:"2026-10-31",notes:"Reviewed",items:[{name:"Supplies",planned:100,actual:25}]}}],requests:[{id:"r",kind:"expense",title:"Supplies",amount:25,status:"approved",description:"Meeting",decision_note:"Checked"}]});
    render(wrap(api));await screen.findByText("Checked");expect(screen.getByText(/Supplies: \$100.00 \/ \$25.00/)).toBeInTheDocument();expect(screen.queryByRole("button",{name:"Edit financial document"})).toBeNull();expect(screen.queryByRole("button",{name:"Record decision"})).toBeNull();
  });
  it("handles loading, failed reads, retry, invalid contexts and missing preview client",async()=>{
    const pending=deferred(),api=makeApi();api.load.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("denied"));
    const view=render(wrap(api));expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await act(async()=>pending.reject(new Error("offline")));fireEvent.click(screen.getByRole("button",{name:"Try again"}));await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button",{name:"Try again"}));await screen.findByRole("button",{name:"Submit request"});
    view.rerender(wrap(null));expect(screen.queryByRole("heading",{name:"Campaign finances"})).toBeNull();
    const invalid=makeApi({...workspace(),chapterId:"other"});view.rerender(wrap(invalid));await screen.findByRole("alert");
    const absent=makeApi(null);view.rerender(wrap(absent));await screen.findByRole("alert");
  });
  it("reports mutation and roster errors and disables duplicate submissions while pending",async()=>{
    const pending=deferred(),api=makeApi();api.members.mockRejectedValue(new Error("offline"));api.submit.mockReturnValueOnce(pending.promise).mockRejectedValue(new Error("denied"));
    render(wrap(api));await screen.findByText("Worker names could not be loaded.");
    fireEvent.submit(screen.getByRole("button",{name:"Submit request"}).closest("form"));expect(screen.getByRole("button",{name:"Submit request"})).toHaveAttribute("aria-disabled","true");
    // Pending, not natively disabled (record 8435): a second submit is refused.
    fireEvent.click(screen.getByRole("button",{name:"Submit request"}));fireEvent.submit(screen.getByRole("button",{name:"Submit request"}).closest("form"));expect(api.submit).toHaveBeenCalledTimes(1);
    await act(async()=>pending.reject(new Error("conflict")));expect(within(screen.getByRole("button",{name:"Submit request"}).closest("form")).getByRole("alert")).toHaveTextContent("We could not confirm that your request was sent.");
    api.members.mockResolvedValue([]);fireEvent.click(screen.getAllByRole("button",{name:"Try again"})[0]);await screen.findByRole("button",{name:"Submit request"});
  });
  it("has Spanish functional forms and role-specific publication choices",async()=>{
    const before=vi.mocked(loadChapterBudgets).mock.calls.length;
    const api=makeApi({...workspace(),canPublish:false,canRecords:false});render(wrap(api,"es"));
    fireEvent.click(await screen.findByRole("button",{name:"Nuevo documento financiero"}));expect(screen.queryByRole("option",{name:"Publicado"})).toBeNull();expect(screen.getByRole("button",{name:"Enviar solicitud"})).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"Cancelar"}));expect(vi.mocked(loadChapterBudgets).mock.calls.length).toBe(before);
  });
  it("pages documents, requests and member names and searches by name",async()=>{
    const data=workspace();data.documents=Array.from({length:21},(_,i)=>({id:"d"+i,title:"Report "+i,body:"Details",kind:"financial_report",status:"draft"}));data.requests=Array.from({length:21},(_,i)=>({id:"r"+i,title:"Request "+i,kind:"expense",amount:1,status:"declined",description:"Details",decision_note:"Checked"}));
    const api=makeApi(data);api.members.mockResolvedValue(Array.from({length:21},(_,i)=>({id:"m"+i,name:"Member "+i})));render(wrap(api));await screen.findByRole("option",{name:"Member 0"});
    for(const label of ["Financial reports and notices","Expenses and reimbursements","Worker"]){
      const pager=screen.getByRole("navigation",{name:label});fireEvent.click(within(pager).getByRole("button",{name:"Next"}));await act(async()=>{});fireEvent.click(within(screen.getByRole("navigation",{name:label})).getByRole("button",{name:"Previous"}));await act(async()=>{});
    }
    fireEvent.change(screen.getByLabelText("Find a worker by name"),{target:{value:"Mira"}});fireEvent.submit(screen.getByRole("button",{name:"Search"}).closest("form"));await waitFor(()=>expect(api.members).toHaveBeenLastCalledWith(0,"Mira"));
  });
  it("drops late reads and writes after the bound client changes or unmounts",async()=>{
    const read=deferred(),write=deferred(),old=makeApi();old.load.mockReturnValueOnce(read.promise);
    const view=render(wrap(old));const next=makeApi({...workspace(),canRoster:false});view.rerender(wrap(next));await screen.findByRole("button",{name:"Submit request"});await act(async()=>read.resolve({...workspace(),documents:[{id:"stale",title:"Wrong report"}]}));expect(screen.queryByText("Wrong report")).toBeNull();
    next.submit.mockReturnValue(write.promise);fireEvent.submit(screen.getByRole("button",{name:"Submit request"}).closest("form"));view.unmount();await act(async()=>write.resolve({}));
  });
  it("keeps published finance reports available to PIN readers while requiring step-up for private requests",async()=>{
    const api=makeApi({...workspace(),canRecords:false,canDocuments:false,canPublish:false,canRoster:false,canSubmit:false,documents:[{id:"pub",title:"Published finance",body:"Reviewed",kind:"financial_report",status:"published"}]});
    render(wrap(api));await screen.findByText("Published finance");
    expect(screen.queryByRole("button",{name:"Submit request"})).toBeNull();
    expect(screen.getByText("Sign in with your password or passkey to submit or review a private expense request.")).toBeInTheDocument();
  });
});

// The finance panel's write controls stay focusable while their
// write runs (the browser focus fixup would otherwise send focus to the page),
// read as unavailable, and refuse a second activation.
describe("chapter finance controls keep focus while their write runs", () => {
  it("keeps Submit request focused while the request is sent, and sends it once", async () => {
    const api = makeApi();
    render(wrap(api));
    const submit = await screen.findByRole("button", { name: "Submit request" });
    await expectHeldWriteFocus(api.submit, submit, () => fireEvent.submit(submit.closest("form")));
    expect(api.submit).toHaveBeenCalledTimes(1);
  });

  // The lock, not the rendered busy state,
  // refuses a second submit that lands before React commits busy.
  it("sends one request when two submits land in the same tick", async () => {
    let release;
    const api = makeApi();
    api.submit.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    render(wrap(api));
    const form = (await screen.findByRole("button", { name: "Submit request" })).closest("form");
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(api.submit).toHaveBeenCalledTimes(1);
    await act(async () => { release({}); });
  });
});
