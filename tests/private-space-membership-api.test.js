import{describe,expect,it,vi}from"vitest";import{listChapterSpaceMembers,searchChapterSpaceMembers,setChapterSpaceMember}from"../src/lib/memberApi.js";
describe("private space membership API",()=>{
 it("lists by space only",async()=>{const rpc=vi.fn().mockResolvedValue({data:[],error:null});await listChapterSpaceMembers({rpc},"s1");expect(rpc).toHaveBeenCalledWith("list_chapter_space_members",{p_space_id:"s1"});});
 it("trims and bounds search server-side",async()=>{const rpc=vi.fn().mockResolvedValue({data:[],error:null});await searchChapterSpaceMembers({rpc},"s1"," Pat ");expect(rpc).toHaveBeenCalledWith("search_chapter_space_members",{p_space_id:"s1",p_query:"Pat",p_limit:20});});
 it("maps add and remove through one guarded RPC",async()=>{const rpc=vi.fn().mockResolvedValue({data:{changed:true},error:null});await setChapterSpaceMember({rpc},"s1","u2",false);expect(rpc).toHaveBeenCalledWith("set_chapter_space_member",{p_space_id:"s1",p_user_id:"u2",p_add:false});});
});
