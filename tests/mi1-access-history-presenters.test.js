// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { ACCESS_ACTIONS } from "../src/features/accessHistory/event.js";
import {
  ACCESS_VIEW_STATES,
  presentAccessHistory,
  presentFailureMessage,
  presentLoading,
  presentMfaRequired,
  presentRetry,
} from "../src/features/accessHistory/index.js";
import { catalogue } from "../src/lib/i18n.js";
import { stripComments } from "./helpers/migration.js";

describe("access history presenters", () => {
  it("exposes the finite view-state set", () => {
    expect(ACCESS_VIEW_STATES).toEqual([
      "empty",
      "loading",
      "success",
      "unauthorized",
      "wrong_organization",
      "retry",
      "mfa_required",
    ]);
  });

  it("presents loading and retry shells", () => {
    expect(presentLoading()).toMatchObject({
      state: "loading",
      title: "Access history",
      events: [],
    });
    expect(presentRetry()).toMatchObject({
      state: "retry",
      message: "Access history could not be reached. Try again.",
    });
  });

  it("maps every known failure reason, including the default", () => {
    expect(presentFailureMessage({ reason: "empty_organization" })).toMatch(/Select an organization/);
    expect(presentFailureMessage({ reason: "wrong_organization" })).toMatch(/another organization/);
    expect(presentFailureMessage({ reason: "membership_inactive" })).toMatch(/Active participation in a campaign/);
    expect(presentFailureMessage({ reason: "unauthorized" })).toMatch(/only read your own/);
    expect(presentFailureMessage({ reason: "catalog_unavailable" })).toMatch(/could not be reached/);
    expect(presentFailureMessage({ reason: "mystery" })).toMatch(/unavailable/);
    expect(presentFailureMessage(null)).toMatch(/unavailable/);
  });

  it("presents empty and success copy and keeps failure details", () => {
    const vacant = presentAccessHistory({ ok: true, events: [], rangeDays: 90 });
    expect(vacant.state).toBe("empty");
    expect(vacant.message).toMatch(/No staff have viewed or changed your profile or issues/);

    const one = presentAccessHistory({
      ok: true,
      rangeDays: 90,
      events: [{
        id: "access-1",
        actorLabel: "Sam",
        action: "viewed_case",
      }],
    });
    expect(one.state).toBe("success");
    expect(one.message).toBe("1 event shown.");
    expect(one.events[0].label).toBe("Sam viewed your issue");

    const many = presentAccessHistory({
      ok: true,
      events: [
        { id: "a", actorLabel: "Sam", action: "viewed_profile" },
        { id: "b", actorLabel: "Lee", action: "updated_case" },
      ],
    });
    expect(many.message).toBe("2 events shown.");
    expect(many.events[1].label).toBe("Lee updated your issue");
    expect(presentAccessHistory({
      ok: true,
      events: [
        { id: "g", actorLabel: "Ava", action: "granted_role" },
        { id: "r", actorLabel: "Ava", action: "revoked_role" },
        { id: "u", actorLabel: "Ava", action: "custom_action" },
      ],
    }).events.map((event) => event.label)).toEqual([
      "Ava gave you a staff role",
      "Ava removed a staff role from your account",
      "Ava custom_action",
    ]);

    const failed = presentAccessHistory({
      ok: false,
      reason: "catalog_unavailable",
      details: { field: "rpc" },
    });
    expect(failed.state).toBe("retry");
    expect(failed.details).toEqual({ field: "rpc" });
    expect(presentAccessHistory({ ok: false, reason: "wrong_organization" }).state).toBe("wrong_organization");
    expect(presentAccessHistory({ ok: false, reason: "empty_organization" }).state).toBe("empty");
    expect(presentAccessHistory({ ok: false }).state).toBe("unauthorized");
    expect(presentAccessHistory({ ok: false, reason: "unauthorized" }).events[0]?.label).toBeUndefined();
  });

  it("names only event families that something actually records", () => {
    const coordinatorSource = readFileSync(resolve(process.cwd(), "src/views/CoordinatorView.jsx"), "utf8");
    const stewardSource = readFileSync(resolve(process.cwd(), "src/views/StewardView.jsx"), "utf8");
    const actionAlt = ACCESS_ACTIONS.join("|");
    const recorded = new Set();
    for (const source of [coordinatorSource, stewardSource]) {
      for (const match of source.matchAll(new RegExp(`recordCaseEvent\\([\\s\\S]*?,\\s*"(${actionAlt})"`, "g"))) {
        recorded.add(match[1]);
      }
      for (const match of source.matchAll(new RegExp(`recordAccess\\([\\s\\S]*?action:\\s*"(${actionAlt})"`, "g"))) {
        recorded.add(match[1]);
      }
    }
    expect(coordinatorSource).toMatch(/recordCaseEvent/);
    expect(stewardSource).toMatch(/recordAccess/);
    expect([...recorded].sort()).toEqual(["updated_case", "viewed_case"]);

    // REQ-UG-ACCESS-HISTORY-PROFILE-VIEWS-20261001: profile events are
    // produced server-side by the staff profile read and every profile write,
    // so the copy may promise them again (PR #2437 had narrowed it while
    // nothing produced them).
    const producer = stripComments(readFileSync(resolve(process.cwd(),
      "supabase/migrations/20261003052000_custom_nav_links_and_profile_access_history.sql"), "utf8"));
    expect(producer).toContain("perform private.record_staff_profile_access(org, p_member_user_id, 'viewed_profile');");
    expect(producer).toContain("perform private.record_staff_profile_access(new.organization_id, new.member_user_id, 'updated_profile');");
    expect(producer).toContain("after insert or update on public.organization_member_operational_profiles");
    expect(producer).toMatch(/actor is null or p_subject_user_id is null or actor = p_subject_user_id/);

    const empty = presentAccessHistory({ ok: true, events: [], rangeDays: 90 });
    const copies = {
      disclaimer: empty.disclaimer,
      empty: empty.message,
      enSub: catalogue.en["accessHistory.sub"],
      esSub: catalogue.es["accessHistory.sub"],
    };
    for (const [name, text] of Object.entries(copies)) expect(text, name).toBeTruthy();

    expect(copies.disclaimer).toMatch(/viewed or changed your profile or issues/i);
    expect(copies.empty).toMatch(/viewed or changed your profile or issues/i);
    expect(copies.enSub).toMatch(/viewed or changed your profile or issues/i);
    expect(copies.esSub).toMatch(/vio o cambió tu perfil o tus asuntos/i);
    expect(copies.esSub).toMatch(/\bMira\b/);
    for (const [name, text] of Object.entries(copies)) {
      expect(text, name).toMatch(/staff role|rol de personal/i);
    }

    // Chapter-scoped role changes reach the feed since 20260925100200, so the
    // copy no longer qualifies the role change as organization-level only.
    for (const [name, text] of Object.entries(copies)) {
      expect(text, `${name} must not exclude chapter role changes`).not.toMatch(/chapter-scoped|alcance de cap\u00edtulo/i);
      expect(text, `${name} must not narrow to organization-level roles`).not.toMatch(/organization-level|a nivel de organizaci\u00f3n/i);
    }

    // Self-access is never recorded, but a staff role a member changed on
    // their own account does reach their feed, so the exclusion names access.
    expect(copies.disclaimer).toMatch(/does not include your own access/i);
    expect(copies.disclaimer).toMatch(/staff role you changed on your own account does appear/i);
    expect(copies.disclaimer, "the disclaimer must not exclude every action of the member's own")
      .not.toMatch(/does not include your own actions/i);
    expect(copies.disclaimer).toMatch(/within 10 minutes appear once/i);

    // This edition says the unlogged case in plain words: a staff list that
    // shows only a summary is not recorded unless the record is opened.
    const listViewEn = /staff list that shows only a summary does not appear here/i;
    const listViewEs = /lista del personal que solo muestra un resumen no aparece aquí/i;
    const loggedSurfaceEn = /unless the person opens your record/i;
    const loggedSurfaceEs = /a menos que la persona abra tu registro/i;
    expect(copies.disclaimer).toMatch(listViewEn);
    expect(copies.disclaimer).toMatch(loggedSurfaceEn);
    // The footer says it once; the intro does not repeat it.
    expect(copies.enSub).not.toMatch(/staff list|queue/i);
    expect(copies.esSub).not.toMatch(/lista del personal|cola/i);
    expect(catalogue.es["accessHistory.disclaimer"]).toMatch(listViewEs);
    expect(catalogue.es["accessHistory.disclaimer"]).toMatch(loggedSurfaceEs);
  });

  it("reads event labels, counts, failures, and the disclaimer from the viewer's catalogue", () => {
    const englishDisclaimer = catalogue.en["accessHistory.disclaimer"];
    const oneEvent = {
      ok: true,
      rangeDays: 90,
      events: [{ id: "access-1", actorLabel: "Sam", action: "viewed_case" }],
    };
    const english = presentAccessHistory(oneEvent);
    const explicitEnglish = presentAccessHistory(oneEvent, "en");
    expect(english).toEqual(explicitEnglish);
    expect(english.message).toBe("1 event shown.");
    expect(english.message).toBe(catalogue.en["accessHistory.count.one"].replace("{count}", "1"));
    expect(english.events[0].label).toBe("Sam viewed your issue");
    expect(english.disclaimer).toBe(englishDisclaimer);
    expect(english.disclaimer).toBe(catalogue.en["accessHistory.disclaimer"]);
    expect(presentLoading()).toMatchObject({
      title: "Access history",
      message: "Loading who accessed your records.",
      disclaimer: englishDisclaimer,
    });
    expect(presentRetry("en").message).toBe("Access history could not be reached. Try again.");
    expect(presentAccessHistory({ ok: true, events: [], rangeDays: 30 }).message).toBe(
      "No staff have viewed or changed your profile or issues, or changed a staff role on your account, in the last 30 days.",
    );

    const spanish = presentAccessHistory(oneEvent, "es");
    expect(spanish.title).toBe("Historial de acceso");
    expect(spanish.message).toBe("Se muestra 1 evento.");
    expect(spanish.message).toBe(catalogue.es["accessHistory.count.one"].replace("{count}", "1"));
    expect(spanish.events[0].label).toBe("Sam vio tu asunto");
    expect(spanish.disclaimer).toBe(catalogue.es["accessHistory.disclaimer"]);
    expect(spanish.disclaimer).not.toBe(englishDisclaimer);
    expect(spanish.message).not.toBe("1 event shown.");
    expect(spanish.events[0].label).not.toContain("viewed your issue");
    expect(presentAccessHistory({
      ok: true,
      events: [
        { id: "a", actorLabel: "Sam", action: "viewed_profile" },
        { id: "b", actorLabel: "Lee", action: "updated_case" },
        { id: "c", actorLabel: "Ava", action: "updated_profile" },
        { id: "d", actorLabel: "Ava", action: "granted_role" },
        { id: "e", actorLabel: "Ava", action: "revoked_role" },
        { id: "f", actorLabel: "Ava", action: "custom_action" },
      ],
    }, "es")).toMatchObject({
      message: "Se muestran 6 eventos.",
      events: [
        { label: "Sam vio tu perfil" },
        { label: "Lee actualizó tu asunto" },
        { label: "Ava actualizó tu perfil" },
        { label: "Ava te dio un rol de personal" },
        { label: "Ava te retiró un rol de personal de tu cuenta" },
        { label: "Ava custom_action" },
      ],
    });

    expect(presentLoading("es")).toMatchObject({
      title: "Historial de acceso",
      message: "Cargando quién accedió a tus registros.",
      disclaimer: catalogue.es["accessHistory.disclaimer"],
    });
    expect(presentRetry("es").message).toBe("No se pudo consultar el historial de acceso. Inténtelo de nuevo.");
    const spanishEmpty = presentAccessHistory({ ok: true, events: [], rangeDays: 90 }, "es");
    expect(spanishEmpty.message).toBe(catalogue.es["accessHistory.emptyRange.90"]);
    expect(spanishEmpty.message).not.toMatch(/No staff have viewed/);
    for (const text of [spanish.disclaimer, spanishEmpty.message]) {
      expect(text).toMatch(/perfil/i);
      expect(text).not.toMatch(/profile/i);
    }

    const reasons = {
      empty_organization: "Seleccione una organización antes de leer el historial de acceso.",
      wrong_organization: "Ese historial de acceso pertenece a otra organización.",
      membership_inactive: "Se requiere participación activa en una campaña.",
      unauthorized: "Solo puedes leer tu propio historial de acceso.",
      catalog_unavailable: "No se pudo consultar el historial de acceso. Inténtelo de nuevo.",
    };
    for (const [reason, message] of Object.entries(reasons)) {
      expect(presentFailureMessage({ reason }, "es")).toBe(message);
      expect(presentAccessHistory({ ok: false, reason }, "es").message).toBe(message);
      expect(message).not.toBe(presentFailureMessage({ reason }));
    }
    expect(presentFailureMessage({ reason: "mystery" }, "es")).toBe("El historial de acceso no está disponible.");
    expect(presentFailureMessage(null, "es")).toBe("El historial de acceso no está disponible.");
    expect(presentAccessHistory({
      ok: false,
      reason: "catalog_unavailable",
      details: { field: "rpc" },
    }, "es")).toMatchObject({
      state: "retry",
      message: reasons.catalog_unavailable,
      details: { field: "rpc" },
    });
  });

  it("names the two-step sign-in state in the viewer's language", () => {
    expect(presentMfaRequired()).toEqual(presentMfaRequired("en"));
    expect(presentMfaRequired().message).toBe("Complete two-step sign-in to see your access history.");
    const spanish = presentMfaRequired("es");
    expect(spanish).toMatchObject({
      state: "mfa_required",
      title: "Historial de acceso",
      message: catalogue.es["accessHistory.mfaRequired"],
      disclaimer: catalogue.es["accessHistory.disclaimer"],
      events: [],
    });
    expect(presentFailureMessage({ reason: "mfa_required" }, "es")).toBe(catalogue.es["accessHistory.mfaRequired"]);
  });
});
