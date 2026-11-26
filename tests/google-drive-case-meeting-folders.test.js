// @vitest-environment node
// REQ-UG-DRIVE-PER-CASE-FOLDERS-20261001: Drive uploads filed into a case
// or meeting folder. The route asks authorize_google_drive_filing (never the
// plain operation gate) for a target, resolves Cases/<case> or Meetings/<meeting>
// under the authorized root, creates folders only on upload, and keeps the
// download parent check on the target folder.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { filingTarget } from "../api/google-drive.js";
import { resolveGoogleDriveChildFolder, resolveGoogleDriveFilingFolder } from "../api/_lib/googleDrive.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const backendUrl = SUPABASE_ORIGIN;
let fetcher;
let queued;
let reservations;

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

async function invoke({ query = { action: "list" }, body } = {}) {
  const response = {
    statusCode: 0, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = value === undefined ? undefined : JSON.parse(value); },
  };
  await handler({ method: "POST", query, body, headers: {
    host: PORTAL_HOST, origin: PORTAL_ORIGIN, authorization: "Bearer member-token",
  } }, response);
  return response;
}

const caseTarget = { kind: "case", id: "11111111-2222-4333-8444-555555555555" };
const authorization = {
  organizationId: "org-1", rootFolderId: "root1", rateLimited: false,
  targetKind: "case", targetId: caseTarget.id, groupFolderName: "Cases", folderName: "Case GR-7 · 11111111",
};

function authorized() {
  queued.push(reply(authorization), reply({ refreshToken: "refresh", rootFolderId: "root1" }), reply({ access_token: "access" }));
}

