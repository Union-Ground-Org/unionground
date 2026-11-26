// Opt-in proof against a disposable Auth server with both password-change
// controls enabled. Never point this at a hosted project or a shared fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

test("recent Auth sessions cannot replace a password without its current value", {
  skip: !process.env.PASSWORD_CHANGE_LOCAL_AUTH_URL,
}, async () => {
  const url = new URL(process.env.PASSWORD_CHANGE_LOCAL_AUTH_URL);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/");
  assert.equal(url.username + url.password + url.search + url.hash, "");
  const secret = process.env.PASSWORD_CHANGE_LOCAL_JWT_SECRET;
  assert.ok(secret?.startsWith("l6-6554-local-fixture-"), "a dedicated local-only fixture secret is required");
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role: "service_role", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const admin = `${jwt}.${createHmac("sha256", secret).update(jwt).digest("base64url")}`;
  async function request(path, method, token, body) {
    const response = await fetch(new URL(path, url), {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  const email = `password-proof-${randomUUID()}@example.test`;
  const current = "local fixture initial passphrase 123";
  const replacement = "local fixture chosen passphrase 456";
  const user = await request("/admin/users", "POST", admin, { email, password: current, email_confirm: true });
  assert.equal(user.status, 200);
  try {
    const login = await request("/token?grant_type=password", "POST", admin, { email, password: current });
    assert.equal(login.status, 200);
    const token = login.body.access_token;
    for (const [proof, code] of [[undefined, "current_password_required"], ["incorrect", "current_password_invalid"]]) {
      const refused = await request("/user", "PUT", token, { password: replacement, ...(proof === undefined ? {} : { current_password: proof }) });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error_code ?? refused.body.code, code);
      // Refusals must leave the original credential usable.
      assert.equal((await request("/token?grant_type=password", "POST", admin, { email, password: current })).status, 200);
    }
    assert.equal((await request("/user", "PUT", token, { password: replacement, current_password: current })).status, 200);
    assert.equal((await request("/token?grant_type=password", "POST", admin, { email, password: current })).status, 400);
    assert.equal((await request("/token?grant_type=password", "POST", admin, { email, password: replacement })).status, 200);
  } finally {
    assert.equal((await request(`/admin/users/${user.body.id}`, "DELETE", admin)).status, 200);
  }
});
