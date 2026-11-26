import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryCard, saveDirectoryCsv } from "../src/components/AdminCommandCenter.jsx";
import { OfficerMemberDirectory } from "../src/components/OfficerMemberDirectory.jsx";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { exportMemberDirectoryCsv, loadAdminMemberDirectory, loadMemberDirectoryAccess } from "../src/lib/memberApi.js";
import { buildSiteGuide } from "../src/lib/siteGuide.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";

// REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030, owner ruling of
// October 30, 2026 (item 4): the export is the directory's own fields for the
// rows the requester sees, built by the server; chapter Presidents and
// Secretary-Treasurers read and export their chapter through the office.

const wrap = (ui, lang = "en") => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);
const PEOPLE = [
  { userId: "u1", fullName: "Ada Stone", initials: "AS", chapterId: "north", chapterName: "North", roles: ["steward"] },
  { userId: "u2", fullName: "Bo Reyes", initials: "BR", chapterId: "north", chapterName: "North", roles: [] },
];
const CONTEXT = { organizationId: "11111111-1111-4111-8111-111111111111", chapterId: "north" };
const CSV = "Full name,Worker since\r\n\"Ada Stone\",\"2019\"\r\n";
const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
});

function stubDownloads() {
  const created = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { created.push(blob); return "blob:directory"; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { created, click };
}

describe("worker directory CSV export", () => {
  it("saves exactly the server's file, with a byte-order mark and a dated name", async () => {
    const { created, click } = stubDownloads();
    const result = saveDirectoryCsv(CSV, { now: new Date(2026, 9, 30, 22, 0) });
    expect(result).toEqual({ filename: "member-directory-2026-10-30.csv", downloaded: true });
    expect(click).toHaveBeenCalledTimes(1);
    expect(created[0].type).toBe("text/csv;charset=utf-8");
    const bytes = new Uint8Array(await created[0].arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toBe(`\uFEFF${CSV}`);
  });

  it("asks the server for the file in the page language and reports the row count", async () => {
    stubDownloads();
    const api = { loadMemberDirectory: vi.fn(), exportMemberDirectory: vi.fn().mockResolvedValue({ csv: CSV, rowCount: 2, scope: "chapter" }) };
    wrap(<DirectoryCard initial={{ items: PEOPLE, nextCursor: null, context: CONTEXT }} api={api} />, "es");
    fireEvent.click(screen.getByRole("button", { name: "Exportar como CSV" }));
    expect(await screen.findByText(t("es", "admin.command.directoryExported", { count: 2 }))).toBeInTheDocument();
    // The export binds to the context the displayed rows were read under.
    expect(api.exportMemberDirectory).toHaveBeenCalledWith(CONTEXT, "es");
  });

  it("names the size limit, a switched campaign and a general failure without saving a file", async () => {
    const { click } = stubDownloads();
    const api = { loadMemberDirectory: vi.fn(), exportMemberDirectory: vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("too large"), { code: "54000" }))
      .mockRejectedValueOnce(Object.assign(new Error("context changed"), { code: "PT409" }))
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "42501" })) };
    wrap(<DirectoryCard initial={{ items: PEOPLE, nextCursor: null, context: CONTEXT }} api={api} />);
    const button = screen.getByRole("button", { name: "Export as CSV" });
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "admin.command.directoryExportTooLarge"));
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(t("en", "admin.command.directoryExportContextChanged")));
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(t("en", "admin.command.directoryExportFailed")));
    expect(click).not.toHaveBeenCalled();
  });

  // "Load more" must not mix a page read under another
  // chapter into the rows on screen or rebind the export to it.
  it("drops the list instead of mixing in a page from a switched campaign", async () => {
    const other = { ...CONTEXT, chapterId: "south" };
    const api = { exportMemberDirectory: vi.fn(),
      loadMemberDirectory: vi.fn().mockResolvedValue({ items: [{ userId: "u9", fullName: "Zed South", initials: "ZS", chapterId: "south", roles: [] }], nextCursor: null, context: other }) };
    wrap(<DirectoryCard initial={{ items: PEOPLE, nextCursor: { name: "Bo Reyes", id: "u2" }, context: CONTEXT, query: "" }} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: t("en", "admin.command.directoryMore") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "admin.command.directoryError"));
    expect(screen.queryByText("Ada Stone")).not.toBeInTheDocument();
    expect(screen.queryByText("Zed South")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export as CSV" })).toBeDisabled();
  });

  it("appends a later page read under the same context and keeps the export bound to it", async () => {
    const api = { exportMemberDirectory: vi.fn().mockResolvedValue({ csv: CSV, rowCount: 3, scope: "chapter" }),
      loadMemberDirectory: vi.fn().mockResolvedValue({ items: [{ userId: "u9", fullName: "Zed North", initials: "ZN", chapterId: "north", roles: [] }], nextCursor: null, context: { ...CONTEXT } }) };
    stubDownloads();
    wrap(<DirectoryCard initial={{ items: PEOPLE, nextCursor: { name: "Bo Reyes", id: "u2" }, context: CONTEXT, query: "" }} api={api} />);
    fireEvent.click(screen.getByRole("button", { name: t("en", "admin.command.directoryMore") }));
    expect(await screen.findByText("Zed North")).toBeInTheDocument();
    expect(screen.getByText("Ada Stone")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export as CSV" }));
    await waitFor(() => expect(api.exportMemberDirectory).toHaveBeenCalledWith(CONTEXT, "en"));
  });

  it("offers no export until a directory page names its context", () => {
    const api = { loadMemberDirectory: vi.fn(), exportMemberDirectory: vi.fn() };
    wrap(<DirectoryCard initial={{ items: PEOPLE, nextCursor: null }} api={api} />);
    expect(screen.getByRole("button", { name: "Export as CSV" })).toBeDisabled();
  });

  it("offers an officer the directory and export without the admin desk links", () => {
    const api = { loadMemberDirectory: vi.fn(), exportMemberDirectory: vi.fn() };
    wrap(<DirectoryCard initial={{ items: PEOPLE, nextCursor: null }} api={api} officer sectionName={null} />);
    const card = screen.getByRole("heading", { name: "Worker directory" }).closest("article");
    expect(within(card).getByText(t("en", "admin.command.directoryOfficerSub"))).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Export as CSV" })).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: "Invite a roster from CSV" })).not.toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: "Invite a worker" })).not.toBeInTheDocument();
  });
});

