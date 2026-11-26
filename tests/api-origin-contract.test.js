// @vitest-environment node
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function contractModule() {
  return import("../scripts/lib/api-origin-contract.mjs").catch(() => ({}));
}

describe("API Origin contract inventory", () => {
  it("provides a verifier for browser-authenticated mutation routes", async () => {
    const contract = await contractModule();
    expect(contract.verifyApiOriginSources).toBeTypeOf("function");
  });

  it("provides a filesystem scanner for the workflow gate", async () => {
    const contract = await contractModule();
    expect(contract.scanApiOriginDirectory).toBeTypeOf("function");
  });

  it("keeps every non-session mutation exception explicit and reviewable", async () => {
    const { MUTATION_ORIGIN_EXCEPTIONS } = await contractModule();
    expect(MUTATION_ORIGIN_EXCEPTIONS).toEqual({
      "api/accept-invitation.js": "route-local-origin-bound-invitation",
      "api/account-mail-events.js": "svix-signed-mail-provider-webhook",
      "api/auth-password-signin.js": "unauthenticated-password-bootstrap",
      // Union Ground's public connect intake checks its own app Origin.
      "api/connect.js": "route-local-origin-bound-public-request",
      "api/demo-session.js": "sample-only-session-bootstrap",
      "api/invitation-preview.js": "route-local-origin-bound-invitation",
      "api/invite-request.js": "route-local-origin-bound-public-request",
      "api/email-unsubscribe.js": "signed-one-click-unsubscribe",
      "api/engagement-email-bridge.js": "bearer-only-server-webhook",
      "api/public-interest-stop-confirm.js": "route-local-origin-bound-public-request",
      "api/public-interest-stop.js": "route-local-origin-bound-public-request",
      "api/public-interest-unsubscribe.js": "single-use-stop-token-one-click-unsubscribe",
      "api/public-interest.js": "route-local-origin-bound-public-request",
      "api/steward-email-intake.js": "hmac-signed-email-webhook",
      "api/twilio-inbound.js": "twilio-signed-webhook",
      "api/twilio-status.js": "twilio-signed-webhook",
    });
  });

  // Union Ground left out dues, the member PIN, passkey/SSO sign-in, the
  // public chapter directory with its event RSVP, Ask your union, join
  // requests and document contributions.
  // Their routes are gone, so the reviewed exception inventory must not keep
  // a standing pass for a file that could be reintroduced unreviewed.
  it.each([
    "api/auth-passkey-signin.js",
    "api/auth-pin-signin.js",
    "api/auth-signin-options.js",
    "api/dues-stripe-webhook.js",
    "api/sso-signin.js",
    "api/sso-admin.js",
    "api/public/event-rsvp.js",
    "api/ask-your-union.js",
    "api/join-request.js",
    "api/document-contribution.js",
  ])("keeps the removed route %s out of the tree and out of the exception inventory", async (path) => {
    const { MUTATION_ORIGIN_EXCEPTIONS } = await contractModule();
    expect(existsSync(fileURLToPath(new URL(`../${path}`, import.meta.url)))).toBe(false);
    expect(Object.keys(MUTATION_ORIGIN_EXCEPTIONS)).not.toContain(path);
  });

  it("scans the actual API directory shape and reports guarded-file violations", async () => {
    const { scanApiOriginDirectory } = await contractModule();
    const root = await mkdtemp(join(tmpdir(), "psg-api-origin-"));
    const apiDir = join(root, "api");
    await mkdir(join(apiDir, "_lib"), { recursive: true });
    await mkdir(join(apiDir, "public"), { recursive: true });
    try {
      await writeFile(join(apiDir, "_lib", "http.js"), `
        export function validateMutationOrigin() { return true; }
        export function bearerToken(request) { return request.headers.authorization; }
      `);
      await writeFile(join(apiDir, "unsafe.js"), `
        import { authenticate, methodGuard } from "./_lib/http.js";
        export default async function handler(request, response) {
          if (methodGuard(request, ["POST"], () => response.end())) return;
          await authenticate("url", "key", request.headers.authorization);
        }
      `);
      await writeFile(join(apiDir, "read.js"), `
        export default function handler(request) {
          if (request.method !== "GET") return;
          return request.headers.authorization;
        }
      `);
      await writeFile(join(apiDir, "public", "unsafe.js"), `
        export default function handler(request) {
          if (request.method !== "PATCH") return;
          return request.headers.cookie;
        }
      `);
      expect(await scanApiOriginDirectory(apiDir)).toEqual([
        { path: "api/_lib/http.js", code: "bearer-helper-without-origin-validation" },
        { path: "api/public/unsafe.js", code: "credential-mutation-without-origin-boundary" },
        { path: "api/unsafe.js", code: "session-mutation-without-origin-boundary" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the repository Origin inventory as a blocking command", () => {
    const repository = fileURLToPath(new URL("..", import.meta.url));
    const result = spawnSync(process.execPath, ["scripts/verify-api-origin-contract.mjs"], {
      cwd: repository,
      encoding: "utf8",
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "PASS: every browser-authenticated API mutation uses the shared Origin boundary.\n",
      stderr: "",
    });
  });

  it("exposes the blocking Origin inventory through the package verification interface", () => {
    const repository = fileURLToPath(new URL("..", import.meta.url));
    const result = spawnSync("npm", ["run", "verify:api-origin", "--silent"], {
      cwd: repository,
      encoding: "utf8",
    });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "PASS: every browser-authenticated API mutation uses the shared Origin boundary.\n",
      stderr: "",
    });
  });

  it("rejects a session-authenticated mutation that omits the shared bearer boundary", async () => {
    const { verifyApiOriginSources } = await contractModule();
    const violations = verifyApiOriginSources([{ path: "api/unsafe.js", source: `
      import { authenticate, methodGuard } from "./_lib/http.js";
      export default async function handler(request, response) {
        if (methodGuard(request, ["POST"], () => response.end())) return;
        await authenticate("url", "key", request.headers.authorization);
      }
    ` }]);
    expect(violations).toEqual([{ path: "api/unsafe.js", code: "session-mutation-without-origin-boundary" }]);
  });

  it("rejects direct Authorization or cookie parsing in a mutation without the shared boundary", async () => {
    const { verifyApiOriginSources } = await contractModule();
    const violations = verifyApiOriginSources([
      { path: "api/direct-token.js", source: `
        export default function handler(request) {
          if (request.method !== "POST") return;
          return request.headers.authorization;
        }
      ` },
      { path: "api/direct-cookie.js", source: `
        export default function handler(request) {
          if (request.method !== "DELETE") return;
          return request.headers.cookie;
        }
      ` },
    ]);
    expect(violations).toEqual([
      { path: "api/direct-cookie.js", code: "credential-mutation-without-origin-boundary" },
      { path: "api/direct-token.js", code: "credential-mutation-without-origin-boundary" },
    ]);
  });

  it("rejects an unclassified mutation even when it has no inline credential parsing", async () => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/new-machine-route.js", source: `
      export default function handler(request) {
        if (request.method !== "POST") return;
        return queueWork(request.body);
      }
    ` }])).toEqual([
      { path: "api/new-machine-route.js", code: "mutation-without-origin-classification" },
    ]);
  });

  it("accepts a mutation only when its exact path is in the reviewed exception inventory", async () => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/twilio-inbound.js", source: `
      export default function handler(request) {
        if (request.method !== "POST") return;
        return verifyTwilioSignature(request);
      }
    ` }])).toEqual([]);
  });

  it("no longer accepts the removed Stripe dues webhook as a reviewed exception", async () => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/dues-stripe-webhook.js", source: `
      export default function handler(request) {
        if (request.method !== "POST") return;
        return verifyStripeSignature(request);
      }
    ` }])).toEqual([
      { path: "api/dues-stripe-webhook.js", code: "mutation-without-origin-classification" },
    ]);
  });

  it("does not let comments or an unused import impersonate an invoked Origin boundary", async () => {
    const { verifyApiOriginSources } = await contractModule();
    const violations = verifyApiOriginSources([
      { path: "api/comment-only.js", source: `
        export default function handler(request) {
          if (request.method !== "POST") return;
          // validateMutationOrigin(request)
          return request.headers.authorization;
        }
      ` },
      { path: "api/import-only.js", source: `
        import { validateMutationOrigin } from "./_lib/http.js";
        export default function handler(request) {
          if (request.method !== "PATCH") return;
          return request.headers.cookie;
        }
      ` },
    ]);
    expect(violations).toEqual([
      { path: "api/comment-only.js", code: "credential-mutation-without-origin-boundary" },
      { path: "api/import-only.js", code: "credential-mutation-without-origin-boundary" },
    ]);
  });

  it("does not let a local look-alike validator impersonate the shared boundary", async () => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/look-alike.js", source: `
      function validateMutationOrigin() { return true; }
      export default function handler(request) {
        if (request.method !== "DELETE") return;
        validateMutationOrigin(request);
        return request.headers.cookie;
      }
    ` }])).toEqual([
      { path: "api/look-alike.js", code: "credential-mutation-without-origin-boundary" },
    ]);
  });

  it("accepts a bearer-only server webhook only when listed with that reason and entered through the shared serverCaller refusal", async () => {
    const { verifyApiOriginSources } = await contractModule();
    const guarded = `
      import { json } from "./_lib/http.js";
      import { serverCaller } from "./_lib/serverCaller.js";
      export default async function handler(request, response) {
        if (!serverCaller(request)) return json(response, 403, { error: "untrusted-origin" });
        if (request.headers.authorization !== "Bearer x") return json(response, 401, {});
        return json(response, 200, {});
      }
    `;
    expect(verifyApiOriginSources([{ path: "api/engagement-email-bridge.js", source: guarded }])).toEqual([]);
    // The same source at a path not listed with that reason.
    expect(verifyApiOriginSources([{ path: "api/email-unsubscribe.js", source: guarded }]))
      .toEqual([{ path: "api/email-unsubscribe.js", code: "credential-mutation-without-origin-boundary" }]);
    expect(verifyApiOriginSources([{ path: "api/other-webhook.js", source: guarded }]))
      .toEqual([{ path: "api/other-webhook.js", code: "credential-mutation-without-origin-boundary" }]);
    // Listed, but a look-alike local check, or the check not first.
    const lookAlike = guarded.replace('import { serverCaller } from "./_lib/serverCaller.js";', "const serverCaller = () => true;");
    const notFirst = guarded.replace("if (!serverCaller(request))", "const presented = request.headers.authorization;\n        if (!serverCaller(request))");
    for (const source of [lookAlike, notFirst]) {
      expect(verifyApiOriginSources([{ path: "api/engagement-email-bridge.js", source }]))
        .toEqual([{ path: "api/engagement-email-bridge.js", code: "credential-mutation-without-origin-boundary" }]);
    }
  });

  it("fails closed with a structured violation when an API source cannot be parsed", async () => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/broken.js", source: "export default (" }])).toEqual([
      { path: "api/broken.js", code: "api-source-parse-failed" },
    ]);
  });

  it("accepts mutations with a rejecting entry guard and ignores reads", async () => {
    const { verifyApiOriginSources } = await contractModule();
    const violations = verifyApiOriginSources([
      { path: "api/bearer.js", source: `
        import { bearerToken, methodGuard, validateMutationOrigin } from "./_lib/http.js";
        export default function handler(request, response) {
          if (!validateMutationOrigin(request)) return;
          if (methodGuard(request, ["POST"], () => response.end())) return;
          return bearerToken(request);
        }
      ` },
      { path: "api/cookie.js", source: `
        import { validateMutationOrigin } from "./_lib/http.js";
        export default function handler(request) {
          if (!validateMutationOrigin(request)) return;
          if (request.method !== "PATCH") return;
          return request.headers.cookie;
        }
      ` },
      { path: "api/read.js", source: `
        export default function handler(request) {
          if (request.method !== "GET") return;
          return request.headers.authorization;
        }
      ` },
    ]);
    expect(violations).toEqual([]);
  });

  it.each([
    'if (request.method === "GET") validateMutationOrigin(request); return mutate(request);',
    'return mutate(request); validateMutationOrigin(request);',
    'function unused() { validateMutationOrigin(request); } return mutate(request);',
    'if (false) validateMutationOrigin(request); return mutate(request);',
    'validateMutationOrigin(request); return mutate(request);',
    'mutate(request); if (!validateMutationOrigin(request)) return; ',
    'if (!validateMutationOrigin(otherRequest)) return; return mutate(request);',
    'if (!validateMutationOrigin(request)) { logFailure(); } return mutate(request);',
  ])("rejects a non-dominating or non-rejecting guard: %s", async (body) => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/unsafe.js", source: `
      import { validateMutationOrigin } from "./_lib/http.js";
      export default function handler(request) {
        ${body}
        // The endpoint supports POST.
      }
      const methods = ["POST"];
    ` }])).toEqual([{ path: "api/unsafe.js", code: "mutation-without-origin-classification" }]);
  });

  it("accepts imported aliases with a terminal rejection before mixed-method work", async () => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/safe.js", source: `
      import { validateMutationOrigin as origin, json as reply } from "./_lib/http.js";
      export default function handler(req, res) {
        if (!origin(req)) return reply(res, 403, { error: "untrusted-origin" });
        if (req.method === "POST") return mutate(req);
        return read(req);
      }
    ` }])).toEqual([]);
  });

  it.each([
    'function handler(request, validateMutationOrigin) { if (!validateMutationOrigin(request)) return; return mutate(request); }',
    'function handler(request) { if (!validateMutationOrigin(request)) return mutate(request); }',
    'function handler(request) { if (!validateMutationOrigin(request)) return; const validateMutationOrigin = () => true; }',
    'function handler(request) { if (!validateMutationOrigin(request)) return; const { validateMutationOrigin } = helpers; }',
    'function handler(request, response) { if (!validateMutationOrigin(request)) return json(response, 403, { error: mutate(request) }); }',
  ])("rejects shadowed guards or work in the rejection branch: %s", async (handler) => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/unsafe.js", source: `
      import { validateMutationOrigin, json } from "./_lib/http.js";
      const methods = ["POST"];
      export default ${handler}
    ` }])).toHaveLength(1);
  });

  it.each([
    'return mutate(request.body);',
    'if (request.method === "GET") return read(); return mutate(request.body);',
    'if (methodGuard(request, allowedMethods, () => response.end())) return; return mutate(request.body);',
  ])("requires classification when mutation methods are implicit: %s", async (body) => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/implicit.js", source: `
      import { methodGuard } from "./_lib/http.js";
      export default function handler(request, response) { ${body} }
    ` }])).toHaveLength(1);
  });

  it("allows unrelated destructured, default, and rest callback parameters after the entry guard", async () => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/safe.js", source: `
      import { validateMutationOrigin } from "./_lib/http.js";
      export default function handler(request) {
        if (!validateMutationOrigin(request)) return;
        if (request.method !== "POST") return;
        return request.body.map(({ id }, index = 0, ...rest) => mutate(id, index, rest));
      }
    ` }])).toEqual([]);
  });

  it.each(["mjs", "cjs", "ts", "py"])("fails closed for an unsupported endpoint extension %s", async (extension) => {
    const { scanApiOriginDirectory } = await contractModule();
    const root = await mkdtemp(join(tmpdir(), "origin-extension-"));
    await mkdir(join(root, "_lib"));
    try {
      await writeFile(join(root, "_lib", "http.js"), `
        export function bearerToken(request) { if (!validateMutationOrigin(request)) return ""; return "token"; }
      `);
      await writeFile(join(root, `unsafe.${extension}`), "export default function handler(req) { return mutate(req.body); }");
      expect(await scanApiOriginDirectory(root)).toEqual([{ path: `api/unsafe.${extension}`, code: "api-source-unsupported-extension" }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    'mutate(request.body); if (request.method !== "GET") return;',
    'if (request.method === "GET") return; mutate(request.body);',
    'if (request.method !== "GET") { mutate(request.body); return; }',
    'if (request.method !== "GET" && request.feature) return; mutate(request.body);',
    'if (methodGuard(request, ["GET"], () => mutate(request.body))) return;',
    'if (methodGuard(request, ["GET"], () => response.end())) { mutate(request.body); return; }',
  ])("rejects an unproven read-only gate: %s", async (body) => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/unsafe-read.js", source: `
      import { methodGuard } from "./_lib/http.js";
      export default function handler(request, response) { ${body} }
    ` }])).toHaveLength(1);
  });

  it("accepts a read-only gate after literal response headers", async () => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/read.js", source: `
      export default function handler(request, response) {
        response.setHeader("Cache-Control", "no-store");
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.status(405).end();
          return;
        }
        return read(request);
      }
    ` }])).toEqual([]);
  });

  it("accepts a read-only gate that rejects through the shared secure HTML responder", async () => {
    const { verifyApiOriginSources } = await contractModule();
    expect(verifyApiOriginSources([{ path: "api/read-html.js", source: `
      import { methodGuard, secureHtml } from "./_lib/http.js";
      export default function handler(request, response) {
        if (methodGuard(request, ["GET", "HEAD"], () => secureHtml(response, 404, "Not found"))) return;
        return read(request);
      }
    ` }])).toEqual([]);
  });

  it.each([
    'const { authorization, cookie } = request.headers; return authenticateSession(authorization, cookie);',
    'const { headers = {} } = request; return authenticateSession(headers.authorization);',
    'const { headers: { authorization } } = request; return authenticateSession(authorization);',
    'const { headers: { cookie } = {} } = request; return authenticateSession(cookie);',
    'const h = request.headers; return authenticateSession(h.authorization);',
    'const h = request.headers || {}; const alias = h; return authenticateSession(alias.cookie);',
    'return http.authenticate("url", "key", "token");',
    'return getBearer(request);',
  ])("does not allow an exception to silently adopt browser credentials: %s", async (body) => {
    const { verifyApiOriginSources } = await contractModule();
    const imports = body.includes("http.") ? 'import * as http from "./_lib/http.js";'
      : body.includes("getBearer") ? 'import { bearerToken as getBearer } from "./_lib/http.js";' : "";
    expect(verifyApiOriginSources([{ path: "api/demo-session.js", source: `
      ${imports}
      export default function handler(request) { ${body} }
    ` }])).toHaveLength(1);
  });

  it("requires the imported boundary to resolve to the actual shared helper", async () => {
    const { verifyApiOriginSources } = await contractModule();
    const source = (path) => `
      import { validateMutationOrigin } from "${path}";
      export default function handler(request) { if (!validateMutationOrigin(request)) return; return mutate(request.body); }
    `;
    expect(verifyApiOriginSources([{ path: "api/public/private-route.js", source: source("./_lib/http.js") }])).toHaveLength(1);
    expect(verifyApiOriginSources([{ path: "api/public/private-route.js", source: source("../_lib/http.js") }])).toEqual([]);
    expect(verifyApiOriginSources([{ path: "api/public/nested/route.js", source: source("../../_lib/http.js") }])).toEqual([]);
  });

  it("rejects a shared bearer helper that stops invoking Origin validation", async () => {
    const { verifyApiOriginSources } = await contractModule();
    const violations = verifyApiOriginSources([{ path: "api/_lib/http.js", source: `
      export function validateMutationOrigin() { return true; }
      export function bearerToken(request) { return request.headers.authorization; }
    ` }]);
    expect(violations).toEqual([{ path: "api/_lib/http.js", code: "bearer-helper-without-origin-validation" }]);
  });
});
