import { describe, expect, it, vi } from "vitest";
import { updateChapterDocumentContent, updateChapterRecordContent, updateChapterSpaceContent } from "../src/lib/memberApi.js";
describe("published content API",()=>{
  it("maps space edit/archive",async()=>{const rpc=vi.fn().mockResolvedValue({data:{id:"s"},error:null});await updateChapterSpaceContent({rpc},"s",{name:" Space ",description:" D ",visibility:"chapter"},true);expect(rpc).toHaveBeenCalledWith("update_chapter_space_content",{p_id:"s",p_name:"Space",p_description:"D",p_visibility:"chapter",p_archive:true});});
  it("maps document re-publication to its RPC and every normalized field", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "document-1", version: 2 }, error: null });
    await updateChapterDocumentContent({ rpc }, "document-1", {
      title: "  Revised policy  ", documentType: "policy", summary: "  What changed  ",
      body: "  The full policy text  ", visibility: "chapter",
    }, "republish");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("update_chapter_document_content", {
      p_id: "document-1", p_title: "Revised policy", p_document_type: "policy",
      p_summary: "What changed", p_body: "The full policy text",
      p_visibility: "chapter", p_action: "republish",
    });
  });
  it.each([false, true])("maps record edits to their RPC with explicit archive=%s", async archive => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "record-1" }, error: null });
    await updateChapterRecordContent({ rpc }, "record-1", {
      recordType: "minutes", title: "  Annual meeting record  ",
      body: "  Attendance approved  ", occurredAt: "2026-08-10T12:34:56Z",
    }, archive);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("update_chapter_record_content", {
      p_id: "record-1", p_record_type: "minutes", p_title: "Annual meeting record",
      p_body: "Attendance approved", p_occurred_at: "2026-08-10T12:34:56Z", p_archive: archive,
    });
  });
});