describe("officer access to the directory", () => {
  const client = (access, page = { items: PEOPLE, nextCursor: null, context: CONTEXT }) => ({
    rpc: vi.fn(async (name) => {
      if (name === "get_member_directory_access") return access;
      if (name === "get_admin_member_directory") return { data: page, error: null };
      throw new Error(`unexpected ${name}`);
    }),
  });

  it("renders nothing for a worker the database does not admit", async () => {
    const backend = client({ data: { canRead: false }, error: null });
    const { container } = wrap(<OfficerMemberDirectory client={backend} />);
    await waitFor(() => expect(backend.rpc).toHaveBeenCalledWith("get_member_directory_access"));
    expect(container).toBeEmptyDOMElement();
    expect(backend.rpc).not.toHaveBeenCalledWith("get_admin_member_directory", expect.anything());
  });

  it("renders nothing before the access probe is deployed", async () => {
    const backend = client({ data: null, error: { code: "PGRST202", message: "not found" } });
    const { container } = wrap(<OfficerMemberDirectory client={backend} />);
    await waitFor(() => expect(backend.rpc).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a Campaign chair or Secretary-Treasurer their campaign's directory with the export", async () => {
    const backend = client({ data: { canRead: true, scope: "chapter", chapterId: "north" }, error: null });
    wrap(<OfficerMemberDirectory client={backend} />);
    expect(await screen.findByText("Ada Stone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export as CSV" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Invite a roster from CSV" })).not.toBeInTheDocument();
  });

  it("offers Retry when the first directory page fails, and loads it on retry", async () => {
    let calls = 0;
    const backend = { rpc: vi.fn(async (name) => {
      if (name === "get_member_directory_access") return { data: { canRead: true, scope: "chapter" }, error: null };
      calls += 1;
      return calls === 1 ? { data: null, error: { code: "08006", message: "connection failure" } } : { data: { items: PEOPLE, nextCursor: null, context: CONTEXT }, error: null };
    }) };
    wrap(<OfficerMemberDirectory client={backend} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(t("en", "admin.command.directoryUnavailable"));
    fireEvent.click(screen.getByRole("button", { name: t("en", "app.tryAgain") }));
    expect(await screen.findByText("Ada Stone")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export as CSV" })).toBeEnabled();
  });

  // A transient probe failure offers Retry; a refusal stays hidden.
  it("offers Retry after a transient access-probe failure and stays hidden on a refusal", async () => {
    let probes = 0;
    const backend = { rpc: vi.fn(async (name) => {
      if (name === "get_member_directory_access") {
        probes += 1;
        return probes === 1 ? { data: null, error: { code: "503", message: "unavailable" } } : { data: { canRead: true, scope: "chapter" }, error: null };
      }
      return { data: { items: PEOPLE, nextCursor: null, context: CONTEXT }, error: null };
    }) };
    wrap(<OfficerMemberDirectory client={backend} />);
    fireEvent.click(await screen.findByRole("button", { name: t("en", "app.tryAgain") }));
    expect(await screen.findByText("Ada Stone")).toBeInTheDocument();

    const refused = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } }) };
    const { container } = wrap(<div data-testid="refused"><OfficerMemberDirectory client={refused} /></div>);
    await waitFor(() => expect(refused.rpc).toHaveBeenCalledTimes(1));
    expect(container.querySelector("[data-testid=refused]")).toBeEmptyDOMElement();
  });

  it("lists the directory on the Campaign chair desk and in the Campaign chair Site guide", () => {
    const page = STAFF_ROLE_NAVIGATION.vp.find((item) => item.key === "vp-member-directory");
    expect(page).toMatchObject({ path: "/m/vp/member-directory", sectionId: "vp-member-directory", labelKey: "admin.command.directoryTitle" });
    for (const lang of ["en", "es"]) {
      const guide = buildSiteGuide({ t: (key, values) => t(lang, key, values), roles: ["vp"] });
      const vp = guide.sections.find((section) => section.key === "vp");
      expect(vp.destinations.map((item) => item.path)).toContain("/m/vp/member-directory");
      expect(vp.body).toContain(t(lang, "admin.command.directoryTitle"));
    }
    const routes = JSON.parse(read("vercel.json")).rewrites;
    expect(routes).toContainEqual({ source: "/m/vp/member-directory", destination: "/index.html" });
  });

  it("puts the officer directory beside the budget in the record tab and on the Campaign chair desk", () => {
    const hub = read("src/views/ProductHubView.jsx");
    expect(hub).toContain("<OfficerMemberDirectory key={`directory:${channelScope}`} client={institutionalClient} />");
    const vp = read("src/views/VpView.jsx");
    expect(vp).toContain('<WorkspaceSection name="vp-member-directory"><OfficerMemberDirectory client={directoryClient} sectionName="vp-member-directory" /></WorkspaceSection>');
  });
});

describe("worker directory export client", () => {
  it("binds the displayed context and the locale, and keeps the server's file", async () => {
    const backend = { rpc: vi.fn().mockResolvedValue({ data: { csv: CSV, rowCount: 1, scope: "organization", chapterId: null }, error: null }) };
    await expect(exportMemberDirectoryCsv(backend, CONTEXT, "fr")).resolves.toEqual({ csv: CSV, rowCount: 1, scope: "organization" });
    expect(backend.rpc).toHaveBeenCalledWith("export_member_directory_csv", { p_expected_org: CONTEXT.organizationId, p_expected_chapter: "north", p_locale: "en" });
    await exportMemberDirectoryCsv(backend, CONTEXT, "es");
    expect(backend.rpc).toHaveBeenLastCalledWith("export_member_directory_csv", { p_expected_org: CONTEXT.organizationId, p_expected_chapter: "north", p_locale: "es" });
  });

  it("refuses a missing context or a malformed export and surfaces the server's code", async () => {
    const unused = { rpc: vi.fn() };
    await expect(exportMemberDirectoryCsv(unused, null, "en")).rejects.toThrow("no directory context");
    expect(unused.rpc).not.toHaveBeenCalled();
    await expect(exportMemberDirectoryCsv({ rpc: vi.fn().mockResolvedValue({ data: { rowCount: 1 }, error: null }) }, CONTEXT)).rejects.toThrow("invalid response");
    await expect(exportMemberDirectoryCsv({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "PT409", message: "directory context changed" } }) }, CONTEXT))
      .rejects.toMatchObject({ code: "PT409" });
  });

  it("carries the context each directory page was read under", async () => {
    const page = await loadAdminMemberDirectory({ rpc: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null, context: CONTEXT }, error: null }) });
    expect(page.context).toEqual(CONTEXT);
    const legacy = await loadAdminMemberDirectory({ rpc: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null }, error: null }) });
    expect(legacy.context).toBeNull();
  });

  it("reads access as a boolean and a known scope only", async () => {
    await expect(loadMemberDirectoryAccess({ rpc: vi.fn().mockResolvedValue({ data: { canRead: true, scope: "chapter" }, error: null }) }))
      .resolves.toEqual({ canRead: true, scope: "chapter" });
    await expect(loadMemberDirectoryAccess({ rpc: vi.fn().mockResolvedValue({ data: { canRead: "yes", scope: "everything" }, error: null }) }))
      .resolves.toEqual({ canRead: false, scope: null });
  });
});
