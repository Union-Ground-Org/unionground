import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";

const product={spaces:[{id:"s1",name:"Organizing",description:"Work",visibility:"chapter",threads:[]}],documents:[{id:"d1",title:"Policy",document_type:"policy",summary:"Old",body:"Body",visibility:"chapter",version:2,status:"published"},{id:"d2",title:"Steward guide",document_type:"training",summary:"Working copy",body:"Draft body",visibility:"chapter",version:1,status:"draft"}],records:[{id:"r1",title:"Decision",record_type:"decision",body:"Approved",occurred_at:"2026-08-01T12:00:00Z"}],intake:[],handshakes:[],governance:[],partnerOrgs:[]};
function view(overrides={},lang="en"){const props={data:{member:{id:"u1",initials:"U"},roles:["vp"],product},onCreateSpace:vi.fn(),onCreateThread:vi.fn(),onSendPost:vi.fn(),onCreateDocument:vi.fn(),onCreateRecord:vi.fn(),onCreateIntake:vi.fn(),onCreateHandshake:vi.fn(),onCreateGovernance:vi.fn(),onUpdateSpace:vi.fn().mockResolvedValue({}),onUpdateDocument:vi.fn().mockResolvedValue({}),onUpdateRecord:vi.fn().mockResolvedValue({}),...overrides};render(<LanguageProvider lang={lang}><ProductHubView {...props}/></LanguageProvider>);return props;}
function openDocumentEditor(title){fireEvent.click(screen.getByRole("button",{name:"Library"}));fireEvent.click(screen.getByRole("button",{name:title}));fireEvent.click(screen.getByRole("button",{name:"Edit"}));}
describe("published content lifecycle UI",()=>{
  it("edits and archives a space for a publishing hat",async()=>{const p=view();fireEvent.click(screen.getByRole("button",{name:"Edit"}));fireEvent.change(screen.getByRole("textbox",{name:"Name"}),{target:{value:"Member organizing"}});fireEvent.click(screen.getByRole("button",{name:"Save"}));await waitFor(()=>expect(p.onUpdateSpace).toHaveBeenCalledWith("s1",expect.objectContaining({name:"Member organizing"}),false));});
  it("re-publishes a document as an explicit new version action",async()=>{const p=view();fireEvent.click(screen.getByRole("button",{name:"Library"}));fireEvent.click(screen.getByRole("button",{name:/Policy/}));fireEvent.click(screen.getByRole("button",{name:"Edit"}));fireEvent.click(screen.getByRole("button",{name:"Publish new version"}));await waitFor(()=>expect(p.onUpdateDocument).toHaveBeenCalledWith("d1",expect.objectContaining({title:"Policy"}),"republish"));});
  it("archives a record only after explicit confirmation",async()=>{const p=view();fireEvent.click(screen.getByRole("button",{name:"The record"}));fireEvent.click(screen.getByRole("button",{name:"Edit"}));fireEvent.click(screen.getByRole("button",{name:"Archive"}));expect(p.onUpdateRecord).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"Confirm archive"}));await waitFor(()=>expect(p.onUpdateRecord).toHaveBeenCalledWith("r1",expect.objectContaining({title:"Decision"}),true));});
  it("does not expose lifecycle controls to a member",()=>{view({data:{member:{id:"u1",initials:"U"},roles:[],product}});expect(screen.queryByRole("button",{name:"Edit"})).not.toBeInTheDocument();});
});

