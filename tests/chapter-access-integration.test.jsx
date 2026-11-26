import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

vi.mock("../src/features/chapterAccess/DraftSharingPanel.jsx", () => ({ DraftSharingPanel: ({ formId }) => <section aria-label={`Sharing ${formId}`} />, DraftSharingUnavailable: () => <p>Sharing unavailable</p> }));
vi.mock("../src/features/chapterAccess/ChapterAccessPanel.jsx", () => ({ ChapterAccessPanel: ({ chapterId }) => <section aria-label={`Leadership ${chapterId}`} /> }));
vi.mock("../src/features/chapterAccess/ChapterOfficePanel.jsx", () => ({ ChapterOfficePanel: ({ chapterId }) => <section aria-label={`Office ${chapterId}`} /> }));
vi.mock("../src/features/institutionalRecords/InstitutionalRecordsPanel.jsx", () => ({ InstitutionalRecordsPanel: () => <section aria-label="Records" /> }));
vi.mock("../src/components/ChapterBudgetPanel.jsx", () => ({ ChapterBudgetPanel: () => null }));
vi.mock("../src/features/finance/ChapterFinancePanel.jsx", () => ({ ChapterFinancePanel: ({ canAuthor }) => <section aria-label="Finances" data-authoring={String(canAuthor)} /> }));
const wrap = (view) => <LanguageProvider lang="en">{view}</LanguageProvider>;
const draft = (id, templateKey) => ({ id, templateKey, status: "draft", step: 0, answers: {}, cosigners: [] });

describe("chapter access in the existing product routes", () => {

  it("keeps health-draft editors outside individual steward sharing", () => {
    render(wrap(<FormsView data={{ member: { initials: "FT" }, forms: [draft("health", "fmla_self")] }} draftSharingApi={{}} focus={{ templateKey: "fmla_self", formId: "health" }} onSaveDraft={vi.fn().mockResolvedValue("health")} />));
    expect(screen.queryByRole("region", { name: "Sharing health" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
    expect(screen.getByText("Sharing unavailable")).toBeInTheDocument();
  });

  it.each(["admin", "vp", "member", "secretary", "treasurer", undefined])("keeps leadership controls under the %s hat and makes the office route discoverable", (hat) => {
    const data = { member: { id: "fictional", chapterId: "chapter", organizationId: "org" }, roles: [hat || "member"], product: { spaces: [], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] } };
    render(wrap(<ProductHubView data={data} institutionalClient={{}} connectionActor={hat ? { selectedHat: hat } : null} />));
    fireEvent.click(screen.getByRole("button", { name: "The record" }));
    expect(Boolean(screen.queryByRole("region", { name: "Office chapter" }))).toBe(["admin", "vp", "secretary"].includes(hat));
    expect(Boolean(screen.queryByRole("region", { name: "Leadership chapter" }))).toBe(["admin", "vp"].includes(hat));
    expect(screen.getByRole("region", { name: "Finances" })).toHaveAttribute("data-authoring", String(["admin", "treasurer"].includes(hat)));
  });

  it("keeps office authoring hidden under Member even when the account holds Admin and Secretary", () => {
    const data={member:{id:"fictional",chapterId:"chapter",organizationId:"org"},roles:["admin","secretary"],product:{spaces:[],documents:[],records:[],intake:[],handshakes:[],governance:[],partnerOrgs:[]}};
    const select=vi.fn();
    render(wrap(<ProductHubView data={data} institutionalClient={{}} connectionActor={{selectedHat:"member"}} staffAccess={false} onSelectOfficeRole={select}/>));
    fireEvent.click(screen.getByRole("button",{name:"The record"}));
    expect(screen.queryByRole("region",{name:"Office chapter"})).toBeNull();
    fireEvent.change(screen.getByLabelText("Acting role"),{target:{value:"secretary"}});
    expect(select).toHaveBeenCalledWith("secretary");
  });
});
