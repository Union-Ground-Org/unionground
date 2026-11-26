import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { catalogue, t } from "../src/lib/i18n.js";
import { LanguageProvider, useLang } from "../src/lib/LanguageContext.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { TaskFieldNotesView } from "../src/views/TaskFieldNotesView.jsx";
import { TIER1_MARKERS } from "./i18nRegisterMarkers.js";

// UX-UG-ES-USTED-TIER1-REMAINING-20260919
//
// The tier-1 sweep: the 60 catalogue.es keys that matched the usted/ustedes +
// formal-imperative union at Main e8245e1d8b and carried no owner in the
// census inventory. 49 addressed the reader with a formal imperative and are
// repaired to tú here; 4 more do so too but are legal-page claim copy and stay
// verbatim (LEGAL_FROZEN below); 7 are marker false positives — the matched
// word is a subjunctive whose grammatical subject is NOT the reader — and
// their ES text is pinned below so a later blanket sweep cannot "repair" a
// string that already reads correctly.
//
// The marker union is TIER1_MARKERS from tests/i18nRegisterMarkers.js, the
// same one scripts/census-es-usted.mjs counts with
// (UX-UG-ES-USTED-CENSUS-TIER2-20260917); scripts/lib/es-usted-census-inventory.json
// records the disposition of every key the ratchet below allows.
//
// Boundaries are a Unicode letter class, not `\b`: `\b` is ASCII-only, so
// `\bdé\b` never matches `Dé los hechos` (é is a non-word character to it).
// The boundary self-test below keeps that property load-bearing, and rendered
// text is read node by node — `textContent` concatenates siblings with no
// separator and silently destroys a word's left boundary.

function tier1Hits(value) {
  if (typeof value !== "string") return [];
  const scan = new RegExp(TIER1_MARKERS.source, "gi");
  return (value.normalize("NFC").match(scan) ?? []);
}

