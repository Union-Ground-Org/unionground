import {describe,it,expect,vi} from "vitest";
import {accessScope,createChapterAccessApi,createGrievancePrivacyApi} from "../src/lib/chapterAccessApi.js";
vi.mock("../src/lib/memberApi.js",()=>({
  MemberApiError: class MemberApiError extends Error {constructor(operation,error){super(error.message);this.operation=operation;}},
  createChapterDocument:vi.fn(async()=>"created"),updateChapterDocumentContent:vi.fn(async()=>"updated"),
}));
const workspace={policy:{},members:[],units:[],committees:[],grants:[],roles:[],settings:[],grantableRoles:[]};
describe("chapter access API",()=>{
  it("does not create a client for a preview",()=>{expect(createChapterAccessApi(null)).toBeNull();expect(createGrievancePrivacyApi(null)).toEqual({});});
  it("maps chapter and container scopes, including absent disabled form controls",()=>{
    expect(accessScope("unit:u")).toEqual({unitId:"u"});expect(accessScope("committee:c")).toEqual({committeeId:"c"});
    expect(accessScope("")).toEqual({});expect(accessScope(null)).toEqual({});
  });
  it("keeps pagination, search and every mutation bound to the chosen chapter",async()=>{
    const client={rpc:vi.fn(async(name)=>({data:name==='get_chapter_access_workspace'?workspace:name==='get_chapter_office_access'?{chapterId:'ch',scopes:[]}:[]}))};const api=createChapterAccessApi(client);
    expect(await api.load("ch",{members:1,units:2,committees:3},"Ada")).toBe(workspace);
    expect(client.rpc).toHaveBeenLastCalledWith("get_chapter_access_workspace",{p_chapter:"ch",p_member_page:1,p_unit_page:2,p_committee_page:3,p_query:"Ada"});
    await api.saveCommittee("ch",{name:"Safety",purpose:"Safety at work",startsOn:"2026-10-31",grievanceAccess:false});
    expect(client.rpc).toHaveBeenLastCalledWith("save_chapter_committee",expect.objectContaining({p_id:null,p_chapter:"ch",p_ends_on:null,p_grievance_access:false}));
    await api.saveCommittee("ch",{id:"c",name:"Safety",purpose:"Review",startsOn:"2026-10-31",endsOn:"2026-11-30",grievanceAccess:true});
    expect(client.rpc).toHaveBeenLastCalledWith("save_chapter_committee",expect.objectContaining({p_id:"c",p_ends_on:"2026-11-30"}));
    await api.setMember("ch","m",{unitId:"u"},true);expect(client.rpc).toHaveBeenLastCalledWith("set_chapter_access_member",{p_chapter:"ch",p_user:"m",p_unit:"u",p_committee:null,p_enabled:true});
    await api.setMember("ch","m",{committeeId:"c"},false);expect(client.rpc).toHaveBeenLastCalledWith("set_chapter_access_member",expect.objectContaining({p_unit:null,p_committee:"c",p_enabled:false}));
    await api.setRole("ch","m","steward",{unitId:"u"},true);
    expect(client.rpc).toHaveBeenLastCalledWith("set_member_access_role",{p_chapter:"ch",p_user:"m",p_role:"steward",p_unit:"u",p_committee:null,p_enabled:true});
    await api.setRole("ch","m","secretary",{committeeId:"c"},true);
    expect(client.rpc).toHaveBeenLastCalledWith("set_member_access_role",expect.objectContaining({p_unit:null,p_committee:"c"}));
    await api.setPolicy("ch",false,"chapter");expect(client.rpc).toHaveBeenLastCalledWith("set_chapter_access_policy",{p_chapter:"ch",p_steward_grievances:false,p_steward_breadth:"chapter"});
    await api.setCapability("ch","secretary","records",false);expect(client.rpc).toHaveBeenLastCalledWith("set_chapter_role_capability",{p_chapter:"ch",p_role:"secretary",p_capability:"records",p_enabled:false});
    await api.office();expect(client.rpc).toHaveBeenLastCalledWith("get_chapter_office_access",undefined);
    await api.sharing("f");expect(client.rpc).toHaveBeenLastCalledWith("list_member_draft_sharing",{p_form:"f"});
    await api.share("f","s",false);expect(client.rpc).toHaveBeenLastCalledWith("set_member_draft_steward_share",{p_form:"f",p_steward:"s",p_shared:false});
    await api.sharedDrafts();expect(client.rpc).toHaveBeenLastCalledWith("list_shared_member_drafts",undefined);
    await api.privateGrievances();expect(client.rpc).toHaveBeenLastCalledWith("list_private_grievance_summaries",undefined);
    await api.setIdentityPrivate("case",true);expect(client.rpc).toHaveBeenLastCalledWith("set_grievance_identity_private",{p_case:"case",p_private:true});
    await createGrievancePrivacyApi(client).loadIdentityVisibility('case');expect(client.rpc).toHaveBeenLastCalledWith('get_grievance_identity_visibility',{p_case:'case'});
    await api.publishNotice('ch','Notice','Text','es');expect(client.rpc).toHaveBeenLastCalledWith('publish_chapter_office_notice',{p_chapter:'ch',p_title:'Notice',p_body:'Text',p_locale:'es',p_unit:null,p_committee:null,p_idempotency_key:expect.any(String)});
    for(const [scope,unit,committee] of [['unit:u','u',null],['committee:c',null,'c']]){
      await api.publishNotice('ch','Notice','Text','es',scope);expect(client.rpc).toHaveBeenLastCalledWith('publish_chapter_office_notice',expect.objectContaining({p_unit:unit,p_committee:committee}));
    }
  });
  it("reports server errors and incomplete rollout payloads",async()=>{
    const client={rpc:vi.fn().mockResolvedValueOnce({error:{message:"denied"}}).mockResolvedValueOnce({data:null}).mockResolvedValueOnce({data:{policy:{}}})};
    const api=createChapterAccessApi(client);await expect(api.office()).rejects.toThrow("denied");
    await expect(api.load("ch",{members:0,units:0,committees:0},"")).rejects.toThrow("unavailable");
    client.rpc.mockResolvedValue({data:{chapterId:'ch'}});await expect(api.office()).rejects.toThrow('Office unavailable');
    client.rpc.mockResolvedValue({data:null});await expect(api.office()).rejects.toThrow('Office unavailable');
    for(const call of [()=>api.documents('ch',0),()=>api.sharing('f'),()=>api.sharedDrafts(),()=>api.privateGrievances()])await expect(call()).rejects.toThrow('Access list unavailable');
    await expect(api.load("ch",{members:0,units:0,committees:0},"")).rejects.toThrow("unavailable");
  });
  it("loads only the chosen chapter's paged documents and preserves the existing document lifecycle",async()=>{
    const client={rpc:vi.fn(async()=>({data:[{id:'d'}]}))};const api=createChapterAccessApi(client);
    expect(await api.documents("ch",2)).toEqual([{id:"d"}]);expect(client.rpc).toHaveBeenLastCalledWith('list_chapter_office_documents',{p_chapter:'ch',p_page:2});
    for(const [scope,action,unit,committee] of [['unit:u','save','u',null],['committee:c','republish',null,'c'],['','save',null,null]]){
      await api.saveDocument(null,{chapterId:'ch',title:'Minutes',body:'Text',summary:'Summary',accessScope:scope},action);
      expect(client.rpc).toHaveBeenLastCalledWith('create_chapter_office_document',{p_chapter:'ch',p_title:'Minutes',p_body:'Text',p_summary:'Summary',p_unit:unit,p_committee:committee,p_published:action==='republish'});
    }
    expect(await api.saveDocument("d",{title:"Minutes"},"republish")).toBe("updated");
  });
});
