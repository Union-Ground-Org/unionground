import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMemoryAccessCatalog } from "../src/features/accessHistory/index.js";
import { buildAccessActor } from "../src/lib/mi1AccessHistoryWiring.js";
import { catalogue } from "../src/lib/i18n.js";
import { AccessHistoryView } from "../src/views/AccessHistoryView.jsx";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW_ISO = "2026-08-28T12:00:00.000Z";

function member(overrides = {}) {
  return buildAccessActor({
    userId: "member-a",
    organizationId: ORG,
    membershipStatus: "active",
    ...overrides,
  });
}

function catalogWith(rows) {
  return createMemoryAccessCatalog(rows.map((row) => ({
    organizationId: ORG,
    subjectUserId: "member-a",
    actorUserId: "steward-1",
    actorRole: "steward",
    actorLabel: "Sam",
    action: "viewed_case",
    entityType: "case",
    occurredAt: "2026-08-20T12:00:00.000Z",
    ...row,
  })));
}

describe("MI1 access history web surface", () => {
  it("keeps the honest loading state until the first remote catalog resolves", async () => {
    let resolveList;
    const api = {
      listOwn: vi.fn(() => new Promise((resolve) => {
        resolveList = resolve;
      })),
    };
    render(<AccessHistoryView actor={member()} api={api} nowIso={() => NOW_ISO} />);
    expect(screen.getAllByText("Loading who accessed your records.")).toHaveLength(1);
    expect(screen.queryByText("Cargando el historial de acceso.")).not.toBeInTheDocument();
    expect(screen.queryByText("No staff have viewed or changed your profile or issues, or changed a staff role on your account, in the last 90 days.")).not.toBeInTheDocument();

    await act(async () => {
      resolveList({ ok: true, catalog: catalogWith([{ id: "access-1" }]) });
    });
    expect(await screen.findByRole("heading", { name: "Sam viewed your issue" })).toBeInTheDocument();
  });

  it("shows one Spanish loading sentence while the catalog is pending", () => {
    const api = { listOwn: vi.fn(() => new Promise(() => {})) };
    render(<AccessHistoryView lang="es" actor={member()} api={api} nowIso={() => NOW_ISO} />);
    expect(screen.getAllByText("Cargando el historial de acceso.")).toHaveLength(1);
    expect(screen.queryByText(catalogue.es["accessHistory.loading"])).not.toBeInTheDocument();
    expect(screen.queryByText("Loading who accessed your records.")).not.toBeInTheDocument();
  });

  it("loads the session-scoped catalog and changes range", async () => {
    const api = {
      listOwn: vi.fn(async () => ({
        ok: true,
        catalog: catalogWith([{ id: "access-1" }]),
      })),
    };
    render(<AccessHistoryView actor={member()} api={api} nowIso={() => NOW_ISO} />);
    expect(await screen.findByRole("heading", { name: "Sam viewed your issue" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
    await waitFor(() => expect(api.listOwn).toHaveBeenCalledWith(30));
  });

  it("retries a failed catalog load", async () => {
    const api = {
      listOwn: vi.fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValue({ ok: true, catalog: catalogWith([{ id: "access-1" }]) }),
    };
    render(<AccessHistoryView lang="es" actor={member()} api={api} nowIso={() => NOW_ISO} />);
    expect(screen.getByRole("heading", { name: "Historial de acceso" })).toBeInTheDocument();
    expect(screen.getByText("Mira cuándo el personal autorizado vio o cambió tu perfil o tus asuntos, o cambió un rol de personal en tu cuenta.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Reintentar" })).toBeInTheDocument();
    expect(screen.getByText(catalogue.es["accessHistory.retry"])).toBeInTheDocument();
    expect(screen.getByText(catalogue.es["accessHistory.disclaimer"])).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(catalogue.en["accessHistory.disclaimer"]);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("heading", { name: "Sam vio tu asunto" })).toBeInTheDocument();
    expect(screen.getByText("Se muestra 1 evento.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("1 event shown.");
    expect(document.body.textContent).not.toContain("viewed your issue");
    expect(document.body.textContent).not.toContain(catalogue.en["accessHistory.disclaimer"]);
  });

  it("shows two-step sign-in copy and no retry control for the MFA refusal", async () => {
    const api = { listOwn: vi.fn().mockResolvedValue({ ok: false, reason: "mfa_required" }) };
    render(<AccessHistoryView actor={member()} api={api} nowIso={() => NOW_ISO} />);
    expect(await screen.findByText("Complete two-step sign-in to see your access history.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows the Spanish two-step sign-in copy for the MFA refusal", async () => {
    const api = { listOwn: vi.fn().mockResolvedValue({ ok: false, reason: "mfa_required" }) };
    render(<AccessHistoryView lang="es" actor={member()} api={api} nowIso={() => NOW_ISO} />);
    expect(await screen.findByText("Complete el inicio de sesión en dos pasos para ver su historial de acceso.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
  });

  it("moves focus to the page heading when a successful retry unmounts the retry button", async () => {
    const api = {
      listOwn: vi.fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValue({ ok: true, catalog: catalogWith([{ id: "access-1" }]) }),
    };
    render(<AccessHistoryView actor={member()} api={api} nowIso={() => NOW_ISO} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    expect(document.activeElement).toBe(retry);

    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { name: "Sam viewed your issue" })).toBeInTheDocument();

    const heading = screen.getByRole("heading", { name: "Access history" });
    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAttribute("tabindex", "-1");
  });

  it("leaves focus alone when the retry button clears while focus is elsewhere", async () => {
    const api = {
      listOwn: vi.fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValue({ ok: true, catalog: catalogWith([{ id: "access-1" }]) }),
    };
    render(<AccessHistoryView actor={member()} api={api} nowIso={() => NOW_ISO} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    const range = screen.getByRole("button", { name: "Last 30 days" });
    range.focus();
    expect(document.activeElement).toBe(range);

    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { name: "Sam viewed your issue" })).toBeInTheDocument();
    expect(document.activeElement).toBe(range);
  });

  it("reads the in-memory catalog when no remote is provided", async () => {
    render(
      <AccessHistoryView
        actor={member()}
        catalog={catalogWith([{ id: "access-1", action: "updated_profile", entityType: "member" }])}
        nowIso={() => NOW_ISO}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Sam updated your profile" })).toBeInTheDocument();
  });

  it("applies the selected range to the in-memory sample catalog", async () => {
    render(
      <AccessHistoryView
        actor={member()}
        catalog={catalogWith([
          { id: "recent", actorLabel: "Sam", occurredAt: "2026-08-20T12:00:00.000Z" },
          { id: "older", actorLabel: "Alex", occurredAt: "2026-05-01T12:00:00.000Z" },
        ])}
        nowIso={() => NOW_ISO}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Sam viewed your issue" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Alex viewed your issue" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Last year" }));
    expect(await screen.findByRole("heading", { name: "Alex viewed your issue" })).toBeInTheDocument();
  });

  it("retries session scope when the organization lookup failed", async () => {
    let attempts = 0;
    const client = {
      rpc: vi.fn(async (name) => {
        if (name !== "get_my_chapter_memberships") return { data: null, error: new Error("gated") };
        attempts += 1;
        return attempts === 1
          ? { data: null, error: new Error("temporarily unavailable") }
          : { data: [{ organizationId: ORG, chapterId: "chapter-a", roles: ["member"], selected: true }], error: null };
      }),
    };
    const api = {
      listOwn: vi.fn(async () => ({ ok: true, catalog: catalogWith([{ id: "access-1" }]) })),
    };
    render(
      <AccessHistoryView
        actor={buildAccessActor({ userId: "member-a" })}
        client={client}
        api={api}
        nowIso={() => NOW_ISO}
      />,
    );
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(2));
  });
});