// SOL-20260813-03. Before this, the editor for a PUBLISHED document carried the
// same plain Save as a draft, and update_chapter_document_content applied the
// content columns for action='save' without touching version or published_at.
// Pressing Save therefore replaced what members were reading while the version
// number and publication date on screen stayed on the previous release.
describe("published document editing is never silent",()=>{
  it("offers a published document only the versioned exits, with no plain save",()=>{
    view();
    openDocumentEditor(/Policy/);
    expect(screen.queryByRole("button",{name:"Save"})).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Publish new version"})).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Archive"})).toBeInTheDocument();
    expect(screen.getByText(/A published document cannot be edited silently/)).toBeInTheDocument();
  });

  it("refuses an implicit form submit on a published document",async()=>{
    // Removing the button is not enough on its own: a form still submits
    // implicitly, so the handler has to refuse as well.
    const p=view();
    openDocumentEditor(/Policy/);
    fireEvent.submit(document.querySelector("form.stack-form"));
    await Promise.resolve();
    expect(p.onUpdateDocument).not.toHaveBeenCalled();
  });

  it("keeps plain save for a draft document",async()=>{
    const p=view();
    openDocumentEditor(/Steward guide/);
    fireEvent.change(screen.getByRole("textbox",{name:"Content"}),{target:{value:"Revised draft"}});
    fireEvent.click(screen.getByRole("button",{name:"Save"}));
    await waitFor(()=>expect(p.onUpdateDocument).toHaveBeenCalledWith("d2",expect.objectContaining({title:"Steward guide",body:"Revised draft"}),"save"));
  });

  it("shows bilingual copy rather than raw Postgres when the server refuses a stale save",async()=>{
    // The open tab can be older than the row: published elsewhere since, this
    // editor still shows Save, and the RPC is what stops the write.
    const refusal=Object.assign(new Error("Update document: published document requires a new version or archive"),{code:"55000"});
    const p=view({onUpdateDocument:vi.fn().mockRejectedValue(refusal)});
    openDocumentEditor(/Steward guide/);
    fireEvent.click(screen.getByRole("button",{name:"Save"}));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en","hub.publishedSaveBlocked"));
    expect(screen.queryByText(/requires a new version or archive$/)).not.toBeInTheDocument();
    expect(p.onUpdateDocument).toHaveBeenCalledWith("d2",expect.anything(),"save");
  });

  it("shows the published lock in Spanish when a stale save is refused",async()=>{
    const refusal=Object.assign(new Error("Update document: published document requires a new version or archive"),{code:"55000"});
    const p=view({onUpdateDocument:vi.fn().mockRejectedValue(refusal)},"es");
    fireEvent.click(screen.getByRole("button",{name:t("es","hub.tab.library")}));
    fireEvent.click(screen.getByRole("button",{name:/Steward guide/}));
    fireEvent.click(screen.getByRole("button",{name:t("es","hub.edit")}));
    fireEvent.click(screen.getByRole("button",{name:t("es","hub.save")}));
    const alert=await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("es","hub.publishedSaveBlocked"));
    expect(alert).not.toHaveTextContent("published document requires");
    expect(p.onUpdateDocument).toHaveBeenCalledWith("d2",expect.anything(),"save");
  });

  it("still surfaces an unrelated save failure unchanged",async()=>{
    // Only 55000 is remapped to the published-lock sentence. Any other code
    // must not inherit that explanation, and the dialog must not paint the
    // driver's English either — catalogue copy is the remaining fallback.
    const p=view({onUpdateDocument:vi.fn().mockRejectedValue(Object.assign(new Error("Update document: chapter required"),{code:"42501"}))});
    openDocumentEditor(/Steward guide/);
    fireEvent.click(screen.getByRole("button",{name:"Save"}));
    const alert=await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("en","hub.saveFailed"));
    expect(alert).not.toHaveTextContent(t("en","hub.publishedSaveBlocked"));
    expect(alert).not.toHaveTextContent("chapter required");
    expect(p.onUpdateDocument).toHaveBeenCalled();
  });

  it("keeps a tokenised refusal as its own translated sentence",async()=>{
    const refusal=Object.assign(new Error("Update document: this event was cancelled"),{details:"scan_code_used"});
    const p=view({onUpdateDocument:vi.fn().mockRejectedValue(refusal)},"es");
    fireEvent.click(screen.getByRole("button",{name:t("es","hub.tab.library")}));
    fireEvent.click(screen.getByRole("button",{name:/Steward guide/}));
    fireEvent.click(screen.getByRole("button",{name:t("es","hub.edit")}));
    fireEvent.click(screen.getByRole("button",{name:t("es","hub.save")}));
    const alert=await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("es","rpcError.scan_code_used"));
    expect(alert).not.toHaveTextContent(t("es","hub.saveFailed"));
    expect(alert).not.toHaveTextContent(t("es","hub.publishedSaveBlocked"));
    expect(alert.textContent).not.toMatch(/cancelled|Steward guide/i);
    expect(p.onUpdateDocument).toHaveBeenCalled();
  });

  it("shows catalogue copy when republish is refused under es",async()=>{
    const p=view({onUpdateDocument:vi.fn().mockRejectedValue(new Error('new row violates row-level security policy for table "chapter_spaces"'))},"es");
    fireEvent.click(screen.getByRole("button",{name:t("es","hub.tab.library")}));
    fireEvent.click(screen.getByRole("button",{name:/Policy/}));
    fireEvent.click(screen.getByRole("button",{name:t("es","hub.edit")}));
    fireEvent.click(screen.getByRole("button",{name:t("es","hub.republish")}));
    const alert=await screen.findByRole("alert");
    expect(alert).toHaveTextContent(t("es","hub.saveFailed"));
    expect(alert.textContent).not.toMatch(/row-level security|chapter_spaces/i);
    expect(p.onUpdateDocument).toHaveBeenCalled();
  });

  it("explains the published lock in Spanish too",()=>{
    view({},"es");
    fireEvent.click(screen.getByRole("button",{name:"Biblioteca"}));
    fireEvent.click(screen.getByRole("button",{name:/Policy/}));
    fireEvent.click(screen.getByRole("button",{name:"Editar"}));
    expect(screen.queryByRole("button",{name:"Guardar"})).not.toBeInTheDocument();
    expect(screen.getByText(/no se puede editar en silencio/)).toBeInTheDocument();
    expect(screen.getByRole("button",{name:"Publicar nueva versión"})).toBeInTheDocument();
  });
});

