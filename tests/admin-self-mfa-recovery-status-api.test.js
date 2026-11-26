// @vitest-environment node
//
// BUG-UG-SOLE-ADMIN-TWO-STEP-RESET-DEAD-END-20261103: the admin's own
// two-step row reads the caller's own recovery-code standing.
import { describe, expect, it, vi } from "vitest";
import { loadMfaRecoveryCodeStatus } from "../src/lib/memberApi.js";

describe("own recovery-code status for the admin page", () => {
  it("reads the caller's own status RPC and keeps only the generation and unused count", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { generatedAt: "2026-11-03T07:00:00Z", generation: 2, unusedCount: 9, usedCount: 1, lockedUntil: null }, error: null });
    await expect(loadMfaRecoveryCodeStatus({ rpc })).resolves.toEqual({ generation: 2, unusedCount: 9 });
    expect(rpc).toHaveBeenCalledWith("get_mfa_recovery_code_status");
  });

  it("treats a missing generation as none and refuses a malformed or refused answer", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { unusedCount: 0 }, error: null })
      .mockResolvedValueOnce({ data: { generation: 1 }, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "authentication required", code: "42501" } });
    await expect(loadMfaRecoveryCodeStatus({ rpc })).resolves.toEqual({ generation: 0, unusedCount: 0 });
    await expect(loadMfaRecoveryCodeStatus({ rpc })).rejects.toThrow("Recovery code status: invalid response");
    await expect(loadMfaRecoveryCodeStatus({ rpc })).rejects.toThrow("Recovery code status: invalid response");
    await expect(loadMfaRecoveryCodeStatus({ rpc })).rejects.toThrow();
  });
});