// Read every text node on its own line so two sibling elements can never be
// concatenated into a word that never appears on screen.
function renderedLines(root) {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const lines = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

// The 49 keys repaired to tú by this record. EN is unchanged for every one.
const REPAIRED = [
  "casework.demoConflict", "casework.demoInvalid",
  "procedure.advanceFailed", "procedure.saveFailed", "procedure.exampleNote",
  "workspace.recipeHelp", "clauses.sub",
  "accessHistory.recordFailed", "accessHistory.updateRecordFailed",
  "pay.sub", "pay.calculatorHint", "pay.hourlyRateHint", "pay.ruleUnsetHint",
  "pay.catalogRetry", "pay.calculationDateRequired", "pay.calculationRulesUnset",
  "pay.invalidInput", "pay.publisherMfa", "pay.publisherInvalid",
  "pay.publisherFailed", "pay.publishStepHelp",
  "hub.voice.sub", "hub.publishedEditNote", "hub.publishedSaveBlocked",
  "hub.lifecycle.exportFailed", "hub.lifecycle.deleteConfirmation",
  "hub.lifecycle.deleteFailed", "hub.lifecycle.deleteIndeterminate",
  "hub.lifecycle.deleteHoldElsewhere", "hub.knowledge.loadError",
  "hub.knowledge.emptyStaff",
  "tasks.fieldNotesUnavailable", "tasks.fieldNoteFailed", "tasks.commentUnavailable",
  "caseDash.stepSub", "caseBulk.advanceOutcomeRequired",
  "admin.chapterLifecycle.sub", "admin.chapterLifecycle.error",
  "admin.chapterLifecycle.noChapter", "admin.chapterLifecycle.membershipSub",
  "admin.chapterLifecycle.membersEmpty",
  "admin.command.lifecycleInviteHelp", "admin.command.lifecycleRetentionHelp",
  "admin.retention.sub", "admin.retention.typeEnable",
  "admin.retention.typeAuthorize", "admin.retention.executed",
  "admin.governanceSub", "search.knowledgeLoadError",
];

// Measured keys that do address the reader in usted but are NOT reworded
// here: legal-page claim copy is counsel-reviewed and every legal.* line feeds
// the LEGAL_COPY_FINGERPRINT digest, so a register change belongs to a legal
// review that bumps that pin, not to this sweep.
const LEGAL_FROZEN = {};

// Keys that matched at the census base and were legal-frozen or ruled as false
// positives or late growth, but that Union Ground's rewritten legal and
// contact copy no longer words in usted. They must stay marker-free.
const LEGAL_NOW_CLEAN = [
  "legal.terms.responsibility.body", "legal.accessibility.report.body",
  "legal.aiDisclosure.chapter.body", "legal.aiDisclosure.sensitive.body",
];
const NOW_CLEAN = [...LEGAL_NOW_CLEAN, "accessHistory.disclaimer", "contact.intro"];

// The 7 marker false positives, each with the grammatical subject of the word
// the union matched. These ES strings MUST NOT change register: they already
// address the reader in tú, or they do not address the reader at all.
const FALSE_POSITIVES = {
  "integrations.sub": {
    subject: "esta organización — 'hasta que esta organización complete el alta'",
    es: "Los proveedores opcionales permanecen sin configurar hasta que esta organización complete el alta. La persistencia está reservada.",
  },
  "caseBulk.advanceOutcomeHelp": {
    subject: "cada transición de asunto — 'que se complete'",
    es: "Este resultado se registra en cada transición de asunto que se complete.",
  },
  "appt.oauthStartFailed": {
    subject: "un operador — 'pide a un operador que revise'; the reader is addressed in tú ('Inténtalo', 'pide')",
    es: "No se pudo iniciar la autorización del calendario. Inténtalo de nuevo o pide a un operador que revise la app registrada del proveedor.",
  },
  "appt.importFailed": {
    subject: "un operador — 'pide a un operador que revise'; the reader is addressed in tú ('quita', 'vuelve a conectar')",
    es: "La conciliación de eventos falló · {date}. La disponibilidad está actualizada; la próxima sincronización programada volverá a intentarlo. Si continúa, quita y vuelve a conectar el calendario o pide a un operador que revise el permiso para leer eventos.",
  },
  "inbox.peerLoadUnavailable": {
    subject: "el contacto entre compañeros — 'hasta que vuelva a estar disponible'",
    es: "No se pudo cargar el contacto entre compañeros. No se muestran datos ni solicitudes hasta que vuelva a estar disponible.",
  },
  "landing.interestStopIntro": {
    subject: "este formulario — 'impide que este formulario vuelva a agregarlo'; the reader is addressed in tú ('Quita')",
    es: "Quita un correo de todas las listas públicas de Union Ground e impide que este formulario vuelva a agregarlo. Primero enviamos un enlace de confirmación; nada cambia hasta que se abra.",
  },
};

// Measured keys whose copy left the catalogue with a removed feature. They stay
// counted among the 60 the census measured, and must stay absent.
const REMOVED_WITH_FEATURE = {
  // A false positive (subject: un administrador financiero autorizado). The
  // Stripe dues integration is removed: Union Ground leaves dues out
  // (owner decision, 2026-10-15).
  "dues.stripeNotConnectedNote": "Stripe dues integration removed",
};

// Tier-1 matches that arrived on Main AFTER the census base this record
// measured, so they are not among its 60 keys and are not reworded here. Each
// is named with its origin so the whole-catalogue ratchet below still fails on
// any further new match. Remove an entry when its own register record lands.
const LATER_GROWTH = {
  // #2769 (civic advocacy merge-back) added the civic privacy section in the
  // usted register. It is policy text; its register is a separate record.
  "legal.privacy.civic.body": "added by #2769 after the census base",
  // #2918 added the access-history two-step prompt in the usted register of
  // its block; tests/mi1-access-history-web-views.test.jsx pins that text.
  "accessHistory.mfaRequired": "added by #2918 after the census base",
  // #3050 moved the access-history presenter copy into the catalogue in the
  // same usted register as its block; tests/mi1-access-history-presenters.test.js
  // pins the retry and failure text.
  "accessHistory.retry": "added by #3050 after the census base",
  "accessHistory.failure.empty_organization": "added by #3050 after the census base",
  "accessHistory.failure.catalog_unavailable": "added by #3050 after the census base",
};

// Tier-1 matches that exist only because the census union also carries the
// casework/admin imperatives (elija, responda, ...), which this sweep's base
// did not scan. Dispositioned in the census inventory; not reworded here.
const CENSUS_UNION_ONLY = {
  "workspace.overviewHelp": "'Elija' addresses the reader; unowned",
  "hub.intake.convertHelp": "'Elija' addresses the reader; unowned",
  "admin.retention.daysInvalid": "'Elija' addresses the reader; unowned",
};

// PK ruling, October 20, 2026: this later key is outside the original
// 60-key census. Pin the full text so this is not a namespace exemption.
const LATER_FALSE_POSITIVES = {
  "reset.recoveryHeld": {
    subject: "la administración de tu capítulo — 'cuando lo haga'; the reader is addressed in tú ('Pide', 'entra', 'elige', 'Escribe')",
    es: "No se pudo completar la recuperación y ahora está en espera, así que no podemos decirte si tu contraseña cambió. Pide a la administración de tu campaña que restablezca tu inicio de sesión en dos pasos; cuando lo haga, entra y elige una contraseña nueva. Escribe a el contacto de soporte que publica el operador si no sabes quién es.",
  },
};

describe("ES tier-1 register sweep", () => {
  it("keeps the letter-class boundary load-bearing", () => {
    // `\b` cannot express these two cases; if the class regresses to `\b`
    // the first expectation fails and the second passes for the wrong reason.
    expect(tier1Hits("Dé los hechos primero.")).toEqual(["Dé"]);
    expect(tier1Hits("Ya leí el aviso y lo dejé como estaba.")).toEqual([]);
    expect(tier1Hits("Inténtalo de nuevo.")).toEqual([]);
  });

  it("dispositions every key the tier-1 census measured", () => {
    const present = [...REPAIRED, ...Object.keys(LEGAL_FROZEN), ...Object.keys(FALSE_POSITIVES), ...LEGAL_NOW_CLEAN];
    const measured = [...present, ...Object.keys(REMOVED_WITH_FEATURE)];
    expect(new Set(measured).size, "a key is listed twice").toBe(60);
    for (const key of present) {
      expect(typeof catalogue.es[key], `${key} es missing`).toBe("string");
      expect(typeof catalogue.en[key], `${key} en missing`).toBe("string");
    }
    for (const [key, reason] of Object.entries(REMOVED_WITH_FEATURE)) {
      expect(catalogue.es[key], `${key} is back: ${reason}`).toBeUndefined();
      expect(catalogue.en[key], `${key} is back: ${reason}`).toBeUndefined();
    }
  });

  it("leaves no formal-imperative marker on any repaired key", () => {
    for (const key of REPAIRED) {
      expect(tier1Hits(catalogue.es[key]), `${key} still uses usted`).toEqual([]);
    }
  });

  it("keeps the keys Union Ground's copy reworded out of usted", () => {
    for (const key of NOW_CLEAN) {
      expect(tier1Hits(catalogue.es[key]), `${key} addresses the reader in usted again`).toEqual([]);
    }
  });

  it("pins the false positives so a later sweep cannot reword them", () => {
    for (const [key, ruling] of Object.entries(FALSE_POSITIVES)) {
      expect(catalogue.es[key], `${key} changed: ${ruling.subject}`).toBe(ruling.es);
    }
  });

  it("pins the later third-person subjunctive without expanding the original census", () => {
    for (const [key, ruling] of Object.entries(LATER_FALSE_POSITIVES)) {
      expect(catalogue.es[key], `${key} changed: ${ruling.subject}`).toBe(ruling.es);
      expect(tier1Hits(catalogue.es[key])).toEqual(["haga"]);
    }
  });

  it("holds the whole Spanish catalogue at the ruled false positives only", () => {
    // The census count may only shrink: any NEW tier-1 match is a key this
    // record never dispositioned and fails here rather than in a later audit.
    const matching = Object.entries(catalogue.es)
      .filter(([, value]) => tier1Hits(value).length > 0)
      .map(([key]) => key)
      .sort();
    expect(matching).toEqual(
      [
        ...Object.keys(FALSE_POSITIVES), ...Object.keys(LEGAL_FROZEN), ...Object.keys(LATER_GROWTH),
        ...Object.keys(CENSUS_UNION_ONLY),
        ...Object.keys(LATER_FALSE_POSITIVES),
      ].sort(),
    );
  });
});

// The three surfaces the record names, rendered in Spanish.
describe("the named error surfaces render in tú", () => {
  it("renders tasks.fieldNoteFailed in Spanish from the Field notes composer", async () => {
    const es = (key, vars) => t("es", key, vars);
    const rendered = render(<TaskFieldNotesView
      tasks={[{ id: "task-a", taskNumber: 1, title: "Primera tarea", status: "to_do", workstream: "General" }]}
      comments={[]}
      assignees={[{ id: "member-1", fullName: "Persona afiliada" }]}
      memberId="member-1"
      chapterId="chapter-1"
      doneVisible={false}
      demo={false}
      lang="es"
      t={es}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onAddComment={vi.fn(async () => { throw new Error("refused"); })}
    />);
    const composer = within(rendered.container).getByPlaceholderText(catalogue.es["tasks.fieldNotePlaceholder"]);
    fireEvent.change(composer, { target: { value: "Nota de prueba" } });
    fireEvent.submit(composer.closest("form"));

    const alert = await within(rendered.container).findByRole("alert");
    expect(alert).toHaveTextContent("Vuelve a intentarlo");
    expect(tier1Hits(renderedLines(alert))).toEqual([]);
    rendered.unmount();
  });

  it("renders hub.lifecycle.deleteFailed in Spanish from the account-deletion dialog", async () => {
    const data = {
      member: { id: "user-1", initials: "MV", fullName: "Worker Voice" },
      roles: [],
      conversations: [],
      broadcasts: [],
      product: {
        spaces: [], documents: [], records: [], intake: [],
        handshakes: [], governance: [], partnerOrgs: [],
      },
    };
    const rendered = render(<LanguageProvider lang="es"><ProductHubView
      data={data}
      onCreateGovernance={vi.fn()}
      onGenerateDataExport={vi.fn()}
      onDeleteAccount={vi.fn().mockRejectedValue(new Error("refused"))}
    /></LanguageProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Derechos de datos" }));
    fireEvent.click(screen.getByRole("button", { name: "Eliminar mi cuenta" }));
    fireEvent.change(screen.getByRole("textbox", { name: catalogue.es["hub.lifecycle.deleteConfirmation"] }), {
      target: { value: "DELETE MY ACCOUNT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Eliminar mi cuenta permanentemente" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Confirma una verificación reciente");
    expect(tier1Hits(renderedLines(alert))).toEqual([]);
    rendered.unmount();
  });

  it("renders accessHistory.recordFailed in Spanish through the notice channel", () => {
    // StewardView and CoordinatorView hand this string to an `onNotice`
    // callback rather than rendering it themselves, so the render under test
    // is the notice element the shell mounts it into.
    function Notice({ notice }) {
      const { t: translate } = useLang();
      return <p role="status">{translate(notice)}</p>;
    }
    const rendered = render(
      <LanguageProvider lang="es"><Notice notice="accessHistory.recordFailed" /></LanguageProvider>,
    );
    const status = within(rendered.container).getByRole("status");
    expect(status).toHaveTextContent("Inténtalo de nuevo");
    expect(tier1Hits(renderedLines(status))).toEqual([]);
    rendered.unmount();
  });
});
