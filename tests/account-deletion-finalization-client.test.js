// BUG-UG-ACCOUNT-DELETION-FINALIZATION-20260831: the UI silently treated
// audited:false exactly like audited:true, so a member never learned their
// deletion's terminal audit record was still pending. The handler-order pins
// protect the teardown transition, while the Testing Library assertion proves
// the signed-out status surface is actually exposed to assistive technology.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, renderHook, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import * as AppModule from "../src/App.jsx";
import { catalogue, t } from "../src/lib/i18n.js";

const APP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "App.jsx"), "utf8");

describe("handleDeleteAccount surfaces an unaudited deletion instead of staying silent", () => {
  const body = APP.match(/async function handleDeleteAccount\([\s\S]*?\n {2}\}/)?.[0] ?? "";

  it("is present in App.jsx", () => {
    expect(body).not.toBe("");
  });

  it("checks the server's audited flag and notifies the member when it is false", () => {
    expect(body).toContain("result?.audited === false");
    expect(body).toContain('setDeletionAuditPendingNotice(tr("hub.lifecycle.deletedPendingAudit"))');
  });

  it("holds the pending-audit outcome outside the self-clearing toast state", () => {
    // The generic notice is a 4.2s toast (see ActionToast). The
    // terminal outcome of an irreversible deletion must not expire while the
    // authenticated shell is still tearing down around it.
    expect(APP).toContain("deletionAuditPendingNotice,");
    expect(APP).toContain("setDeletionAuditPendingNotice,");
    expect(APP).toContain("useDeletionAuditPendingNotice()");
    const noticeTimeout = APP.match(/export function ActionToast\([\s\S]*?\n}\n\nexport function useDeletionAuditPendingNotice/)?.[0] ?? "";
    expect(noticeTimeout).not.toBe("");
    expect(noticeTimeout).not.toContain("deletionAuditPendingNotice");
  });

  it("renders the pending-audit status in the signed-out surface after session teardown", () => {
    expect(AppModule.AppStatusNotice).toBeTypeOf("function");
    if (typeof AppModule.AppStatusNotice !== "function") return;
    const message = t("en", "hub.lifecycle.deletedPendingAudit");
    render(createElement(AppModule.AppStatusNotice, { message }));
    expect(screen.getByRole("status")).toHaveTextContent(message);

    const signedOutBranch = APP.match(/if \(!session\) \{\n    const authScreen[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(signedOutBranch).toContain("<AppStatusNotice message={deletionAuditPendingNotice} />");
    // The ordinary toast state is deliberately NOT rendered here: `notice` is
    // not cleared on sign-out, so including it would flash a stale member toast
    // over the signed-out surface and change the audited:true path.
    expect(signedOutBranch).not.toContain("deletionAuditPendingNotice || notice");
  });

  it("preserves the warning through deletion teardown and clears it before a new account renders", () => {
    const { result } = renderHook(() => AppModule.useDeletionAuditPendingNotice());
    const message = t("en", "hub.lifecycle.deletedPendingAudit");

    act(() => result.current.setDeletionAuditPendingNotice(message));
    expect(result.current.deletionAuditPendingNotice).toBe(message);

    act(() => result.current.clearDeletionAuditPendingNoticeForSession(null));
    expect(result.current.deletionAuditPendingNotice).toBe(message);
    const signedOut = render(createElement(AppModule.AppStatusNotice, {
      message: result.current.deletionAuditPendingNotice,
    }));
    expect(screen.getByRole("status")).toHaveTextContent(message);
    signedOut.unmount();

    act(() => result.current.clearDeletionAuditPendingNoticeForSession("33333333-3333-4333-8333-333333333333"));
    expect(result.current.deletionAuditPendingNotice).toBe("");
    render(createElement(AppModule.AppStatusNotice, {
      message: result.current.deletionAuditPendingNotice,
    }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    const generationBody = APP.slice(
      APP.indexOf("const beginSessionGeneration = useCallback"),
      APP.indexOf("return guardRef.current.generation;"),
    );
    expect(generationBody).toContain("clearDeletionAuditPendingNoticeForSession(nextUserId)");
  });

  it("still tears down the local session before checking audited, so cleanup never depends on the audit outcome", () => {
    const teardownIndex = body.indexOf("setSession(null)");
    const auditCheckIndex = body.indexOf("result?.audited === false");
    expect(teardownIndex).toBeGreaterThan(-1);
    expect(auditCheckIndex).toBeGreaterThan(teardownIndex);
  });

  it("has a real, distinct translation in both shipped languages", () => {
    for (const locale of ["en", "es"]) {
      const message = t(locale, "hub.lifecycle.deletedPendingAudit");
      expect(message, `hub.lifecycle.deletedPendingAudit missing for ${locale}`).not.toBe("hub.lifecycle.deletedPendingAudit");
      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toBe(catalogue[locale]["hub.lifecycle.exported"]);
    }
  });
});
