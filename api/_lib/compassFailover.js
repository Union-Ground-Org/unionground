import {
  MESH_GATEWAY, FIREWORKS_GATEWAY, buildCompassGatewayRequest,
  hasMeshProofHeaders, normalizeResolvedProvider, readProviderResponse,
} from "./compassAiGovernance.js";

// Only failures at the actual network boundary can request paid failover.
// Failed minimization, authorization, JSON parsing and response attestation
// remain refusals; the caller cannot turn them into an outage by choosing a code.
async function completeOnce(messages, access, attestedDigest, buildRequest) {
  const request = buildRequest(messages, access);
  let response;
  try { response = await fetch(request.url, request.options); }
  catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw Object.assign(new Error("provider transport unavailable"), {
      name: timeout ? "TimeoutError" : "Error",
      failoverCause: timeout ? "timeout" : "transport",
      gatewayCause: timeout ? "gateway_timeout" : "gateway_error",
    });
  }
  if (!response.ok) {
    const status = Number(response.status);
    throw Object.assign(new Error("provider unavailable"), {
      gatewayResponse: response,
      gatewayCause: status === 402 ? "no_credits" : status === 401 || status === 403 ? "unauthorized" : "gateway_error",
      ...(status === 408 || status === 429 || status >= 500 && status <= 599 ? { failoverCause: "temporary_http" } : {}),
    });
  }
  let completion;
  try { completion = await response.json(); }
  catch (error) {
    // A 200 with an unreadable body is a provider failure like any other:
    // bounded cause, no body, and the caller's outage alert still fires. A
    // body read that hits the request deadline keeps its timeout class.
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw Object.assign(new Error("provider response unreadable"), {
      name: timeout ? "TimeoutError" : "Error",
      gatewayResponse: response,
      gatewayCause: timeout ? "gateway_timeout" : "gateway_error",
      metadataPresent: hasMeshProofHeaders(response.headers),
    });
  }
  const verdict = readProviderResponse(completion, response.headers, { provider: access.provider, attestedDigest });
  if (!verdict.ok) throw Object.assign(new Error("provider response refused"), {
    gatewayResponse: response, gatewayCause: verdict.cause, metadataPresent: hasMeshProofHeaders(response.headers),
  });
  return { content: verdict.content, completion, provider: access.provider };
}

export async function completeWithMeshFailover({ messages, access, attestedDigest, authorizeFailover, buildRequest = buildCompassGatewayRequest }) {
  try { return await completeOnce(messages, access, attestedDigest, buildRequest); }
  catch (error) {
    if (access.provider?.gateway !== MESH_GATEWAY || !error.failoverCause || !authorizeFailover) throw error;
    let authorization;
    try { authorization = await authorizeFailover(error.failoverCause); }
    catch { throw Object.assign(new Error("fallback authorization unavailable"), { cause: "governance_unavailable", failoverRefused: true }); }
    if (authorization?.authorized !== true) {
      // An unconfigured optional fallback preserves the original mesh outage.
      if (authorization?.cause === "fallback_unconfigured") throw error;
      throw Object.assign(new Error("fallback refused"), { cause: authorization?.cause || "governance_unavailable", failoverRefused: true });
    }
    const provider = normalizeResolvedProvider(authorization);
    if (!provider || provider.gateway !== FIREWORKS_GATEWAY) {
      throw Object.assign(new Error("fallback configuration refused"), { cause: "config", failoverRefused: true });
    }
    // No recursion, retry, different retrieval, or fallback-to-mesh loop. The
    // mesh failure class rides along so the caller can report the takeover.
    try {
      return { ...(await completeOnce(messages, { ...access, provider }, null, buildRequest)), failoverCause: error.failoverCause };
    } catch (fallbackError) {
      // The failure now belongs to the fallback provider; the caller's
      // diagnostic and operator alert must name it, not the mesh.
      throw Object.assign(fallbackError, { provider });
    }
  }
}