describe("chapter handshake lifecycle UI", () => {
  it("lets staff send a draft handshake and accept a sent one", async () => {
    const onUpdateHandshake = vi.fn().mockResolvedValue({});
    view({
      preview: true,
      onUpdateHandshake,
      data: {
        member: { id: "u1", initials: "U" },
        roles: ["admin"],
        product: {
          ...product,
          handshakes: [
            { id: "h-draft", title: "Home care referral sheet", purpose: "Draft form", data_scope: "docs_only", status: "draft", union_orgs: { name: "Riverside Home Care Workers Chapter" } },
            { id: "h-sent", title: "Cape weekend coverage notes", purpose: "Sent sheet", data_scope: "docs_only", status: "requested", union_orgs: { name: "Harborview Care Cape Chapter" } },
            { id: "h-accepted", title: "Boston overtime rota", purpose: "Accepted sheet", data_scope: "docs_only", status: "accepted", union_orgs: { name: "Harborview Care Boston Chapter" } },
          ],
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Partners" }));
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByText("Accepted")).toBeInTheDocument();
    expect(screen.getByText("Sent — waiting for the partner to countersign.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onUpdateHandshake).toHaveBeenCalledWith("h-draft", "requested", "draft"));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(onUpdateHandshake).toHaveBeenCalledWith("h-sent", "accepted", "requested"));
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(onUpdateHandshake).toHaveBeenCalledWith("h-accepted", "active", "accepted"));
  });

  it("shows live two-sided actions only to the chapter responsible for the next transition", async () => {
    const onUpdateHandshake = vi.fn().mockResolvedValue({});
    view({
      onUpdateHandshake,
      data: {
        member: { id: "u1", initials: "U", chapterId: "chapter-a" },
        roles: ["admin"],
        product: {
          ...product,
          handshakes: [
            { id: "h-inbound", chapter_id: "chapter-b", receiving_chapter_id: "chapter-a", title: "Inbound", purpose: "Review", data_scope: "docs_only", status: "requested", union_orgs: { name: "Partner B" } },
            { id: "h-outbound", chapter_id: "chapter-a", receiving_chapter_id: "chapter-b", title: "Outbound", purpose: "Waiting", data_scope: "docs_only", status: "requested", union_orgs: { name: "Partner B" } },
            { id: "h-accepted-outbound", chapter_id: "chapter-a", receiving_chapter_id: "chapter-b", title: "Accepted outbound", purpose: "Countersign", data_scope: "docs_only", status: "accepted", union_orgs: { name: "Partner B" } },
            { id: "h-accepted-inbound", chapter_id: "chapter-b", receiving_chapter_id: "chapter-a", title: "Accepted inbound", purpose: "Waiting", data_scope: "docs_only", status: "accepted", union_orgs: { name: "Partner B" } },
          ],
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Partners" }));
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Decline" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Activate" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(onUpdateHandshake).toHaveBeenCalledWith("h-inbound", "accepted", "requested"));
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(onUpdateHandshake).toHaveBeenCalledWith("h-accepted-outbound", "active", "accepted"));
  });

  it("does not expose handshake lifecycle controls to a member", () => {
    view({
      onUpdateHandshake: vi.fn(),
      data: {
        member: { id: "u1", initials: "U" },
        roles: [],
        product: {
          ...product,
          handshakes: [
            { id: "h-sent", title: "Cape weekend coverage notes", purpose: "Sent sheet", data_scope: "docs_only", status: "requested", union_orgs: { name: "Harborview Care Cape Chapter" } },
          ],
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Partners" }));
    expect(screen.queryByRole("button", { name: "Start handshake" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });
});
