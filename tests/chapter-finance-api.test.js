import { describe,it,expect,vi } from "vitest";
import { createChapterFinanceApi } from "../src/lib/chapterFinanceApi.js";
const scope={organizationId:"org",chapterId:"chapter"};
describe("chapter finance API",()=>{
  it("does not create a preview client",()=>expect(createChapterFinanceApi(null,scope)).toBeNull());
  it("binds every query and mutation to the selected organization and chapter",async()=>{
    const client={rpc:vi.fn(async name=>({data:name==='list_chapter_finance_members'?[]:{saved:true}}))},api=createChapterFinanceApi(client,scope);
    await api.load(2,3);expect(client.rpc).toHaveBeenLastCalledWith("get_chapter_finance_workspace",{p_org:"org",p_chapter:"chapter",p_page:2,p_request_page:3,p_authoring:false});
    await createChapterFinanceApi(client,scope,true).load(0,0);expect(client.rpc).toHaveBeenLastCalledWith("get_chapter_finance_workspace",expect.objectContaining({p_authoring:true}));
    await api.members(4,"Fictional");expect(client.rpc).toHaveBeenLastCalledWith("list_chapter_finance_members",{p_org:"org",p_chapter:"chapter",p_page:4,p_query:"Fictional"});
    await api.saveDocument({kind:"financial_report",title:"Quarter",body:"Reviewed report",status:"draft"});
    expect(client.rpc).toHaveBeenLastCalledWith("save_chapter_financial_document",{p_org:"org",p_chapter:"chapter",p_id:null,p_revision:0,p_kind:"financial_report",p_title:"Quarter",p_body:"Reviewed report",p_status:"draft",p_budget:null});
    await api.saveDocument({id:"report",revision:2,kind:"budget",title:"Budget",body:"Reviewed snapshot",status:"published",budgetId:"budget"});
    expect(client.rpc).toHaveBeenLastCalledWith("save_chapter_financial_document",expect.objectContaining({p_id:"report",p_revision:2,p_budget:"budget"}));
    await api.submit({subjectId:"member",kind:"expense",title:"Supplies",description:"Details",amount:"12.25"});
    expect(client.rpc).toHaveBeenLastCalledWith("submit_chapter_financial_request",{p_org:"org",p_chapter:"chapter",p_subject:"member",p_kind:"expense",p_title:"Supplies",p_description:"Details",p_amount:12.25});
    await api.decide({id:"request",revision:1},"approved","Checked");
    expect(client.rpc).toHaveBeenLastCalledWith("decide_chapter_financial_request",{p_org:"org",p_chapter:"chapter",p_id:"request",p_revision:1,p_decision:"approved",p_note:"Checked"});
  });
  it("propagates authorization and validation failures",async()=>{
    const api=createChapterFinanceApi({rpc:vi.fn(async()=>({error:{message:"denied",code:"42501"}}))},scope);
    await expect(api.load(0,0)).rejects.toThrow("denied");
    await expect(createChapterFinanceApi({rpc:vi.fn(async()=>({data:null}))},scope).members(0,"")).rejects.toThrow("Member names unavailable");
  });
});