beforeEach(() => {
  for (const [key, value] of Object.entries({
    VITE_SUPABASE_URL: backendUrl, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture", GOOGLE_DRIVE_CLIENT_ID: "client",
    GOOGLE_DRIVE_CLIENT_SECRET: "secret", GOOGLE_DRIVE_REDIRECT_URI: `${PORTAL_ORIGIN}/api/google-drive?action=callback`,
  })) vi.stubEnv(key, value);
  queued = [];
  reservations = new Map();
  fetcher = vi.fn((url, options) => {
    if (String(url).endsWith('/rpc/reserve_google_drive_filing_folder')) {
      const args = JSON.parse(options.body);
      const key = `${args.p_organization_id}:${args.p_root_folder_id}:${args.p_target_key}`;
      if (!reservations.has(key) && args.p_proposed_folder_id) reservations.set(key, args.p_proposed_folder_id);
      return Promise.resolve(reply({ folderId: reservations.get(key) || null }));
    }
    if (queued.length) return Promise.resolve(queued.shift());
    throw new Error("Unexpected external request");
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("filing target parsing", () => {
  it("accepts only a case or meeting with a bounded id", () => {
    expect(filingTarget({})).toBeNull();
    expect(filingTarget({ target: null })).toBeNull();
    expect(filingTarget({ target: { kind: "meeting", id: "evt-1" } })).toEqual({ kind: "meeting", id: "evt-1" });
    for (const target of [{ kind: "member", id: "x" }, { kind: "case", id: "" }, { kind: "case", id: 7 }, { kind: "case", id: "x".repeat(201) }, "case"]) {
      expect(() => filingTarget({ target })).toThrow(/invalid filing target/);
    }
  });

  it("answers 400 for a malformed target before any authorization", async () => {
    const response = await invoke({ body: { target: { kind: "member", id: "x" } } });
    expect(response).toMatchObject({ statusCode: 400, body: { error: "invalid google drive request" } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("case and meeting folders", () => {
  it("lists every provider page under the authorized case folder", async () => {
    authorized();
    queued.push(reply({ files: [{ id: "casesGroup" }] }), reply({ files: [{ id: "caseFolder" }] }),
      reply({ files: Array.from({ length: 100 }, (_, i) => ({ id: `recent-${i}` })), nextPageToken: "older" }),
      reply({ files: [{ id: "older-file-101" }] }));
    const response = await invoke({ body: { target: caseTarget } });
    expect(response.statusCode).toBe(200);
    expect(response.body.files).toHaveLength(101);
    expect(response.body.files[100].id).toBe("older-file-101");
    const pages = fetcher.mock.calls.map(([url]) => new URL(url))
      .filter(url => url.searchParams.get("orderBy") === "modifiedTime desc");
    expect(pages.map(url => url.searchParams.get("q")))
      .toEqual(["'caseFolder' in parents and trashed=false", "'caseFolder' in parents and trashed=false"]);
  });

  it("returns an honest error when a later folder page fails, without partial files", async () => {
    authorized();
    queued.push(reply({ files: [{ id: "casesGroup" }] }), reply({ files: [{ id: "caseFolder" }] }),
      reply({ files: [{ id: "first-page" }], nextPageToken: "older" }), reply({ error: "unavailable" }, 503));
    const response = await invoke({ body: { target: caseTarget } });
    expect(response).toMatchObject({ statusCode: 503, body: { error: "google drive request failed" } });
    expect(response.body).not.toHaveProperty("files");
  });

  it("authorizes the target through authorize_google_drive_filing and lists an empty, not-yet-created folder", async () => {
    authorized();
    queued.push(reply({ files: [] }));
    const response = await invoke({ body: { target: caseTarget } });
    expect(response).toMatchObject({ statusCode: 200, body: { files: [] } });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(`${backendUrl}/rest/v1/rpc/authorize_google_drive_filing`);
    expect(JSON.parse(options.body)).toEqual({ p_action: "list", p_target_kind: "case", p_target_id: caseTarget.id });
    const folderQuery = new URL(fetcher.mock.calls.find(([url]) => String(url).includes("/drive/v3/files"))[0]).searchParams.get("q");
    expect(folderQuery).toContain("name='Cases'");
    expect(folderQuery).toContain("'root1' in parents");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("creates Cases and the case folder on upload and uploads into the case folder", async () => {
    authorized();
    queued.push(reply({ files: [] }), reply({ ids: ["casesGroup"] }), reply({ id: "casesGroup" }), reply({ files: [] }), reply({ ids: ["caseFolder"] }), reply({ id: "caseFolder" }), reply({ id: "file1", name: "notes.pdf" }));
    const response = await invoke({
      query: { action: "upload" },
      body: { target: caseTarget, name: "notes.pdf", mimeType: "application/pdf", contentBase64: Buffer.from("pdf").toString("base64") },
    });
    expect(response.statusCode).toBe(200);
    const creates = fetcher.mock.calls.filter(([url, options]) => String(url).includes('/drive/v3/files?fields=id') && options.method === 'POST');
    const createGroup = JSON.parse(creates[0][1].body);
    expect(createGroup).toMatchObject({ name: "Cases", parents: ["root1"] });
    const createCase = JSON.parse(creates[1][1].body);
    expect(createCase).toMatchObject({ name: "Case GR-7 · 11111111", parents: ["casesGroup"] });
    expect(fetcher.mock.calls.find(([url]) => String(url).includes("uploadType=multipart"))[1].body.toString()).toContain('"parents":["caseFolder"]');
  });

  it("refuses a download from a case folder that does not exist yet", async () => {
    authorized();
    queued.push(reply({ files: [] }));
    const response = await invoke({ query: { action: "download" }, body: { target: caseTarget, fileId: "file1" } });
    expect(response.statusCode).toBe(404);
  });

  it("checks a download's parent against the target folder, not the shared root", async () => {
    authorized();
    queued.push(reply({ files: [{ id: "casesGroup" }] }), reply({ files: [{ id: "caseFolder" }] }), reply({ id: "file1", parents: ["root1"], size: "3" }));
    const response = await invoke({ query: { action: "download" }, body: { target: caseTarget, fileId: "file1" } });
    expect(response.statusCode).toBe(404);
  });

  it("passes a rate-limited or refused target through as the public failure", async () => {
    queued.push(reply({ rateLimited: true, action: "list" }));
    expect((await invoke({ body: { target: caseTarget } })).statusCode).toBe(429);
    queued.push(reply({ code: "42501", message: "restricted case files stay in Union Ground" }, 403));
    expect(await invoke({ body: { target: caseTarget } })).toMatchObject({ statusCode: 403, body: { error: "not authorized" } });
  });
});

describe("folder helpers", () => {
  it("finds an existing child folder and never creates when asked not to", async () => {
    const local = vi.fn().mockResolvedValueOnce(reply({ files: [{ id: "existing" }] })).mockResolvedValueOnce(reply({ files: [] }));
    expect(await resolveGoogleDriveChildFolder({ fetchImpl: local, accessToken: "a", parentId: "root1", name: "Meetings" })).toBe("existing");
    expect(await resolveGoogleDriveChildFolder({ fetchImpl: local, accessToken: "a", parentId: "root1", name: "Meetings" })).toBe("");
    expect(local).toHaveBeenCalledTimes(2);
  });

  it("strips path and control characters from names and escapes quotes in the query", async () => {
    const local = vi.fn().mockResolvedValueOnce(reply({ files: [] })).mockResolvedValueOnce(reply({ ids: ['made'] })).mockResolvedValueOnce(reply({ id: "made" }));
    await resolveGoogleDriveChildFolder({ fetchImpl: local, accessToken: "a", parentId: "root1", name: "Case O'Brien/a\u0007b", create: true, reserveFolder: async ({ proposedId }) => proposedId });
    expect(new URL(local.mock.calls[0][0]).searchParams.get("q")).toContain("name='Case O\\'Brien a b'");
    expect(JSON.parse(local.mock.calls[2][1].body).name).toBe("Case O'Brien a b");
  });

  it("refuses an invalid parent id or empty name", async () => {
    await expect(resolveGoogleDriveChildFolder({ fetchImpl: vi.fn(), accessToken: "a", parentId: "../x", name: "Cases" })).rejects.toThrow(/invalid-google-drive-folder/);
    await expect(resolveGoogleDriveChildFolder({ fetchImpl: vi.fn(), accessToken: "a", parentId: "root1", name: "   " })).rejects.toThrow(/invalid-google-drive-folder/);
  });

  it("stops at a missing group folder without creating it", async () => {
    const local = vi.fn().mockResolvedValueOnce(reply({ files: [] }));
    expect(await resolveGoogleDriveFilingFolder({ fetchImpl: local, accessToken: "a", rootFolderId: "root1", groupFolderName: "Meetings", folderName: "Meeting 2026-10-05 · Rally · abc123" })).toBe("");
    expect(local).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when Google creates a folder without an id", async () => {
    const local = vi.fn().mockResolvedValueOnce(reply({ files: [] })).mockResolvedValueOnce(reply({}));
    await expect(resolveGoogleDriveChildFolder({ fetchImpl: local, accessToken: "a", parentId: "root1", name: "Cases", create: true, reserveFolder: async ({ proposedId }) => proposedId })).rejects.toThrow(/incomplete/);
  });
});

describe("durable folder creation", () => {
  it("converges concurrent uploads and a restarted retry on one folder ID", async () => {
    let reserved = null;
    let generated = 0;
    const created = new Map();
    const reserveFolder = async ({ proposedId }) => {
      if (!reserved && proposedId) reserved = proposedId;
      return reserved;
    };
    const transport = vi.fn(async (url, options = {}) => {
      if (String(url).includes('/generateIds')) return reply({ ids: [`id${++generated}`] });
      if (options.method === 'POST') {
        const folder = JSON.parse(options.body);
        if (created.has(folder.id)) return reply({ error: { status: 'ALREADY_EXISTS' } }, 409);
        created.set(folder.id, folder);
        return reply({ id: folder.id });
      }
      if (String(url).includes('?fields=id,mimeType,parents,trashed')) return reply({ ...created.get(reserved), trashed: false });
      return reply({ files: [] });
    });
    const input = { fetchImpl: transport, accessToken: 'a', parentId: 'root1', name: 'Cases', create: true, reserveFolder };
    const ids = await Promise.all([resolveGoogleDriveChildFolder(input), resolveGoogleDriveChildFolder(input)]);
    expect(ids).toEqual([reserved, reserved]);
    expect(created.size).toBe(1);
    expect(await resolveGoogleDriveChildFolder(input)).toBe(reserved);
    expect(created.size).toBe(1);
  });

  it("refuses a conflict whose existing folder is in another parent", async () => {
    const local = vi.fn().mockResolvedValueOnce(reply({ error: { status: 'ALREADY_EXISTS' } }, 409))
      .mockResolvedValueOnce(reply({ id: 'reserved', mimeType: 'application/vnd.google-apps.folder', parents: ['foreign'], trashed: false }));
    await expect(resolveGoogleDriveChildFolder({ fetchImpl: local, accessToken: 'a', parentId: 'root1', name: 'Cases', create: true,
      reserveFolder: async () => 'reserved' })).rejects.toThrow(/reservation-mismatch/);
  });
});
