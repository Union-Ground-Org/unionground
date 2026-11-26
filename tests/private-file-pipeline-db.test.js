import sensitiveFilesHandler from "../api/sensitive-case-files.js";
// @vitest-environment node
import { X509Certificate, createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createServer } from "node:tls";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { expect, it, vi } from "vitest";
import handler from "../api/private-files.js";
import { privateFileScannerPolicy, scanPrivateFileWithClamd } from "../api/_lib/privateFileScanner.js";
import { CANARY_CLEAN, CANARY_EICAR, SCANNER_CLIENT_IDENTITIES, scannerProofDirectoryPattern } from "../scripts/prepare-private-file-scanner-proof.mjs";
import { pinnedSampleSupabaseOrigin } from "../src/lib/sampleBackend.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.RUN_PRIVATE_FILE_PIPELINE_DB_TESTS === "1" ? it : it.skip;

databaseIt("scans owned SaaS bytes through real Auth, authorization, inspection and ClamAV; refuses the unprovisioned demo", async () => {
  expect(process.env.PRIVATE_FILE_PIPELINE_DISPOSABLE_CONFIRM).toBe("reset-after-proof");
  const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const status = JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, "utf8"));
  const api = new URL(status.API_URL);
  expect(["127.0.0.1", "localhost"]).toContain(api.hostname);
  expect(Number(api.port)).toBe(Number(new URL(connectionString).port) - 1);
  const certDirectory = process.env.PRIVATE_FILE_PIPELINE_SCANNER_DIR;
  // scripts/prepare-private-file-scanner-proof.mjs anchors the fixture directory
  // to $RUNNER_TEMP on a runner and /tmp otherwise; the name prefix stays pinned.
  expect(certDirectory).toMatch(scannerProofDirectoryPattern());
  const clamdPort = Number(process.env.PRIVATE_FILE_PIPELINE_CLAMD_PORT);
  expect(clamdPort).toBeGreaterThan(1024);
  expect(clamdPort).toBeLessThan(65536);
  expect(CANARY_EICAR.length).toBe(68);
  // Keep the real SAMPLE project allowlist intact. Rewrite only its transport
  // to this owned loopback server; refuse every other outbound origin. This
  // exercises host/backend selection without ever contacting a hosted database.
  const sampleOrigin = pinnedSampleSupabaseOrigin();
  const localFetch = globalThis.fetch;
  const sampleRequests = [];
  const localRequests = [];
  vi.stubGlobal("fetch", (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === sampleOrigin) {
      sampleRequests.push(url.pathname);
      url.protocol = api.protocol;
      url.host = api.host;
    }
    if (url.origin !== api.origin) throw new Error("pipeline proof refused a non-disposable fetch");
    localRequests.push(url.pathname);
    const routed = input instanceof Request ? new Request(url, input) : url.toString();
    return localFetch(routed, init);
  });
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
  const caller = createClient(status.API_URL, status.ANON_KEY, options);
  const sql = new pg.Client({ connectionString });
  const ids = { org: randomUUID(), case: randomUUID(), task: randomUUID(), form: randomUUID() };
  const chapter = `pipeline-${ids.org}`;
  const files = [];
  const results = [];
  const demoRefusals = [];
  const surfaces = [];
  const authorizedClients = new Set(Object.values(SCANNER_CLIENT_IDENTITIES));
  const acceptedConnections = Object.fromEntries([...authorizedClients].map((identity) => [identity, 0]));
  const sockets = new Set();
  // Production terminates with ONE server keypair behind TWO listeners, each
  // with its own client SAN allowlist (ghostunnel --allow-dns). That is what
  // makes one PRIVATE_FILE_SCANNER_EXPECTED_SPKI serve both surfaces while each
  // surface's client certificate stays independently revocable — H7's
  // acceptance criterion. The proof builds the same shape: verifying the chain
  // alone would only prove "our CA signed something".
  const terminator = (allowedIdentity) => createServer({
    key: readFileSync(join(certDirectory, "server.key")), cert: readFileSync(join(certDirectory, "server.crt")),
    ca: readFileSync(join(certDirectory, "ca.crt")), requestCert: true, rejectUnauthorized: true,
  }, (socket) => {
    sockets.add(socket);
    const names = String(socket.getPeerCertificate()?.subjectaltname || "")
      .split(",").map((entry) => entry.trim());
    if (!names.includes(`DNS:${allowedIdentity}`) || !authorizedClients.has(allowedIdentity)) { socket.destroy(); return; }
    acceptedConnections[allowedIdentity] += 1;
    const upstream = connect({ host: "127.0.0.1", port: clamdPort });
    sockets.add(upstream);
    socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
    socket.on("close", () => { sockets.delete(socket); upstream.destroy(); });
    upstream.on("close", () => sockets.delete(upstream));
    socket.pipe(upstream); upstream.pipe(socket);
  });
  const tls = terminator(SCANNER_CLIENT_IDENTITIES.production);
  const sampleTls = terminator(SCANNER_CLIENT_IDENTITIES.sample);
  await sql.connect();
  let userId;
  let transaction = false;
  let proofFailure;
  const rpc = async (name, args) => { const result = await caller.rpc(name, args); if (result.error) throw result.error; return result.data; };
  try {
    await new Promise((resolve, reject) => { tls.once("error", reject); tls.listen(0, "localhost", resolve); });
    await new Promise((resolve, reject) => { sampleTls.once("error", reject); sampleTls.listen(0, "localhost", resolve); });
    for (const [key, value] of Object.entries({
      VITE_APP_SURFACE: "saas", VITE_SUPABASE_URL: status.API_URL, VITE_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      // The lab is a loopback backend: the provider boundary admits it only
      // under the project reference `local` (api/_lib/providerBoundary.js).
      UNIONGROUND_SUPABASE_PROJECT_REF: "local",
      SAMPLE_SUPABASE_URL: sampleOrigin, SAMPLE_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY, SAMPLE_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      PRIVATE_FILE_SCANNER_HOST: "localhost", PRIVATE_FILE_SCANNER_PORT: String(tls.address().port),
      PRIVATE_FILE_SCANNER_CA: readFileSync(join(certDirectory, "ca.crt"), "utf8"),
      PRIVATE_FILE_SCANNER_CERT: readFileSync(join(certDirectory, "client.crt"), "utf8"),
      PRIVATE_FILE_SCANNER_KEY: readFileSync(join(certDirectory, "client.key"), "utf8"),
      // The pin is derived from the proof's own server certificate rather than
      // handed in, so the proof exercises the real post-handshake identity
      // assertion instead of a value that could drift away from the listener.
      PRIVATE_FILE_SCANNER_EXPECTED_SPKI: createHash("sha256")
        .update(new X509Certificate(readFileSync(join(certDirectory, "server.crt")))
          .publicKey.export({ type: "spki", format: "der" })).digest("base64"),
      PRIVATE_FILE_SCANNER_ENGINE_MIN: "1.5.4",
      SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SENSITIVE_DATA_ACTIVE_KEY: "v1",
      SAMPLE_SENSITIVE_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString("base64") }), SAMPLE_SENSITIVE_DATA_ACTIVE_KEY: "v1",
      // The SAMPLE twins: same CA, same server leaf and therefore the same pin,
      // a different port and a different client identity.
      SAMPLE_PRIVATE_FILE_SCANNER_HOST: "localhost", SAMPLE_PRIVATE_FILE_SCANNER_PORT: String(sampleTls.address().port),
      SAMPLE_PRIVATE_FILE_SCANNER_CA: readFileSync(join(certDirectory, "ca.crt"), "utf8"),
      SAMPLE_PRIVATE_FILE_SCANNER_CERT: readFileSync(join(certDirectory, "sample-client.crt"), "utf8"),
      SAMPLE_PRIVATE_FILE_SCANNER_KEY: readFileSync(join(certDirectory, "sample-client.key"), "utf8"),
      SAMPLE_PRIVATE_FILE_SCANNER_EXPECTED_SPKI: createHash("sha256")
        .update(new X509Certificate(readFileSync(join(certDirectory, "server.crt")))
          .publicKey.export({ type: "spki", format: "der" })).digest("base64"),
      SAMPLE_PRIVATE_FILE_SCANNER_ENGINE_MIN: "1.5.4",
    })) vi.stubEnv(key, value);
    const email = `pipeline-${ids.org}@example.invalid`;
    const password = `Synthetic!${randomBytes(24).toString("base64url")}`;
    const user = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (user.error) throw user.error;
    userId = user.data.user.id;
    const signedIn = await caller.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    const session = signedIn.data.session;
    const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString());
    await sql.query("begin"); transaction = true;
    await sql.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
    await sql.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, chapter, userId]);
    await sql.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9901)", [chapter, ids.org]);
    await sql.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, userId]);
    await sql.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapter]);
    await sql.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, chapter]);
    await sql.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [ids.org, userId]);
    await sql.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [ids.org]);
    await sql.query("insert into public.member_cases(id,user_id,reference,title,case_type) values($1,$2,$3,'Synthetic pipeline case','other')", [ids.case, userId, chapter]);
    await sql.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapter, userId]);
    await sql.query("insert into public.chapter_tasks(id,chapter_id,title,created_by,updated_by) values($1,$2,'Synthetic pipeline task',$3,$3)", [ids.task, chapter, userId]);
    await sql.query("insert into public.member_forms(id,user_id,template_key) values($1,$2,'grievance')", [ids.form, userId]);
    await sql.query("commit"); transaction = false;
    // SaaS uses the owned loopback fixture. Union Ground's D9 demo has no pinned
    // database and must refuse writes rather than borrowing this SaaS backend.
    for (const surface of ["saas", "demo"]) {
      vi.stubEnv("VITE_APP_SURFACE", surface);
      for (const kind of ["case", "task", "form", "knowledge"]) {
        for (const [fixture, bytes] of [["clean", Buffer.from("Synthetic clean pipeline fixture")], ["eicar", CANARY_EICAR]]) {
          if (surface === "demo") {
            expect(sampleOrigin).toBe("");
            const fileId = randomUUID();
            const before = { ...acceptedConnections };
            const requestsBefore = localRequests.length;
            const response = { status(code) { this.code = code; return this; }, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
            await handler({ method: "POST", headers: { host: "localhost", authorization: `Bearer ${session.access_token}` }, body: { kind, fileId } }, response);
            expect(response.code, `disabled demo/${kind}/${fixture}`).toBe(503);
            if (kind === "case") {
              const upload = { status(code) { this.code = code; return this; }, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
              await sensitiveFilesHandler({ method: "POST", headers: { host: "localhost", authorization: `Bearer ${session.access_token}` },
                body: { action: "upload", fileId, bytes: bytes.toString("base64") } }, upload);
              expect(upload.code, `disabled demo/${fixture}/encrypted-upload`).toBe(503);
            }
            expect(acceptedConnections).toEqual(before);
            expect(localRequests).toHaveLength(requestsBefore);
            demoRefusals.push({ kind, fixture, status: response.code });
            continue;
          }
          const filename = `${surface}-${fixture}.txt`;
          const digest = createHash("sha256").update(bytes).digest("hex");
          let file;
          if (kind === "knowledge") {
            const prepared = await rpc("prepare_steward_library_upload", { p_file_name: filename, p_byte_size: bytes.length, p_content_sha256: digest,
              p_title: "Synthetic pipeline", p_summary: "Fixture", p_category: "contract", p_idempotency_key: randomUUID(), p_chapter_id: chapter });
            const target = await rpc("get_knowledge_file_storage_target", { p_file_id: prepared.fileId, p_storage_handle: prepared.storageHandle, p_mode: "upload" });
            file = { id: prepared.fileId, bucketId: target.bucketId, objectName: target.objectName };
          } else {
            // Case and task go through the caller-minted two-phase checkpoint:
            // 20260906023000 gates the legacy one-step registrations on a current
            // verdict, which nothing can hold at registration time. The form kind
            // keeps its registration RPC, whose row is invisible until the gated
            // confirm_member_form_file runs.
            const registration = {
              case: ["begin_member_case_file_upload", { p_file_id: randomUUID(), p_case_id: ids.case }],
              task: ["begin_chapter_task_file_upload", { p_file_id: randomUUID(), p_task_id: ids.task }],
              form: ["register_member_form_file", { p_form_id: ids.form }],
            }[kind];
            file = await rpc(registration[0], { ...registration[1], p_filename: filename, p_mime_type: "text/plain", p_size_bytes: bytes.length });
          }
          files.push(file);
          const bucket = caller.storage.from(file.bucketId);
          if (kind === "case") {
            expect((await bucket.upload(file.objectName, bytes, { contentType: "text/plain", upsert: false })).error).toBeTruthy();
            const uploadResponse = { status(code) { this.code = code; return this; }, setHeader() { return this; }, end(body) { this.body = JSON.parse(body); } };
            await sensitiveFilesHandler({ method: "POST", headers: { host: "localhost", authorization: `Bearer ${session.access_token}` },
              body: { action: "upload", fileId: file.id, bytes: bytes.toString("base64") } }, uploadResponse);
            expect(uploadResponse.code, `${surface}/${kind}/${fixture}/encrypted-upload`).toBe(200);
          } else {
            const upload = await bucket.upload(file.objectName, bytes, { contentType: "text/plain", upsert: false });
            if (upload.error) throw upload.error;
          }
          expect((await bucket.download(file.objectName)).error).toBeTruthy();
          const response = { status(code) { this.code = code; return this; }, setHeader() { return this; }, end(body) { this.body = JSON.parse(body); } };
          const connectionsBefore = { ...acceptedConnections };
          await handler({ method: "POST", headers: { host: "localhost", authorization: `Bearer ${session.access_token}` }, body: { kind, fileId: file.id } }, response);
          expect(response.code, `${surface}/${kind}/${fixture}`).toBe(fixture === "clean" ? 200 : 422);
          const expectedIdentity = SCANNER_CLIENT_IDENTITIES[surface === "demo" ? "sample" : "production"];
          for (const identity of Object.values(SCANNER_CLIENT_IDENTITIES)) {
            expect(acceptedConnections[identity] - connectionsBefore[identity], `${surface}/${kind}/${fixture}/${identity}`)
              .toBe(identity === expectedIdentity ? 3 : 0);
          }
          const ledger = (await sql.query("select status,sha256,engine,signature_version,object_id,object_version from private.private_upload_scans where bucket_id=$1 and object_name=$2", [file.bucketId, file.objectName])).rows[0];
          expect(ledger).toMatchObject({ status: fixture === "clean" ? "clean" : "blocked", sha256: digest, engine: "ClamAV 1.5.4" });
          // Case, task and form rows are all invisible until their gated
          // confirmation runs, so the clean fixture confirms before the
          // authenticated download below is expected to succeed. The EICAR
          // fixture deliberately does not: its confirmation is what the gate
          // refuses.
          const confirmation = { case: "confirm_member_case_file_upload", task: "confirm_chapter_task_file_upload", form: "confirm_member_form_file" }[kind];
          if (confirmation && fixture === "clean") await rpc(confirmation, { p_file_id: file.id });
          const downloaded = await bucket.download(file.objectName);
          if (fixture === "clean") {
            expect(downloaded.error).toBeNull();
            const storedBytes = Buffer.from(await downloaded.data.arrayBuffer());
            if (kind === "case") {
              expect(storedBytes).not.toEqual(bytes);
              const readResponse = { status(code) { this.code = code; return this; }, setHeader() { return this; }, end(body) { this.body = Buffer.isBuffer(body) ? Buffer.from(body) : body; } };
              await sensitiveFilesHandler({ method: "POST", headers: { host: "localhost", authorization: `Bearer ${session.access_token}` },
                body: { action: "read", fileId: file.id } }, readResponse);
              expect(readResponse.code, `${surface}/${kind}/${fixture}/encrypted-read`).toBe(200);
              expect(readResponse.body).toEqual(bytes);
            } else expect(storedBytes).toEqual(bytes);
          } else expect(downloaded.error).toBeTruthy();
          expect((await bucket.createSignedUrl(file.objectName, 300)).error).toBeTruthy();
          results.push({ surface, kind, fixture, status: ledger.status, sha256: ledger.sha256, engine: ledger.engine, signatureVersion: ledger.signature_version });
        }
      }
    }
    expect(results).toHaveLength(8);
    expect(demoRefusals).toHaveLength(8);
    expect(sampleRequests).toEqual([]);
    // ---- Per-surface scanner identity (H7), against the same real daemon ----
    // The four-kind SaaS pipeline includes encrypted case upload/read; the demo
    // API refuses while unprovisioned. This lower-level adapter proof still checks
    // each configured credential reaches its OWN listener, and both listeners
    // present the same server key and therefore the same pin, and the engine
    // still detects on both.
    for (const [surface, port, identity] of [
      ["saas", tls.address().port, SCANNER_CLIENT_IDENTITIES.production],
      ["demo", sampleTls.address().port, SCANNER_CLIENT_IDENTITIES.sample],
    ]) {
      const policy = privateFileScannerPolicy(process.env, surface);
      expect(policy.port, surface).toBe(port);
      const clean = await scanPrivateFileWithClamd(CANARY_CLEAN, { config: policy, timeoutMs: 20000 });
      expect(clean.verdict, `${surface}/clean`).toBe("clean");
      const blocked = await scanPrivateFileWithClamd(CANARY_EICAR, { config: policy, timeoutMs: 20000 });
      expect(blocked.verdict, `${surface}/eicar`).toBe("blocked");
      // One server keypair, so one pin serves both surfaces — which is exactly
      // why a per-surface SPKI would be the wrong answer here.
      expect(clean.scannerSpki, surface).toBe(process.env.PRIVATE_FILE_SCANNER_EXPECTED_SPKI);
      surfaces.push({ surface, identity, port, engine: clean.engine, signatureVersion: clean.signatureVersion });
    }
    // The negative that makes revocation mean anything: each surface's client
    // certificate is refused by the other surface's listener. Without the SAN
    // allowlist both would be accepted — the chain is identical — and H7's
    // "revoking SAMPLE's client cert must not affect production" would be
    // untestable.
    for (const [surface, otherPort] of [["saas", sampleTls.address().port], ["demo", tls.address().port]]) {
      const crossed = { ...privateFileScannerPolicy(process.env, surface), port: otherPort };
      await expect(scanPrivateFileWithClamd(CANARY_CLEAN, { config: crossed, timeoutMs: 20000 }))
        .rejects.toThrow("private-file-scanner-unavailable");
    }
    // Revoke only SAMPLE at its listener. Production must still scan with its
    // own credential, even though both certificates chain to the same CA.
    authorizedClients.delete(SCANNER_CLIENT_IDENTITIES.sample);
    await expect(scanPrivateFileWithClamd(CANARY_CLEAN, { config: privateFileScannerPolicy(process.env, "demo"), timeoutMs: 20000 }))
      .rejects.toThrow("private-file-scanner-unavailable");
    expect((await scanPrivateFileWithClamd(CANARY_CLEAN, { config: privateFileScannerPolicy(process.env, "saas"), timeoutMs: 20000 })).verdict)
      .toBe("clean");
  } catch (error) { proofFailure = error; } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => tls.close(resolve));
    await new Promise((resolve) => sampleTls.close(resolve));
    const failures = [];
    const cleanup = async (label, operation) => {
      try { const result = await operation(); if (result?.error) throw result.error; }
      catch (error) { failures.push(new Error(`Synthetic pipeline cleanup failed: ${label}; ${error.code || error.name}; ${error.constraint || ""}`)); }
    };
    if (transaction) await cleanup("rollback", () => sql.query("rollback"));
    for (const file of files) await cleanup("stored bytes", () => admin.storage.from(file.bucketId).remove([file.objectName]));
    // These committed feature fixtures cross real PostgREST transactions and
    // create append-only application audit rows. Like the required CBA proof,
    // they live until the explicitly owned database is reset by its controller.
    // Remove bytes through Storage now; never disable audit/FK guards to erase
    // the remaining relational fixture. The artifact records the reset duty.
    await cleanup("connection", () => sql.end());
    // eslint-disable-next-line no-unsafe-finally -- cleanup failures must fail the proof even after its assertions ran
    if (failures.length) throw new AggregateError(failures, "Synthetic pipeline cleanup incomplete", { cause: proofFailure });
  }
  if (proofFailure) throw proofFailure;
  if (process.env.PRIVATE_FILE_PIPELINE_ARTIFACT) writeFileSync(process.env.PRIVATE_FILE_PIPELINE_ARTIFACT,
    JSON.stringify({ status: "passed", scope: "real local SaaS Auth/Storage/feature RPC/worker/mTLS/ClamAV pipeline; unprovisioned demo refused; synthetic fixtures only", verifiedAt: new Date().toISOString(),
      cleanup: { storedBytesRemoved: true, proxyClosed: true, disposableResetRequired: true, organizationId: ids.org, userId }, results, demoRefusals, surfaces,
      identityProof: { foreignCertificatesRejected: 2, sampleRevocationIsolated: true, apiSurfaceConnectionsChecked: 8, disabledDemoRefusals: 8 } }, null, 2) + "\n");
}, 180000);
