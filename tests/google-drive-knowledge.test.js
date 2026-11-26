// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_DRIVE_SCOPE,
  buildGoogleDriveAuthorizationUrl,
  buildGoogleDriveOauthMaterial,
  downloadGoogleDriveFile,
  ensureGoogleDriveRootFolder,
  exchangeGoogleDriveCode,
  listGoogleDriveFiles,
  readGoogleDriveAccountEmail,
  uploadGoogleDriveFile,
} from "../api/_lib/googleDrive.js";
import { decodeBoundedBase64 } from "../api/google-drive.js";

function response(body, { ok = true, status = 200 } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok, status, text: async () => text, arrayBuffer: async () => Buffer.from(text) };
}

describe("Google Drive knowledge connector", () => {
  it("builds unpredictable PKCE material and a least-privilege consent URL", () => {
    const first = buildGoogleDriveOauthMaterial();
    const second = buildGoogleDriveOauthMaterial();
    expect(first.state).not.toBe(second.state);
    expect(first.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
    const url = new URL(buildGoogleDriveAuthorizationUrl({
      clientId: "client", redirectUri: "https://app.unionground.test/api/google-drive?action=callback",
      state: first.state, codeChallenge: first.codeChallenge,
    }));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_DRIVE_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("requires a refresh token from the one-time authorization exchange", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ access_token: "access-only" }));
    await expect(exchangeGoogleDriveCode({
      fetchImpl, clientId: "client", clientSecret: "secret", code: "code",
      codeVerifier: "verifier", redirectUri: "https://app.unionground.test/callback",
    })).rejects.toThrow("google-drive-code-exchange-incomplete");
    const submitted = fetchImpl.mock.calls[0][1].body;
    expect(submitted.get("code_verifier")).toBe("verifier");
  });

  it("returns the verified connected account email and rejects unusable identity claims", async () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = (claims) => `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
    const valid = {
      iss: "https://accounts.google.com", aud: "client", email_verified: true,
      email: "Steward@Example.Test", exp: Math.floor(Date.now() / 1000) + 300,
    };
    expect(readGoogleDriveAccountEmail(token(valid), { clientId: "client" })).toBe("steward@example.test");
    expect(readGoogleDriveAccountEmail(token({ ...valid, iss: "accounts.google.com" }), { clientId: "client" })).toBe("steward@example.test");
    for (const claims of [
      { ...valid, iss: "https://accounts.evil.test" },
      { ...valid, aud: "other-client" },
      { ...valid, exp: Math.floor(Date.now() / 1000) - 1 },
      { ...valid, email_verified: false },
      { ...valid, email: "not-an-email" },
      { ...valid, email: `${"a".repeat(320)}@example.test` },
    ]) {
      expect(readGoogleDriveAccountEmail(token(claims), { clientId: "client" })).toBe("");
    }
    expect(readGoogleDriveAccountEmail(token(valid), {})).toBe("");
    expect(readGoogleDriveAccountEmail("not.a.jwt", { clientId: "client" })).toBe("");
    expect(readGoogleDriveAccountEmail(undefined, { clientId: "client" })).toBe("");
  });

  it("carries the connected account email out of the authorization exchange", async () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const fetchImpl = vi.fn().mockResolvedValue(response({
      access_token: "access", refresh_token: "refresh", scope: "drive.file",
      id_token: `${encode({ alg: "RS256" })}.${encode({
        iss: "https://accounts.google.com", aud: "client", email_verified: true,
        email: "steward@example.test", exp: Math.floor(Date.now() / 1000) + 300,
      })}.signature`,
    }));
    await expect(exchangeGoogleDriveCode({
      fetchImpl, clientId: "client", clientSecret: "secret", code: "code",
      codeVerifier: "verifier", redirectUri: "https://app.unionground.test/callback",
    })).resolves.toMatchObject({ refreshToken: "refresh", accountEmail: "steward@example.test" });
  });

  it("reuses or creates only the bounded Union Ground resources folder", async () => {
    const existingFetch = vi.fn().mockResolvedValue(response({ files: [{ id: "folder-1" }] }));
    await expect(ensureGoogleDriveRootFolder({ fetchImpl: existingFetch, accessToken: "token" })).resolves.toBe("folder-1");

    const createFetch = vi.fn()
      .mockResolvedValueOnce(response({ files: [] }))
      .mockResolvedValueOnce(response({ id: "folder-2" }));
    await expect(ensureGoogleDriveRootFolder({ fetchImpl: createFetch, accessToken: "token" })).resolves.toBe("folder-2");
    expect(JSON.parse(createFetch.mock.calls[1][1].body)).toEqual({
      name: "Union Ground resources",
      mimeType: "application/vnd.google-apps.folder",
    });
  });

  it("bounds list projections and sanitizes multipart uploads", async () => {
    const listFetch = vi.fn().mockResolvedValue(response({ files: [{
      id: "file-1", name: "x".repeat(250), mimeType: "text/plain", size: "12",
      modifiedTime: "2026-08-29T00:00:00Z", webViewLink: "javascript:bad",
    }] }));
    const files = await listGoogleDriveFiles({ fetchImpl: listFetch, accessToken: "token", rootFolderId: "folder-1" });
    expect(files[0]).toMatchObject({ id: "file-1", size: 12, webViewLink: null });
    expect(files[0].name).toHaveLength(200);

    const uploadFetch = vi.fn().mockResolvedValue(response({ id: "uploaded" }));
    await uploadGoogleDriveFile({
      fetchImpl: uploadFetch, accessToken: "token", rootFolderId: "folder-1",
      name: "../unsafe\nname.txt", mimeType: "text/plain", bytes: Buffer.from("safe"),
    });
    const multipart = uploadFetch.mock.calls[0][1].body.toString("utf8");
    expect(multipart).toContain("..-unsafe-name.txt");
    expect(multipart).toContain('"parents":["folder-1"]');

    const sanitizedMimeFetch = vi.fn().mockResolvedValue(response({ id: "uploaded-2" }));
    await uploadGoogleDriveFile({
      fetchImpl: sanitizedMimeFetch, accessToken: "token", rootFolderId: "folder-1",
      name: "safe.txt", mimeType: "text/plain\r\nInjected: yes", bytes: Buffer.from("safe"),
    });
    expect(sanitizedMimeFetch.mock.calls[0][1].body.toString("utf8"))
      .toContain("Content-Type: application/octet-stream");
  });

  it("strictly validates the serverless base64 upload envelope", () => {
    expect(decodeBoundedBase64("c2FmZQ==")?.toString()).toBe("safe");
    expect(decodeBoundedBase64("not base64!!")).toBeNull();
    expect(decodeBoundedBase64("A".repeat(Math.ceil((3 * 1024 * 1024) / 3) * 4 + 4))).toBeNull();
  });

  it("rejects malformed IDs and oversized downloads", async () => {
    await expect(downloadGoogleDriveFile({ accessToken: "token", fileId: "../bad", rootFolderId: "folder-1" }))
      .rejects.toThrow("invalid-google-drive-file-id");
    const fetchImpl = vi.fn().mockResolvedValue(response({
      id: "valid_id", parents: ["folder-1"], size: String(3 * 1024 * 1024 + 1),
    }));
    const download = downloadGoogleDriveFile({
      fetchImpl, accessToken: "token", fileId: "valid_id", rootFolderId: "folder-1",
    });
    await expect(download).rejects.toMatchObject({ message: "google-drive-download-too-large", status: 413 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("downloads only direct children of the configured organization folder", async () => {
    const outsideFetch = vi.fn().mockResolvedValue(response({
      id: "valid_id", parents: ["another-folder"], size: "4",
    }));
    await expect(downloadGoogleDriveFile({
      fetchImpl: outsideFetch, accessToken: "token", fileId: "valid_id", rootFolderId: "folder-1",
    })).rejects.toMatchObject({ message: "google-drive-download-outside-root", status: 404 });

    const insideFetch = vi.fn()
      .mockResolvedValueOnce(response({ id: "valid_id", parents: ["folder-1"], size: "4" }))
      .mockResolvedValueOnce(response("safe"));
    await expect(downloadGoogleDriveFile({
      fetchImpl: insideFetch, accessToken: "token", fileId: "valid_id", rootFolderId: "folder-1",
    })).resolves.toEqual(Buffer.from("safe"));
    expect(insideFetch).toHaveBeenCalledTimes(2);
  });
});
