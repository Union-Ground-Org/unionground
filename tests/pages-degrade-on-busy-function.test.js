// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { MemberApiError, withSoftRpcDeadline } from "../src/lib/memberApiError.js";
import { isServiceBusyError, rpcErrorText, rpcErrorTextStrict, rpcRefusalKey } from "../src/lib/rpcErrorText.js";
import { t } from "../src/lib/i18n.js";

// BUG-UG-PAGES-FAIL-HARD-ON-MISSING-OR-SLOW-FUNCTION-20261003: during
// the October 3 apply window a member read "Mark notifications read: canceling
// statement due to statement timeout". A statement timeout, a lock wait or a
// function the API does not know yet now reads as one plain sentence.

const tEn = (key, vars) => t("en", key, vars);
const tEs = (key, vars) => t("es", key, vars);
const BUSY_EN = "Union Ground is busy right now, so that did not finish. Try again in a moment.";

const busy = [
  ["57014", "canceling statement due to statement timeout"],
  ["55P03", "canceling statement due to lock timeout"],
  ["PGRST202", "Could not find the function public.set_appointment_schedule in the schema cache"],
  ["42883", "function private.not_yet_deployed(uuid) does not exist"],
  ["PGRST002", "Could not query the database for the schema cache. Retrying."],
];

describe("service-busy errors", () => {
  it.each(busy)("%s reads as busy, never as the server's sentence", (code, message) => {
    const error = new MemberApiError("Mark notifications read", { code, message });
    expect(isServiceBusyError(error)).toBe(true);
    expect(rpcErrorText(tEn, error, "toast.saveFailed")).toBe(BUSY_EN);
    expect(rpcErrorTextStrict(tEn, error, "fallback")).toBe(BUSY_EN);
    expect(rpcRefusalKey(error, "fallback.key")).toBe("error.serviceBusy");
    expect(rpcErrorText(tEn, error, "toast.saveFailed")).not.toContain(message);
  });

  it("says it in Spanish too", () => {
    const error = new MemberApiError("Mark notifications read", { code: "57014", message: "canceling statement due to statement timeout" });
    expect(rpcErrorText(tEs, error, "toast.saveFailed")).toBe("Union Ground está ocupado en este momento, así que eso no terminó. Inténtalo de nuevo en un momento.");
  });

  it("leaves other refusals on their existing paths", () => {
    const denied = new MemberApiError("Save", { code: "42501", message: "permission denied" });
    expect(isServiceBusyError(denied)).toBe(false);
    expect(rpcRefusalKey(denied, "fallback.key")).toBe("rpcError.notPermitted");
    expect(rpcErrorText(tEn, { message: "Plain refusal" }, "toast.saveFailed")).toBe("Plain refusal");
  });
});

describe("RPC authentication refusals", () => {
  const refusal = { code: "42501", message: "authentication required" };

  it.each([
    ["bare", refusal],
    ["wrapped", new MemberApiError("Form", refusal)],
    ["labelled message", { ...refusal, message: "Save profile: authentication required" }],
  ])("localizes an exact %s refusal as sign-in guidance", (_shape, error) => {
    const key = rpcRefusalKey(error, "fallback.key");
    expect(tEn(key)).toBe("Sign in and complete the second verification step to continue.");
    expect(tEs(key)).toBe("Inicia sesión y completa el segundo paso de verificación para continuar.");
  });

  it("keeps the existing mapping for a different code or message", () => {
    expect(rpcRefusalKey({ ...refusal, code: "22023" }, "fallback.key")).toBe("fallback.key");
    expect(rpcRefusalKey({ ...refusal, message: "authentication required for this action" }, "fallback.key")).toBe("rpcError.notPermitted");
  });
});

describe("soft RPC deadline", () => {
  it("answers a timeout-shaped error when a read outlasts its deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = withSoftRpcDeadline(new Promise(() => {}), 4_000);
      await vi.advanceTimersByTimeAsync(4_001);
      await expect(pending).resolves.toEqual({ data: null, error: { code: "57014", message: "soft deadline exceeded" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a timely result straight through", async () => {
    await expect(withSoftRpcDeadline(Promise.resolve({ data: [1], error: null }), 4_000)).resolves.toEqual({ data: [1], error: null });
  });
});
