// The stale-verdict recovery, end to end through the real client modules.
//
// The other UI suites stub the API layer, so they prove the view reacts to a
// `privateFileCode`. This one proves the code exists in the first place: a real
// Storage 4xx travels through downloadPrivateFileBlob → PrivateFileError
// (staleVerdict) → MemberApiError('stale') → the vault's re-check button →
// exactly one POST to /api/private-files → a successful reopen.
//
// That chain is the whole difference between a member seeing "Re-check this
// file" and a member seeing an unexplained failure on a document they are
// entitled to read, which is what happens when a clean verdict ages out.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CasesView } from "../src/views/CasesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import filesHandler from "../api/sensitive-case-files.js";
import { createClient } from "@supabase/supabase-js";
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
vi.mock("../api/_lib/sensitiveStorage.js", () => ({ createSensitiveStorage: (...args) => createClient(...args).storage.from("case-files") }));
vi.mock("../api/_lib/sensitiveDataCrypto.js", () => ({ sensitiveKeyring: () => ({}) }));
vi.mock("../api/_lib/sensitiveCaseDocuments.js", () => ({
  SENSITIVE_DOCUMENT_MAX_BYTES: 10485760, SENSITIVE_DOCUMENT_CHUNK_BYTES: 1048576, SENSITIVE_DOCUMENT_FULL_READ_MAX_BYTES: 4194304,
  decryptCaseDocument: (bytes) => bytes,
}));
import { memberCaseFileBlob, recheckPrivateFile } from "../src/lib/memberApi.js";

const FILE_ID = "3a9c7e51-6d20-4b8f-9c11-5e7d2f480a63";

const caseRow = {
  id: "case-1", reference: "GR-509", title: "Schedule grievance", type: "Scheduling",
  articles: "Article 8", status: "active", step: "Step 2", deadline: "Aug 20",
  deadlineValue: "2026-08-20", overdue: false,
  updates: [],
  files: [{
    id: FILE_ID, filename: "schedule.pdf", mimeType: "application/pdf", sizeBytes: 4,
    bucketId: "case-files", objectName: "user-1/case-1/file/schedule.pdf",
    createdAt: "2026-08-02T12:00:00Z",
  }],
};

let serverStorageRead;
let serverLedgerRead;
function inspectionServer() {
  const impl = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (_url === "/api/sensitive-case-files") {
      const headers = new Headers();
      const response = { code: 0, body: null, status(code) { this.code = code; return this; },
        setHeader(key, value) { headers.set(key, value); return this; }, end(value) { this.body = value; } };
      await filesHandler({ method: "POST", headers: { host: "localhost", authorization: "Bearer synthetic" }, body }, response);
      return { ok: response.code === 200, status: response.code, headers,
        json: async () => JSON.parse(response.body), arrayBuffer: async () => new Uint8Array(response.body).buffer };

    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ status: "clean", fileId: body.fileId }),
    };
  });
  return impl;
}

// A Storage client that refuses the read until the ledger is refreshed. 403 is
// what the restrictive quarantine policy answers for an authorized caller whose
// clean verdict expired: the row is still theirs, the bytes are simply gated.
// `verdictCurrent` is the read ledger's own answer, and it is per case on
// purpose: the server offers a re-check only when Storage refuses AND the
// ledger agrees the clean verdict has aged out, so a suite that pins the ledger
// to one answer cannot tell that conjunct from "any Storage refusal".
function supabaseStub({ verdictCurrent = false } = {}) {
  let current = false;
  const download = vi.fn(async () => (current
    ? { data: new Blob(["%PDF-1.4"]), error: null }
    : { data: null, error: { message: "Object not accessible", status: 403 }, failure: "denied" }));
  serverStorageRead = download;
  const query = { select: () => query, eq: () => query, single: async () => ({ data: {
    id: FILE_ID, object_name: "synthetic/path", mime_type: "application/pdf",
    member_cases: { organization_id: "synthetic" }, encrypted_content: { dataVersion: "synthetic-version" },
  } }) };
  serverLedgerRead = vi.fn(async () => ({ data: verdictCurrent }));
  vi.mocked(createClient).mockReturnValue({ from: () => query, rpc: (...args) => serverLedgerRead(...args), storage: { from: () => ({ download: () => serverStorageRead() }) } });
  return {
    client: {
      storage: { from: vi.fn(() => ({ download })) },
      auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "member-token" } }, error: null })) },
      rpc: vi.fn(),
    },
    download,
    ledgerRead: serverLedgerRead,
    markClean: () => { current = true; },
  };
}

let popups;
let fetchImpl;

