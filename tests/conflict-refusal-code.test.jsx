// BUG-UG-STALE-EVENT-SAVE-LOCK-TIMEOUT-20261106 (#7202). PostgREST 14
// retries SQLSTATE 40001 without limit, so the server's stale-write refusals
// moved to PT409 (migration 20261106220000). Every client branch that read
// 40001 as "somebody changed this, reload" must read PT409 the same way.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { CONFLICT_REFUSAL_CODES, isConflictRefusalCode } from "../src/lib/memberApiError.js";
import { rpcRefusalKey } from "../src/lib/rpcErrorText.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("conflict refusal codes", () => {
  it("reads PT409 and 40001 as the same reload-and-retry refusal, and nothing else", () => {
    expect(CONFLICT_REFUSAL_CODES).toEqual(["PT409", "40001"]);
    for (const code of ["PT409", "40001"]) expect(isConflictRefusalCode(code)).toBe(true);
    for (const code of [null, undefined, "", "55P03", "42501", "22023", "P0002", "PT404", 40001]) {
      expect(isConflictRefusalCode(code)).toBe(code === 40001);
    }
  });

  it("gives PT409 the conflict sentence when no detail token names the refusal", () => {
    expect(rpcRefusalKey({ code: "PT409", message: "budget conflict" }, "fallback")).toBe("rpcError.conflict");
    expect(rpcRefusalKey({ code: "40001", message: "budget conflict" }, "fallback")).toBe("rpcError.conflict");
    // A detail token still wins, as it does for the event editor.
    expect(rpcRefusalKey({ code: "PT409", details: "event_changed" }, "fallback")).toBe("rpcError.event_changed");
  });

  it("shows the organization setting conflict notice and reloads on PT409", async () => {
    const configuration = {
      settings: [{ key: "limits.messages.per_day", kind: "integer", category: "security", label: "Messages per day", description: "Daily cap.", value: 5, defaultValue: 5, minimum: 1, maximum: 25, organizationEditable: true, overridden: false, updatedAt: "2026-11-06T19:00:00.000Z", lastChange: null }],
      labelKeys: [], labelOverrides: {},
    };
    const setOrganizationSetting = vi.fn().mockRejectedValue(Object.assign(new Error("setting changed"), { code: "PT409" }));
    const reload = vi.fn();
    const { container } = render(<LanguageProvider lang="en"><AdminSecurityConfiguration configuration={configuration} failedLoginInbox={null}
      api={{ setOrganizationSetting, resetOrganizationSetting: vi.fn() }} reload={reload} onNotice={vi.fn()} /></LanguageProvider>);
    const row = within(container.querySelector('[data-setting-key="limits.messages.per_day"]'));
    fireEvent.change(row.getByRole("spinbutton"), { target: { value: "7" } });
    fireEvent.click(row.getByRole("button", { name: "Save Messages per day" }));
    await waitFor(() => expect(setOrganizationSetting).toHaveBeenCalledWith("limits.messages.per_day", 7, "2026-11-06T19:00:00.000Z"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another administrator changed this setting, so nothing was saved.");
    expect(reload).toHaveBeenCalled();
  });
});
