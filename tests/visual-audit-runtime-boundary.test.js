// @vitest-environment node

import { describe, expect, it } from "vitest";

const runtimeBoundaryPath = new URL(
  "../scripts/lib/visual-audit-runtime-boundary.mjs",
  import.meta.url,
);

describe("live visual-audit target runtime boundary", () => {
  it("attributes a response to the identity that started its request", async () => {
    const { createTargetRuntimeBoundary } = await import(runtimeBoundaryPath.href);
    const boundary = createTargetRuntimeBoundary();
    const stewardRequest = {};
    const memberRequest = {};

    boundary.restartTarget();
    boundary.trackRequest(stewardRequest);
    boundary.restartTarget();
    boundary.trackRequest(memberRequest);

    expect(boundary.belongsToCurrentTarget(stewardRequest)).toBe(false);
    expect(boundary.belongsToCurrentTarget(memberRequest)).toBe(true);
  });

  it("does not adopt a request that started before target capture", async () => {
    const { createTargetRuntimeBoundary } = await import(runtimeBoundaryPath.href);
    const boundary = createTargetRuntimeBoundary();
    const bootstrapRequest = {};

    boundary.trackRequest(bootstrapRequest);
    boundary.restartTarget();

    expect(boundary.belongsToCurrentTarget(bootstrapRequest)).toBe(false);
  });

  it("retains only a sanitized origin class and path for HTTP failures", async () => {
    const {
      describeRuntimeHttpFailure,
      describeRuntimeNetworkFailure,
    } = await import(runtimeBoundaryPath.href);
    const baseUrl = "https://app.example.org";

    expect(describeRuntimeHttpFailure({
      status: 500,
      responseUrl: "https://sample-project.supabase.co/rest/v1/rpc/get_steward_desk_kpis?apikey=secret",
      baseUrl,
    })).toBe("HTTP 500 upstream: /rest/v1/rpc/get_steward_desk_kpis");
    expect(describeRuntimeHttpFailure({
      status: 404,
      responseUrl: "https://app.example.org/missing?member=protected",
      baseUrl,
    })).toBe("HTTP 404 app: /missing");
    expect(describeRuntimeNetworkFailure({
      errorText: "net::ERR_CONNECTION_RESET",
      requestUrl: "https://sample-project.supabase.co/rest/v1/rpc/list_steward_conversations?cursor=protected",
      baseUrl,
    })).toBe("Network net::ERR_CONNECTION_RESET upstream: /rest/v1/rpc/list_steward_conversations");
  });

  it("recognizes Chromium's duplicate resource console line without hiding application errors", async () => {
    const { isGenericResourceConsoleError } = await import(runtimeBoundaryPath.href);

    expect(isGenericResourceConsoleError(
      "Failed to load resource: the server responded with a status of 500 ()",
    )).toBe(true);
    expect(isGenericResourceConsoleError(
      "Member Home failed to load: statement timeout",
    )).toBe(false);
  });
});