beforeEach(() => {
  popups = [];
  vi.spyOn(window, "open").mockImplementation(() => {
    const popup = { location: "", opener: window, close: vi.fn() };
    popups.push(popup);
    return popup;
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:case-file");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  fetchImpl = inspectionServer();
  vi.stubGlobal("fetch", fetchImpl);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stale private-file verdict recovery", () => {
  it("renders a re-check for a refused read, issues exactly one inspection, and reopens", async () => {
    const stub = supabaseStub();
    render(
      <LanguageProvider lang="en">
        <CasesView
          data={{ cases: [caseRow] }}
          onCreateCase={vi.fn()}
          onUpdateCase={vi.fn()}
          onAddCaseUpdate={vi.fn()}
          onAddCaseFile={vi.fn()}
          onRemoveCaseFile={vi.fn()}
          onOpenCaseFile={(file) => memberCaseFileBlob(stub.client, file)}
          onRecheckCaseFile={(file) => recheckPrivateFile(stub.client, "case", file.id)}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const dialog = screen.getByRole("dialog");

    // 1. The read is refused by the quarantine policy.
    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    expect(await within(dialog).findByRole("alert"))
      .toHaveTextContent("This file needs a fresh safety check before it can open.");
    expect(popups[0].close).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 2. One click, one inspection, carrying nothing but {kind, fileId}.
    stub.markClean();
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Re-check this file(?:: |$)/ }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe("/api/private-files");
    expect(JSON.parse(init.body)).toEqual({ kind: "case", fileId: FILE_ID });
    expect(init.headers.Authorization).toBe("Bearer member-token");
    expect(init.credentials).toBe("omit");
    // No bucket, object name, digest or verdict was ever the caller's to send.
    expect(init.body).not.toMatch(/case-files|objectName|sha256|clean/);

    // 3. The affordance clears and the document opens.
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: /^Re-check this file(?:: |$)/ })).toBeNull());
    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    await waitFor(() => expect(popups[1].location).toBe("blob:case-file"));
    expect(popups[1].opener).toBeNull();
    expect(stub.download).toHaveBeenCalledTimes(2);
    // Two authorized reads and exactly one inspection.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps a genuine outage distinct from a stale verdict, so no re-check is offered", async () => {
    const stub = supabaseStub();
    stub.download.mockResolvedValue({ data: null, error: { message: "bad gateway", status: 502 } });
    render(
      <LanguageProvider lang="en">
        <CasesView
          data={{ cases: [caseRow] }}
          onCreateCase={vi.fn()}
          onUpdateCase={vi.fn()}
          onAddCaseUpdate={vi.fn()}
          onAddCaseFile={vi.fn()}
          onRemoveCaseFile={vi.fn()}
          onOpenCaseFile={(file) => memberCaseFileBlob(stub.client, file)}
          onRecheckCaseFile={vi.fn()}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    await within(dialog).findByRole("alert");
    // A 5xx says nothing about the verdict, so re-checking would be a guess.
    expect(within(dialog).queryByRole("button", { name: /^Re-check this file(?:: |$)/ })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a denied read whose verdict is still current generic, so no re-check is offered", async () => {
    // The same 403 as the first case, but the read ledger answers that the
    // clean verdict has NOT aged out. Re-checking would change nothing, so the
    // member gets the plain unavailable sentence and no affordance. This is the
    // case that tells a ledger-gated 409 apart from one fired by any refusal.
    const stub = supabaseStub({ verdictCurrent: true });
    render(
      <LanguageProvider lang="en">
        <CasesView
          data={{ cases: [caseRow] }}
          onCreateCase={vi.fn()}
          onUpdateCase={vi.fn()}
          onAddCaseUpdate={vi.fn()}
          onAddCaseFile={vi.fn()}
          onRemoveCaseFile={vi.fn()}
          onOpenCaseFile={(file) => memberCaseFileBlob(stub.client, file)}
          onRecheckCaseFile={vi.fn()}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Schedule grievance/ }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^Open(?:: |$)/ }));
    const alert = await within(dialog).findByRole("alert");
    // The generic document failure the 503 produces, not the stale-verdict sentence.
    expect(alert).toHaveTextContent("The document action failed. Try again.");
    expect(alert).not.toHaveTextContent("fresh safety check");
    expect(within(dialog).queryByRole("button", { name: /^Re-check this file(?:: |$)/ })).toBeNull();
    // The ledger was consulted through caller RLS and agreed, which is the only
    // difference between this outcome and the re-check offer above.
    expect(stub.ledgerRead).toHaveBeenCalledWith("sensitive_case_read_current", { p_file_id: FILE_ID });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
