// @vitest-environment node

import { describe, expect, it } from "vitest";
import handler from "../api/health.js";

function invoke(method) {
  let status;
  let body;
  const headers = new Map();
  const response = {
    status(value) { status = value; return this; },
    setHeader(name, value) { headers.set(name.toLowerCase(), value); return this; },
    end(value) { body = value; },
  };
  handler({ method }, response);
  return { status, headers, body };
}

describe("service health endpoint", () => {
  it("returns only stable, non-sensitive liveness data", () => {
    const result = invoke("GET");
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(result.body)).toEqual({ ok: true, service: "union-base" });
    expect(result.body).not.toMatch(/env|database|supabase|commit|secret|token|member|organization|user|email|phone|address|case|message/i);
  });

  it("supports HEAD and rejects mutation methods", () => {
    expect(invoke("HEAD")).toMatchObject({ status: 200, body: undefined });
    expect(invoke("POST")).toMatchObject({ status: 405 });
  });
});
