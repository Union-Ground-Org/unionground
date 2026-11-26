import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MfaSettings } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

const verified = (id) => ({ id, factor_type: "totp", status: "verified" });
const blocked = { required: true, holdsStaffRole: true, enrolled: false, blocked: true, suspendedRoles: ["coordinator"] };

describe("successful MFA disable followed by an unreadable factor list", () => {
  it("does not claim two-step is off while the factor re-read is still pending", async () => {
    let finishRead;
    const listFactors = vi.fn()
      .mockResolvedValueOnce({ data: { all: [verified("totp-1")] }, error: null })
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const client = { auth: { mfa: { listFactors, unenroll: vi.fn().mockResolvedValue({ error: null }) } } };
    render(<LanguageProvider lang="en"><MfaSettings client={client} staffMfa={blocked} onStandingChanged={vi.fn()} passkeyEnrollmentEnabled={false} recoveryCodeEnrollmentEnabled={false}/></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: catalogue.en["mfa.disable"] }));
    fireEvent.click(await screen.findByRole("button", { name: catalogue.en["mfa.disableConfirm"] }));
    await waitFor(() => expect(listFactors).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(catalogue.en["mfa.offSub"])).toBeNull();
    expect(screen.queryByText(catalogue.en["mfa.staffRequiredBlocked"])).toBeNull();
    expect(screen.queryByRole("button", { name: catalogue.en["mfa.staffHatsRestore"] })).toBeNull();
    await act(async () => finishRead({ data: { all: [] }, error: null }));
    expect(screen.getByText(catalogue.en["mfa.offSub"])).toBeInTheDocument();
  });

  it("keeps recovery-code rotation confirmation when the re-read finds another verified factor", async () => {
    let finishRead;
    let statusReads = 0;
    const listFactors = vi.fn()
      .mockResolvedValueOnce({ data: { all: [verified("totp-1")] }, error: null })
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const rpc = vi.fn((name) => {
      if (name === "get_mfa_recovery_code_status") {
        statusReads += 1;
        // If removal needlessly drops verified state, the next status read
        // stalls while the existing recovery codes are still valid.
        return statusReads === 1 ? Promise.resolve({ data: { generation: 1, unusedCount: 10 }, error: null }) : new Promise(() => {});
      }
      return Promise.resolve({ data: { codes: ["replacement-code"] }, error: null });
    });
    const client = { rpc, auth: { mfa: { listFactors, unenroll: vi.fn().mockResolvedValue({ error: null }) } } };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      render(<LanguageProvider lang="en"><MfaSettings client={client} staffMfa={blocked} onStandingChanged={vi.fn()} passkeyEnrollmentEnabled={false}/></LanguageProvider>);
      expect(await screen.findByRole("button", { name: catalogue.en["mfa.recoveryRotate"] })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: catalogue.en["mfa.disable"] }));
      fireEvent.click(await screen.findByRole("button", { name: catalogue.en["mfa.disableConfirm"] }));
      await waitFor(() => expect(listFactors).toHaveBeenCalledTimes(2));
      await act(async () => finishRead({ data: { all: [verified("totp-2")] }, error: null }));
      const rotate = screen.getByRole("button", { name: catalogue.en["mfa.recoveryRotate"] });
      expect(rotate).toBeEnabled();
      fireEvent.click(rotate);
      expect(confirm).toHaveBeenCalledWith(catalogue.en["mfa.recoveryRotateConfirm"]);
      expect(rpc).not.toHaveBeenCalledWith("generate_mfa_recovery_codes");
      expect(statusReads).toBe(1);
    } finally { confirm.mockRestore(); }
  });

  it.each(["rejection", "error result"])("retires stale verified standing after a %s and trusts a later fresh read", async (failure) => {
    const initial = [verified("totp-1"), verified("totp-2")];
    const listFactors = vi.fn().mockResolvedValueOnce({ data: { all: initial }, error: null });
    if (failure === "rejection") listFactors.mockRejectedValueOnce(new Error("network"));
    else listFactors.mockResolvedValueOnce({ data: null, error: new Error("network") });
    // A later factor read may reveal another device's newly enrolled factor.
    listFactors.mockResolvedValue({ data: { all: [verified("replacement")] }, error: null });
    const unenroll = vi.fn().mockResolvedValue({ error: null });
    const client = { auth: { mfa: { listFactors, unenroll } } };
    const onStandingChanged = vi.fn().mockResolvedValue(undefined);
    render(<LanguageProvider lang="en"><MfaSettings client={client} staffMfa={blocked} onStandingChanged={onStandingChanged} passkeyEnrollmentEnabled={false} recoveryCodeEnrollmentEnabled={false}/></LanguageProvider>);

    expect(await screen.findByRole("button", { name: catalogue.en["mfa.staffHatsRestore"] })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["mfa.disable"] }));
    fireEvent.click(await screen.findByRole("button", { name: catalogue.en["mfa.disableConfirm"] }));
    await waitFor(() => expect(onStandingChanged).toHaveBeenCalledTimes(1));
    expect(unenroll).toHaveBeenNthCalledWith(1, { factorId: "totp-1" });
    expect(unenroll).toHaveBeenNthCalledWith(2, { factorId: "totp-2" });
    expect(screen.getByText(catalogue.en["mfa.unknownSub"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: catalogue.en["mfa.staffHatsRestore"] })).toBeNull();
    expect(screen.queryByText(catalogue.en["mfa.staffHatsRestorePending"])).toBeNull();
    expect(screen.queryByText(catalogue.en["mfa.onSub"])).toBeNull();
    expect(screen.getByText(catalogue.en["mfa.staffRequiredBlocked"])).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: catalogue.en["mfa.retry"] }));
    expect(await screen.findByRole("button", { name: catalogue.en["mfa.staffHatsRestore"] })).toBeEnabled();
    expect(screen.getByText(catalogue.en["mfa.onSub"])).toBeInTheDocument();
    expect(listFactors).toHaveBeenCalledTimes(3);
  });
});
